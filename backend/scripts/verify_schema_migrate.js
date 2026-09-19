'use strict';
/*
 * 回归测试：数据结构版本与迁移框架（backend/lib/schema.js）
 *
 * 在临时目录里造【真实文件】、跑【真实迁移函数】—— 刻意不 mock 文件系统，
 * 因为要验证的恰恰是文件操作本身：备份是否真落盘、失败后原文件是否字节不变。
 *
 * 覆盖八项：
 *   ① setIfMissing 语义     —— 有值不覆盖、缺失才补（「只补不覆盖」的原子保证）
 *   ② apply 透传            —— 非管辖文件/数组原样返回；管辖文件保持原对象引用
 *   ③ 版本相等              —— changed=false，且不产生任何备份
 *   ④ 版本落后              —— 触发迁移：备份文件真存在 + 内容更新 + 版本号已升
 *   ⑤ 幂等                  —— 迁移后再跑一次，changed=false
 *   ⑥ 迁移抛错              —— 原文件字节不变（写回在调用方，失败天然无害）
 *   ⑦ 版本超前              —— 抛 SCHEMA_VERSION_AHEAD
 *   ⑧ 一致性                —— SCHEMA_VERSION === max(MIGRATIONS)+1（加载时已断言，这里显式跑一次）
 *
 * ★ 不联网、不碰 data/ 下任何真实文件（全部在 os.tmpdir() 的临时目录里，跑完自删）。
 *   用法：node backend/scripts/verify_schema_migrate.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const schema = require(path.join(__dirname, '..', 'lib', 'schema'));

let pass = 0, fail = 0;
function t(name, cond, actual) {
  if (cond) { pass++; console.log('  \u2705 ' + name); }
  else { fail++; console.log('  \u274c ' + name + (actual !== undefined ? '  \u2192 实际: ' + JSON.stringify(actual) : '')); }
}

// 临时目录：造真实文件（不走内存 mock）
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-schema-'));
const file = 'holdings.json';
const full = path.join(dir, file);
const write = (obj) => fs.writeFileSync(full, JSON.stringify(obj, null, 2) + '\n', 'utf8');

try {
  // ── ① setIfMissing 语义 ──
  const o1 = { a: 1 };
  schema.setIfMissing(o1, 'a', 99);
  schema.setIfMissing(o1, 'b', 2);
  t('①a 已有值不被覆盖', o1.a === 1);
  t('①b 缺失才补', o1.b === 2);

  // ── ② apply 透传 ──
  const arr = [1, 2];
  t('②a 数组型文件原样返回（history 等挂不了字段）', schema.apply('history.json', arr) === arr);
  const anyObj = { x: 1 };
  t('②b 非管辖文件原样返回', schema.apply('theme_map.json', anyObj) === anyObj);
  const h = { funds: [] };
  t('②c 管辖文件保持原对象引用（不换实例）', schema.apply('holdings.json', h) === h);
  t('②d apply 不注入 _schemaVersion（铁律 1）', !('_schemaVersion' in h));

  // ── ③ 版本相等 ──
  write({ _schemaVersion: schema.SCHEMA_VERSION, funds: [{ code: 'X' }] });
  const r1 = schema.migrateIfNeeded(file, JSON.parse(fs.readFileSync(full, 'utf8')), { dataDir: dir });
  t('③a 版本相等 changed=false', r1.changed === false);
  t('③b 不产生备份', fs.readdirSync(dir).filter(n => n.includes('.bak-')).length === 0);

  // ── ④ 版本落后（注入假迁移，走真实文件与真实备份）──
  const raw1 = { _schemaVersion: 1, funds: [{ code: 'X', amount: 100 }] };
  write(raw1);
  const r2 = schema.migrateIfNeeded(file, raw1, {
    dataDir: dir,
    targetVersion: 2,
    migrations: { 2: (o) => { o.funds.forEach(f => schema.setIfMissing(f, 'feeRate', 0.0015)); return o; } },
  });
  t('④a changed=true', r2.changed === true);
  t('④b 备份文件真存在', !!r2.backup && fs.existsSync(r2.backup));
  t('④c 备份内容 = 迁移前（feeRate 尚未补）', (() => {
    try { return JSON.parse(fs.readFileSync(r2.backup, 'utf8')).funds[0].feeRate === undefined; } catch (e) { return false; }
  })());
  t('④d 版本号已升到 2', r2.obj._schemaVersion === 2);
  t('④e 新默认值已补', r2.obj.funds[0].feeRate === 0.0015);
  t('④f 旧值未被覆盖', r2.obj.funds[0].amount === 100);
  write(r2.obj); // 模拟调用方写回

  // ── ⑤ 幂等 ──
  const r3 = schema.migrateIfNeeded(file, JSON.parse(fs.readFileSync(full, 'utf8')),
    { dataDir: dir, targetVersion: 2, migrations: { 2: (o) => o } });
  t('⑤ 迁移后再跑一次 changed=false', r3.changed === false);

  // ── ⑥ 迁移抛错 ──
  const raw3 = { _schemaVersion: 1, funds: [] };
  write(raw3);
  const before = fs.readFileSync(full, 'utf8');
  let threw = false;
  try {
    schema.migrateIfNeeded(file, raw3, {
      dataDir: dir, targetVersion: 2,
      migrations: { 2: () => { throw new Error('boom'); } },
    });
  } catch (e) { threw = true; }
  t('⑥a 迁移抛错向上传播', threw);
  t('⑥b 原文件字节不变（写回在调用方，失败天然无害）', fs.readFileSync(full, 'utf8') === before);

  // ── ⑦ 版本超前 ──
  let ahead = false, code = '';
  try { schema.migrateIfNeeded(file, { _schemaVersion: 99 }, { dataDir: dir }); }
  catch (e) { ahead = true; code = e.code; }
  t('⑦ 版本超前抛 SCHEMA_VERSION_AHEAD', ahead && code === 'SCHEMA_VERSION_AHEAD');

  // ── ⑧ 一致性 ──
  try { schema.assertConsistent(); t('⑧ SCHEMA_VERSION === max(MIGRATIONS)+1', true); }
  catch (e) { t('⑧ SCHEMA_VERSION === max(MIGRATIONS)+1', false, e.message); }
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清理非致命 */ }
}

console.log('\n\u2500\u2500 结果: ' + pass + ' 通过 / ' + fail + ' 失败 \u2500\u2500');
process.exit(fail ? 1 : 0);

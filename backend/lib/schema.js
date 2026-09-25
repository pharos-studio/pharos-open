'use strict';
/*
 * 数据结构版本与迁移 —— 本项目唯一的版本口径（唯一真相源）。
 *
 * ── 它管什么 ──
 *   · SCHEMA_VERSION  项目级数据版本。锚在 holdings.json 的 `_schemaVersion` 字段上
 *     （history / decision_history 等顶层数组挂不了字段，由同一版本统一驱动）。
 *   · normalize*      读取/写入时补「业务字段默认值」—— 只补 undefined，绝不覆盖已有值。
 *   · MIGRATIONS      结构变更（改字段名/类型/拆合）时才写；key n 表示「把 (n-1) 升到 n」。
 *
 * ── 三条铁律（都是设计阶段推演出来的坑，改这里前必读）──
 *   1. apply() 绝不注入 _schemaVersion —— 版本号只由 migrateIfNeeded 写入。
 *      否则迁移读到的是注入值而非磁盘真值，迁移永不触发（次序陷阱）。
 *   2. _schemaVersion 的缺省语义是 1（没有版本号 = 最早版本）。
 *      若缺省当「当前版本」，升版本时存量数据会被当成新版、静默跳过迁移。
 *   3. 迁移不挂在读取路径上 —— 读操作必须无副作用（store.js 的约定）。
 *      迁移只在 server.js 启动块跑一次；热路径（含 fetchers 每基金一读）只走幂等的 apply()。
 *
 * ── 与 timing_state.json 的 version 字段的分工 ──
 *   timing_state.json 是派生状态（丢了可重建），engines/timing.js 敢「不匹配就丢弃重建」；
 *   holdings / config 是用户数据，丢了找不回 —— 只能迁移，绝不能丢弃。两套口径并行，互不管辖。
 *
 * ── 以后怎么用 ──
 *   · 加字段：往 normalizeHoldings / normalizeConfig 里加一行 setIfMissing(...)。
 *     完全不需要迁移 —— 写路径会补上默认值，用户下次保存时文件自动带新字段。
 *   · 改结构：SCHEMA_VERSION++，往 MIGRATIONS 写一个函数（key = 新版本号）。
 *     启动时自动跑；跑前自动备份到 <文件>.bak-<时间戳>；失败时原文件不会被碰（写回在调用方）。
 */
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;

// MIGRATIONS[n] 把数据从 (n-1) 升到 n。现在为空 —— 第一次真的要改结构时才加。
// 例：MIGRATIONS[2] = (obj) => { /* 把 v1 结构改成 v2 */ return obj; };
// holdings 的 v2 是跨 holdings/history 的严格迁移，由 engines/shareMigration.js 独占执行；
// 此处 identity 仅供 config 等单文件版本升级及迁移框架自检。
const MIGRATIONS = { 2: (obj) => obj };

// 只补 undefined —— 语义在此处保证一次，所有 normalize* 都经它写。
function setIfMissing(obj, key, value) {
  if (obj[key] === undefined) obj[key] = value;
}

// 「这是示例数据」的判据 —— 与 audit_desensitize.js / verify_edit_recalc.js /
// verify_principal_caliber.js 三处共用同一个正则，改这里必须四处同改。
const DEMO_MARK_RX = /DEMO DATA|NOT real holdings|placeholder/i;

// ── 归一：读路径与写路径都走这里。只补业务缺省值，绝不注入 _schemaVersion（铁律 1）──
// 唯一的例外是下面那条「剥离示例标记」—— 它必须删除一个字段，原因见行内注释。
// 以后加字段在下面加 setIfMissing 行。
function normalizeHoldings(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return h;
  // ★ 一旦装进真实持仓，就必须摘掉「示例数据」标记，否则脱敏审计会永久停在 Mode B
  //   （Mode B 只查关键词、不跑数值指纹），等于门禁静默失效 —— 判据见 audit_desensitize.js:102-106。
  //   funds 为空时保留标记：此刻它确实是空模板，审计本就该走 Mode B。
  if (Array.isArray(h.funds) && h.funds.length > 0
      && typeof h._comment === 'string' && DEMO_MARK_RX.test(h._comment)) {
    delete h._comment;
  }
  if (Array.isArray(h.funds)) {
    for (const f of h.funds) {
      if (!f || typeof f !== 'object') continue;
      if (!Array.isArray(f.purchases)) f.purchases = [];
    }
  }
  // 示例（将来加字段时照这样写）：setIfMissing(h, 'someFutureField', defaultValue);
  return h;
}
function normalizeConfig(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return c;
  if (!c.purchaseDefaults || typeof c.purchaseDefaults !== 'object' || Array.isArray(c.purchaseDefaults)) {
    c.purchaseDefaults = { feeWaived: false };
  } else {
    setIfMissing(c.purchaseDefaults, 'feeWaived', false);
  }
  return c;
}

function normalizeFor(file, obj) {
  if (file === 'holdings.json') return normalizeHoldings(obj);
  if (file === 'config.json') return normalizeConfig(obj);
  return obj;
}
const apply = normalizeFor;

// ── 迁移 ──
function bakStamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
    + '-' + String(d.getMilliseconds()).padStart(3, '0');
}

// 备份一个数据文件，返回备份路径。命名约定 `.bak-<时间戳>`（`.gitignore` 已忽略 data/**/*.bak*）。
// ★ 只此一份实现：迁移（下面）与启动时的类别补齐（server.js）都调它 ——
//   备份命名一旦出现第二份实现，迟早会分叉。调用方自己判断「要不要备份」。
function backupFile(full) {
  const bak = full + '.bak-' + bakStamp();
  fs.copyFileSync(full, bak);
  return bak;
}

// raw 必须经 store.readJSONRaw 拿（磁盘真值，未经 apply）。返回 { obj, changed, backup? }。
// 只做内存迁移 + 创建备份文件；写回由调用方负责 —— 失败时原文件未动，下次启动再试，天然幂等。
// 迁移中途抛错：原文件同样未动（备份保留，便于排查），错误向上抛。
function migrateIfNeeded(file, raw, opts) {
  const o = opts || {};
  const target = o.targetVersion || SCHEMA_VERSION;
  const mig = o.migrations || MIGRATIONS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { obj: raw, changed: false };
  }
  const v = raw._schemaVersion || 1;   // 铁律 2：缺省 = 1
  if (v > target) {
    const e = new Error(file + ' 的数据版本是 v' + v + '，高于当前程序支持的 v' + target
      + '。多半是用新版程序写了数据后又回退了旧版 —— 请更新程序，不要手改数据文件。');
    e.code = 'SCHEMA_VERSION_AHEAD';
    throw e;
  }
  if (v === target) return { obj: raw, changed: false };
  // v < target → 需要迁移。先备份（对现有文件的复制，不影响原文件）。
  // 分区存储下逻辑文件名与物理路径不同（如 config.json → data/config/config.json）。
  // 调用方已解析出真实路径时必须优先使用 fullPath，避免在 data/ 根目录备份不存在的旧路径。
  const full = o.fullPath || (o.dataDir ? path.join(o.dataDir, file) : null);
  let backup = null;
  if (full) {
    backup = backupFile(full);
  }
  let obj = raw;
  for (let i = v + 1; i <= target; i++) {
    const m = mig[i];
    if (!m) {
      throw new Error('缺少把数据从 v' + (i - 1) + ' 升到 v' + i + ' 的迁移函数（MIGRATIONS[' + i + '] 未定义）'
        + (backup ? '。原数据已备份到 ' + backup : ''));
    }
    obj = m(obj);
    if (!obj || typeof obj !== 'object') {
      throw new Error('迁移函数 MIGRATIONS[' + i + '] 返回了非法对象（必须是对象）');
    }
    obj._schemaVersion = i;
  }
  return { obj, changed: true, backup };
}

// SCHEMA_VERSION 必须恰好等于最高迁移目标版本；无迁移时基线为 v1。
function assertConsistent() {
  const keys = Object.keys(MIGRATIONS).map(Number);
  const max = keys.length ? Math.max.apply(null, keys) : 1;
  if (SCHEMA_VERSION !== max) {
    throw new Error('schema 版本不自洽：SCHEMA_VERSION=' + SCHEMA_VERSION + '，但最高迁移是 v' + max
      + '。加迁移时必须同步更新 SCHEMA_VERSION。');
  }
}
assertConsistent();

module.exports = {
  SCHEMA_VERSION, MIGRATIONS,
  setIfMissing, normalizeHoldings, normalizeConfig,
  apply, migrateIfNeeded, assertConsistent, backupFile,
};

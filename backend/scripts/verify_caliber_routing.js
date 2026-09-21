'use strict';
/*
 * 两层分类路由回归测试（离线，不联网，不依赖行情）。
 * 锁定 2026-09-12 引入的「category + caliber」两层解析：防止改 registry / util 时静默把路由搞坏。
 * 关键不变量：
 *   ① 旧数据无 caliber → broad 默认 'cn' → 命中 'broad'（与改动前逐位一致，零回归）
 *   ② broad + caliber='us' → 命中 'broad:us'（海外宽基，滚动分位 ∨ PE回撤）
 *   ③ 其他三条线（dividend/growth/cycle）不受口径维度影响
 *   ④ type 保持 'broad'（决策卡/矩阵/综合分分流靠 caliber，而非新 type）
 * 2026-09-20 追加：内置类别/预设的「只增不改」补齐（lib/categories.js 的 ensureBuiltins）——
 *   老用户升级时 categories.json 不会被 setup 覆盖，靠启动补齐把 bond/cash 与 presets 补进去；
 *   这里同时钉住「代码常量 == data/example/categories.example.json」防漂移。
 * 用法：node backend/scripts/verify_caliber_routing.js
 */
const { resolveRegistry } = require('../engines/registry');
const util = require('../lib/util');

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = String(got) === String(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | got=${got} want=${want}`);
  ok ? pass++ : fail++;
}

console.log('--- caliberOf 缺省与容错 ---');
t('broad 无 caliber → cn（旧数据兼容）', util.caliberOf({ category: 'broad' }), 'cn');
t('broad 显式 us', util.caliberOf({ category: 'broad', caliber: 'us' }), 'us');
t('broad 显式 cn', util.caliberOf({ category: 'broad', caliber: 'cn' }), 'cn');
t('broad 非法 caliber 值 → 回退默认 cn', util.caliberOf({ category: 'broad', caliber: 'xx' }), 'cn');
t('growth 无口径概念 → null', util.caliberOf({ category: 'growth' }), null);
t('dividend 无口径概念 → null', util.caliberOf({ category: 'dividend' }), null);
t('cycle 无口径概念 → null', util.caliberOf({ category: 'cycle' }), null);
t('null 输入不抛错', util.caliberOf(null), null);
t('DEFAULT_CALIBER 表正确', JSON.stringify(util.DEFAULT_CALIBER), JSON.stringify({ broad: 'cn' }));

console.log('\n--- resolveRegistry 三段解析（key / type / caliber / label）---');
// ⚠️ code 只是占位（本脚本验证的是 category/caliber 路由，REGISTRY 没有按 code 注册的条目，
//    所以 code 取什么都不影响断言）。label 断言**钉住** REGISTRY.label ——
//    将来若再改类别显示名，这里会先红，提醒你同步改 data/example/categories.example.json。
const CASES = [
  { f: { code: 'DEMO01', category: 'broad' },                  key: 'broad',     type: 'broad',    label: '宽基',              hasCal: 'cn' },
  { f: { code: 'DEMO02', category: 'broad', caliber: 'us' },   key: 'broad:us',  type: 'broad',    label: '宽基·海外',          hasCal: 'us' },
  { f: { code: 'DEMO03', category: 'broad', caliber: 'us' },   key: 'broad:us',  type: 'broad',    label: '宽基·海外',          hasCal: 'us' },
  { f: { code: 'DEMO04', category: 'broad', caliber: 'cn' },   key: 'broad',     type: 'broad',    label: '宽基',              hasCal: 'cn' },
  { f: { code: 'DEMO05', category: 'dividend' },               key: 'dividend',  type: 'dividend', label: '红利·低波',          hasCal: null },
  { f: { code: 'DEMO06', category: 'growth' },                 key: 'growth',    type: 'tech',     label: '主题·行业（高波动）', hasCal: null },
  { f: { code: 'DEMO07', category: 'growth' },                 key: 'growth',    type: 'tech',     label: '主题·行业（高波动）', hasCal: null },
  { f: { code: 'DEMO08', category: 'cycle' },                  key: 'cycle',     type: 'cycle',    label: '商品·对冲',          hasCal: null }
];
CASES.forEach(c => {
  const hit = resolveRegistry(c.f);
  const tag = `${c.f.code}(${c.f.category}${c.f.caliber ? '/' + c.f.caliber : ''})`;
  t(`${tag} key`, hit ? hit.key : 'null', c.key);
  t(`${tag} type`, hit ? hit.reg.type : 'null', c.type);
  t(`${tag} label`, hit ? hit.reg.label : 'null', c.label);
  t(`${tag} caliber`, hit ? (hit.reg.caliber || null) : null, c.hasCal);
});

console.log('\n--- 未知类别 / 缺字段不崩 ---');
t('未知 category → null', resolveRegistry({ code: '999999', category: 'unknown' }), null);
t('缺 category → null', resolveRegistry({ code: '999999' }), null);
t('null 输入 → null', resolveRegistry(null), null);

console.log('\n--- 关键不变量 ---');
const cnHit = resolveRegistry({ code: '202015', category: 'broad' });
const usHit = resolveRegistry({ code: '016452', category: 'broad', caliber: 'us' });
t('cn / us 用同一个 type（综合分靠 caliber 分流，不靠 type）', cnHit.reg.type === usHit.reg.type, true);
t('cn / us 是不同的 builder（算法不同）', cnHit.reg.builder !== usHit.reg.builder, true);
t('cn builder 名 = buildCoreDecision', cnHit.reg.builder.name, 'buildCoreDecision');
t('us builder 名 = buildBroadGlobalDecision', usHit.reg.builder.name, 'buildBroadGlobalDecision');

console.log('\n--- 内置项补齐 ensureBuiltins（修「升级后看不到债券/现金」）---');
const fs = require('fs');
const path = require('path');
const catLib = require('../lib/categories');
const REGISTRY = require('../engines/registry').REGISTRY;

// 键排序序列化：结构比较用它，避免「键顺序不同就假红」
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
const example = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'data', 'example', 'categories.example.json'), 'utf8'));

// ① 老用户的文件：4 条展示线、没有 presets / customCategories 段
const legacy = {
  _comment: 'legacy file',
  categories: catLib.BUILTIN_CATEGORIES.slice(0, 4).map((c) => ({ key: c.key, name: c.name })),
  engines: catLib.BUILTIN_ENGINES.map((e) => ({ key: e.key, name: e.name })),
  calibers: catLib.BUILTIN_CALIBERS.map((c) => ({ key: c.key, name: c.name, note: c.note })),
};
const r1 = catLib.ensureBuiltins(legacy);
t('老文件 → changed=true', r1.changed, true);
t('老文件 → 展示线补成 6 条，顺序 = 内置序（= 环形图排布序）',
  r1.obj.categories.map((x) => x.key).join(','), 'broad,dividend,growth,cycle,bond,cash');
t('老文件 → presets 段补成 7 条', r1.obj.presets.length, 7);
t('老文件 → 补的正是展示线 bond/cash',
  r1.added.filter((a) => a.seg === 'categories').map((a) => a.key).join(','), 'bond,cash');

// ② 幂等：再跑一次必须无事可做（否则每次启动都会重写用户的配置文件）
t('幂等：复跑 changed=false', catLib.ensureBuiltins(r1.obj).changed, false);

// ③ 只增不改：用户改过的显示名 / 自建分类 / _comment / 未知段，一个字节都不许动
const mine = {
  _comment: 'user edited',
  categoryPolicy: { custom: 'keep me' },
  categories: [{ key: 'broad', name: '我的大盘' }, { key: 'custom:ab12', name: '我的医药' }],
  engines: [{ key: 'broad', name: '宽基' }],
  calibers: [],
  presets: [],
  customCategories: [{ key: 'custom:ab12', name: '我的医药', category: 'growth' }],
};
const mineBefore = canon(mine);
const r3 = catLib.ensureBuiltins(mine);
t('只增不改：改过的显示名保持「我的大盘」', r3.obj.categories[0].name, '我的大盘');
t('只增不改：自建分类仍在展示线里', r3.obj.categories.some((x) => x.key === 'custom:ab12'), true);
const custSame = canon(r3.obj.customCategories) === canon(mine.customCategories);
t('只增不改：customCategories 一字未动', custSame ? '一致' : canon(r3.obj.customCategories), '一致');
t('只增不改：_comment 保留', r3.obj._comment, 'user edited');
t('只增不改：未知段保留', canon(r3.obj.categoryPolicy), canon({ custom: 'keep me' }));
const argSame = canon(mine) === mineBefore;
t('纯函数：不修改入参', argSame ? '一致' : canon(mine) + ' ≠ ' + mineBefore, '一致');
t('只增不改：已有条目按原引用带入（未被重建）', r3.obj.categories[0] === mine.categories[0], true);

// ④ 完整文件（= 模板）不该有任何变化
t('完整文件 → changed=false', catLib.ensureBuiltins(example).changed, false);

// ⑤ 防漂移：代码常量必须与 data/example/categories.example.json 的对应段一致。
//    两处都是「内置项」的定义，一旦分叉就会出现「新装用户看得到、老用户补不到」的怪状态。
const fresh = catLib.ensureBuiltins({}).obj;
['categories', 'engines', 'calibers', 'presets'].forEach((seg) => {
  const same = canon(fresh[seg]) === canon(example[seg]);
  // 通过时只打印「一致」，不一致才把两边完整展开（这几段 JSON 很长，别刷屏）
  t('防漂移：' + seg + ' 与模板逐项一致', same ? '一致' : canon(fresh[seg]) + ' ≠ ' + canon(example[seg]), '一致');
});

// ⑥ 算法显示名必须与 REGISTRY.label 一致（否则「类别管理」里的名字和决策卡上的对不上）
catLib.BUILTIN_ENGINES.forEach((e) => {
  t('引擎名钉住 REGISTRY.label：' + e.key, e.name, REGISTRY[e.key].label);
});

// ⑦ 决策卡 title 前缀 / 时机诊断类别名 也钉住 REGISTRY.label（2026-09-21 全面正名后的防漂移）。
//    这两处是「同一类别的另一份手写显示名」，2026-09-19 的改名就漏过：registry 与类别管理是新名，
//    决策卡 title 仍是旧名，复盘页又从这个 title 里剥类别名显示 → 同一类别两套名字并存且不报错。
//    规则：title 里「决策：」之前的部分必须逐字等于对应 REGISTRY.label；
//    唯一例外是宽基 A 股口径的「(双锚)」限定词（区分海外口径，见 advice.js 内注释）。
//    其它不带「决策：」的 title（减仓信号、回撤播报等）不收进前缀表，新增时不会误红。
const adviceSrc = fs.readFileSync(path.join(__dirname, '..', 'engines', 'advice.js'), 'utf8');
const titlePrefixes = [];
adviceSrc.replace(/title:\s*`([^`]*)`/g, (all, s) => {
  const cut = s.indexOf('决策：');
  if (cut > 0) titlePrefixes.push(s.slice(0, cut).trim());
  return all;
});
const TITLE_WANT = {
  dividend: REGISTRY.dividend.label,
  growth: REGISTRY.growth.label,
  cycle: REGISTRY.cycle.label,
  'broad:us': REGISTRY['broad:us'].label,
  broad: REGISTRY.broad.label + '(双锚)',
};
Object.keys(TITLE_WANT).forEach((key) => {
  const hit = titlePrefixes.indexOf(TITLE_WANT[key]) >= 0;
  t('决策卡 title 前缀钉住 REGISTRY.label：' + key,
    hit ? '命中' : '未见「' + TITLE_WANT[key] + '」（现有前缀：' + (titlePrefixes.join('｜') || '无') + '）', '命中');
});
t('决策卡 title 共 ' + Object.keys(TITLE_WANT).length + ' 张（新增决策卡须同步登记 TITLE_WANT）',
  titlePrefixes.length, Object.keys(TITLE_WANT).length);

const timingSrc = fs.readFileSync(path.join(__dirname, '..', 'engines', 'timing.js'), 'utf8');
const catM = timingSrc.match(/const CAT_LABEL = \{([\s\S]*?)\};/);
const catLabel = {};
if (catM) catM[1].replace(/(\w+):\s*'([^']*)'/g, (all, k, v) => { catLabel[k] = v; return all; });
// CAT_LABEL 的键是「算法 type」不是 registry key：tech 与 growth 两个 type 都对应 growth 这条线
const TYPE_TO_REG = { tech: 'growth', growth: 'growth', cycle: 'cycle', dividend: 'dividend', broad: 'broad' };
Object.keys(TYPE_TO_REG).forEach((ty) => {
  t('CAT_LABEL.' + ty + ' 钉住 REGISTRY.label（' + TYPE_TO_REG[ty] + '）',
    catLabel[ty] || '（CAT_LABEL 缺 ' + ty + '）', REGISTRY[TYPE_TO_REG[ty]].label);
});

// ⑧ 畸形输入一律不抛错（用户的文件被手改坏也不能让启动挂掉）
let threw = null;
[null, undefined, [], 'x', 42, {}, { categories: 'x' }, { presets: 'x' }, { categories: [] }].forEach((bad) => {
  try { catLib.ensureBuiltins(bad); } catch (e) { threw = JSON.stringify(bad) + ' → ' + e.message; }
});
t('畸形输入不抛错', threw, null);
t('某段不是数组 → 记 skipped 且保留原值',
  catLib.ensureBuiltins({ categories: 'x' }).skipped.map((s) => s.seg).join(','), 'categories');

console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);

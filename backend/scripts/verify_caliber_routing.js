'use strict';
/*
 * 两层分类路由回归测试（离线，不联网，不依赖行情）。
 * 锁定 2026-09-12 引入的「category + caliber」两层解析：防止改 registry / util 时静默把路由搞坏。
 * 关键不变量：
 *   ① 旧数据无 caliber → broad 默认 'cn' → 命中 'broad'（与改动前逐位一致，零回归）
 *   ② broad + caliber='us' → 命中 'broad:us'（海外宽基，滚动分位 ∨ PE回撤）
 *   ③ 其他三条线（dividend/growth/cycle）不受口径维度影响
 *   ④ type 保持 'broad'（决策卡/矩阵/综合分分流靠 caliber，而非新 type）
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
const CASES = [
  { f: { code: '202015', category: 'broad' },                     key: 'broad',     type: 'broad',    label: '宽基',      hasCal: 'cn' },
  { f: { code: '016452', category: 'broad', caliber: 'us' },       key: 'broad:us',  type: 'broad',    label: '宽基·海外', hasCal: 'us' },
  { f: { code: '018966', category: 'broad', caliber: 'us' },       key: 'broad:us',  type: 'broad',    label: '宽基·海外', hasCal: 'us' },
  { f: { code: '202015', category: 'broad', caliber: 'cn' },       key: 'broad',     type: 'broad',    label: '宽基',      hasCal: 'cn' },
  { f: { code: '008163', category: 'dividend' },                   key: 'dividend',  type: 'dividend', label: '红利低波',  hasCal: null },
  { f: { code: '016664', category: 'growth' },                     key: 'growth',    type: 'tech',     label: '科技成长',  hasCal: null },
  { f: { code: '016874', category: 'growth' },                     key: 'growth',    type: 'tech',     label: '科技成长',  hasCal: null },
  { f: { code: '018391', category: 'cycle' },                      key: 'cycle',     type: 'cycle',    label: '黄金(对冲)', hasCal: null }
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

console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);

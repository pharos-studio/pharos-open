'use strict';
/*
 * 回归测试：红利(absYield)线的加仓理由完整性 + matrix 展示字段
 *   ① absYield 分支补齐「中性 + 跌破年线」加仓理由（2026-09-17 修复前该路径 reasons 为空
 *      → 界面显示「加仓」却零解释。008163 当时正落在这条通道上，是活的复现样本）
 *   ② 新增 matrix.refYield（advice.js 红利卡片文案改 absYield 口径所依赖）
 * 用打桩数据跑**真实** buildFundDecision 并断言。不联网、不读也不写任何数据文件。
 * 用法：node backend/scripts/verify_dividend_reason.js
 */
const path = require('path');
const { buildFundDecision } = require(path.join(__dirname, '..', 'engines', 'kernel'));

let pass = 0, fail = 0;
function t(name, cond, actual) {
  if (cond) { pass++; console.log('  \u2705 ' + name); }
  else { fail++; console.log('  \u274c ' + name + (actual !== undefined ? '  \u2192 \u5b9e\u9645: ' + JSON.stringify(actual) : '')); }
}

// history 是**降序**（新的在前）：computeMA 取 slice(0, d)，即最近 d 个交易日。
function mkHistory(n, newest, step) {
  const h = [];
  for (let i = 0; i < n; i++) h.push({ date: '2026-01-01', nav: +(newest + i * step).toFixed(4) });
  return h;
}
// 260 点，1.50 → ~2.02，MA250 ≈ 1.749 → devPct ≈ -14.2% ⇒ below
const histBelow = mkHistory(260, 1.5, 0.002);
// 260 点，1.90 → ~1.40，MA250 ≈ 1.751 → devPct ≈ +8.5% ⇒ above
const histAbove = mkHistory(260, 1.9, -0.002);

// 参考带：000922 参考股息率 5.00% → 便宜线 5.50% / 贵线 4.50%
const PARAMS = { cheapBy: 'absYield', cheapYield: 0.055, expensiveYield: 0.045, windowDays: 250 };

console.log('\n\u3010\u7528\u4f8b 1\u3011\u4e2d\u6027 + \u8dcc\u7834\u5e74\u7ebf \u21d2 \u52a0\u4ed3\uff0c\u7406\u7531\u5fc5\u987b\u975e\u7a7a\uff08\u672c\u6b21\u4fee\u590d\u70b9\uff09');
{
  const d = buildFundDecision({ yield: 0.050, refYield: 0.05, nav: 1.5, history: histBelow, pePercentile: null, recent20dChange: 0 }, PARAMS);
  t('action === "add"', d.action === 'add', d.action);
  t('yieldZone === "neutral"', d.matrix.yieldZone === 'neutral', d.matrix.yieldZone);
  t('maZone === "below"', d.matrix.maZone === 'below', d.matrix.maZone);
  t('\u2605 reasons \u975e\u7a7a\uff08\u4fee\u590d\u524d\u4e3a 0 \u6761\uff09', d.reasons.length > 0, d.reasons);
  t('\u7406\u7531\u542b\u300c\u8dcc\u7834 250 \u65e5\u7ebf\u300d', d.reasons.some(r => r.indexOf('\u8dcc\u7834 250 \u65e5\u7ebf') >= 0), d.reasons);
  t('\u7406\u7531\u542b\u300c\u8d8b\u52bf\u786e\u8ba4\u901a\u9053\u52a0\u4ed3\u300d', d.reasons.some(r => r.indexOf('\u8d8b\u52bf\u786e\u8ba4\u901a\u9053\u52a0\u4ed3') >= 0), d.reasons);
  t('\u7406\u7531\u7ed9\u51fa\u8ddd\u4fbf\u5b9c\u7ebf\u8fd8\u5dee 0.50pp\uff08\u53c2\u8003\u5e26 5.50% \u2212 \u73b0\u503c 5.00%\uff09', d.reasons.some(r => r.indexOf('\u8ddd\u4fbf\u5b9c\u7ebf\u8fd8\u5dee 0.50pp') >= 0), d.reasons);
  t('\u7406\u7531\u4e0d\u91cd\u590d\u62a5\u53c2\u8003\u5e26\uff08\u907f\u514d\u4e0e\u6458\u8981\u91cd\u590d\uff09', !d.reasons.some(r => r.indexOf('4.50~5.50%') >= 0), d.reasons);
  t('matrix.refYield === 0.05\uff08\u65b0\u589e\u5b57\u6bb5\uff09', d.matrix.refYield === 0.05, d.matrix.refYield);
  t('matrix.cheapYield === 0.055', d.matrix.cheapYield === 0.055, d.matrix.cheapYield);
  t('matrix.expensiveYield === 0.045', d.matrix.expensiveYield === 0.045, d.matrix.expensiveYield);
  console.log('    \u2192 detail \u6bb5: ' + d.reasons.join('\uff1b'));
}

console.log('\n\u3010\u7528\u4f8b 2\u3011\u4fbf\u5b9c \u21d2 \u52a0\u4ed3\uff0c\u65e7\u7406\u7531\u4e0d\u53d7\u5f71\u54cd\uff08\u56de\u5f52\u9a8c\u8bc1\uff0c\u9632\u6539\u5d29\uff09');
{
  const d = buildFundDecision({ yield: 0.060, refYield: 0.05, nav: 1.5, history: histBelow, pePercentile: null, recent20dChange: 0 }, PARAMS);
  t('action === "add"', d.action === 'add', d.action);
  t('yieldZone === "cheap"', d.matrix.yieldZone === 'cheap', d.matrix.yieldZone);
  t('\u7406\u7531\u6070\u597d 1 \u6761\uff08\u4e0d\u4f1a\u4e24\u6761\u90fd push\uff09', d.reasons.length === 1, d.reasons);
  t('\u7406\u7531\u542b\u300c\u9ad8\u4e8e\u4fbf\u5b9c\u7ebf\u300d', d.reasons.some(r => r.indexOf('\u9ad8\u4e8e\u4fbf\u5b9c\u7ebf') >= 0), d.reasons);
}

console.log('\n\u3010\u7528\u4f8b 3\u3011\u4e2d\u6027 + \u5e74\u7ebf\u4e0a\u65b9 \u21d2 \u4e0d\u52a8\uff0c\u65b0\u589e\u5206\u652f\u4e0d\u5f97\u8bef\u89e6\u53d1');
{
  const d = buildFundDecision({ yield: 0.050, refYield: 0.05, nav: 1.9, history: histAbove, pePercentile: null, recent20dChange: 0 }, PARAMS);
  t('maZone === "above"', d.matrix.maZone === 'above', d.matrix.maZone);
  t('action === "hold"', d.action === 'hold', d.action);
  t('\u7406\u7531\u4e0d\u542b\u300c\u8d8b\u52bf\u786e\u8ba4\u901a\u9053\u52a0\u4ed3\u300d', !d.reasons.some(r => r.indexOf('\u8d8b\u52bf\u786e\u8ba4\u901a\u9053\u52a0\u4ed3') >= 0), d.reasons);
}

console.log('\n\u3010\u7528\u4f8b 4\u3011\u8d35 \u21d2 \u4e0d\u52a8');
{
  const d = buildFundDecision({ yield: 0.040, refYield: 0.05, nav: 1.9, history: histAbove, pePercentile: null, recent20dChange: 0 }, PARAMS);
  t('yieldZone === "expensive"', d.matrix.yieldZone === 'expensive', d.matrix.yieldZone);
  t('action === "hold"', d.action === 'hold', d.action);
}

console.log('\n\u3010\u7528\u4f8b 5\u3011refYield \u7f3a\u5931 \u21d2 refYield \u4e3a null\uff0c\u4e0d\u5f97\u62a5\u9519');
{
  const d = buildFundDecision({ yield: 0.050, refYield: null, nav: 1.5, history: histBelow, pePercentile: null, recent20dChange: 0 }, PARAMS);
  t('matrix.refYield === null', d.matrix.refYield === null, d.matrix.refYield);
  t('\u65e0\u5f02\u5e38\u8fd4\u56de', d.action === 'add' || d.action === 'hold', d.action);
}

console.log('\n\u3010\u7528\u4f8b 6\u3011history \u4e0d\u8db3 250 \u21d2 \u5e74\u7ebf\u4e0d\u5f97\u5192\u5145\uff08\u56de\u5f52\uff09');
{
  const d = buildFundDecision({ yield: 0.050, refYield: 0.05, nav: 1.5, history: mkHistory(100, 1.5, 0.002), pePercentile: null, recent20dChange: 0 }, PARAMS);
  t('maZone === "na"', d.matrix.maZone === 'na', d.matrix.maZone);
  t('action === "hold"', d.action === 'hold', d.action);
}

console.log('\n\u2500\u2500 \u7ed3\u679c: ' + pass + ' \u901a\u8fc7 / ' + fail + ' \u5931\u8d25 \u2500\u2500');
process.exit(fail ? 1 : 0);

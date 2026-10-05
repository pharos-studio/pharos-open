'use strict';
// Pure V/M/composite scoring. No strategy routing or configuration reads.
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const square = (p) => p * p * 100;
// 「相对尺」归一化（方案 A，2026-09-09）：把连续估值指标 x 映射到它自己的「贵线→便宜线」区间。
// 到 cheap 端 = 1（满分），到 expensive 端 = 0；两端谁大谁小由调用方按"越大越便宜 / 越小越便宜"自行传入，
// 故 span 可为负（红利股息率、ERP 都是"越大越便宜"）；span=0 或数据缺失 → null（交给兜底/降级）。
function relScale(x, cheap, expensive) {
  if (x == null || isNaN(x) || cheap == null || expensive == null || isNaN(cheap) || isNaN(expensive)) return null;
  const span = expensive - cheap;
  if (span === 0) return null;
  return clamp((expensive - x) / span, 0, 1);
}

// 主锚 + 副锚加权；任一缺失则降级为单锚直用（不打折权重），四线统一
function blend(main, sub, wMain) {
  if (main != null && sub != null) return main * wMain + sub * (1 - wMain);
  return main != null ? main : sub;
}

// 由 L2 决策结果(dec.matrix) 合成 0~100「基金综合分」= wV×V + wM×M（市场信号，零成本依赖）
// cheapBy ∈ 'tech' | 'broad' | 'cycle' | 'dividend'，由 registry 的 reg.type 传入
// caliber：仅 broad 使用（'cn' 走 A 股带 / 'us' 走海外带），由 registry 的 reg.caliber 传入
// ---------- 2026-09-14：位置分重构 —— 拆成「估值分 V」+「动量分 M」+「综合分」----------
// 背景：旧位置分把动量当**二值补丁**（金叉 +0.1 / 未止跌 ×0.3）贴在估值核上 → 看不出强弱、也说不清两派贡献。
// 设计：
//   ① V（均值回归派）：估值核 + wDip × dipBonus（★「跌破均线」= 超跌 = 更便宜，留在 V 加分，不进 M，避免语义翻转）
//   ② M（动量派）：金叉强度 / 止跌强度 / 趋势偏离 —— 全部由**二值改连续**
//   ③ 综合分 = wV×V + wM×M；硬约束（总闸 / 暂停申购）**一票否决 → 0**（不参与加权）
// ★ add/hold 判定逻辑在独立策略侧，本文件只负责评分。

// 已得因子间重新归一权重；全缺失返回 null（绝不返回 0，避免「没数据」伪装成「没动量」）
function wavg(pairs) {
  let s = 0, sw = 0;
  for (const pr of pairs) {
    const v = pr[0], w = pr[1];
    if (v != null && !isNaN(v) && w > 0) { s += v * w; sw += w; }
  }
  return sw > 0 ? s / sw : null;
}

// 线 → 配置键（broad 按 caliber 分 cn / us）
function lineKey(cheapBy, caliber) {
  if (cheapBy === 'broad') return caliber === 'us' ? 'broadUS' : 'broad';
  return cheapBy; // tech / cycle / dividend
}

// 「跌破均线」的超跌确认（连续化）：跌得越深越接近 1；站上均线 → 0
// ★语义：跌破 = 超跌 = 更便宜 → **加分**（与旧的「跌破 → +0.1」同向，绝不翻转）
function dipBonusOf(m, AC, cheapBy) {
  const MC = AC.composite.momentum;
  const dFull = (cheapBy === 'dividend') ? MC.divDipFullPct : MC.dipFullPct;
  const dev = (cheapBy === 'dividend') ? m.devPct : m.ma120DevPct;
  if (dev == null || isNaN(dev)) return null;
  return relScale(-dev, dFull, 0); // −dev 越大（跌得越深）→ 越接近 1
}

// ---- V：估值分（均值回归派，0~100）----
// 缺失 → null（由综合层用中性 25 兜底并打 degraded 标记，不让「数据缺失」伪装成「中性便宜」）
function synthesizeValueScore(dec, AC, cheapBy, caliber) {
  const m = (dec && dec.matrix) || {};
  const wDip = AC.composite.wDip;
  let v = null;
  if (cheapBy === 'tech') {
    // 原式保留（0.7×回撤 + 0.3×价格分位），**只去掉**金叉 +0.1 与未止跌 ×0.3 两个二值补丁
    const fullPct = AC.tech.fullPct;
    const ddP = (m.drawdown != null) ? clamp(-m.drawdown / fullPct, 0, 1) : null;
    const valP = (m.pricePercentile != null) ? clamp((100 - m.pricePercentile) / 100, 0, 1) : null;
    v = (ddP != null && valP != null) ? (0.7 * ddP + 0.3 * valP) : (ddP != null ? ddP : valP);
    // 科技线不加 dipBonus：其「跌」已由回撤 ddP 表达，避免重复计算
  } else {
    let base = null;
    if (cheapBy === 'broad') {
      const isUS = caliber === 'us';
      const B = isUS ? AC.broadUS : AC.broad;
      const main = relScale(isUS ? m.peRollingPct : m.pePercentile, B.cheapPct, B.expensivePct);
      const sub = relScale(m.erp != null ? m.erp * 100 : null, B.erpHigh, B.erpLow);
      base = (main != null) ? blend(main, sub, B.wMain) : null; // ★主锚缺失不降级副锚
    } else if (cheapBy === 'cycle') {
      base = relScale(m.pricePercentile, AC.gold.cheapPct, AC.gold.expensivePct);
    } else if (cheapBy === 'dividend') {
      base = relScale(m.yield, m.cheapYield, m.expensiveYield);
    }
    if (base == null) return null;
    const db = dipBonusOf(m, AC, cheapBy);
    v = clamp(base + wDip * (db != null ? db : 0), 0, 1);
  }
  if (v == null) return null;
  return square(clamp(v, 0, 1));
}

// ---- M：动量分（动量派，0~100）★核心：所有因子已由二值改连续 ----
function synthesizeMomentumScore(dec, AC, cheapBy, caliber) {
  const m = (dec && dec.matrix) || {};
  const MC = AC.composite.momentum;
  const MW = AC.composite.momentumWeights[lineKey(cheapBy, caliber)] || {};
  const cross = relScale(m.maSpreadPct, MC.crossFullPct, MC.crossZeroPct);   // 金叉强度
  const stop = relScale(m.stopRisePct, MC.stopRiseFullPct, 0);               // 止跌强度（单侧：≤0 → 0，不倒扣）
  const trend = relScale(cheapBy === 'dividend' ? m.devPct : m.ma120DevPct,
    cheapBy === 'dividend' ? MC.divDevFullPct : MC.trendDevFullPct,
    cheapBy === 'dividend' ? -MC.divDevFullPct : -MC.trendDevFullPct);       // 趋势强弱
  const mRaw = wavg([[cross, MW.cross], [stop, MW.stopRise], [trend, MW.trend]]);
  return mRaw == null ? null : square(clamp(mRaw, 0, 1));
}

// ---- 综合分：wV×V + wM×M，硬约束一票否决 ----
function synthesizeCompositeScore(dec, AC, cheapBy, caliber, opts) {
  const m = (dec && dec.matrix) || {};
  const out = { composite: null, valueScore: null, momentumScore: null, weights: null, blocked: null, degraded: [] };
  const V = synthesizeValueScore(dec, AC, cheapBy, caliber);
  const M = synthesizeMomentumScore(dec, AC, cheapBy, caliber);
  const W = AC.composite.weights[lineKey(cheapBy, caliber)] || { wV: 1, wM: 0 };
  const N = square(AC.neutralP); // 25（中性锚）
  out.valueScore = V; out.momentumScore = M; out.weights = W;
  if (V == null) out.degraded.push('V');
  if (M == null) out.degraded.push('M');
  out.composite = W.wV * (V == null ? N : V) + W.wM * (M == null ? N : M);
  // 硬约束：一票否决（不参与加权）
  if (m.gate === 'block' && AC.composite.hardBlock.gate !== false) { out.blocked = 'gate'; out.composite = 0; }
  else if (opts && opts.suspended && AC.composite.hardBlock.suspended !== false) { out.blocked = 'suspended'; out.composite = 0; }
  return out;
}

// ---- 兼容入口：对外语义 = 综合分（0~100）----
function synthesizePositionScore(dec, AC, cheapBy, caliber, opts) {
  return synthesizeCompositeScore(dec, AC, cheapBy, caliber, opts).composite;
}

// ---- 综合分展示标签 ----
function compositeLabelOf(c) {
  if (!c) return null;
  if (c.blocked === 'gate') return 'PE总闸拦截';
  if (c.blocked === 'suspended') return '暂停申购';
  if (c.degraded && c.degraded.length) return '部分维度缺失·按中性计';
  return null;
}


// 由 L2 决策结果派生前端展示 label
function synthesizePositionLabel(dec) {
  const m = (dec && dec.matrix) || {};
  if (m.gate === 'block') return 'PE总闸拦截';
  return (dec && dec.action === 'add') ? 'L2已确认加仓' : 'L2未确认加仓(不动)';
}


module.exports = { synthesizePositionScore, synthesizeValueScore, synthesizeMomentumScore, synthesizeCompositeScore, compositeLabelOf, synthesizePositionLabel, relScale, wavg };

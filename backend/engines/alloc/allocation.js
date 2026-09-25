'use strict';
/*
 * 综合分信号引擎（原「分配引擎」已于 2026-09-08 清理）。
 * computeAllocation 是决策内核 registry→strategies→kernel.buildFundDecision 的下游消费者：
 *   - 把每只基金的 L2 决策结果(dec.matrix) 合成为 0~100「基金综合分」(scoreMap)；
 *   - 给传入的 funds 数组挂 _dec / _marketScore 副作用，供 advice.js 决策卡复用（同源、零漂移）。
 * 纯市场信号（回撤/估值分位/趋势），不读任何买入成本，不依赖网络 I/O。
 * 2026-09-09 方案 A「相对尺」：broad/cycle/dividend 三线由离散三档(0/0.5/1)改为连续归一化
 *   relScale(x, cheap, expensive)（科技线 V 保留原式）。综合分 = wV×V(便宜度) + wM×M(动能)，
 *   与决策层「现在能不能买」是两层，二者允许背离（如金叉 add 但分数低）。
 * 分配金额机制（byFund/byCategory/invest/surplus/excluded/monthlyBudget）已全部移除，
 * 引擎只产出综合分信号，金额建议由用户自定（不强制）。
 */
const config = require('../../lib/config');
const util = require('../../lib/util');
const { resolveRegistry, isPendingCategory } = require('../registry');

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const square = (p) => p * p * 100;

// 综合分配置（读取 config.signals.allocation；归一化带与策略文件同源读 config.signals.broad / gold，防口径漂移）
function getAllocCfg() {
  const cfg = config.getConfig();
  const a = (cfg && cfg.signals && cfg.signals.allocation) || {};
  const s = (cfg && cfg.signals) || {};
  const t = a.tech || {};
  const b = s.broad || {};
  const g = s.gold || {};
  const ab = a.broad || {};
  const bg = s.broadGlobal || {};       // 宽基·海外（caliber=us）决策层参数带（同源，防漂移）
  const abg = a.broadGlobal || {};
  return {
    capPct: a.capPct != null ? a.capPct : 0.10,
    anchorMode: a.anchorMode === 'last' ? 'last' : 'avg',
    neutralP: a.neutralP != null ? a.neutralP : 0.5,
    tech: {
      fullPct: t.fullPct != null ? t.fullPct : 30,
      confirmDiscount: t.confirmDiscount != null ? t.confirmDiscount : 0.3,
      dipWindow: t.dipWindow != null ? t.dipWindow : 60,
      stopWindow: t.stopWindow != null ? t.stopWindow : 20
    },
    dividend: {
      lo: (a.dividend && a.dividend.lo != null) ? a.dividend.lo : 0.8,
      span: (a.dividend && a.dividend.span != null) ? a.dividend.span : 0.4
    },
    // 方案 A「相对尺」归一化带（2026-09-09）：综合分直接读连续原始量，在「贵线→便宜线」之间归一化
    broad: {
      cheapPct: b.cheapPct != null ? b.cheapPct : 25,
      expensivePct: b.expensivePct != null ? b.expensivePct : 80,
      erpHigh: b.erpHigh != null ? b.erpHigh : 6.9,         // 与 kernel.js 同款默认值（2026-09-09 校准）
      erpLow: b.erpLow != null ? b.erpLow : 5.3,
      wMain: ab.wMain != null ? ab.wMain : 0.7   // 主锚(PE分位)权重，副锚(ERP)为 1−wMain
    },
    // 宽基·海外（caliber=us）独立参数带（2026-09-12）：读决策层同款带 signals.broadGlobal，防口径漂移。
    // ★绝不能沿用 A 股的 erpHigh/erpLow=6.9/5.3：美股 ERP 结构性为负（当前约 −1.6%），套用会把副锚恒压成 0。
    // ★主锚喂的是 matrix.peRollingPct（自算滚动分位），不是 matrix.pePercentile（蛋卷固定约10年分位）。
    broadUS: {
      cheapPct: bg.cheapPct != null ? bg.cheapPct : 25,
      expensivePct: bg.expensivePct != null ? bg.expensivePct : 80,
      erpHigh: bg.erpHigh != null ? bg.erpHigh : null,      // null → 副锚自动关闭（单锚降级）
      erpLow: bg.erpLow != null ? bg.erpLow : null,
      wMain: abg.wMain != null ? abg.wMain : 0.7
    },
    gold: {
      cheapPct: g.cheapPct != null ? g.cheapPct : 35,
      expensivePct: g.expensivePct != null ? g.expensivePct : 75
    },
    // 2026-09-14 综合分（V/M 按派别加权）；全部走 config，禁止硬编码（尺度参数须由回测标定）
    composite: {
      hardBlock: {
        gate: (a.composite && a.composite.hardBlock && a.composite.hardBlock.gate === false) ? false : true,
        suspended: (a.composite && a.composite.hardBlock && a.composite.hardBlock.suspended === false) ? false : true
      },
      wDip: (a.composite && a.composite.wDip != null) ? a.composite.wDip : 0.1,
      weights: (a.composite && a.composite.weights) || {
        dividend: { wV: 0.9, wM: 0.1 }, broad: { wV: 0.8, wM: 0.2 },
        broadUS: { wV: 0.8, wM: 0.2 }, cycle: { wV: 0.6, wM: 0.4 }, tech: { wV: 0.5, wM: 0.5 }
      },
      momentumWeights: (a.composite && a.composite.momentumWeights) || {
        tech: { cross: 0.6, stopRise: 0.4, trend: 0 }, broadcast: null,
        broad: { cross: 0, stopRise: 0.5, trend: 0.5 },
        broadUS: { cross: 0, stopRise: 0.5, trend: 0.5 },
        cycle: { cross: 0, stopRise: 0.5, trend: 0.5 },
        dividend: { cross: 0, stopRise: 0, trend: 1 }
      },
      momentum: {
        crossFullPct: numCfg(a.composite, 'crossFullPct', 5),
        crossZeroPct: numCfg(a.composite, 'crossZeroPct', -5),
        stopRiseFullPct: numCfg(a.composite, 'stopRiseFullPct', 3),
        trendDevFullPct: numCfg(a.composite, 'trendDevFullPct', 10),
        divDevFullPct: numCfg(a.composite, 'divDevFullPct', 8),
        dipFullPct: numCfg(a.composite, 'dipFullPct', 10),
        divDipFullPct: numCfg(a.composite, 'divDipFullPct', 3)
      }
    }
  };
}

// 读 config.signals.allocation.composite.momentum 下的数值参数（缺失用默认，避免硬编码）
function numCfg(cp, key, dflt) {
  const mv = (cp && cp.momentum) || {};
  return mv[key] != null ? mv[key] : dflt;
}

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
// ★ add/hold 判定逻辑完全不动（在 kernel 侧），本文件只负责评分。

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

function purchaseStatusMeta(f, now) {
  const s = f && f.purchaseStatus;
  const ts = now == null ? Date.now() : Number(now);
  const fresh = !!(s && s.updatedAt && ts - Number(s.updatedAt) < 24 * 3600 * 1000);
  const state = s && s.state || 'unknown';
  return { state, fresh, suspended: fresh && state === 'suspended', unavailable: !fresh || state === 'unknown' };
}

function purchaseDecision(marketVerdict, ps, userLimit) {
  const blocked = !!(ps && (ps.suspended || ps.unavailable)) || (userLimit != null && userLimit <= 0);
  return {
    blocked,
    verdict: blocked ? 'hold' : marketVerdict,
    executable: !blocked && marketVerdict === 'add',
  };
}

// 综合分信号入口：挂载 _dec/_marketScore 副作用 + 返回 scoreMap（唯一活输出）。
// 参数保持原签名（allocation/analysis 调用处不变）；totalValue/monthlyBudget 已无用途，保留形参不破坏调用方。
function computeAllocation(allocation, policy, funds, totalValue, monthlyBudget, valuationMap, dailyLimits) {
  allocation = Array.isArray(allocation) ? allocation : [];
  funds = Array.isArray(funds) ? funds : [];
  dailyLimits = dailyLimits || null;
  const AC = getAllocCfg();

  // 1) 真实市场分 + 决策副作用（给 funds 挂 _dec / _marketScore，advice.js 决策卡复用，同源零漂移）
  funds.forEach(f => {
    const hit = resolveRegistry(f);
    if (!hit) {
      // ★ 无算法的类别（待建设 / 未归类）：不能只是"清空分数"就完事。
      //   旧实现在下方 scoreMap 循环里遇到 `_marketScore == null` 就 return，
      //   于是这类基金**连 scoreMap 条目都没有** —— 前端连"待建设"都显示不出来，
      //   表现就是"这只基金在看板上凭空少了一截"（决策页整只消失、配置页丢市值）。
      //   现在打个显式标记，由下方 scoreMap 产出一条 unsupported 记录。
      const pending = isPendingCategory(f.category);
      f._marketScore = null; f._dec = null;
      f._unsupported = { pending, reason: pending ? 'pending' : 'unknown' };
      return;
    }
    f._unsupported = null;
    const dec = hit.reg.builder(f, valuationMap, config.getConfig());
    f._dec = dec;
    const lim0 = (dailyLimits && dailyLimits[f.code] != null) ? dailyLimits[f.code] : null;
    const ps = purchaseStatusMeta(f);
    f._purchaseStatusMeta = ps;
    f._composite = synthesizeCompositeScore(dec, AC, hit.reg.type, hit.reg.caliber, { suspended: ps.suspended || (lim0 != null && lim0 <= 0) });
    f._marketScore = f._composite.composite; // 语义变更：位置分 → 综合分（0~100）
  });

  // 2) eligible：policy=buy 且未暂停申购（仅 scoreMap.eligible 标注用，与分配无关）
  const eligible = funds.filter(f => {
    const b = util.engineCategoryToBucket(f.category);
    if ((policy[b] || 'buy') !== 'buy') return false;
    if (dailyLimits && dailyLimits[f.code] != null && dailyLimits[f.code] <= 0) return false;
    const ps = f._purchaseStatusMeta || purchaseStatusMeta(f);
    if (ps.suspended || ps.unavailable) return false;
    return true;
  });

  // 3) 综合分信号（前端决策页/复盘页兜底，唯一活输出）
  const scoreMap = {};
  funds.forEach(f => {
    if (f._marketScore == null || !f._dec) {
      // 待建设 / 未归类：仍产出一条记录，让前端能显示状态而不是"什么都没有"
      if (f._unsupported) {
        scoreMap[f.code] = {
          code: f.code, name: f.name,
          marketScore: null, valueScore: null, momentumScore: null,
          compositeLabel: f._unsupported.pending ? '待建设' : '未归类',
          weights: null, degraded: [],
          positionLabel: null,
          eligible: false, suspended: false,
          unsupported: true, unsupportedReason: f._unsupported.reason
        };
      }
      return;
    }
    const lim = (dailyLimits && dailyLimits[f.code] != null) ? dailyLimits[f.code] : null;
    const c = f._composite || {};
    const ps = f._purchaseStatusMeta || purchaseStatusMeta(f);
    const marketVerdict = f._dec.action === 'add' ? 'add' : 'hold';
    const decision = purchaseDecision(marketVerdict, ps, lim);
    scoreMap[f.code] = {
      code: f.code, name: f.name,
      marketScore: +f._marketScore.toFixed(1),                                   // = 综合分
      valueScore: c.valueScore == null ? null : +c.valueScore.toFixed(1),       // V 估值分
      momentumScore: c.momentumScore == null ? null : +c.momentumScore.toFixed(1), // M 动量分
      compositeLabel: compositeLabelOf(c),
      weights: c.weights || null,                                               // { wV, wM }
      degraded: c.degraded || [],                                               // ['V'] / ['M'] / ['V','M']
      positionLabel: synthesizePositionLabel(f._dec),
      eligible: eligible.includes(f),
      suspended: ps.suspended || (lim != null && lim <= 0),
      purchaseStatus: f.purchaseStatus || null,
      statusFresh: ps.fresh,
      marketVerdict,
      verdict: decision.verdict,
      executable: decision.executable
    };
  });
  return { scoreMap };
}

// 导出 synthesizePositionScore / relScale 供纯函数断言脚本（验证 0）直接调用，改综合分口径时可脱离网络单测。
// ---- 冻结的旧位置分逻辑（2026-09-14 前）----
// 用途：backtest_tech_stopfall.js §⑩「位置分口径撕裂表」是待办清单 §5 的历史证据，依赖旧的 ×0.3 语义。
// ⚠ 冻结于此，仅供回测脚本复现，**禁止在生产链路调用**；待办 §5 结案后可删。
function legacyPositionScore(dec, AC, cheapBy, caliber) {
  const m = (dec && dec.matrix) || {};
  if (m.gate === 'block') return 0;            // PE 总闸硬安全阀
  const by = cheapBy || 'tech';
  const neutralP = (AC && AC.neutralP != null) ? AC.neutralP : 0.5;
  let p = null;
  if (by === 'tech') {
    const fullPct = (AC && AC.tech && AC.tech.fullPct) || 30;
    const ddP = (m.drawdown != null) ? clamp(-m.drawdown / fullPct, 0, 1) : null;
    const valP = (m.pricePercentile != null) ? clamp((100 - m.pricePercentile) / 100, 0, 1) : null; // 已含 PE 优先/价格分位降级
    p = (ddP != null && valP != null) ? (0.7 * ddP + 0.3 * valP)
      : (ddP != null ? ddP : valP);
    if (p != null) {                                                        // 仅在 p 有值时做趋势调整，避免 null 被 coerce 成 0
      if (m.goldenState === true) p = clamp(p + 0.1, 0, 1);                 // 金叉加成
      if (m.stopFall !== true) p = p * ((AC && AC.tech && AC.tech.confirmDiscount) || 0.3); // 未止跌折扣
    }
  } else if (by === 'broad') {
    // 方案 A（2026-09-09）：连续「相对尺」，主锚 PE 分位(25/80) + 副锚 ERP(5.3/6.9)。
    // ★量纲：matrix.erp 是小数（0.0607 = 6.07%），而 config 的 erpHigh/erpLow 是百分数 → 必须 *100 再入尺。
    //   漏乘会把 6.07% 当 0.0607 送进「越大越便宜」的尺，直接 clamp 成 0 分（P0，实测 8.2 → 2.0）。
    // ★主锚缺失不降级给副锚：pe 与 pePercentile 在 fetchers 里成对产生/丢失，若主锚没了只剩 ERP 单锚，
    //   会把「估值数据缺失」误读成「ERP 很便宜 → 100 分」，语义错误。故 main==null → p=null（25 分兜底）。
    //
    // 口径分流（2026-09-12，caliber='us' 为宽基·海外）：
    //   - 主锚数据源不同：cn 用 matrix.pePercentile（蛋卷/乐咕当期分位）；us 用 matrix.peRollingPct（自算滚动分位）
    //   - 阈值带不同：cn 读 signals.broad（ERP 6.9/5.3 中债口径）；us 读 signals.broadGlobal（ERP +2.1/−1.5 美债口径）
    //   ★两者绝不能互相借用：美股 ERP 结构性为负，套 A 股 6.9/5.3 会把副锚恒压成 0（位置分硬顶，见 plans §8.5/§8.6）
    const isUS = caliber === 'us';
    const B = (isUS ? (AC && AC.broadUS) : (AC && AC.broad)) || {};
    const main = relScale(isUS ? m.peRollingPct : m.pePercentile, B.cheapPct, B.expensivePct);
    const sub = relScale(m.erp != null ? m.erp * 100 : null, B.erpHigh, B.erpLow);
    p = (main != null) ? blend(main, sub, B.wMain) : null;
    if (p != null && m.trendWeak === true && m.stopFall === true) p = clamp(p + 0.1, 0, 1);
    // 注：通道②（PE 回撤 cheapByDip）**不额外加分**。理由：① 它与主锚同源于 PE，回撤发生时滚动分位本身已下降，
    //   再加成属重复计算；② 位置分回答「便不便宜」、action 回答「能不能买」，两层允许背离是本项目既定设计
    //   （科技线「金叉 add 却只有 11.4 分」即同款）。故回撤只做触发，不进分数。
  } else if (by === 'cycle') {
    const G = (AC && AC.gold) || {};                                     // gold = cycle 线参数（35/75）
    p = relScale(m.pricePercentile, G.cheapPct, G.expensivePct);
    if (p != null && m.trendWeak === true && m.stopFall === true) p = clamp(p + 0.1, 0, 1);
  } else if (by === 'dividend') {
    // span 为负：股息率「越大越便宜」，廉价线是高位（cheapYield > expensiveYield）
    p = relScale(m.yield, m.cheapYield, m.expensiveYield);
    // 跌破年线确认（kernel.js absYield 分支通道②：股息率中性 + below → add）
    // 注：旧代码限 yieldZone==='neutral' 才加；连续化后无法再用离散 zone 判定，放宽为「只看 below」。
    // 影响面：仅贵档（原 0 分）会变成 1 分 → 平方后 1 分，≤1 分，已评估接受。
    if (p != null && m.maZone === 'below') p = clamp(p + 0.1, 0, 1);
  }
  if (p == null) return square(neutralP);      // 无数据兜底 25 分
  return square(clamp(p, 0, 1));               // 沿用平方加速 p²×100
}

module.exports = { computeAllocation, synthesizePositionScore, synthesizeValueScore, synthesizeMomentumScore, synthesizeCompositeScore, legacyPositionScore, compositeLabelOf, relScale, wavg, purchaseStatusMeta, purchaseDecision };

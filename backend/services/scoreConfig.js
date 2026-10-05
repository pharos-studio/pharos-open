'use strict';
// Configuration normalization, no cached/global configuration.
function getAllocCfg(cfg) {
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
      erpHigh: b.erpHigh != null ? b.erpHigh : 6.9,         // 保留原默认值（2026-09-09 校准）
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

function numCfg(cp, key, dflt) {
  const mv = (cp && cp.momentum) || {};
  return mv[key] != null ? mv[key] : dflt;
}


module.exports = { getAllocCfg };

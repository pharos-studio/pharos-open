'use strict';
/*
 * 策略：商品 / 对冲（cycle）
 * 适用范围：**任何商品类基金**（黄金、白银、原油、豆粕…）。本线只看基金自身净值的
 *   250 日价格分位与三重均线，**不依赖任何指数估值锚**，所以并不绑黄金这一种标的。
 * 指标、限制、矩阵与理由由本策略完整负责；配置由调用方传入。
 */
// Strategy-local matrix and reasons; no compatibility-kernel dependency.
const util = require('../../lib/util');

// cycle 类（黄金/对冲）信号线：价格分位(便宜/贵) × 三重均线位置(跌破MA120=趋势弱) × 急涨总闸 × 止跌确认 → 本策略矩阵
// 纯价格纪律，与仓位/资金解耦；金额由用户决定。不读舆论/新闻，只看客观价格证据。
function buildGoldDecision(fund, valuationMap, config) {
  if(require('../../lib/goldIdentity').isGoldRoute(fund))return require('./goldDual')(fund);
  const g = (config && config.signals && config.signals.gold) || {};
  const v = (valuationMap && valuationMap[fund.code]) || (fund && fund.valuation) || {};
  const hist = (fund && fund.history) || [];
  const nav = fund && fund.latestNav != null ? fund.latestNav : (hist[0] ? hist[0].nav : null);
  const stopWindow = g.stopWindow || 20;
  const cheapPct = g.cheapPct != null ? g.cheapPct : 35;
  const expensivePct = g.expensivePct != null ? g.expensivePct : 75;

  // ① 250日价格分位（与估值链口径一致；history 最新在前）
  let pricePercentile = null;
  if (hist.length >= 60) pricePercentile = util.percentileOf(hist.slice(0, 250));
  if (pricePercentile == null && v.pricePercentile != null) pricePercentile = v.pricePercentile;

  // ② 三重均线位置（MA60/120/250 = 季/半年/年，三个时间尺度）
  const mas = [60, 120, 250].map(w => util.computeMA(hist, w));
  let trendWeak = null;
  let trendGrade = null;
  if (mas[1] != null && nav != null) {
    trendWeak = nav < mas[1]; // 跌破半年线 = 中线下（可行动门槛）
    if (mas[0] != null && mas[2] != null) {
      if (nav < mas[0] && nav < mas[1] && nav < mas[2]) trendGrade = '全下(强降)';
      else if (nav > mas[0] && nav > mas[1] && nav > mas[2]) trendGrade = '全上(强升)';
      else trendGrade = '混杂';
    }
  }

  // ③ 急涨：近20日涨幅（传 recent20dChange，由引擎按 surge20dPct 判总闸）
  const recent20dChange = v.recent20dChange != null ? v.recent20dChange : util.recentChangePct(hist, 20);

  // ④ 止跌：近 stopWindow 日最低 > 前 stopWindow 日最低（下跌动能衰竭）
  const navs = hist.map(h => h.nav).filter(n => !isNaN(n) && n > 0);
  let stopFall = false;
  if (navs.length >= stopWindow * 2) {
    const near = navs.slice(0, stopWindow);
    const prev = navs.slice(stopWindow, stopWindow * 2);
    stopFall = Math.min.apply(null, near) > Math.min.apply(null, prev);
  }
  // ★2026-09-14 新增：动量因子的连续化（只算不判，仅供评分层动量分 M 使用，不参与任何 add/hold 判定）
  //   把二值的 stopFall 变成「低点抬高幅度%」，与 stableLow 同窗口同方向（> 0 ⟺ stableLow === true）
  const stopRisePct = util.lowRaisePct(hist, stopWindow);
  // 趋势强弱：现价相对 MA120 的偏离%（0 分界 = trendWeak 的临界点）
  const ma120DevPct = util.maDevPct(hist, 120, nav);

  return buildSignalDecision({
    pricePercentile,
    nav,
    recent20dChange,
    trendWeak,
    stopFall,
    trendGrade,
    stopRisePct,                                  // ★新增（连续化，仅供 M）
    ma120DevPct                                   // ★新增（连续化，仅供 M）
  }, {
    cheapBy: 'pricePercentile',
    cheapPct,
    expensivePct,
    surge20dPct: g.surge20dPct != null ? g.surge20dPct : 7,
    stopWindow
  });
}

module.exports = buildGoldDecision;


// Low-level legacy signal contract, owned by this strategy.
function buildSignalDecision(signalSource, params) {
  if(require('../../lib/goldIdentity').isGoldRoute(signalSource))return require('./goldDual')(signalSource);
  const p = params || {};
  const cheapRatio = p.cheapRatio != null ? p.cheapRatio : 1.05;
  const expensiveRatio = p.expensiveRatio != null ? p.expensiveRatio : 0.90;
  const peGatePct = p.peGatePct != null ? p.peGatePct : 85;
  const surge20dPct = p.surge20dPct != null ? p.surge20dPct : 5;
  const s = signalSource || {};
  const reasons = [];
  const matrix = {};

  // ① 本策略的位置判断；兼容矩阵的其他字段保留原默认值
  let yieldZone = 'na';
  let ratio = null;
  let dipReady = false; // 科技专用：回撤到位+止跌
  let pctZone = 'na';   // 黄金专用：价格分位区（便宜/中性/贵）
  let peZone = 'na';    // 宽基双锚：PE 分位区
  let erpZone = 'na';   // 宽基双锚：ERP 区（高=股票划算）
  {
    // 便宜 = 250日价格分位 ≤cheapPct 便宜 / ≥expensivePct 贵 / 中间中性
    const cp = p.cheapPct != null ? p.cheapPct : 35;
    const ep = p.expensivePct != null ? p.expensivePct : 75;
    pctZone = (s.pricePercentile != null && !isNaN(s.pricePercentile))
      ? (s.pricePercentile <= cp ? 'cheap' : (s.pricePercentile >= ep ? 'expensive' : 'neutral'))
      : 'na';
  }

  // ② 本策略趋势及兼容展示字段
  let maZone = 'na';
  let devPct = null;
  let ma = null;
  {
    // 趋势维度：trendWeak(现价<MA120) 由调用方算好传入 → below/above；null 表示历史不足
    maZone = s.trendWeak == null ? 'na' : (s.trendWeak ? 'below' : 'above');
  }

  // ③ PE 初筛（总闸）：分位 ≥ peGatePct 且近20日急涨 > surge20dPct → 强制「不动」
  // 分位口径：优先 s.gatePercentile（海外宽基传**滚动分位**——固定分位遇水位台阶会长期失效），
  // 缺失时回退 s.pePercentile（A股 / 科技原口径，行为与文案逐字不变）。
  const gatePct = (s.gatePercentile != null) ? s.gatePercentile : s.pePercentile;
  let gate = 'pass';
  if (gatePct != null && gatePct >= peGatePct && (s.recent20dChange || 0) > surge20dPct) {
    gate = 'block';
    reasons.push(`PE 分位 ${gatePct}% 且近20日涨 ${s.recent20dChange}%，总闸拦截`);
  }
  // ③ 急涨总闸（仅 pricePercentile 模式用）：近20日涨 > surge20dPct → 仅中性区强拦（便宜区不拦）
  let surge = false;
  if ((s.recent20dChange || 0) > surge20dPct) surge = true;

  // 决策矩阵（二档）；PE 总闸命中 → 强制不动
  let action = 'hold';
  if (gate === 'block') {
    action = 'hold';
  } else {
    // 黄金：便宜即买；贵不买；中性需 跌破半年线(趋势弱) ∧ 已止跌 才加仓；中性急涨强拦
    if (pctZone === 'cheap') {
      action = 'add';
    } else if (pctZone === 'expensive') {
      action = 'hold';
    } else { // neutral
      if (surge) action = 'hold';
      else if (s.trendWeak === true && s.stopFall === true) action = 'add';
      else action = 'hold';
    }
  }

  // 理由文案（尽力解释触发路径）
  const anchorPct = (s.anchor3y != null ? s.anchor3y : p.anchor3yFallback) || 0;
  const anchorPctStr = (anchorPct * 100).toFixed(2);
  const yieldPctStr = s.yield != null ? (s.yield * 100).toFixed(2) : '?';
  {
    const gradeTxt = s.trendGrade || '';
    const pctStr = (s.pricePercentile != null && !isNaN(s.pricePercentile)) ? s.pricePercentile.toFixed(0) : '?';
    if (action === 'add') {
      if (pctZone === 'cheap') {
        reasons.push(`250日价格分位 ${pctStr}% 处于便宜区（≤${p.cheapPct}%），均值回归买点`);
      } else if (pctZone === 'neutral' && s.trendWeak === true && s.stopFall === true) {
        reasons.push(`分位 ${pctStr}% 中性，但净值已跌破半年线（${gradeTxt}）且近${p.stopWindow || 20}日已止跌，机会区`);
      }
    } else {
      if (gate !== 'block') {
        if (pctZone === 'expensive') {
          reasons.push(`250日价格分位 ${pctStr}% 处于贵区（≥${p.expensivePct}%），防高位接盘`);
        } else if (pctZone === 'neutral' && surge) {
          reasons.push(`分位 ${pctStr}% 中性，但近20日涨 ${(s.recent20dChange || 0).toFixed(1)}% 急涨（> ${p.surge20dPct}%），总闸强拦不追尖`);
        } else if (pctZone === 'neutral' && s.trendWeak !== true) {
          reasons.push(`分位 ${pctStr}% 中性，未跌破半年线（${gradeTxt}），无加仓信号`);
        } else if (pctZone === 'neutral' && s.stopFall !== true) {
          reasons.push(`分位 ${pctStr}% 中性且跌破半年线，但近${p.stopWindow || 20}日未止跌，等止跌确认再加仓`);
        } else if (pctZone === 'na') {
          reasons.push('价格分位数据缺失，按不动处理');
        }
      }
    }
  }

  matrix.yieldZone = yieldZone;
  matrix.maZone = maZone;
  matrix.devPct = devPct != null ? +devPct.toFixed(2) : null;
  matrix.ratio = ratio != null ? +ratio.toFixed(3) : null;
  matrix.dipReady = dipReady;
  matrix.drawdown = (s.drawdown != null) ? +(+s.drawdown).toFixed(2) : null;
  matrix.stopFall = s.stopFall === true;
  // ★2026-09-14 新增：动量因子的连续量（只写 matrix，不参与任何 action 判定，供评分层动量分 M 使用）
  matrix.stopRisePct = (s.stopRisePct != null && !isNaN(s.stopRisePct)) ? +(+s.stopRisePct).toFixed(2) : null;  // 低点抬高幅度(pp)
  matrix.maSpreadPct = (s.maSpreadPct != null && !isNaN(s.maSpreadPct)) ? +(+s.maSpreadPct).toFixed(2) : null;  // 双均线乖离(pp)
  matrix.ma120DevPct = (s.ma120DevPct != null && !isNaN(s.ma120DevPct)) ? +(+s.ma120DevPct).toFixed(2) : null;  // 现价 vs MA120 偏离(pp)
  matrix.goldenState = maZone === 'golden';
  matrix.cross = s.cross || null;
  matrix.gate = gate;
  matrix.pctZone = pctZone;
  matrix.peZone = peZone;
  matrix.erpZone = erpZone;
  matrix.trendWeak = s.trendWeak === true;
  matrix.trendGrade = s.trendGrade || null;
  matrix.pricePercentile = (s.pricePercentile != null && !isNaN(s.pricePercentile)) ? +(+s.pricePercentile).toFixed(2) : null;
  matrix.recent20dChange = (s.recent20dChange != null) ? +(+s.recent20dChange).toFixed(2) : null;
  matrix.surge = surge;
  // 综合分连续化（2026-09-09 方案 A「相对尺」）所需原始连续量：综合分不再读切好的三档 zone，
  // 而是拿这些原始值自己在「贵线→便宜线」之间归一化（与 core.js/gold.js/dividend.js 同源，避免口径漂移）。
  matrix.pePercentile = (s.pePercentile != null && !isNaN(s.pePercentile)) ? +(+s.pePercentile).toFixed(2) : null;
  matrix.erp = (s.erp != null && !isNaN(s.erp)) ? +(+s.erp).toFixed(6) : null;          // 小数，如 0.045 = 4.5%
  matrix.yield = (s.yield != null && !isNaN(s.yield)) ? +(+s.yield).toFixed(6) : null; // 基金股息率（小数）
  matrix.cheapYield = (p.cheapYield != null && !isNaN(p.cheapYield)) ? +(+p.cheapYield).toFixed(6) : null;
  matrix.expensiveYield = (p.expensiveYield != null && !isNaN(p.expensiveYield)) ? +(+p.expensiveYield).toFixed(6) : null;
  // ★2026-09-17 新增（只增不改，纯展示）：000922 动态参考股息率（小数）。absYield 口径下
  // 便宜线/贵线 = 参考值 × cheapMult/expensiveMult，展示层需原值才能说明「带是怎么算出来的」。
  matrix.refYield = (s.refYield != null && !isNaN(s.refYield)) ? +(+s.refYield).toFixed(6) : null;
  return { action, reasons, matrix, positionScore: null };
}
module.exports.buildSignalDecision = buildSignalDecision;

'use strict';
/*
 * 策略：主题 · 行业（tech / growth）
 * 适用范围：沿用现有主题行业资产——医药、消费、新能源、军工、半导体、港股科技。
 *   国内主动权益与疑似主动但未核验档案转独立买入判断，**不只科技**（显示名原为「科技成长」，因作者只买科技而得名，容易让人误以为
 *   其他行业不能用）。本线本质是「深度回撤抄底」：只看基金自身净值的 60 日回撤 + 止跌 + 双均线，
 *   **不需要跟踪指数，也不需要估值锚**，所以对行业不敏感。
 * 指标、限制、矩阵与理由由本策略完整负责；配置由调用方传入。
 */
// Strategy-local matrix and reasons; no compatibility-kernel dependency.
const util = require('../../lib/util');

// growth 类（科技成长）信号线：回撤+止跌(便宜) × 双均线金叉(趋势) × PE总闸 → 本策略矩阵
// 不读舆论/新闻，只看客观价格证据；金额用户自定。
function buildTechDecision(fund, valuationMap, config) {
  if(require('../../lib/activeEquityIdentity').isActiveEquityRoute(fund))return require('./activeEquity')(fund,valuationMap,config);
  const t = (config && config.signals && config.signals.tech) || {};
  const peG = (config && config.signals && config.signals.peGate) || {};
  const v = (valuationMap && valuationMap[fund.code]) || (fund && fund.valuation) || {};
  const hist = (fund && fund.history) || [];
  const nav = fund && fund.latestNav != null ? fund.latestNav : (hist[0] ? hist[0].nav : null);
  const dipWindow = t.dipWindow || 60;
  const stopWindow = t.stopWindow || 20;
  const dipPct = t.dipPct || 15;

  // ① 回撤：当前净值距 dipWindow 窗口高点跌幅
  const dd = hist.length ? util.drawdownFromHigh(hist.slice(0, dipWindow)) : null;
  // ② 止跌：近 stopWindow 日最低 > 前 stopWindow 日最低（下跌动能衰竭；数据不足=false，公共函数与分配层共用）
  const stopFall = util.stableLow(hist, stopWindow);
  // ★2026-09-14 新增：动量因子的连续化（只算不判，仅供评分层动量分 M 使用，不参与任何 add/hold 判定）
  //   把二值的 stopFall 变成「低点抬高幅度%」，与 stableLow 同窗口同方向（> 0 ⟺ stableLow === true）
  const stopRisePct = util.lowRaisePct(hist, stopWindow);
  // 金叉强度：MA20 相对 MA60 的乖离%（0 分界 = goldenState 的临界点，连续化后强弱金叉不再同分）
  const maSpreadPct = util.maSpreadPct(hist, 20, 60);
  // ③ 双均线金叉：MA20 vs MA60，当前状态 + 近 back 点交叉事件
  const ma20 = util.computeMA(hist, 20);
  const ma60 = util.computeMA(hist, 60);
  let goldenState = null, cross = null;
  if (ma20 != null && ma60 != null) {
    goldenState = ma20 > ma60;
    const back = Math.min(10, Math.max(1, hist.length - 60));
    const ma20b = util.computeMA(hist.slice(back), 20);
    const ma60b = util.computeMA(hist.slice(back), 60);
    if (ma20b != null && ma60b != null) {
      const nowDiff = ma20 - ma60, backDiff = ma20b - ma60b;
      if (backDiff < 0 && nowDiff > 0) cross = 'golden';
      else if (backDiff > 0 && nowDiff < 0) cross = 'dead';
    }
  }
  // 估值维：优先 PE 分位；QDII 无 trackIndex（无 PE）时用 250 日价格分位降级（util.percentileOf 入参 {nav}[]）
  const pricePercentile = (v.pePercentile != null) ? v.pePercentile : util.percentileOf(hist.slice(0, 250));
  return buildSignalDecision({
    yield: null, // 科技无股息率
    nav,
    history: hist,
    pePercentile: v.pePercentile != null ? v.pePercentile : null,
    pricePercentile: pricePercentile != null ? pricePercentile : null,
    recent20dChange: v.recent20dChange != null ? v.recent20dChange : 0,
    drawdown: dd,
    stopFall,
    goldenState,
    cross,
    stopRisePct,                                  // ★新增（连续化，仅供 M）
    maSpreadPct                                   // ★新增（连续化，仅供 M）
  }, {
    cheapBy: 'techDip',
    dipPct,
    stopWindow,
    peGatePct: peG.peGatePct != null ? peG.peGatePct : 85,
    surge20dPct: peG.surge20dPct != null ? peG.surge20dPct : 5
  });
}

module.exports = buildTechDecision;


// Low-level legacy signal contract, owned by this strategy.
function buildSignalDecision(signalSource, params) {
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
    // 便宜 = 60日回撤≤-dipPct% 且止跌（stopFall 由调用方算好）
    const dd = (s.drawdown != null) ? s.drawdown : null;
    const dipPct = p.dipPct != null ? p.dipPct : 15;
    dipReady = (dd != null && dd <= -dipPct && s.stopFall === true);
  }

  // ② 本策略趋势及兼容展示字段
  let maZone = 'na';
  let devPct = null;
  let ma = null;
  {
    // 金叉状态：MA20 > MA60（goldenState 由调用方算好）
    maZone = s.goldenState === true ? 'golden' : (s.goldenState === false ? 'dead' : 'na');
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

  // 决策矩阵（二档）；PE 总闸命中 → 强制不动
  let action = 'hold';
  if (gate === 'block') {
    action = 'hold';
  } else {
    // 科技：两条买入通道任一满足即加仓
    if (dipReady || maZone === 'golden') action = 'add';
    else action = 'hold';
  }

  // 理由文案（尽力解释触发路径）
  const anchorPct = (s.anchor3y != null ? s.anchor3y : p.anchor3yFallback) || 0;
  const anchorPctStr = (anchorPct * 100).toFixed(2);
  const yieldPctStr = s.yield != null ? (s.yield * 100).toFixed(2) : '?';
  {
    const ddStr = (s.drawdown != null) ? s.drawdown.toFixed(1) : '?';
    if (action === 'add') {
      if (dipReady && maZone === 'golden') {
        reasons.push(`回撤 ${ddStr}% 已到位（≤-${p.dipPct}%）且止跌，同时均线金叉（MA20 上穿 MA60）趋势修复，双通道共振`);
      } else if (dipReady) {
        reasons.push(`回撤 ${ddStr}% 已到位（≤-${p.dipPct}%）且止跌（近${p.stopWindow || 20}日低点抬升），深度回撤通道`);
      } else if (maZone === 'golden') {
        reasons.push(`均线金叉（MA20 上穿 MA60）趋势修复，上升路线买入`);
      }
    } else if (gate !== 'block') {
      const ddNum = (s.drawdown != null) ? s.drawdown : null;
      const deepButNoStop = ddNum != null && ddNum <= -(p.dipPct || 15) && s.stopFall !== true;
      if (maZone === 'dead' && deepButNoStop) {
        reasons.push(`回撤 ${ddStr}% 已深（≤-${p.dipPct}%）但近${p.stopWindow || 20}日未止跌，且均线死叉（MA20<MA60）趋势偏弱，等止跌确认`);
      } else if (maZone === 'dead') {
        reasons.push(`回撤 ${ddStr}% 未到位，且均线死叉（MA20 在 MA60 下方）趋势偏弱，等回撤到位+止跌`);
      } else if (deepButNoStop) {
        reasons.push(`回撤 ${ddStr}% 已深（≤-${p.dipPct}%）但近${p.stopWindow || 20}日未止跌，等止跌确认再加仓`);
      } else {
        reasons.push(`回撤 ${ddStr}% 未到位，且未出现金叉，无加仓信号`);
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

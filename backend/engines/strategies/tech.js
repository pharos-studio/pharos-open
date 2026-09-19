'use strict';
/*
 * 策略：主题 · 行业（tech / growth）
 * 适用范围：**任何高波动资产**——医药、消费、新能源、军工、半导体、港股科技、主动偏股
 *   基金全都适用，**不只科技**（显示名原为「科技成长」，因作者只买科技而得名，容易让人误以为
 *   其他行业不能用）。本线本质是「深度回撤抄底」：只看基金自身净值的 60 日回撤 + 止跌 + 双均线，
 *   **不需要跟踪指数，也不需要估值锚**，所以对行业不敏感。
 * 链路四段式（①② 专属算法写在下方；③④ 调内核骨架，差异显式声明）：
 *   ① 便宜判定：60日窗口回撤 ≤-dipPct%(15) 且止跌（近 stopWindow(20) 日低点 > 前 stopWindow 日低点）= techDip。
 *   ② 趋势：双均线金叉状态（MA20 > MA60 = golden，由本文件算好传 goldenState）。
 *   ③ 总闸：PE 闸（pePercentile≥85 且近20日涨>5% 强制不动；主动QDII无PE自动跳过）。
 *   ④ 决策矩阵：阶段一仍由内核 techDip 分支执行（两条买入通道任一满足即加仓）；阶段二可自定义。
 */
const { buildFundDecision } = require('../kernel');
const util = require('../../lib/util');

// growth 类（科技成长）信号线：回撤+止跌(便宜) × 双均线金叉(趋势) × PE总闸 → 走通用引擎(techDip 模式)
// 不读舆论/新闻，只看客观价格证据；金额用户自定。
function buildTechDecision(fund, valuationMap, config) {
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
  return buildFundDecision({
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

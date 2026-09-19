'use strict';
/*
 * 策略：商品 / 对冲（cycle）
 * 适用范围：**任何商品类基金**（黄金、白银、原油、豆粕…）。本线只看基金自身净值的
 *   250 日价格分位与三重均线，**不依赖任何指数估值锚**，所以并不绑黄金这一种标的。
 * 链路四段式（①② 专属算法写在下方；③④ 调内核骨架，差异显式声明）：
 *   ① 便宜判定：250日价格分位（pricePercentile，≤35 便宜 / ≥75 贵 / 中间中性）。
 *   ② 趋势：三重均线位置（MA60/120/250；跌破半年线 MA120 = 趋势弱 trendWeak，trendGrade 三级）。
 *   ③ 总闸：急涨闸（近20日涨 > 7% 时仅中性区强拦，便宜区不拦）。
 *   ④ 决策矩阵：阶段一仍由内核 pricePercentile 分支执行；阶段二可自定义。
 */
const { buildFundDecision } = require('../kernel');
const util = require('../../lib/util');

// cycle 类（黄金/对冲）信号线：价格分位(便宜/贵) × 三重均线位置(跌破MA120=趋势弱) × 急涨总闸 × 止跌确认 → 走通用引擎(pricePercentile 模式)
// 纯价格纪律，与仓位/资金解耦；金额由统一分配引擎决定。不读舆论/新闻，只看客观价格证据。
function buildGoldDecision(fund, valuationMap, config) {
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

  return buildFundDecision({
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

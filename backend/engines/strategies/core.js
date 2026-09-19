'use strict';
/*
 * 策略：宽基 · A股口径（broad / caliber=cn）
 * 适用范围：**跟踪 A 股宽基指数的指数基金**——沪深300、中证500/1000/A500、创业板、科创50
 *   等都可以挂到这条线，不限于沪深300。★必须填对「跟踪指数(trackIndex)」：本线的估值锚
 *   就是该指数自己的 PE 分位与 ERP，填错或缺失会直接退化成「数据缺失·按不动处理」。
 *   海外宽基请改用 caliber=us；行业主题请用「主题·行业」线。
 * 链路四段式（①② 专属算法写在下方；③④ 调内核骨架，差异显式声明）：
 *   ① 便宜判定：双锚（peErp）——锚1=PE分位(≤25 便宜 / ≥80 贵，乐咕近5年滚动) × 锚2=ERP=1/PE−中债10年(≥4.5% 高 / ≤2.5% 低)。
 *   ② 趋势：三重均线位置（MA60/120/250；跌破半年线 MA120 = 趋势弱 trendWeak，trendGrade 三级）。
 *   ③ 总闸：PE 闸（pePercentile≥85 且近20日涨>5% 强制不动）。
 *   ④ 决策矩阵：阶段一仍由内核 peErp 分支执行（四象限）；阶段二可自定义。
 */
const { buildFundDecision } = require('../kernel');
const util = require('../../lib/util');

// broad 类（宽基，如沪深300）信号线：双锚（PE分位×ERP股债利差）+ 三重均线(MA60/120/250) → 走通用引擎(peErp 模式)
// 锚1=PE分位(纵向比自己贵不贵)，锚2=ERP=1/PE−无风险利率(横向比债券划不划算)。双锚交叉成四象限。
function buildCoreDecision(fund, valuationMap, config) {
  const b = (config && config.signals && config.signals.broad) || {};
  const peG = (config && config.signals && config.signals.peGate) || {};
  const v = (valuationMap && valuationMap[fund.code]) || (fund && fund.valuation) || {};
  const hist = (fund && fund.history) || [];
  const nav = fund && fund.latestNav != null ? fund.latestNav : (hist[0] ? hist[0].nav : null);
  const pe = v.pe != null ? v.pe : null;
  const pePercentile = v.pePercentile != null ? v.pePercentile : null;
  // ERP 第二锚：1/PE − 无风险利率。中债口径唯一（analysis 自动抓取东方财富，挂在 v.treasury10y）；
  // 仅当抓取失败时回退 config.treasury10y 常量兜底。严禁美债FRED（中美利差倒挂失真）。
  const treasury10y = (v.treasury10y != null && v.treasury10y > 0)
    ? v.treasury10y
    : (config && config.treasury10y != null ? config.treasury10y : null);
  let erp = null;
  if (pe != null && pe > 0 && treasury10y != null && treasury10y > 0) {
    erp = 1 / pe - treasury10y;
  }
  // 三重均线（MA60/120/250 = 季/半年/年）
  const stopWindow = b.stopWindow || 20;
  const mas = (b.maWindows || [60, 120, 250]).map(w => util.computeMA(hist, w));
  let trendWeak = null, trendGrade = null;
  if (mas[1] != null && nav != null) {
    trendWeak = nav < mas[1];
    if (mas[0] != null && mas[2] != null) {
      if (nav < mas[0] && nav < mas[1] && nav < mas[2]) trendGrade = '全下(强降)';
      else if (nav > mas[0] && nav > mas[1] && nav > mas[2]) trendGrade = '全上(强升)';
      else trendGrade = '混杂';
    }
  }
  const recent20dChange = v.recent20dChange != null ? v.recent20dChange : util.recentChangePct(hist, 20);
  // 止跌：近 stopWindow 日最低 > 前 stopWindow 日最低
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
    pePercentile,
    erp,
    nav,
    history: hist,
    recent20dChange,
    trendWeak,
    stopFall,
    trendGrade,
    stopRisePct,                                  // ★新增（连续化，仅供 M）
    ma120DevPct                                   // ★新增（连续化，仅供 M）
  }, {
    cheapBy: 'peErp',
    cheapPct: b.cheapPct != null ? b.cheapPct : 30,
    expensivePct: b.expensivePct != null ? b.expensivePct : 70,
    erpHigh: b.erpHigh != null ? b.erpHigh : 6.9,          // 与 kernel.js 同款默认值（2026-09-09 校准）
    erpLow: b.erpLow != null ? b.erpLow : 5.3,
    stopWindow,
    peGatePct: peG.peGatePct != null ? peG.peGatePct : 85,
    surge20dPct: peG.surge20dPct != null ? peG.surge20dPct : 5
  });
}

module.exports = buildCoreDecision;

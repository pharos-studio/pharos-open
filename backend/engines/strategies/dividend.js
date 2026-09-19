'use strict';
/*
 * 策略：红利低波（dividend）
 * 适用范围：**A 股红利 / 低波类基金**。海外红利没有免费估值源，用本线会走常量兜底带，
 *   请看板里「缺估值锚」的降级提示。其他任何资产都不该挂到这条线上。
 * 链路四段式（①② 专属算法写在下方；③④ 调内核骨架，差异显式声明）：
 *   ① 便宜判定：绝对股息率带(absYield)——相对中证红利000922动态股息率(referenceYield)的
 *      cheapMult(1.10)/expensiveMult(0.90) 倍率定便宜/贵，PE 分位主线已砍（永不启用）。
 *   ② 趋势：年线偏离（由内核按 nav/history 自算 MA250）。
 *   ③ 总闸：PE 闸关（signalSource 传 pePercentile:null，总闸恒 pass）、急涨闸关（非 pricePercentile 模式，不启用）。
 *   ④ 决策矩阵：阶段一仍由内核 absYield 分支执行；阶段二可在本文件自定义矩阵。
 */
const { buildFundDecision } = require('../kernel');

// 红利低波信号线：绝对股息率带(absYield) + 中债ERP展示。
// PE分位主线已砍（用户2026-09-01拍板，永不启用）：标普SPCLLHCP 无免费PE历史，
// 且用户判定代理指数不接近，故红利纯走中证红利000922动态股息率参考带。
// 动态数据(000922 dyr / 中债10年)由 analysis.js 预抓并挂在 valuation 上，本函数保持同步。
function buildDividendDecision(fund, valuationMap, config) {
  const dy = (config && config.signals && config.signals.dividendYield) || {};
  const maCfg = (config && config.signals && config.signals.ma250) || {};
  const peG = (config && config.signals && config.signals.peGate) || {};
  const v = (valuationMap && valuationMap[fund.code]) || (fund && fund.valuation) || {};
  const nav = fund && fund.latestNav != null ? fund.latestNav : (fund && fund.history && fund.history[0] ? fund.history[0].nav : null);
  const dyr = v.dyr != null ? v.dyr : null;            // 基金股息率(valuation.dyr，代理近似)
  const refYield = v.referenceYield != null ? v.referenceYield : null; // 000922 动态股息率(参考带)
  // 绝对带：相对 000922 参考的倍率（动态；refYield 缺失时回退常量带）
  const cheapYield = refYield != null ? refYield * (dy.cheapMult || 1.10) : (dy.cheapYield || 0.045);
  const expensiveYield = refYield != null ? refYield * (dy.expensiveMult || 0.90) : (dy.expensiveYield || 0.035);
  return buildFundDecision({
    yield: dyr,
    refYield,
    nav,
    history: fund && fund.history,
    pePercentile: null, // PE分位主线已砍：红利纯走股息率带，不受 PE 总闸约束
    recent20dChange: v.recent20dChange != null ? v.recent20dChange : 0
  }, {
    cheapBy: 'absYield',
    cheapYield, expensiveYield,
    windowDays: maCfg.windowDays,
    peGatePct: peG.peGatePct, surge20dPct: peG.surge20dPct
  });
}

module.exports = buildDividendDecision;

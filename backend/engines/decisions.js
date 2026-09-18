'use strict';
/*
 * 决策信号引擎（聚合导出层）。
 * 算法层已拆分（2026-09-01，用户拍板「链路骨架留内核 + 判定规则下沉策略文件」）：
 *   - engines/kernel.js            内核：buildFundDecision（四步链路骨架+契约+共享拍板）+ loadYieldAnchor3y
 *   - engines/strategies/*.js      各策略 builder：dividend(红利absYield) / tech(科技techDip) / gold(黄金pricePercentile)
 *                                  / core(宽基·A股 peErp) / broadGlobal(宽基·海外 滚动分位∨PE回撤)
 * 本文件只做聚合导出，导出名保持不变 → registry.js / server.js 零改动。
 */
const kernel = require('./kernel');
module.exports = {
  buildFundDecision: kernel.buildFundDecision,
  loadYieldAnchor3y: kernel.loadYieldAnchor3y,
  buildDividendDecision: require('./strategies/dividend'),
  buildTechDecision:     require('./strategies/tech'),
  buildGoldDecision:     require('./strategies/gold'),
  buildCoreDecision:     require('./strategies/core'),
  buildBroadGlobalDecision: require('./strategies/broadGlobal')
};

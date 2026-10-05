'use strict';
// Compatibility exports only. Runtime registry imports strategies directly.
const kernel = require('./kernel');
const legacyGlobal=require('./strategies/broadGlobal'),nasdaq=require('./strategies/nasdaq'),{isNasdaqRoute}=require('../lib/nasdaqIdentity');
function buildBroadGlobalDecision(fund,valuationMap,config){return isNasdaqRoute(fund)?nasdaq(fund,valuationMap,config):legacyGlobal(fund,valuationMap,config);}
module.exports = {
  buildFundDecision: kernel.buildFundDecision,
  loadYieldAnchor3y: kernel.loadYieldAnchor3y,
  buildDividendDecision: require('./strategies/dividend'),
  buildTechDecision:     require('./strategies/tech'),
  buildActiveEquityDecision: require('./strategies/activeEquity'),
  buildGoldDecision:     require('./strategies/gold'),
  buildGoldDualDecision: require('./strategies/goldDual'),
  buildCoreDecision:     require('./strategies/core'),
  buildBroad300Decision: require('./strategies/broad300').buildBroad300Decision,
  buildBroadGlobalDecision
};

'use strict';
// Compatibility exports only. Runtime registry imports strategies directly.
const kernel = require('./kernel');
const scope = require('../lib/strategyScope');
const legacyGlobal=require('./strategies/broadGlobal'),nasdaq=require('./strategies/nasdaq'),{isNasdaqRoute}=require('../lib/nasdaqIdentity');
function buildBroadGlobalDecision(fund,valuationMap,config){return scope.isRecordOnly(fund)?scope.decision(fund):isNasdaqRoute(fund)?nasdaq(fund,valuationMap,config):legacyGlobal(fund,valuationMap,config);}
module.exports = {
  buildFundDecision: scope.guard(kernel.buildFundDecision),
  loadYieldAnchor3y: kernel.loadYieldAnchor3y,
  buildDividendDecision: scope.guard(require('./strategies/dividend')),
  buildTechDecision:     require('./strategies/tech'),
  buildActiveEquityDecision: require('./strategies/activeEquity'),
  buildGoldDecision:     scope.guard(require('./strategies/gold')),
  buildGoldDualDecision: scope.guard(require('./strategies/goldDual')),
  buildGoldMonthlyDecision: scope.guard(require('./strategies/goldMonthly')),
  buildCoreDecision:     scope.guard(require('./strategies/core')),
  buildBroad300Decision: scope.guard(require('./strategies/broad300').buildBroad300Decision),
  buildBroadGlobalDecision
};

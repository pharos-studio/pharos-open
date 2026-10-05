'use strict';
// Compatibility service facade. Pure decisions, scores and constraints live in separate modules.
const config = require('../../lib/config');
const util = require('../../lib/util');
const { getAllocCfg } = require('../../services/scoreConfig');
const { runDecisionPipeline } = require('../decisionPipeline');
function computeAllocation(allocation, policy, funds, totalValue, monthlyBudget, valuationMap, dailyLimits) {
  const cfg = config.getConfig();
  return runDecisionPipeline({ allocation, policy, funds, valuationMap, dailyLimits,
    scoreConfig: getAllocCfg(cfg), strategyConfig: cfg, now: Date.now(), today: util.todayStr() });
}
module.exports = { computeAllocation, ...require('../scoring'), ...require('../tradeConstraints') };

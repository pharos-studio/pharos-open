'use strict';
// Deprecated compatibility dispatcher only. New runtime code uses strategy registry.
const builders = {
  techDip: require('./strategies/tech').buildSignalDecision,
  pricePercentile: require('./strategies/gold').buildSignalDecision,
  peErp: require('./strategies/core').buildSignalDecision,
  broadGlobal: require('./strategies/broadGlobal').buildSignalDecision
};
// Legacy defaults must never dispatch into the new fund-specific runtime strategy.
function disabled() {
  return { action:null,reasons:['红利旧兼容规则已停用'],matrix:null,positionScore:null,
    unsupported:true,unsupportedReason:'rule_disabled',marketVerdict:null,verdict:null,eligible:false,executable:false };
}
function buildFundDecision(signalSource, params) {
  if(require('../lib/goldIdentity').isGoldRoute(signalSource))return require('./strategies/goldDual')(signalSource);
  const builder = params && Object.hasOwn(builders, params.cheapBy) && builders[params.cheapBy];
  return builder ? builder(signalSource, params) : disabled();
}
module.exports = { buildFundDecision, loadYieldAnchor3y: require('../services/yieldHistory').loadYieldAnchor3y };

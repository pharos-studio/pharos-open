'use strict';
const profile = require('../../lib/dividendTrend');

// 月频计划仅表达策略节奏，不产生择时、买入或执行信号。
const VERSION = 'dividend-monthly-dca-v1';
function buildDividendDecision(fund) {
  const reason = profile.eligibility(fund);
  const label = reason === 'profile_unverified' ? '需要处理'
    : reason === 'scope_unsupported' ? '暂不支持' : '每月定投';
  const supported = !reason;
  return {
    action: null,
    reasons: [supported ? '每月定投，手动执行；系统不指定日期、金额或完成情况。' : label + '：' + reason],
    strategyVersion: VERSION,
    unsupported: !supported,
    unsupportedReason: reason || null,
    matrix: {
      _type: 'dividendMonthlyDca', strategyVersion: VERSION,
      marketState: supported ? 'monthly_dca' : reason,
      marketStateLabel: label, displayKind: supported ? 'plan' : null,
      frequency: supported ? 'monthly' : null,
      dataError: reason || null
    },
    positionScore: null, marketVerdict: null, verdict: null, executable: false
  };
}

buildDividendDecision.VERSION = VERSION;
module.exports = buildDividendDecision;

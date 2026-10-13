'use strict';
const identity = require('../../lib/goldMonthlyIdentity');
const VERSION = 'gold-monthly-dca-v1';
function buildGoldMonthlyDecision(fund, valuationMap, config, context = {}) {
  const now = Number(context.now ?? Date.now());
  const reason = identity.CODES.has(fund?.code) ? identity.eligibility(identity.evidenceOf(fund.code), now) : 'scope_unsupported';
  const supported = !reason;
  const label = supported ? '每月定投' : reason === 'scope_unsupported' ? '暂不支持' : '需要处理';
  return { action:null, marketVerdict:null, verdict:null, eligible:false, executable:false, positionScore:null,
    strategyVersion:VERSION, unsupported:!supported, unsupportedReason:reason,
    reasons:[supported ? '计划：每月定投；由你决定是否执行。系统不指定日期、金额或完成情况。' : label + '：当前官方身份或适用范围未通过核验。'],
    matrix:{_type:'goldMonthly', strategyVersion:VERSION, marketState:supported?'monthly_dca':reason,
      marketStateLabel:label, displayKind:supported?'plan':null, frequency:supported?'monthly':null,
      dataError:reason, computedAt:new Date(now).toISOString(), identityVersion:identity.LEDGER.methodVersion}
  };
}
buildGoldMonthlyDecision.VERSION = VERSION;
module.exports = buildGoldMonthlyDecision;

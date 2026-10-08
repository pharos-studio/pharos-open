'use strict';
// Purchase constraints; preserve policy semantics separately for the existing state route.
function purchaseStatusMeta(f, now) {
  const s = f && f.purchaseStatus;
  const ts = now == null ? Date.now() : Number(now);
  const fresh = !!(s && s.updatedAt && ts - Number(s.updatedAt) < 24 * 3600 * 1000);
  const state = s && s.state || 'unknown';
  return { state, fresh, suspended: fresh && state === 'suspended', unavailable: !fresh || state === 'unknown' };
}

function purchaseDecision(marketVerdict, ps, userLimit) {
  const blocked = !!(ps && (ps.suspended || ps.unavailable)) || (userLimit != null && userLimit <= 0);
  return {
    blocked,
    verdict: blocked ? 'hold' : marketVerdict,
    executable: !blocked && marketVerdict === 'add',
  };
}


function policyEligible(fund, policy, ps, userLimit, categoryToBucket) {
  if ((policy[categoryToBucket(fund.category)] || 'buy') !== 'buy') return false;
  if (userLimit != null && userLimit <= 0) return false;
  return !(ps.suspended || ps.unavailable);
}

// Existing state route gates verdict/executable by policy; scored routes only mark eligible.
// This intentional compatibility distinction must not be harmonized by a refactor.
function policyDecision(decision, allowed, stateRoute) {
  return stateRoute ? { ...decision, verdict: allowed ? decision.verdict : 'hold',
    executable: allowed && decision.executable } : decision;
}
module.exports = { purchaseStatusMeta, purchaseDecision, policyEligible, policyDecision };

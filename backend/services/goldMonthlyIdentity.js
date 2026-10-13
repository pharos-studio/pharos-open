'use strict';
const identity = require('../lib/goldMonthlyIdentity');
function createService(deps = {}) {
  const resolveOfficial = deps.resolveOfficial || identity.evidenceOf;
  return { async resolve(code, now = Date.now()) {
    try { const evidence = await resolveOfficial(code); return { evidence, error: evidence?.code === code ? identity.eligibility(evidence, now) : 'profile_unverified' }; }
    catch (_) { return { error:'profile_unverified' }; }
  } };
}
module.exports = { ...createService(), createService };

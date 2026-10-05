'use strict';
const LEDGER=require('../data/activeEquityIdentity.json'),{eligibility}=require('../lib/activeEquityIdentity');
function createService(deps={}){const evidenceOf=deps.resolveOfficial||((code)=>LEDGER.funds.find(e=>e.code===code));async function resolve(code){try{const evidence=await evidenceOf(code);if(evidence?.code!==code)return {error:'profile_unverified'};const error=eligibility(evidence);return {evidence,...(error?{error}:{})};}catch(_){return {error:'profile_unverified'};}}return {resolve};}
module.exports={...createService(),createService};

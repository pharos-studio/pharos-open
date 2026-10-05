'use strict';
const {eligibility}=require('../lib/nasdaqIdentity');
// Reviewed official evidence lives in the public runtime ledger. No name or proxy whitelist can certify admission.
const EVIDENCE=require('../data/nasdaqIdentity.json');
function createService(deps={}){
  const evidenceOf=deps.resolveOfficial||((code)=>EVIDENCE.funds.find(e=>e.code===code));
  async function resolve(code){try{
    const evidence=await evidenceOf(code);if(evidence?.code!==code)return {error:'profile_unverified'};
    const error=eligibility(evidence);return {evidence,...(error?{error}:{})};
  }catch(_){return {error:'profile_unverified'};}}
  return {resolve};
}
module.exports={...createService(),createService};

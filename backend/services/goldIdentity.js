'use strict';
const {LEDGER,eligibility}=require('../lib/goldIdentity');
function createService(deps={}){const evidenceOf=deps.resolveOfficial||((code)=>LEDGER.funds.find(e=>e.code===code));return {async resolve(code){try{const evidence=await evidenceOf(code);if(evidence?.code!==code)return {error:'profile_unverified'};return {evidence,error:eligibility(evidence)};}catch(_){return {error:'profile_unverified'};}}};}
module.exports={...createService(),createService};

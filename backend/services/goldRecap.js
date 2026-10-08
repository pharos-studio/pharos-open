'use strict';
const identity=require('./goldIdentity'),dataService=require('./goldData'),C=require('../lib/goldCalendar'),R=require('../lib/goldRecap'),S=require('../lib/goldSignal'),{LEDGER}=require('../lib/goldIdentity');
function createService(deps={}){const resolve=deps.resolve||identity.resolve,fetchFull=deps.fetchFull||dataService.fetchFull,now=deps.now||Date.now;return {async backfill(samples,params){
  if(LEDGER.releaseEnabled!==true)return {changed:0,done:0,reason:'release_pending'};const inputByCode=new Map();let changed=0,done=0;
  for(const sample of samples){if(sample.strategyVersion!==S.VERSION||!['pending','partial'].includes(sample.backfill))continue;
    let input=inputByCode.get(sample.code);if(!inputByCode.has(sample.code)){try{const resolved=await resolve(sample.code);input=resolved.error?{error:resolved.error}:dataService.prepareInput(await fetchFull(sample.code),resolved.evidence,C.orderContext(now(),resolved.evidence));}catch(e){input={error:e.message};}inputByCode.set(sample.code,input);}
    if(input.error||!input._returnRows)continue;const result=R.evaluate(input._returnRows,sample,params);if(!result.update)continue;
    Object.assign(sample,result.update,{backfilledAt:C.day(now()),recapSourceHash:input.sourceHash,recapActionHash:input.actionHash});changed++;if(result.update.backfill==='done')done++;
  }return {changed,done};
}};}
module.exports={...createService(),createService};

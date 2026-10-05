'use strict';
const assert=require('node:assert/strict'),F=require('../fixtures/nasdaqInputs');
async function snapshot(options={}){
  const config=require('../lib/config'),store=require('../lib/store'),util=require('../lib/util'),fetchers=require('../fetchers'),service=require('../services/nasdaqData');
  const undo=[],patch=(o,k,v)=>{const old=o[k];undo.push(()=>o[k]=old);o[k]=v;};
  const kinds=['both','waiting','unknown','outside','suspended','missingPe','future'],funds=kinds.map((k,i)=>F.fund('99900'+(i+1),k));
  let instant=options.startInstant||F.NOW;
  if(options.profileState)funds[2].profileState=options.profileState;
  if(options.purchaseStamp!=null)funds[0].purchaseStatus.updatedAt=options.purchaseStamp;
  patch(Date,'now',()=>instant);patch(config,'getConfig',()=>require('../../data/example/config.example.json'));
  patch(util,'todayStr',()=> '2026-09-24');patch(util,'shanghaiNow',()=>({ymd:'2026-09-24',hour:12,minute:0}));patch(util,'isTradingHours',()=>false);
  patch(store,'readJSON',key=>key==='holdings.json'?{funds}:key==='categories.json'?require('../../data/example/categories.example.json'):{});
  for(const key of ['writeJSON','writeJSONSafe','writeDecisionHistory','appendSnapshot'])patch(store,key,()=>{throw Error('unexpected test write');});
  patch(fetchers,'fetchNavHistory',async code=>({history:funds.find(f=>f.code===code).history,failed:false}));
  patch(fetchers,'fetchValuation',async()=>{throw Error('Nasdaq used legacy valuation fallback');});
  patch(fetchers,'fetchIndexPeHistory',async()=>{throw Error('Nasdaq used legacy PE route');});
  patch(fetchers,'fetchBond10Y',async()=>({cn:.02,us:.04}));patch(fetchers,'fetchHoldings',async()=>({holdings:[],reportDate:null}));
  patch(service,'forFund',async fund=>{const i=funds.findIndex(f=>f.code===fund.code),input=F.input(fund.code,kinds[i]);
    input.context.knownAt=options.startInstant||F.NOW;input.context.computedAt=new Date(input.context.knownAt).toISOString();
    if(i===0&&options.officialConstraint)input.evidence.purchaseConstraint=options.officialConstraint;
    if(i===funds.length-1&&options.finalInstant)instant=options.finalInstant;
    return input;});
  try{
    const analysis=require('../engines/analysis'),advice=require('../engines/advice');
    const built=await analysis.buildAnalysis();patch(analysis,'buildAnalysis',async()=>built);
    const {REGISTRY}=require('../engines/registry');patch(REGISTRY['broad:nasdaq'],'builder',()=>{throw Error('duplicate Nasdaq strategy calculation');});
    const card=await advice.buildAdvice('pm');return {analysis:JSON.parse(JSON.stringify(built)),advice:JSON.parse(JSON.stringify(card))};
  }finally{undo.reverse().forEach(fn=>fn());}
}
async function run(){
  const result=await snapshot(),funds=result.advice.funds;
  assert.equal(funds.length,7);
  for(const f of funds){const sm=result.analysis.plan.scoreMap[f.code];assert.equal(f.strategyVersion,'nasdaq-dual-v1');
    assert.equal(f.score,null);assert.equal(f.valueScore,null);assert.equal(f.momentumScore,null);assert.equal(f.marketVerdict,sm.marketVerdict);
    assert.equal(f.verdict,sm.verdict);assert.equal(f.executable,sm.executable);assert.equal(f.matrix.inputVersion,'nasdaq-live-input-v1');}
  assert.equal(funds[0].route,'both');assert.equal(funds[0].marketVerdict,'add');assert.equal(funds[0].executable,true);
  assert.equal(funds[1].marketState,'waiting');assert.equal(funds[2].marketVerdict,null);assert.equal(funds[2].verdict,null);
  assert.equal(funds[3].marketState,'scope_unsupported');assert.equal(funds[4].blockedReason,'purchase_suspended');
  assert.equal(funds[4].marketVerdict,'add');assert.equal(funds[5].marketVerdict,'add');assert.equal(funds[5].pathStates.draw,'unknown');
  assert.equal(funds[6].blockedReason,'future_order_recheck');assert.equal(funds[6].executable,false);
  const cut=await snapshot({startInstant:Date.parse('2026-09-24T06:59:00Z'),finalInstant:Date.parse('2026-09-24T07:01:00Z')});
  assert.equal(cut.advice.funds[0].orderDate,'2026-09-28');assert.equal(cut.advice.funds[0].executable,false);
  assert.equal(cut.advice.funds[0].computedAt,'2026-09-24T07:01:00.000Z');
  const ttl=await snapshot({startInstant:F.NOW,finalInstant:F.NOW+120000,purchaseStamp:F.NOW-86400000+60000});
  assert.equal(ttl.analysis.plan.scoreMap['999001'].statusFresh,false);assert.equal(ttl.advice.funds[0].executable,false);
  const futureStatus=await snapshot({purchaseStamp:F.NOW+1});assert.equal(futureStatus.advice.funds[0].blockedReason,'purchase_status_unverified');
  const review=await snapshot({profileState:'needs_review'});assert.equal(review.advice.funds[2].verdict,null);
  const official={status:'suspended',start:'2026-09-01',checkedAt:new Date(F.NOW-1000).toISOString(),source:'https://example.invalid/suspension'};
  const pause=await snapshot({officialConstraint:official});assert.equal(pause.advice.funds[0].marketVerdict,'add');
  assert.equal(pause.advice.funds[0].blockedReason,'official_purchase_suspended');assert.equal(pause.advice.funds[0].executable,false);
  const staleOfficial=await snapshot({officialConstraint:{...official,checkedAt:new Date(F.NOW-86400000).toISOString()}});
  assert.equal(staleOfficial.advice.funds[0].blockedReason,'official_resumption_unverified');assert.equal(staleOfficial.advice.funds[0].executable,false);
  const unresolved=await snapshot({officialConstraint:{status:'unknown',source:'https://example.invalid/official-pause-hint',checkedAt:new Date(F.NOW).toISOString()}});
  assert.equal(unresolved.advice.funds[0].blockedReason,'official_constraint_unverified');assert.equal(unresolved.advice.funds[0].marketVerdict,'add');
  assert.equal(unresolved.advice.funds[0].executable,false);
  console.log('纳指API：同次判断、无评分、三态、双触发去重、缺PE趋势及独立交易限制通过');
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={snapshot,run};

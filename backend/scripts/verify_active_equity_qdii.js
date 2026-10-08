'use strict';
const assert=require('node:assert/strict'),F=require('../fixtures/activeEquityInputs'),C=require('../lib/activeEquityCalendar'),I=require('../lib/activeEquityIdentity'),D=require('../services/activeEquityData'),R=require('../engines/registry'),B=require('../engines/strategies/activeEquity'),tech=require('../engines/strategies/tech'),T=require('../engines/timing');
const {data}=require('./verify_active_equity_data');
function evidence(code='999801'){
  const e={...F.evidence(code),domestic:false,qdii:true,investmentScope:'global-active-equity'};
  const valuationDates=F.rows().map(r=>r.date),availableAt=Object.fromEntries(valuationDates.map(d=>[d,C.shift(d,2)+'T18:00:00+08:00']));
  e.qdiiCalendar={code,verified:true,version:'synthetic-qdii-v1',source:'https://example.invalid/synthetic-valuation-calendar',publicationSource:'https://example.invalid/synthetic-publication-times',from:e.initializationFrom,to:'2026-09-30',subscriptionDates:['2026-09-24','2026-09-25','2026-09-28','2026-09-29','2026-09-30'],valuationDates,availableAt};
  return e;
}
async function run(){
  const identity=require('../services/activeEquityIdentity');
  for(const code of ['016664','016665','012920']){
    const resolved=await identity.resolve(code);assert.equal(resolved.error,'daily_sampling_unverified');
    for(const category of ['growth','broad','cycle','dividend']){
      const fund={code,category,name:'masked',_activeEquityData:await D.forFund({code})};
      assert.equal(R.resolveRegistry(fund).reg.type,'activeEquity');
      for(const build of [B,tech]){const result=build(fund);assert.equal(result.action,null);assert.equal(result.positionScore,null);assert.equal(result.executable,false);assert.equal(result.matrix.evidenceChecks.identity,true);assert.equal(result.matrix.evidenceChecks.calendar,false);}
    }
  }
  assert.equal(I.isActiveEquityRoute({code:'999802',name:'合成主动混合（QDII）',fundType:'QDII-混合'}),true);
  for(const fund of [
    {code:'999803',name:'合成海外精选',market:'QDII',category:'growth'},
    {code:'999804',name:'合成全球精选',market:'QDII',category:'broad',managementType:'active'},
    {code:'999805',name:'Synthetic global fund',market:'QDII',fundType:'QDII-equity',category:'dividend'},
    {code:'999807',name:'合成海外黄金资源混合（QDII）',market:'QDII',fundType:'混合型',category:'growth'},
  ]){assert.equal(I.isActiveEquityRoute(fund),true);assert.equal(R.resolveRegistry(fund).reg.type,'activeEquity');assert.equal(tech(fund).action,null);assert.equal(tech(fund).unsupportedReason,'profile_unverified');}
  assert.equal(I.isActiveEquityRoute({code:'999806',name:'合成海外指数',market:'QDII',category:'growth',managementType:'active',fundType:'指数型'}),false);
  assert.equal(I.isActiveEquityRoute({code:'016452',name:'纳斯达克100指数（QDII）',fundType:'QDII-指数'}),false);
  assert.equal(I.isActiveEquityRoute({code:'016452',name:'masked',market:'QDII',category:'growth'}),false);
  assert.equal(R.resolveRegistry({code:'016452',name:'masked',market:'QDII',category:'growth'}).reg.type,'nasdaq');
  assert.equal(R.resolveRegistry({code:'999808',name:'合成纳斯达克100',indexCode:'NDX',market:'QDII',category:'growth'}).reg.type,'nasdaq');
  assert.equal(R.resolveRegistry({code:'018391',name:'南方上海金ETF联接A',market:'A',category:'cycle'}).reg.type,'goldDual');
  assert.equal(I.isActiveEquityRoute({name:'QDII债券基金'}),false);
  const e=evidence(),ctx=C.orderContext(F.NOW,e),raw=data(e.code),good=D.prepareInput(raw,e,ctx);
  assert(good.result,good.error);assert.equal(good.result.date,'2026-09-21');assert.equal(ctx.orderDate,'2026-09-24');
  assert.equal(C.deadline('2026-09-22',e),Date.parse('2026-09-24T18:00:00+08:00'));
  assert.equal(C.orderContext(Date.parse('2026-09-24T07:00:00Z'),e).orderDate,'2026-09-25');
  const closed=structuredClone(e);closed.qdiiCalendar.subscriptionDates=closed.qdiiCalendar.subscriptionDates.filter(d=>d!=='2026-09-24');assert.equal(C.orderContext(F.NOW,closed).futureOrder,true);
  for(const [key,value,error] of [['identityVerified',false,'profile_unverified'],['samplingVerified',false,'daily_sampling_unverified'],['continuityVerified',false,'initialization_unverified'],['rulesVerified',false,'fund_calendar_unverified']]){
    const bad={...e,[key]:value},input=D.prepareInput(raw,bad,C.orderContext(F.NOW,bad));assert.equal(input.error,error);assert.equal(B({code:e.code,_activeEquityData:input}).action,null);
  }
  const absent=structuredClone(e);delete absent.qdiiCalendar.availableAt['2026-09-18'];assert.equal(D.prepareInput(raw,absent,C.orderContext(F.NOW,absent)).error,'publication_time_unverified');
  const misbound=structuredClone(e);misbound.qdiiCalendar.code='999999';assert.equal(C.orderContext(F.NOW,misbound).error,'fund_calendar_unverified');
  const coverage=structuredClone(e);coverage.qdiiCalendar.to='2026-09-23';coverage.qdiiCalendar.subscriptionDates=['2026-09-23'];assert.equal(C.orderContext(F.NOW,coverage).error,'calendar_coverage_short');
  const timezone=structuredClone(e);timezone.qdiiCalendar.availableAt['2026-09-18']='2026-09-20T18:00:00';assert.equal(C.validContract(timezone),false);
  const gap=structuredClone(raw);gap.history=gap.history.filter(r=>r.date!=='2026-09-18');gap.total=gap.history.length;gap.checksum=D.hash(gap.history);assert.match(D.prepareInput(gap,e,ctx).error,/expected_nav_gap/);
  const future=structuredClone(raw);future.history[0].nav=999;future.history[0].rawFields.DWJZ='999';future.history[0].dayChange=1;future.history[0].rawFields.JZZZL='1';future.checksum=D.hash(future.history);assert.deepEqual(D.prepareInput(future,e,ctx).result,good.result);
  const stale=structuredClone(e);stale.qdiiCalendar.valuationDates=stale.qdiiCalendar.valuationDates.filter(d=>d<='2026-09-01');stale.qdiiCalendar.availableAt=Object.fromEntries(Object.entries(stale.qdiiCalendar.availableAt).filter(([d])=>d<='2026-09-01'));
  assert.equal(C.selectKnown(stale.qdiiCalendar.valuationDates.map(date=>({date,close:1})),stale,C.orderContext(F.NOW,stale)).error,'stale_nav_over_14d');
  let requests=0;const svc=D.createService({now:()=>F.NOW,identity:{resolve:async()=>({evidence:{...e,rulesVerified:false}})},fetchText:async()=>{requests++;throw Error('unexpected network');}});assert.equal((await svc.forFund({code:e.code})).error,'fund_calendar_unverified');assert.equal(requests,0);
  // Separate share cache, requests and action identity. No A data reused for C.
  const codes=['999801','999802'],writes=[];const shares=D.createService({now:()=>F.NOW,read:()=>null,write:(key)=>writes.push(key),fetchActions:async code=>data(code).actions,fetchText:async url=>{const u=new URL(url),snapshot=data(u.searchParams.get('fundCode')),n=Number(u.searchParams.get('pageIndex'));return JSON.stringify({TotalCount:snapshot.total,Data:{LSJZList:snapshot.history.slice((n-1)*20,n*20).map(r=>r.rawFields)}});}});
  const [a,c]=await Promise.all(codes.map(code=>shares.fetchFull(code)));assert.notEqual(a,c);assert.equal(a.code,codes[0]);assert.equal(c.code,codes[1]);assert.equal(writes.length,2);
  assert.equal(D.prepareInput(a,evidence(codes[1]),C.orderContext(F.NOW,evidence(codes[1]))).error,'nav_snapshot_integrity_invalid');
  const publicDecision=B({code:e.code,_activeEquityData:good});assert(!JSON.stringify(publicDecision.matrix.identity).includes('availableAt'));assert.equal(publicDecision.matrix.evidenceChecks.calendar,true);
  // Fixed synthetic trend path; exercise B through the same frozen signal function.
  const S=require('../lib/activeEquitySignal'),trend=Array.from({length:400},(_,i)=>({date:C.shift('2024-01-01',i),P:i<370?100+i*.1:i<397?137-(i-370)*.4:126.6+(i-396),dailyValid:true}));
  assert.equal(S.analyzeAt(trend,399).B.trigger,true);assert.equal(S.analyzeAt(F.rows(),319).A.trigger,true);
  console.log('QDII：三份额路由、主动/指数边界、独立份额、日期与公告证据、完整性、时效和无回落通过');
}
function recap(){
  const code='016664',legacy={type:'buy',code,category:'growth',eventDate:'2026-09-01',amt:10,campaign:{id:'old-growth'},backfill:'done'},memory={'timing_state.json':{version:1,baselineDate:'2026-09-01',funds:{[code]:{lastVerdict:'add',campaignId:'old-growth'}}},'timing_samples.json':[legacy],'holdings.json':{funds:[{code,category:'growth',purchases:[{date:'2026-09-02',amount:10},{date:'2026-09-26',amount:20}]}]}};
  const old=JSON.stringify(legacy),oldCursor=JSON.stringify(memory['timing_state.json'].funds),purchases=JSON.stringify(memory['holdings.json']);let today='2026-09-24';
  T._forTest({today:()=>today,read:key=>memory[key],write:(key,value)=>memory[key]=structuredClone(value)});
  try{assert.equal(T.buyScan(),0);const dec=kind=>({...B(F.fund(code,kind)),category:'growth',name:'合成QDII',blockedReason:null});T.onDecide({[code]:dec('waiting')});assert.equal(memory['timing_samples.json'].length,1);today='2026-09-25';T.onDecide({[code]:dec('candidate')});today='2026-09-28';assert.equal(T.buyScan(),1);const buy=memory['timing_samples.json'].at(-1);assert.equal(buy.strategyVersion,'active-equity-buy-v1');assert.match(buy.campaign.id,/active-equity-buy-v1/);assert.equal(JSON.stringify(memory['timing_samples.json'][0]),old);assert.equal(JSON.stringify(memory['timing_state.json'].funds),oldCursor);assert.equal(JSON.stringify(memory['holdings.json']),purchases);}finally{T._forTest();}
  console.log('QDII复盘：首次基线、旧growth游标/样本/流水保留，新购买仅关联新版本通过');
}
async function api(){
  const config=require('../lib/config'),store=require('../lib/store'),util=require('../lib/util'),fetchers=require('../fetchers'),analysis=require('../engines/analysis'),advice=require('../engines/advice'),undo=[];
  const patch=(o,k,v)=>{const old=o[k];undo.push(()=>o[k]=old);o[k]=v;};
  const funds=['016664','016665','012920'].map(code=>({code,name:'合成QDII份额 '+code,market:'QDII',category:'growth',purchases:[],history:[{date:'2026-09-22',nav:1,dayChange:1}],purchaseStatus:{state:'open',updatedAt:F.NOW-1000}}));
  patch(Date,'now',()=>F.NOW);patch(config,'getConfig',()=>require('../../data/example/config.example.json'));patch(util,'todayStr',()=> '2026-09-24');patch(util,'shanghaiNow',()=>({ymd:'2026-09-24',hour:12,minute:0}));patch(util,'isTradingHours',()=>false);
  patch(D,'forFund',D.createService({now:()=>F.NOW}).forFund);
  patch(store,'readJSON',key=>key==='holdings.json'?{funds}:key==='categories.json'?require('../../data/example/categories.example.json'):{});
  for(const key of ['writeJSON','writeJSONSafe','writeDecisionHistory','appendSnapshot'])patch(store,key,()=>{throw Error('unexpected test write');});
  patch(fetchers,'fetchNavHistory',async code=>({history:funds.find(f=>f.code===code).history,failed:false}));patch(fetchers,'fetchValuation',async()=>{throw Error('QDII fell back to legacy valuation');});patch(fetchers,'fetchIndexPeHistory',async()=>{throw Error('QDII fell back to PE');});patch(fetchers,'fetchHoldings',async()=>({holdings:[],reportDate:null}));
  try{const built=await analysis.buildAnalysis();patch(analysis,'buildAnalysis',async()=>built);const out=await advice.buildAdvice('pm');assert.equal(out.funds.length,3);for(const f of out.funds){assert.equal(f.strategyVersion,'active-equity-buy-v1');assert.equal(f.marketVerdict,null);assert.equal(f.verdict,null);assert.equal(f.score,null);assert.equal(f.valueScore,null);assert.equal(f.momentumScore,null);assert.equal(f.executable,false);assert.equal(f.matrix.dataError,'daily_sampling_unverified');assert.equal(built.plan.scoreMap[f.code].marketVerdict,null);}}finally{undo.reverse().forEach(fn=>fn());}
  console.log('QDII正式分析/建议：三个旧growth份额走主动权益、空判断同源、无评分/旧估值/写入通过');
}
if(require.main===module)run().then(recap).then(api).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={evidence,run,recap,api};

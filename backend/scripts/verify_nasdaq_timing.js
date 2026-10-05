'use strict';
const assert=require('node:assert/strict'),T=require('../engines/timing'),F=require('../fixtures/nasdaqInputs');
const VERSION=require('../lib/nasdaqSignal').VERSION;
const old={type:'buy',code:'999001',category:'broad',eventDate:'2026-09-02',amt:100,campaign:null,backfill:'done'};
const db={'timing_state.json':{version:1,baselineDate:'2026-01-01',funds:{'999001':{lastVerdict:'add',campaignId:'legacy'}}},
  'timing_samples.json':[structuredClone(old)],'holdings.json':{funds:[{...F.fund(),purchases:[
    {date:'2026-09-02',amount:100},{date:'2026-09-24',amount:101},
    {date:'2026-09-28',amount:102,pricingDate:'2026-09-29',session:'T+1',shares:1,nav:100},
    {date:'2026-09-29',amount:103,session:'T+1'},
    {date:'2026-09-30',amount:104,session:'T+1',nav:100,shares:1}]}]}};
let today='2026-09-24';const cfg={timing:{historyStart:'2026-01-01',gapDays:3}};
T._forTest({today:()=>today,read:k=>db[k],write:(k,v)=>{db[k]=v;return true;}});
function decide(action,blockedReason=null,futureOrder=false){T.onDecide({'999001':{action,category:'broad',strategyVersion:VERSION,blockedReason,
  executable:action==='add'&&!blockedReason,matrix:{_type:'nasdaq',strategyVersion:VERSION,marketState:action==='add'?'candidate':'waiting',
    dataError:action==null?'missing':null,futureOrder,route:'both',conditions:{},pathStates:{draw:'buy',trend:'buy'},
    metrics:{navDate:'2026-09-22'},orderDate:today,computedAt:new Date(F.NOW).toISOString(),inputVersion:'nasdaq-live-input-v1',sourceHash:'synthetic'}}},cfg);}
try{
  const legacyState=structuredClone(db['timing_state.json'].funds);
  decide('hold');assert.equal(db['timing_samples.json'].length,1);
  today='2026-09-28';decide('add');assert.equal(db['timing_samples.json'].length,2);
  assert.match(db['timing_samples.json'][1].campaign.id,/nasdaq-dual-v1/);
  today='2026-10-01';decide(null);decide('hold','purchase_suspended');decide('hold',null,true);
  assert.equal(db['timing_state.json'].strategyFunds[VERSION]['999001'].lastRun,'2026-09-28');
  today='2026-10-08';decide('hold');assert.equal(db['timing_samples.json'].length,3);
  assert.equal(db['timing_samples.json'][2].eventDate,today);assert.equal(db['timing_samples.json'][2].approx,true);
  T.buyScan(cfg);T.buyScan(cfg);
  assert.deepEqual(db['timing_samples.json'][0],old);assert.deepEqual(db['timing_state.json'].funds,legacyState);
  const sameDay=db['timing_samples.json'].find(s=>s.type==='buy'&&s.eventDate==='2026-09-24');
  assert.equal(sameDay.strategyVersion,undefined);assert.equal(sameDay.campaign,null);
  const buy=db['timing_samples.json'].find(s=>s.type==='buy'&&s.eventDate==='2026-09-28');
  assert.equal(buy.pricingDate,'2026-09-29');assert.equal(buy.pricingSession,'T+1');assert.equal(buy.purchaseConfirmed,true);
  const pending=db['timing_samples.json'].find(s=>s.type==='buy'&&s.eventDate==='2026-09-29');
  assert.equal(pending.pricingDate,null);assert.equal(pending.purchaseConfirmed,false);
  const record=db['holdings.json'].funds[0].purchases.find(p=>p.amount===103);
  Object.assign(record,{shares:1,nav:100,pricingDate:'2026-09-30'});T.buyScan(cfg);
  assert.equal(pending.pricingDate,'2026-09-30');assert.equal(pending.purchaseConfirmed,true);
  assert.equal(pending.pricingEvidence.signature,'999001|2026-09-29|103');assert.equal(pending.pricingCompletedAt,today);
  const frozen=structuredClone(pending);record.pricingDate='2026-10-08';T.buyScan(cfg);assert.deepEqual(pending,frozen);
  assert.deepEqual(db['timing_samples.json'][0],old);
  const pricedWithoutDate=db['timing_samples.json'].find(s=>s.type==='buy'&&s.amt===104);
  assert.equal(pricedWithoutDate.purchaseConfirmed,true);assert.equal(pricedWithoutDate.pricingDate,null);
  const confirmedRecord=db['holdings.json'].funds[0].purchases.find(p=>p.amount===104);
  confirmedRecord.pricingDate='2026-10-08';T.buyScan(cfg);assert.equal(pricedWithoutDate.pricingDate,'2026-10-08');
  const completeSnapshot=structuredClone(pricedWithoutDate);confirmedRecord.pricingDate='2026-10-09';T.buyScan(cfg);
  assert.deepEqual(pricedWithoutDate,completeSnapshot);
  const stats=T.stats(cfg);assert.equal(stats.versionLedgers[VERSION].version,VERSION);
  assert.equal(stats.versionLedgers[VERSION].open.total,1);assert.equal(stats.openLedger.total,0);
  console.log('纳指复盘：基线、中断不补信号、旧版本隔离、保守同日购买与真实定价字段通过');
}finally{T._forTest();}

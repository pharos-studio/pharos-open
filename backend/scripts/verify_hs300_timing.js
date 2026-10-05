'use strict';
const assert=require('node:assert/strict');
const timing=require('../engines/timing'),F=require('./fixtures/hs300Inputs');
const VERSION=F.VERSION;
const data={'timing_state.json':{version:1,baselineDate:'2026-01-01',funds:{'999001':{campaignId:'old',lastVerdict:'add',lastAddDate:'2026-09-01'}}},
  'timing_samples.json':[{type:'advice-open',code:'999001',category:'broad',eventDate:'2026-09-01',campaign:{id:'old',openDate:'2026-09-01'},backfill:'done'},
    {type:'buy',code:'999001',category:'broad',eventDate:'2026-09-02',amt:100,campaign:null,backfill:'done'}],
  'holdings.json':{funds:[{...F.fund(),purchases:[{date:'2026-09-02',amount:100},{date:'2026-09-25',amount:100}]}]}};
let day='2026-09-24';
timing._forTest({today:()=>day,read:key=>data[key],write:(key,value)=>{data[key]=value;return true;}});
const cfg={timing:{gapDays:3,historyStart:'2026-01-01'}};
function decide(action,blockedReason=null) {timing.onDecide({'999001':{action,category:'broad',strategyVersion:VERSION,blockedReason,
  executable:!blockedReason&&action==='add',matrix:{_type:'broad300',strategyVersion:VERSION,dataError:action==null?'missing':null,
    marketState:action==='add'?'candidate':'waiting',metrics:{navDate:'2026-09-22'},orderDate:day,conditions:{},route:'trend'}}},cfg);}
try {
  const old=structuredClone(data['timing_samples.json']),cursor=structuredClone(data['timing_state.json'].funds);
  decide('hold');assert.equal(data['timing_samples.json'].length,2);
  day='2026-09-25';decide('add');assert.equal(data['timing_samples.json'].length,3);
  assert.match(data['timing_samples.json'][2].campaign.id,/hs300-dual-v1/);
  day='2026-10-01';decide(null);decide('hold','purchase_suspended');assert.equal(data['timing_samples.json'].length,3);
  assert.equal(data['timing_state.json'].strategyFunds[VERSION]['999001'].lastRun,'2026-09-25');
  day='2026-10-08';decide('hold');assert.equal(data['timing_samples.json'].length,4);
  assert.equal(data['timing_samples.json'][3].eventDate,day);assert.equal(data['timing_samples.json'][3].approx,true);
  assert.deepEqual(data['timing_samples.json'].slice(0,2),old);assert.deepEqual(data['timing_state.json'].funds,cursor);
  timing.buyScan(cfg);
  const buy=data['timing_samples.json'].find(s=>s.type==='buy'&&s.eventDate==='2026-09-25');
  assert.equal(buy.strategyVersion,VERSION);assert.match(buy.campaign.id,/hs300-dual-v1/);
  assert.equal(data['timing_samples.json'][1].campaign,null);
  const savedFund=data['holdings.json'].funds[0];
  data['holdings.json'].funds[0]={...savedFund,indexCode:'000905',trackIndex:'SH000905',name:'档案改动后的基金'};
  timing.buyScan(cfg);
  assert.equal(data['timing_samples.json'][1].campaign,null,'档案改动后也不得补附旧版本购买');
  data['holdings.json'].funds[0]=savedFund;
  const stats=timing.stats(cfg);assert.equal(stats.openLedger.total,1);
  assert.equal(stats.versionLedgers[VERSION].open.total,1);assert.equal(stats.versionLedgers[VERSION].close.total,1);
  const other='999002';day='2026-10-09';
  timing.onDecide({[other]:{action:'add',strategyVersion:VERSION,category:'broad',blockedReason:'user_limit_zero',matrix:{_type:'broad300',strategyVersion:VERSION}}},cfg);
  assert.equal(data['timing_state.json'].strategyFunds[VERSION][other],undefined);
  console.log('沪深300复盘：首次基线、中断、交易拦截、版本隔离、购买关联与分组通过');
}finally{timing._forTest();}

'use strict';
// Public synthetic runtime gate. No research files, network or user data are needed.
const assert = require('node:assert/strict');
const trend = require('../lib/dividendTrend');
const calendar = require('../lib/domesticCalendar');
const builder = require('../engines/strategies/dividend');
const decisions = require('../engines/decisions');
const {runDecisionPipeline} = require('../engines/decisionPipeline');
const {createService} = require('../services/dividendData');
const timing = require('../engines/timing');
const config = require('../lib/config'), store = require('../lib/store');
const example = require('../../data/example/config.example.json');
const rows=[];let d=new Date('2024-01-01T00:00:00Z');
for(let i=0;i<650;) {
  if(![0,6].includes(d.getUTCDay())) {rows.push({date:d.toISOString().slice(0,10),close:1+i*.0004+.035*Math.sin(i/9)});i++;}
  d.setUTCDate(d.getUTCDate()+1);
}
const known=rows.slice(0,278),orderDate=rows[278].date;
const base={code:'999991',name:'DEMO 国内红利',market:'A',category:'dividend',fundType:'指数型-股票',
  indexCode:'DEMO-INDEX',indexName:'DEMO 红利指数',profileState:'ready',
  currentValue:100,principal:100,latestNav:1,latestDate:known.at(-1).date,
  purchaseStatus:{state:'open',updatedAt:Date.parse('2026-09-30T02:00:00Z')},
  _dividendData:{known,context:{orderDate},source:'synthetic'}};
function pipeline(f,limits={},policy={core:'buy'}) {
  return runDecisionPipeline({funds:[f],allocation:[],policy,dailyLimits:limits,
    valuationMap:{},strategyConfig:example,scoreConfig:example.alloc,
    today:'2026-09-30',now:Date.parse('2026-09-30T03:00:00Z')}).scoreMap[f.code];
}
const rounded=r=>Object.fromEntries(Object.entries(r.metrics).map(([k,v])=>[k,typeof v==='number'?+v.toFixed(3):v]));
for(const params of [undefined,{},...['yield','absYield','unknown','__proto__','constructor'].map(cheapBy=>({cheapBy}))]) {
  const r=decisions.buildFundDecision({},params);assert.equal(r.action,null);assert.equal(r.unsupportedReason,'rule_disabled');
}
const candidate=trend.evaluate(known,orderDate);
const edge={close:2,ma250:1,ma60:2,dip60:-2,recovery10:1.5,bias250:8,weeklyRsi14:45,previousWeeklyRsi14:44};
assert(Object.values(trend.conditionsOf(edge)).every(Boolean));
assert(Object.values(trend.conditionsOf({...edge,dip60:-6,weeklyRsi14:65})).every(Boolean));
for(const [key,value,condition]of [['close',1,'navAboveMa250'],['ma60',1,'ma60AboveMa250'],
  ['dip60',-2+1e-8,'dip60InRange'],['dip60',-6-1e-8,'dip60InRange'],
  ['recovery10',1.5-1e-8,'recovery10Ready'],['bias250',8+1e-8,'bias250Allowed'],
  ['weeklyRsi14',45-1e-8,'weeklyRsiInRange'],['weeklyRsi14',65+1e-8,'weeklyRsiInRange'],
  ['previousWeeklyRsi14',45,'weeklyRsiRising']]) assert.equal(trend.conditionsOf({...edge,[key]:value})[condition],false);
assert.equal(candidate.trend,true);assert(Object.values(candidate.conditions).every(Boolean));
assert.equal(trend.evaluate(known.slice(-250),orderDate).available,false);
assert.equal(trend.evaluate(known,known.at(-1).date).available,false);
assert.equal(trend.evaluate([...known,{...known.at(-1)}],orderDate).available,false);
const flat=known.map(r=>({...r,close:1}));const flatResult=trend.evaluate(flat,orderDate);
assert.equal(flatResult.metrics.weeklyRsi14,50);assert.equal(flatResult.conditions.weeklyRsiRising,false);
const futureChanged=rows.map((r,i)=>({...r,close:i>=278?99:r.close}));
assert.deepEqual(trend.evaluate(futureChanged.slice(0,278),orderDate),candidate);
const summary=pipeline({...base});assert.equal(summary.marketVerdict,'add');assert.equal(summary.verdict,'add');
assert.equal(summary.executable,true);assert.equal(summary.marketScore,null);assert.deepEqual(summary.metrics,rounded(candidate));
for(const reference of [null,{value:0},{value:.09},{value:.01,asOf:'2001-01-01'}]) {
  const r=pipeline({...base,dividendYieldReference:reference});assert.equal(r.marketVerdict,'add');
}
for(const fund of [{...base,market:'QDII'},{...base,fundType:'混合型-偏股'},{...base,indexName:'DEMO 普通指数'},{...base,indexName:'恒生港股高股息指数'}]) {
  const r=pipeline(fund);assert.equal(r.marketVerdict,null);assert.equal(r.unsupportedReason,'scope_unsupported');assert.equal(r.executable,false);
}
for(const fund of [{...base,indexCode:null},{...base,_dividendData:{error:'incomplete_week_close'}},{...base,_dividendData:null}]) {
  const r=pipeline(fund);assert.equal(r.marketVerdict,null);assert.equal(r.verdict,null);assert.equal(r.executable,false);
}
const pending=pipeline({...base,profileState:'needs_review',_composite:{composite:100},_dec:{action:'add'}});
assert.equal(pending.marketVerdict,null);assert.equal(pending.executable,false);
for(const [fund,limits,policy] of [
  [{...base,purchaseStatus:{state:'suspended',updatedAt:base.purchaseStatus.updatedAt}}, {},{dividend:'buy'}],
  [{...base,purchaseStatus:{state:'unknown',updatedAt:base.purchaseStatus.updatedAt}}, {},{dividend:'buy'}],
  [{...base,purchaseStatus:{state:'open',updatedAt:1}}, {},{dividend:'buy'}],
  [{...base}, {[base.code]:0},{dividend:'buy'}],
  [{...base}, {},{core:'frozen'}]]) {
  const r=pipeline(fund,limits,policy);assert.equal(r.marketVerdict,'add');assert.equal(r.verdict,'hold');assert.equal(r.executable,false);
}
assert.equal(calendar.isOpen('2026-10-01'),false);
assert.equal(calendar.isOpen('2026-10-10'),false);
assert.equal(calendar.nextOpen('2026-09-30',2),'2026-10-09');
assert.equal(calendar.isOpen('2027-01-04'),null);
assert.equal(calendar.orderContext(Date.parse('2026-09-30T06:59:59Z')).orderDate,'2026-09-30');
assert.equal(calendar.orderContext(Date.parse('2026-09-30T07:00:00Z')).orderDate,'2026-10-08');
assert.equal(calendar.orderContext(Date.parse('2027-01-04T01:00:00Z')).error,'calendar_unverified');
const lagRows=rows.filter(r=>r.date<='2026-02-10');
const prepared=calendar.prepare(lagRows,{orderDate:'2026-02-10',knownThrough:'2026-02-10'});
assert(!prepared.error);assert.equal(prepared.known.at(-1).date,'2026-02-06');
assert.equal(calendar.prepare(lagRows.filter(r=>r.date!=='2026-02-06'),{orderDate:'2026-02-10'}).error,'incomplete_week_close');
assert.equal(calendar.prepare(lagRows.filter(r=>r.date!=='2026-02-04'),{orderDate:'2026-02-10'}).error,'nav_calendar_coverage_gap');
const monday=calendar.prepare(lagRows,{orderDate:'2026-02-09'});
assert.equal(monday.error,'incomplete_week_close');
const friday=calendar.orderContext(Date.parse('2026-02-06T08:00:00Z'));
const fridayKnown=calendar.prepare(lagRows,friday);
assert.equal(fridayKnown.error,'incomplete_week_close'); // Monday's Friday close is not knowable on Friday.

let day='2026-09-01';
const memory={'timing_state.json':{version:1,baselineDate:'2026-08-01',funds:{[base.code]:{campaignId:'legacy',lastAddDate:'2026-08-01'}}},
  'timing_samples.json':[{type:'buy',category:'dividend',code:base.code,eventDate:'2026-08-02',amt:100,campaign:null}]};
timing._forTest({today:()=>day,read:key=>structuredClone(memory[key]||null),write:(key,v)=>{memory[key]=structuredClone(v);return true;}});
const legacyCursor=JSON.stringify(memory['timing_state.json'].funds);
function feed(action,valid=true) { timing.onDecide({[base.code]:{category:'dividend',name:base.name,action:valid?action:null,
  strategyVersion:trend.VERSION,executable:false,blockedReason:'purchase_suspended',
  matrix:{_type:'dividendTrend',marketState:valid?action==='add'?'candidate':'waiting':'insufficient',metrics:candidate.metrics,conditions:candidate.conditions}}},example); }
feed('add');assert.equal(memory['timing_samples.json'].length,1);
day='2026-09-02';feed('add');assert.equal(memory['timing_samples.json'].length,1,'baseline add is not a fabricated transition');
day='2026-09-03';feed('hold');
day='2026-09-04';feed('add');assert.equal(memory['timing_samples.json'].length,2);
const open=memory['timing_samples.json'][1];assert(open.campaign.id.includes(trend.VERSION));assert.equal(open.executable,false);
day='2026-09-20';feed('hold',false);assert.equal(memory['timing_samples.json'].length,2);
assert.equal(JSON.stringify(memory['timing_state.json'].funds),legacyCursor);
memory['holdings.json']={funds:[{code:base.code,name:base.name,category:'dividend',purchases:[
  {date:'2026-08-02',amount:100},{date:'2026-09-05',amount:100}]}]};
timing.buyScan(example);
assert.equal(memory['timing_samples.json'][0].campaign,null);
assert.equal(memory['timing_samples.json'].at(-1).campaign.id,open.campaign.id);
assert.equal(timing.stats(example).strategyVersions.find(r=>r.version===trend.VERSION).open,1);
day='2026-09-21';feed('hold');assert.equal(memory['timing_samples.json'].filter(r=>r.type==='advice-close').length,1);

async function dataTests() {
  const history=[];let date=new Date('2010-01-01T00:00:00Z');
  for(let i=0;i<3400;) {
    if(![0,6].includes(date.getUTCDay())) {history.push({FSRQ:date.toISOString().slice(0,10),DWJZ:'1',LJJZ:'1',JZZZL:'0'});i++;}
    date.setUTCDate(date.getUTCDate()+1);
  }
  history.reverse();let calls=0,writes=0,clock=100000000,bad=false;
  const actions={dividends:[],splits:[],sourceUrl:'https://example.invalid/actions'};
  const request=async url=>{
    calls++;const page=Number(new URL(url).searchParams.get('pageIndex'));
    if(bad&&page===2) throw Error('simulated_page_failure');
    return JSON.stringify({TotalCount:history.length,Data:{LSJZList:history.slice((page-1)*20,page*20)}});
  };
  const service=createService({fetchText:request,fetchActions:async()=>actions,read:()=>null,write:()=>{writes++;},now:()=>clock});
  const [a,b]=await Promise.all([service.fetchFull(base.code),service.fetchFull(base.code)]);
  assert.equal(a,b);assert.equal(a.history.length,3400);assert.equal(calls,170);assert.equal(writes,1);
  clock+=3600001;const before=calls;const next=await service.fetchFull(base.code);assert.equal(next.history.length,3400);
  assert(calls-before<=3,'hourly incremental update fetched the entire history');
  clock+=86400001;bad=true;await assert.rejects(service.fetchFull(base.code),/simulated_page_failure/);
  assert.equal(writes,2,'partial history was published');
  const failed=await service.forFund(base,Date.parse('2026-09-30T02:00:00Z'));assert.equal(failed.error,'simulated_page_failure');
  const duplicate=createService({fetchText:async url=>{
    const p=Number(new URL(url).searchParams.get('pageIndex'));
    return JSON.stringify({TotalCount:40,Data:{LSJZList:history.slice(0,20)}});
  },fetchActions:async()=>actions,read:()=>null,write:()=>{throw Error('invalid history wrote');}});
  await assert.rejects(duplicate.fetchFull(base.code),/coverage_mismatch/);
  const wrongTotal=createService({fetchText:async url=>{
    const p=Number(new URL(url).searchParams.get('pageIndex'));
    return JSON.stringify({TotalCount:p===1?40:41,Data:{LSJZList:history.slice((p-1)*20,p*20)}});
  },fetchActions:async()=>actions,read:()=>null,write:()=>{throw Error('partial history wrote');}});
  await assert.rejects(wrongTotal.fetchFull(base.code),/coverage_mismatch/);
}
async function adviceTests() {
  const analysis=require('../engines/analysis');
  const old={analysis:analysis.buildAnalysis,read:store.readJSON,write:store.writeJSONSafe,history:store.writeDecisionHistory,cfg:config.getConfig};
  try {
    config.getConfig=()=>example;store.readJSON=()=>({});store.writeJSONSafe=()=>true;
    store.writeDecisionHistory=()=>true;
    for(const error of [null,'incomplete_week_close','calendar_unverified']) {
      const f={...base,_dividendData:error?{error}:base._dividendData};
      const sm=pipeline(f);
      analysis.buildAnalysis=async()=>({funds:[f],plan:{scoreMap:{[f.code]:sm}},asOf:'DEMO',allocation:[],
        totals:{totalPrincipal:100,totalNetInvested:100,totalFee:0,totalValue:100,totalProfit:0,totalProfitPct:0}});
      const card=(await require('../engines/advice').buildAdvice('pm')).funds[0];
      assert.equal(card.marketVerdict,sm.marketVerdict);assert.equal(card.verdict,sm.verdict);
      assert.equal(card.score,null);assert(!card.conclusion.includes('数据不足但'));
      assert.match(card.detail,/仅参考/);
    }
  } finally {
    analysis.buildAnalysis=old.analysis;store.readJSON=old.read;store.writeJSONSafe=old.write;store.writeDecisionHistory=old.history;config.getConfig=old.cfg;
  }
}
async function analysisTests() {
  const analysis=require('../engines/analysis'),fetchers=require('../fetchers'),util=require('../lib/util');
  const service=require('../services/dividendData'),{REGISTRY}=require('../engines/registry');
  const undo=[];
  const patch=(object,key,value)=>{const old=object[key];undo.push(()=>{object[key]=old;});object[key]=value;};
  let inputCalls=0;
  const demo=[{...base,purchases:[],feeRate:0},{...base,code:'999992',profileState:'needs_review',purchases:[],feeRate:0}];
  try {
    patch(Date,'now',()=>Date.parse('2026-09-30T03:00:00Z'));
    patch(config,'getConfig',()=>example);
    patch(util,'todayStr',()=> '2026-09-30');
    patch(util,'isTradingHours',()=>false);
    patch(util,'shanghaiNow',()=>({ymd:'2026-09-30',hour:11,minute:0}));
    patch(store,'readJSON',key=>key==='holdings.json'?{funds:demo}:key==='categories.json'
      ?require('../../data/example/categories.example.json'):{});
    for(const key of ['writeJSONSafe','writeJSON','writeDecisionHistory','appendSnapshot'])
      patch(store,key,()=>{throw Error('unexpected integration write: '+key);});
    patch(fetchers,'fetchNavHistory',async()=>({history:known.slice(-250).reverse().map(r=>({date:r.date,nav:r.close})),failed:false}));
    patch(fetchers,'fetchValuation',()=>{throw Error('dividend used obsolete valuation proxy');});
    patch(fetchers,'fetchDanjuanEvaList',async()=>({'SH000922':{dyr:.09}}));
    patch(service,'forFund',async fund=>{inputCalls++;return fund.profileState==='needs_review'?{error:'profile_unverified'}:base._dividendData;});
    const built=await analysis.buildAnalysis();
    assert.equal(inputCalls,2);
    assert.equal(built.funds[0].dividendYieldReference.value,null,'another index was used as dividend reference');
    const encoded=JSON.stringify(built);
    assert(!encoded.includes('_dividendData'));assert(!encoded.includes('"known":'),'full signal history leaked into API');
    assert.equal(built.plan.scoreMap['999992'].marketVerdict,null);
    assert.equal(built.plan.scoreMap['999992'].verdict,null);
    assert.equal(built.plan.scoreMap['999992'].marketStateLabel,'档案待确认');
    patch(analysis,'buildAnalysis',async()=>built);
    for(const reg of Object.values(REGISTRY)) patch(reg,'builder',()=>{throw Error('duplicate dividend strategy calculation');});
    const advice=await require('../engines/advice').buildAdvice('pm');
    for(const f of advice.funds) {
      const sm=built.plan.scoreMap[f.code];
      assert.equal(f.marketVerdict,sm.marketVerdict);assert.equal(f.verdict,sm.verdict);
      assert.equal(f.executable,sm.executable);assert.equal(f.marketState,sm.marketState);
      assert.equal(f.score,null);assert.equal(f.valueScore,null);assert.equal(f.momentumScore,null);
    }
    assert.equal(inputCalls,2,'advice repeated full-history fetch');
  } finally {undo.reverse().forEach(restore=>restore());}
}
(async()=>{await dataTests();await adviceTests();await analysisTests();console.log('国内红利正式规则：纯计算、完整历史、时序、约束、接口同源、空值和版本隔离通过');})().catch(e=>{console.error(e);process.exitCode=1;});

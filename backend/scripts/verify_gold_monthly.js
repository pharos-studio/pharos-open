'use strict';
const assert=require('node:assert/strict'),I=require('../lib/goldMonthlyIdentity');
const NOW=Date.parse('2026-10-12T14:00:00Z'),codes=[...I.CODES];
function verifyEsmSyntax(){const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
  for(const file of ['api.js','pages/review.js','pages/decision-card.js','pages/macro-policy.js']){
    const source=fs.readFileSync(path.join(__dirname,'../../public/js',file),'utf8');
    const out=cp.spawnSync(process.execPath,['--input-type=module','--check'],{input:source,encoding:'utf8'});assert.equal(out.status,0,`${file}: ${out.stderr}`);
  }
  const malformed="import x from './x.js'; const row=el('td',{},[el('span',{text:'state'}));";
  const bad=cp.spawnSync(process.execPath,['--input-type=module','--check'],{input:malformed,encoding:'utf8'});assert.notEqual(bad.status,0,'ESM syntax guard must reject a missing children-array bracket');
}
function evidence(code){return {code,name:'合成黄金'+code,shareClass:code==='000217'||code==='018392'?'C':'A',domestic:true,otc:true,currency:'CNY',kind:'gold-etf-link',group:'spot-gold',identityVerified:true,source:'https://www.huaan.com.cn/synthetic/'+code,sourceSha256:'0'.repeat(64),verifiedAt:'2026-10-12T00:00:00Z',effectiveFrom:'2013-01-01'};}
async function snapshot(options={}){const config=require('../lib/config'),store=require('../lib/store'),util=require('../lib/util'),fetchers=require('../fetchers'),service=require('../services/goldData'),analysis=require('../engines/analysis'),advice=require('../engines/advice'),timing=require('../engines/timing'),undo=[];
  const patch=(o,k,v)=>{const old=o[k];undo.push(()=>o[k]=old);o[k]=v;};
  const funds=codes.map((code,index)=>({code,name:'合成黄金基金'+(index+1),category:'cycle',market:'A',profileState:'ready',feeRate:0,purchases:index===0?[{date:'2026-09-30',amount:100,shares:50,nav:2,pricingDate:'2026-10-01'},{date:'2026-10-05',amount:20,shares:null}]:[],purchaseStatus:{state:index===1?'suspended':index===2?'unknown':'open',updatedAt:NOW}}));
  if(options.purchaseStamp!=null)funds[0].purchaseStatus.updatedAt=options.purchaseStamp;
  const cfg=structuredClone(require('../../data/example/config.example.json'));if(options.userLimit!=null)cfg.dailyLimits[codes[0]]=options.userLimit;if(options.policy)cfg.categoryPolicy[util.engineCategoryToBucket('cycle')]=options.policy;
  patch(I.LEDGER,'releaseEnabled',options.enabled??I.enabled());const entries=codes.map(evidence);if(options.invalidIdentity)entries[3].identityVerified=false;patch(I.LEDGER,'funds',entries);
  patch(Date,'now',()=>NOW);patch(config,'getConfig',()=>cfg);patch(util,'todayStr',()=> '2026-10-12');patch(util,'shanghaiNow',()=>({ymd:'2026-10-12',hour:22,minute:0}));patch(util,'isTradingHours',()=>false);
  patch(store,'readJSON',key=>key==='holdings.json'?{funds}:key==='categories.json'?require('../../data/example/categories.example.json'):{});patch(store,'readDecisionHistory',()=>[]);
  for(const key of ['writeJSON','writeJSONSafe','writeDecisionHistory','appendSnapshot'])patch(store,key,()=>{throw Error('unexpected test write');});
  if(options.session==='am'){patch(store,'writeJSONSafe',(key,value)=>{assert.equal(key,'signals.json');assert.deepEqual(value,{});return true;});patch(store,'writeDecisionHistory',value=>{assert.deepEqual(value.funds,{});return true;});}
  patch(fetchers,'fetchNavHistory',async()=>({history:options.emptyNav===false?[{date:'2026-10-09',nav:2}]:[],failed:false}));patch(fetchers,'fetchValuation',async()=>null);patch(fetchers,'fetchHoldings',async()=>({holdings:[],reportDate:null}));
  patch(service,'forFund',async()=>{if(options.enabled!==false)throw Error('monthly must not fetch A/B history');return {error:'profile_unverified'};});
  patch(timing,'onDecide',()=>({opened:0,closed:0,baseline:false}));
  try{const built=await analysis.buildAnalysis();patch(analysis,'buildAnalysis',async()=>built);if(options.noScoreMap)built.plan.scoreMap={};const card=await advice.buildAdvice(options.session||'pm');return {analysis:JSON.parse(JSON.stringify(built)),advice:JSON.parse(JSON.stringify(card))};}finally{undo.reverse().forEach(fn=>fn());}
}
async function timingIsolation(){const T=require('../engines/timing'),L=require('../data/goldIdentity.json'),original=L.releaseEnabled,monthly=I.LEDGER.releaseEnabled;
  const state={version:1,baselineDate:'2026-09-01',funds:{},strategyFunds:{'gold-dual-v1':{'000216':{baselineDate:'2026-09-01',lastVerdict:'add',campaignId:'old'}}}},samples=[{type:'advice-open',code:'000216',strategyVersion:'gold-dual-v1',eventDate:'2026-09-02',campaign:{id:'old',openDate:'2026-09-02'},backfill:'done'},{type:'buy',code:'000216',strategyVersion:'gold-dual-v1',eventDate:'2026-09-04',amt:10,campaign:null,pricingDate:null,backfill:'pending'}];
  const memory={'timing_state.json':state,'timing_samples.json':samples,'holdings.json':{funds:[{code:'000216',category:'cycle',purchases:[{date:'2026-09-04',amount:10,shares:10,nav:1,pricingDate:'2026-09-04'},{date:'2026-10-10',amount:99,shares:99,nav:1,pricingDate:'2026-10-10'}]}]}};
  T._forTest({today:()=> '2026-10-12',read:key=>memory[key],write:(key,value)=>memory[key]=structuredClone(value)});
  try{I.LEDGER.releaseEnabled=true;L.releaseEnabled=false;const before=JSON.stringify(memory);T.onDecide({'000216':{name:'黄金',category:'cycle',action:null,matrix:{_type:'goldMonthly',strategyVersion:'gold-monthly-dca-v1',marketState:'monthly_dca'}}});assert.equal(JSON.stringify(memory),before);assert.equal(T.buyScan(),0);assert.equal(JSON.stringify(memory),before);
    L.releaseEnabled=true;assert.equal(T.buyScan(),0);const updated=memory['timing_samples.json'];assert.equal(updated.length,2);assert.equal(updated[1].pricingDate,'2026-09-04');assert.equal(updated[1].campaign.id,'old');assert.equal(updated[1].strategyVersion,'gold-dual-v1');assert.deepEqual(memory['timing_state.json'],state);assert.equal(T.buyScan(),0);
  }finally{I.LEDGER.releaseEnabled=monthly;L.releaseEnabled=original;T._forTest();}
}
function verifyReleaseDefaults(){
  assert.equal(I.enabled(),true,'public monthly plan must be enabled');
  assert.equal(require('../data/goldIdentity.json').releaseEnabled,false,'legacy quant gate must remain disabled');
  const build=require('../engines/strategies/gold');
  for(const code of codes){
    assert.equal(I.eligibility(I.evidenceOf(code)),null,`${code}: current official identity`);
    const out=build({code,name:'黄金',category:'cycle'});
    assert.equal(out.strategyVersion,'gold-monthly-dca-v1');assert.equal(out.matrix.marketState,'monthly_dca');
    assert.equal(out.matrix.displayKind,'plan');assert.equal(out.matrix.frequency,'monthly');
    for(const key of ['action','marketVerdict','verdict','positionScore'])assert.equal(out[key],null);
    assert.equal(out.executable,false);assert.equal(out.eligible,false);
  }
}
async function run(){verifyEsmSyntax();verifyReleaseDefaults();
  for(const session of ['am','pm'])for(const noScoreMap of [false,true]){const out=await snapshot({session,noScoreMap});assert.equal(out.advice.funds.length,7);for(const f of out.advice.funds){assert.equal(f.strategyVersion,'gold-monthly-dca-v1');assert.equal(f.marketState,'monthly_dca');assert.equal(f.displayKind,'plan');assert.equal(f.frequency,'monthly');for(const k of ['marketVerdict','verdict','score','valueScore','momentumScore'])assert.equal(f[k],null);assert.equal(f.eligible,false);assert.equal(f.executable,false);assert.equal(f.matrix.dataError,null);assert(!f.constraints.includes('policy_blocked'));}}
  assert.equal((await snapshot({invalidIdentity:true})).advice.funds[3].unsupported,true);
  for(const [opts,reason]of [[{policy:'frozen'},'policy_blocked'],[{userLimit:0},'user_limit_zero'],[{purchaseStamp:NOW+1},'purchase_status_unverified']])assert.equal((await snapshot(opts)).advice.funds[0].blockedReason,reason);
  assert((await snapshot({enabled:false})).advice.funds.every(f=>f.strategyVersion==='gold-dual-v1'));
  const gate=I.LEDGER.releaseEnabled,old=I.LEDGER.funds;try{I.LEDGER.releaseEnabled=true;I.LEDGER.funds=codes.map(evidence);const f={code:'000216',name:'合成黄金'};const original=Date.now;Date.now=()=>NOW;try{for(const builder of [require('../engines/strategies/gold'),require('../engines/strategies/gold').buildSignalDecision,x=>require('../engines/kernel').buildFundDecision(x,{cheapBy:'pricePercentile'}),require('../engines/decisions').buildGoldDecision])assert.equal(builder(f).strategyVersion,'gold-monthly-dca-v1');}finally{Date.now=original;}assert.equal(require('../engines/registry').resolveRegistry({code:'999999',name:'黄金'}).reg.type,'goldMonthly');assert.equal(require('../engines/strategies/goldMonthly')({code:'999999',name:'黄金'}).unsupportedReason,'scope_unsupported');assert.equal(require('../engines/registry').resolveRegistry({code:'999700',name:'白银期货',category:'cycle'}).reg.type,'cycle');for(const mutation of [{identityVerified:false},{source:'https://evil.example/fund'},{verifiedAt:'2027-01-01T00:00:00Z'},{currency:'USD'},{otc:false}])assert(I.eligibility({...evidence('000216'),...mutation},NOW));}finally{I.LEDGER.releaseEnabled=gate;I.LEDGER.funds=old;}
  await timingIsolation();const monthlyGate=I.LEDGER.releaseEnabled;try{I.LEDGER.releaseEnabled=true;await require('./verify_gold_backfill').run();}finally{I.LEDGER.releaseEnabled=monthlyGate;}
  console.log('gold monthly: API null/no-score/empty NAV, independent constraints, gate/compatibility/scope and old-version pricing/relink/backfill isolation passed');}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});module.exports={run,snapshot,syntheticPayload:snapshot,timingIsolation,verifyEsmSyntax,verifyReleaseDefaults,evidence,NOW};

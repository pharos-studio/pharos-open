'use strict';
const assert=require('node:assert/strict'),F=require('../fixtures/activeEquityInputs');
async function snapshot(options={}){const config=require('../lib/config'),store=require('../lib/store'),util=require('../lib/util'),fetchers=require('../fetchers'),service=require('../services/activeEquityData'),undo=[],patch=(o,k,v)=>{const old=o[k];undo.push(()=>o[k]=old);o[k]=v;},kinds=['candidate','waiting','insufficient','profile_pending','suspended','future'],funds=kinds.map((k,i)=>F.fund('99910'+(i+1),k));let t=F.NOW;
  if(options.purchaseStamp!=null)funds[0].purchaseStatus.updatedAt=options.purchaseStamp;
  patch(Date,'now',()=>t);patch(config,'getConfig',()=>require('../../data/example/config.example.json'));patch(util,'todayStr',()=> '2026-09-24');patch(util,'shanghaiNow',()=>({ymd:'2026-09-24',hour:12,minute:0}));patch(util,'isTradingHours',()=>false);
  patch(store,'readJSON',key=>key==='holdings.json'?{funds}:key==='categories.json'?require('../../data/example/categories.example.json'):{});for(const key of ['writeJSON','writeJSONSafe','writeDecisionHistory','appendSnapshot'])patch(store,key,()=>{throw Error('unexpected test write');});patch(fetchers,'fetchNavHistory',async code=>({history:funds.find(f=>f.code===code).history,failed:false}));patch(fetchers,'fetchValuation',async()=>{throw Error('active used legacy valuation');});patch(fetchers,'fetchIndexPeHistory',async()=>{throw Error('active used legacy PE');});patch(fetchers,'fetchHoldings',async()=>({holdings:[],reportDate:null}));
  patch(service,'forFund',async fund=>{const i=funds.findIndex(f=>f.code===fund.code),out=F.input(fund.code,kinds[i]);if(i===0&&options.initializationPending)out.evidence.continuityVerified=false;if(i===kinds.length-1&&options.finalInstant)t=options.finalInstant;return out;});
  try{const analysis=require('../engines/analysis'),advice=require('../engines/advice'),built=await analysis.buildAnalysis();patch(analysis,'buildAnalysis',async()=>built);const {REGISTRY}=require('../engines/registry');patch(REGISTRY.activeEquity,'builder',()=>{throw Error('duplicate active strategy evaluation');});const card=await advice.buildAdvice('pm');return {analysis:JSON.parse(JSON.stringify(built)),advice:JSON.parse(JSON.stringify(card))};}finally{undo.reverse().forEach(fn=>fn());}}
async function run(){for(const options of [{},{finalInstant:Date.parse('2026-09-24T08:00:00Z')},{purchaseStamp:F.NOW+1},{initializationPending:true}]){const out=await snapshot(options);assert.equal(out.advice.funds.length,6);for(const f of out.advice.funds){const sm=out.analysis.plan.scoreMap[f.code];assert.equal(f.strategyVersion,'long-term-accumulation-v1');assert.equal(f.marketState,'record_only');for(const k of ['action','marketVerdict','verdict','score','valueScore','momentumScore'])assert.equal(f[k],null);assert.equal(f.executable,false);assert.equal(f.eligible,false);assert.equal(sm.marketVerdict,null);assert.equal(f.unsupported,false);assert(!out.advice.issues.some(i=>i.code===f.code));}assert.equal(out.advice.alerts.length,0);}console.log('主动权益 API：正常/缺数据/未知身份/暂停/未来日期均仅记账，空判断同源且无策略故障通过');}
async function realGates(){const I=require('../services/activeEquityIdentity'),L=require('../data/activeEquityIdentity.json'),B=require('../engines/strategies/activeEquity'),D=require('../services/activeEquityData'),R=require('../engines/registry');
  // 已核验落笔的条目：闸门必须放行，并进入真实策略；其余仍须被挡住且不得给出结论。
  // 2026-10-08：三只 QDII（016664/016665/012920）四道门已全部签署放行——采样、连续性、
  // 以及含基金专属 qdiiCalendar 的规则门，故纳入已核验集合，应产出真实判断。
  const VERIFIED=new Set(['008903','003095','260108','270005','001714','016874','016664','016665','012920']);
  for(const e of L.funds){const verified=VERIFIED.has(e.code),resolved=await I.resolve(e.code);
    if(verified){assert.equal(resolved.error,undefined,e.code+' 已核验却仍被闸门拦下：'+resolved.error);const input=await D.forFund({code:e.code});assert.equal(input.error,undefined,e.code+' 输入仍报错：'+input.error);assert(input.result,e.code+' 缺少策略结果');}
    else if(resolved.error===undefined){assert.equal((await D.forFund({code:e.code})).error,'fund_calendar_unverified',e.code+' 四门已过却未停在日历门');}
    else assert.equal(resolved.error,'daily_sampling_unverified');
    for(const category of ['growth','broad','cycle','dividend']){const fund={code:e.code,category,name:'masked',_activeEquityData:await D.forFund({code:e.code})};assert.equal(R.resolveRegistry(fund).reg.type,'recordOnly');assert.equal(B(fund).action,null);assert.equal(B(fund).marketState,'record_only');const decision=B.legacy(fund);
      if(verified){assert.equal(decision.unsupported,false,e.code+' 不应再标记 unsupported');assert(['add','hold'].includes(decision.action),e.code+' 应进入真实策略，实际 action='+decision.action);}
      else{assert.equal(decision.action,null);assert.equal(decision.executable,false);const why=(decision.reasons&&decision.reasons[0])||'';assert(/采样|日历|开放规则/.test(why),e.code+' 拦截原因不对：'+why);}}}}
async function trimSnapshot({active=true,session='am',existing=false}={}){
  const config=require('../lib/config'),store=require('../lib/store'),util=require('../lib/util'),analysis=require('../engines/analysis'),timing=require('../engines/timing'),advice=require('../engines/advice'),pipeline=require('../engines/decisionPipeline'),undo=[],writes=[],patch=(o,k,v)=>{const old=o[k];undo.push(()=>o[k]=old);o[k]=v;},cfg=structuredClone(require('../../data/example/config.example.json'));
  cfg.categoryPolicy[util.engineCategoryToBucket('growth')]='frozen';
  const fund=F.fund(active?'999101':'999777');fund.name=active?'合成国内主动混合C':'合成半导体指数C';fund.fundType=active?'混合型-偏股':'指数型-股票';fund.currentValue=120;fund.principal=100;fund.profitPct=20;fund.latestNav=1.2;fund.latestDate='2026-09-22';
  if(!active){delete fund._activeEquityData;delete fund.managementType;}
  const id='trim:'+fund.code,seed=existing?{[id]:{active:true,lastFired:'2026-08-01'}}:{},expected=structuredClone(seed),plan=pipeline.runDecisionPipeline({funds:[fund],policy:cfg.categoryPolicy,dailyLimits:cfg.dailyLimits,strategyConfig:cfg,scoreConfig:require('../services/scoreConfig').getAllocCfg(cfg),now:F.NOW,today:'2026-09-24'});
  patch(Date,'now',()=>F.NOW);patch(util,'todayStr',()=> '2026-09-24');patch(config,'getConfig',()=>cfg);
  patch(analysis,'buildAnalysis',async()=>({asOf:'2026-09-24',funds:[fund],allocation:[],totals:{},plan}));
  patch(store,'readJSON',key=>key==='signals.json'?seed:{});patch(store,'readDecisionHistory',()=>[]);patch(store,'writeJSONSafe',(key,value)=>{writes.push({key,value:structuredClone(value)});return true;});patch(store,'writeDecisionHistory',()=>true);patch(timing,'onDecide',()=>({opened:0,closed:0}));
  try{return {advice:await advice.buildAdvice(session),writes,signals:structuredClone(seed),expected,id};}finally{undo.reverse().forEach(fn=>fn());}
}
async function buyOnlyScope(){for(const active of [true,false])for(const session of ['am','pm'])for(const existing of [false,true]){const out=await trimSnapshot({active,session,existing});const f=out.advice.funds[0];assert.equal(f.marketState,'record_only');assert.equal(f.marketVerdict,null);assert.equal(f.verdict,null);assert.equal(f.executable,false);assert.equal(f.eligible,false);assert.equal(out.advice.alerts.length,0);assert.deepEqual(out.signals,out.expected);for(const write of out.writes.filter(w=>w.key==='signals.json'))assert.deepEqual(write.value,out.expected);if(session==='pm')assert.equal(out.writes.length,0);}console.log('主动与主题C：冻结AM/PM无买卖/等待提醒，已有冷却不改，缺证不伪装错误通过');}
async function openCalendarGates(){const C=require('../lib/activeEquityCalendar'),L=require('../data/activeEquityIdentity.json');
  // 016874 的开放日窄于 A 股交易日：合同 p10/p26 允许在非港股通交易日不开放。例外清单必须来自
  // 交易所年度安排（事前可知），且必须覆盖全部实测停业日；否则退回 fund_calendar_unverified。
  const e=L.funds.find(f=>f.code==='016874');assert(e,'台账缺少 016874');assert.equal(e.openCalendar,'cn-minus-hkconnect');
  assert.notEqual(C.openExceptionEvidence(e),null,'例外证据不完整');assert.equal(C.validContract(e),true);
  for(const d of e.openExceptions)assert(C.dates.includes(d),'例外日不是 CN 交易日：'+d);
  for(const d of e.openClosureObservations)assert(e.openExceptions.includes(d),'实测停业日未被官方清单覆盖：'+d);
  const at=(s,ev)=>C.orderContext(Date.parse(s+'T10:00:00+08:00'),ev||e);
  assert.equal(at('2025-07-01').orderDate,'2025-07-02','例外日应顺延到下一个确定开放日');
  assert.equal(at('2025-07-01').futureOrder,true);
  assert.equal(at('2025-07-02').orderDate,'2025-07-02');
  assert.equal(at('2023-01-19').orderDate,'2023-01-30');
  assert.equal(at('2024-12-31').orderDate,'2025-01-02');
  assert.equal(at('2026-07-01').orderDate,'2026-07-02');
  assert.equal(at('2013-06-03').error,'calendar_coverage_short','早于例外覆盖起点必须拒绝');
  const drop=k=>{const o={...e};delete o[k];return o;};
  assert.equal(C.validContract(drop('openExceptionsSources')),false);
  assert.equal(C.validContract({...e,openExceptionsSources:[{url:'https://x/',sha256:'nope'}]}),false);
  assert.equal(C.validContract({...e,openExceptions:[...e.openExceptions,'2025-07-05'].sort()}),false);
  assert.equal(C.validContract({...e,openExceptions:[...e.openExceptions].reverse()}),false);
  assert.equal(C.validContract({...e,openExceptionsFrom:'2023-06-01'}),false);
  assert.equal(C.validContract({...e,openCalendar:'cn'}),true);
  assert.equal(at('2025-07-01',{...e,openCalendar:'cn'}).orderDate,'2025-07-01','旧口径行为不得改变');
  console.log('主动权益开放日例外：官方清单健全、实测停业日全被覆盖、例外日顺延、证据缺失退回、旧口径不变 通过');
}
// ★ realGates（真实台账 × 真实净值，需联网）已移到verify_active_equity_real_gates.js，
//   归入 test:network：净值快照缓存在被 gitignore 的目录里，CI 的全新 checkout 必然要联网。
if(require.main===module)run().then(openCalendarGates).then(buyOnlyScope).catch(e=>{console.error(e);process.exitCode=1;});module.exports={snapshot,syntheticPayload:snapshot,run,realGates,openCalendarGates,trimSnapshot,buyOnlyScope};

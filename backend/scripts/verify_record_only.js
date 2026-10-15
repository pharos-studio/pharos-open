'use strict';
// Synthetic full-chain fixture, exported for desktop/mobile browser checks.
// All IO is in memory; this script never starts a service or writes account files.
const assert = require('node:assert/strict');
const NOW = Date.parse('2026-10-15T04:00:00Z');
function fixture() {
  const rows = [
    {code:'999301',name:'合成半导体指数C',fundType:'指数型-股票',indexName:'中证半导体产业指数',category:'growth'},
    {code:'999302',name:'合成行业错分类C',fundType:'指数型-股票',indexName:'恒生科技指数',category:'broad',trackIndex:'NDX',profileState:'needs_review'},
    {code:'999303',name:'合成海外主动混合C',fundType:'QDII-混合',category:'cycle',market:'QDII'},
    {code:'008903',name:'已登记主动份额（脱敏）',category:'dividend'},
    {code:'999304',name:'旧档案未知基金',category:'growth',profileState:'needs_review'},
    {code:'999305',name:'合成中证500指数',fundType:'指数型-股票',indexName:'中证500指数',indexCode:'000905',trackIndex:'SH000905',category:'broad'},
    {code:'999306',name:'合成海外宽基',fundType:'QDII-指数',indexName:'标普500指数',trackIndex:'SPX',category:'broad',market:'QDII',caliber:'us'},
    {code:'999307',name:'合成普通红利指数',fundType:'指数型-股票',indexName:'中证红利指数',indexCode:'000922',trackIndex:'SH000922',category:'dividend'},
    {code:'000216',name:'合成黄金ETF联接A',fundType:'指数型-其他',category:'cycle'},
    {code:'999308',name:'合成银行间债券',fundType:'债券型-长债',category:'bond'},
    {code:'999309',name:'合成信息货币',fundType:'货币型-普通货币',category:'cash'},
    {code:'999310',name:'合成白银商品指数',fundType:'指数型-其他',indexName:'白银期货指数',category:'cycle'},
    {code:'202015',name:'合成沪深300联接',fundType:'指数型-股票',indexName:'沪深300指数',indexCode:'000300',trackIndex:'SH000300',category:'broad'},
    {code:'016452',name:'合成纳斯达克100',fundType:'QDII-指数',indexName:'纳斯达克100指数',indexCode:'NDX',trackIndex:'NDX',category:'broad',market:'QDII',caliber:'us'},
  ];
  return rows.map(f=>({market:'A',profileState:'ready',feeRate:0,caliber:null,...f,
    history:Array.from({length:320},(_,i)=>({date:new Date(NOW-i*86400000).toISOString().slice(0,10),nav:2+i/1000,dayChange:.2})),
    purchases:[{date:'2026-09-01',amount:100,nav:2,shares:50,sharesSource:'broker',shareCalcVersion:2}],
    purchaseStatus:{state:'open',updatedAt:NOW,maxBuy:1000}}));
}
async function snapshot({session='pm',funds:customFunds}={}) {
  const config=require('../lib/config'),store=require('../lib/store'),util=require('../lib/util'),fetchers=require('../fetchers');
  const undo=[],writes=[],calls=[],patch=(o,k,v)=>{const old=o[k];undo.push(()=>o[k]=old);o[k]=v;};
  const funds=customFunds || fixture(),cfg=structuredClone(require('../../data/example/config.example.json'));
  cfg.categoryPolicy.growth='frozen';cfg.categoryPolicy.tech='frozen';
  const memory={'holdings.json':{_schemaVersion:2,funds},'categories.json':require('../../data/example/categories.example.json'),
    'signals.json':{'trim:999301':{active:true,lastFired:'2026-09-01'}},
    'timing_state.json':{version:1,baselineDate:'2026-09-01',funds:{'999301':{campaignId:'old',lastVerdict:'add'}}},
    'timing_samples.json':[{type:'advice-open',code:'999301',name:'旧主题历史',category:'growth',eventDate:'2026-09-01',campaign:{id:'old',openDate:'2026-09-01'},backfill:'done'}]};
  const oldSamples=structuredClone(memory['timing_samples.json']);
  patch(Date,'now',()=>NOW);patch(config,'getConfig',()=>cfg);patch(util,'todayStr',()=> '2026-10-15');patch(util,'shanghaiNow',()=>({ymd:'2026-10-15',hour:12,minute:0}));patch(util,'isTradingHours',()=>false);
  patch(store,'readJSON',key=>memory[key]||{});patch(store,'readDecisionHistory',()=>[{date:'2026-10-08',funds:{'999301':{factors:[{dim:'旧因子',value:1}],verdict:'add'}}}]);
  for(const key of ['writeJSON','writeJSONSafe'])patch(store,key,(file,value)=>{writes.push({file,value:structuredClone(value)});memory[file]=structuredClone(value);return true;});
  patch(store,'writeDecisionHistory',value=>{writes.push({file:'decision_history.json',value:structuredClone(value)});return true;});patch(store,'appendSnapshot',()=>{throw Error('unexpected snapshot write');});
  patch(fetchers,'fetchNavHistory',async code=>{calls.push({kind:'accountNav',code});return {history:funds.find(f=>f.code===code).history,failed:false};});
  patch(fetchers,'fetchValuation',async index=>{assert.notEqual(index,'NDX','stopped theme must not fetch legacy PE');return {pe:15,pePercentile:20,treasury10y:.02};});
  patch(fetchers,'fetchBond10Y',async()=>({cn:.02,us:.04}));patch(fetchers,'fetchIndexPeHistory',async index=>{assert.notEqual(index,'NDX');return Array.from({length:200},(_,i)=>({date:new Date(NOW-i*7*86400000).toISOString().slice(0,10),pe:15+i/20}));});
  patch(fetchers,'fetchHoldings',async()=>({holdings:[],reportDate:null}));
  patch(require('../services/activeEquityData'),'forFund',async()=>{throw Error('stopped active history service called');});
  patch(require('../services/activeEquityData'),'revalidateInput',()=>{throw Error('stopped active revalidation called');});
  patch(require('../services/hs300Data'),'forFund',async fund=>require('./fixtures/hs300Inputs').input(fund.code));
  patch(require('../services/nasdaqData'),'forFund',async fund=>require('../fixtures/nasdaqInputs').input(fund.code));
  try {
    const analysis=require('../engines/analysis'),advice=require('../engines/advice'),timing=require('../engines/timing');
    const built=await analysis.buildAnalysis();patch(analysis,'buildAnalysis',async()=>built);
    const card=await advice.buildAdvice(session);
    if(session==='am')timing.buyScan();
    return {analysis:JSON.parse(JSON.stringify(built)),advice:JSON.parse(JSON.stringify(card)),
      state:{holdings:structuredClone(memory['holdings.json']),categories:structuredClone(memory['categories.json']),config:cfg,navMeta:{}},
      holdings:structuredClone(memory['holdings.json']),writes,calls,memory:structuredClone(memory),oldSamples};
  } finally {undo.reverse().forEach(fn=>fn());}
}
async function run() {
  const scope=require('../lib/strategyScope'),registry=require('../engines/registry');
  for(const f of fixture().slice(0,5))for(const category of ['growth','broad','dividend','cycle','bond','cash']) {
    // Unknown identity is only conservatively stopped in its original growth category.
    if(f.code==='999304'&&category!=='growth')continue;
    const changed={...f,category};assert(scope.isRecordOnly(changed),f.code+'/'+category);assert.equal(registry.resolveRegistry(changed).reg.type,'recordOnly');
    const dec=require('../engines/decisions').buildCoreDecision(changed,{},{});assert.equal(dec.action,null);assert.equal(dec.marketState,'record_only');
  }
  for(const fund of [
    {fundType:'债券型',name:'银行间信息债券',category:'bond'},
    {fundType:'货币型',name:'科技公司货币基金',category:'cash'},
    {fundType:'指数型-股票',name:'信息公司基金',indexName:'中证500指数',category:'broad'},
    {fundType:'QDII-指数',indexName:'标普500指数',category:'broad'},
    {fundType:'指数型-股票',indexName:'中证红利指数',category:'dividend'},
    {fundType:'指数型-其他',indexName:'白银期货指数',category:'cycle'}]) assert(!scope.isRecordOnly(fund),JSON.stringify(fund));
  assert(scope.isRecordOnly({fundType:'指数型-股票',indexName:'全指信息',category:'broad',trackIndex:'SH000300'}));
  assert(scope.isRecordOnly({fundType:'股票型',name:'主动股票基金',indexCode:'000300',indexName:'沪深300指数',category:'broad'}));
  const lookup={code:'999777',found:true,profileRevision:'synthetic',autoProfile:{name:'旧未知基金',category:'growth',market:'A'},confirmations:{proxy:false}};
  const chosen=require('../lib/fundProfile').applySelected(lookup,'synthetic',{category:'broad'}).profile;
  assert.equal(chosen.strategyScope,'record_only');assert(scope.isRecordOnly(chosen));
  assert.equal(scope.fields({strategyScope:'record_only',scopeReason:'active_equity',category:'broad'}).scopeReason,'active_equity');
  await profileRoutes();
  await sectorRoutes();
  for(const session of ['am','pm']) {
    const out=await snapshot({session}),recorded=out.advice.funds.filter(f=>f.marketState==='record_only');assert.equal(recorded.length,5);
    assert.equal(out.analysis.funds.length,14);assert.equal(out.analysis.totals.totalValue,1400);assert.equal(out.analysis.totals.totalPrincipal,1400);
    for(const f of recorded) {
      const sm=out.analysis.plan.scoreMap[f.code];
      for(const row of [f,sm]) {for(const k of ['action','marketVerdict','verdict','score','marketScore','valueScore','momentumScore'])assert.equal(row[k],null,f.code+'/'+k);assert.equal(row.executable,false);assert.equal(row.eligible,false);assert.equal(row.unsupported,false);}
      assert(!out.advice.issues.some(i=>i.code===f.code));assert(!out.advice.alerts.some(i=>i.code===f.code));assert.equal(out.advice.weekAgo[f.code],undefined);
    }
    assert.equal(out.advice.funds.find(f=>f.code==='999307').strategyVersion,'dividend-monthly-dca-v1');
    assert.equal(out.advice.funds.find(f=>f.code==='000216').strategyVersion,'gold-monthly-dca-v1');
    assert.equal(out.advice.funds.find(f=>f.code==='016452').strategyVersion,'nasdaq-dual-v1');
    assert.equal(out.advice.funds.find(f=>f.code==='202015').strategyVersion,'hs300-dual-v1');
    assert.deepEqual(out.memory['timing_samples.json'].filter(s=>recorded.some(f=>f.code===s.code)),out.oldSamples);
    assert.deepEqual(out.memory['signals.json'],{'trim:999301':{active:true,lastFired:'2026-09-01'}});
    for(const w of out.writes.filter(w=>w.file==='decision_history.json'))for(const f of recorded)assert.equal(w.value.funds[f.code],undefined);
    if(session==='pm')assert.equal(out.writes.length,0);
  }
  const T=require('../engines/timing'),old={version:1,baselineDate:'2026-09-01',funds:{'999301':{campaignId:'old',lastVerdict:'add'}}},samples=[{code:'999301',category:'growth',type:'advice-open',campaign:{id:'old'},backfill:'done'}];
  T._forTest({today:()=> '2026-10-15',read:key=>key==='holdings.json'?{funds:fixture()}:key==='timing_state.json'?old:key==='timing_samples.json'?samples:null,write:()=>{throw Error('record-only timing write');}});
  try {for(const action of ['add','hold'])T.onDecide({'999301':{category:'growth',name:'旧行业',action,matrix:{_type:'tech'}},'008903':{category:'broad',action,strategyVersion:'active-equity-buy-v1',matrix:{_type:'activeEquity'}}});}finally{T._forTest();}
  const h=require('./verify_gold_simple_ui').harness([{code:'999301',name:'仅记账UI',...scope.fields({category:'growth'}),latestNav:2}]);await h.render();
  const card=h.root.querySelector('.dec-card');assert.match(card.textContent,/仅记账/);assert(!card.attrs.degraded);assert(!/还缺什么|数据待补齐|等待机会/.test(card.textContent));
  h.context.store.reloadAdvice=async()=>{throw Error('synthetic advice unavailable');};await h.render();
  const fallback=h.root.querySelector('.dec-card');assert.match(fallback.textContent,/仅记账/);assert(!fallback.attrs.degraded);assert(!/还缺什么|数据待补齐|等待机会|暂无策略判断/.test(fallback.textContent));
  console.log('record only: identity/category bypass, retained strategies/assets, AM/PM alerts/history/timing/cooldown, no active input fetch, and actual review DOM passed');
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
async function profileRoutes() {
  const http=require('node:http'),{Readable}=require('node:stream'),profile=require('../lib/fundProfile'),store=require('../lib/store'),config=require('../lib/config');
  const undo=[],patch=(o,k,v)=>{const old=o[k];undo.push(()=>o[k]=old);o[k]=v;};
  let handler,holdings={_schemaVersion:2,funds:[]};
  let looked={code:'999777',found:true,archiveFound:true,profileRevision:'theme',confirmations:{proxy:false},autoProfile:{name:'合成半导体指数',fundType:'指数型-股票',indexName:'半导体指数',category:'growth',market:'A',strategyScope:'record_only',scopeReason:'theme_sector'}};
  patch(http,'createServer',fn=>{handler=fn;return {};});patch(config,'getApiKey',()=> 'synthetic-test-key');
  patch(profile,'lookup',async()=>structuredClone(looked));patch(require('../engines/shareMigration'),'isPending',()=>false);
  patch(store,'readJSON',key=>key==='holdings.json'?structuredClone(holdings):{});patch(store,'withFileLocks',async(keys,fn)=>fn());
  patch(store,'writeJSONSafe',(key,value)=>{assert.equal(key,'holdings.json');holdings=structuredClone(value);return true;});patch(require('../engines/feeSync'),'syncFundFees',async()=>({}));
  const serverPath=require.resolve('../server'),cached=require.cache[serverPath];delete require.cache[serverPath];
  try {
    require('../server');assert.equal(typeof handler,'function');
    const request=async(url,body,method='POST')=>{const req=Readable.from([JSON.stringify(body)]);req.url=url;req.method=method;req.headers={'x-api-key':'synthetic-test-key'};let status,result;await handler(req,{writeHead:c=>status=c,end:s=>result=JSON.parse(s)});assert.equal(status,200,JSON.stringify(result));return result;};
    await request('/api/funds',{code:looked.code,profileRevision:'theme',confirmations:{category:'broad',strategyScope:null}});
    assert.equal(holdings.funds[0].strategyScope,'record_only');assert.equal(holdings.funds[0].category,'broad');
    patch(require('../services/dividendReference'),'get',async()=>{throw Error('record only requested add-on reference');});
    assert.equal((await request('/api/dividend-reference?code=999777',{},'GET')).marketState,'record_only');
    assert.equal((await request('/api/fund-degraded?code=999777',{},'GET')).marketState,'record_only');
    await request('/api/funds/999777/reidentify',{action:'confirm',profileRevision:'theme',confirmations:{category:'cycle',strategyScope:null}});
    assert.equal(holdings.funds[0].strategyScope,'record_only');assert.equal(holdings.funds[0].category,'cycle');
    const raw=structuredClone(holdings);raw.funds[0].strategyScope=null;assert(profile.profileWriteError(raw,holdings));
    looked={...looked,profileRevision:'corrected',autoProfile:{name:'合成中证500指数',fundType:'指数型-股票',indexName:'中证500指数',indexCode:'000905',category:'broad',market:'A',strategyScope:null,scopeReason:null}};
    await request('/api/funds/999777/reidentify',{action:'confirm',profileRevision:'corrected',confirmations:{category:'broad'}});
    assert.equal(holdings.funds[0].strategyScope,null);assert.equal(holdings.funds[0].scopeReason,null);assert(!require('../lib/strategyScope').isRecordOnly(holdings.funds[0]));
    const old={funds:[{code:'999777',name:'旧档案',category:'growth',profileState:'ready',estimateProvider:'sina'}]};
    const migrated=profile.migrateFundRecords(old,{},new Map([['999777',{strategyScope:'record_only',scopeReason:'theme_sector'}]]));assert.equal(migrated.changed,false);assert.equal(migrated.holdings.funds[0].strategyScope,undefined);
  } finally {undo.reverse().forEach(fn=>fn());delete require.cache[serverPath];if(cached)require.cache[serverPath]=cached;}
}
async function sectorRoutes() {
  const names=['中证申万有色金属指数','中证全指能源指数','中证全指原材料指数','国证资源行业指数','中证石油天然气产业指数','中证基建工程指数','中证家用电器指数','中证建筑装饰指数','中证黄金产业股票指数',
    '银行红利低波指数','煤炭红利指数','中证中药指数','中证新材料主题指数','中证云计算与大数据主题指数','中证航运产业指数','中证5G产业50指数','中证基础设施指数',
    '合成甲行业指数','合成乙产业指数','合成丙主题指数','合成丁行业红利指数'];
  const scope=require('../lib/strategyScope'),registry=require('../engines/registry');
  const http=require('node:http'),{Readable}=require('node:stream'),fetchers=require('../fetchers'),quotes=require('../lib/indexQuote'),store=require('../lib/store'),config=require('../lib/config');
  const undo=[],patch=(o,k,v)=>{const old=o[k];undo.push(()=>o[k]=old);o[k]=v;};
  let handler,holdings={_schemaVersion:2,funds:[]};
  const archives=Object.fromEntries(names.map((indexName,i)=>[String(990100+i),{name:'合成'+indexName,type:'指数型-股票',indexName,indexCode:'SYNTHETIC-SECTOR-'+i,market:'A',suggestedCategory:'broad',suggestedCaliber:'cn',suggestedBy:'type'}]));
  patch(http,'createServer',fn=>{handler=fn;return {};});patch(config,'getApiKey',()=> 'synthetic-test-key');
  patch(fetchers,'fundAutoFill',async code=>({found:true,archiveFound:true,source:'archive',code,...archives[code]}));
  patch(fetchers,'fetchFundRates',async()=>null);patch(quotes,'fetchIndexQuote',async()=>null);
  patch(require('../engines/shareMigration'),'isPending',()=>false);patch(store,'readJSON',key=>key==='holdings.json'?structuredClone(holdings):{});
  patch(store,'withFileLocks',async(keys,fn)=>fn());patch(store,'writeJSONSafe',(key,value)=>{assert.equal(key,'holdings.json');holdings=structuredClone(value);return true;});
  patch(require('../engines/feeSync'),'syncFundFees',async()=>({}));
  const serverPath=require.resolve('../server'),cached=require.cache[serverPath];delete require.cache[serverPath];
  try {
    require('../server');
    const request=async(url,body={},method='POST')=>{const req=Readable.from([JSON.stringify(body)]);req.url=url;req.method=method;req.headers={'x-api-key':'synthetic-test-key'};let status,result;await handler(req,{writeHead:c=>status=c,end:s=>result=JSON.parse(s)});assert.equal(status,200,JSON.stringify(result));return result;};
    let chains=0;
    for(const [code,archive] of Object.entries(archives)) {
      const looked=await request('/api/fund-lookup?code='+code,{},'GET');
      assert.equal(looked.strategyScope,'record_only',archive.indexName+' lookup');
      assert.equal(looked.autoProfile.strategyScope,'record_only');assert.equal(looked.autoProfile.scopeReason,'theme_sector');
      for(const [i,category] of ['broad','cycle','dividend','bond','cash','growth'].entries()) {
        // Exercise the actual save callback, then refresh/advice with the saved
        // automatic profile. The accounting selection cannot erase its scope.
        const body={code,profileRevision:looked.profileRevision,confirmations:{category,strategyScope:null},...(i?{action:'confirm'}:{})};
        await request(i?'/api/funds/'+code+'/reidentify':'/api/funds',body);
        const saved=holdings.funds.find(f=>f.code===code);assert.equal(saved.category,category);assert.equal(saved.strategyScope,'record_only');
        const raw={...saved,strategyScope:null,scopeReason:null,trackIndex:'SH000300'};
        assert.equal(scope.reasonOf(raw),'theme_sector',archive.indexName+'/'+category+' raw identity');
        assert.equal(registry.resolveRegistry(raw).reg.type,'recordOnly');
        const funded=fixture()[0],account={...funded,...saved,purchases:funded.purchases};
        const out=await snapshot({funds:[account],session:'am'});
        assert.equal(out.analysis.totals.totalValue,100);assert.equal(out.analysis.totals.totalPrincipal,100);
        for(const row of [out.analysis.plan.scoreMap[code],out.advice.funds[0]]) {
          assert.equal(row.marketState,'record_only');assert.equal(row.unsupported,false);
          for(const key of ['action','marketVerdict','verdict','score','marketScore'])assert.equal(row[key],null,archive.indexName+'/'+category+'/'+key);
          assert.equal(row.executable,false);assert.equal(row.eligible,false);
        }
        assert.equal(out.advice.issues.length,0);assert.equal(out.advice.alerts.length,0);
        assert(!out.memory['timing_samples.json'].some(s=>s.code===code));
        for(const write of out.writes.filter(w=>w.file==='decision_history.json'))assert.equal(write.value.funds[code],undefined);
        chains++;
      }
    }
    const commodities=[['上海金价格指数','goldMonthly'],['白银期货指数','cycle'],['原油期货指数','cycle'],['有色金属期货指数','cycle']];
    for(const [i,[indexName,route]] of commodities.entries()) {
      const fund={...fixture()[0],code:String(990200+i),name:'合成'+indexName,fundType:'指数型-其他',indexName,category:'cycle'};
      assert.equal(scope.isRecordOnly(fund),false,indexName);assert.equal(registry.resolveRegistry(fund).reg.type,route,indexName);
      const out=await snapshot({funds:[fund]});assert.notEqual(out.advice.funds[0].marketState,'record_only');assert.equal(out.analysis.totals.totalValue,100);
    }
    for(const indexName of ['银行红利低波指数','煤炭红利指数'])for(const fundType of ['指数型-股票',null]) {
      const fund={code:'990299',category:'dividend',indexName,fundType};assert.equal(scope.reasonOf(fund),'theme_sector');assert.equal(registry.resolveRegistry(fund).reg.type,'recordOnly');
    }
    for(const indexName of ['中证红利指数','红利低波50指数','标普中国A股大盘红利低波50指数','央企红利指数','国企红利指数','红利主题指数']) {
      const fund={code:'990298',fundType:'指数型-股票',category:'dividend',indexName};assert.equal(scope.isRecordOnly(fund),false,indexName);assert.equal(registry.resolveRegistry(fund).reg.type,'dividend');
    }
    for(const indexName of ['中证500指数','沪深300指数','标普500指数','中证800行业中性指数','全行业宽基指数','行业均衡因子指数','多行业均衡指数']) {
      const fund={code:'990297',name:'合成科技管理公司基金',fundType:'指数型-股票',category:'broad',indexName};
      assert.equal(scope.isRecordOnly(fund),false,indexName);assert.notEqual(registry.resolveRegistry(fund).reg.type,'recordOnly');
    }
    assert.equal(scope.isRecordOnly({category:'broad'}),false);
    for(const fundType of ['债券型-长债','货币型-普通货币','混合型-偏债','混合型-平衡']) {
      assert.equal(scope.isRecordOnly({name:'合成科技机构',fundType,managementType:'active',category:'bond'}),false,fundType);
    }
    for(const indexName of ['有色金属产业期货指数','黄金行业现货价格指数']) {
      assert.equal(scope.isRecordOnly({fundType:'指数型-其他',indexName,category:'cycle'}),false,indexName);
    }
    assert.equal(scope.isRecordOnly({fundType:'指数型-其他',indexName:'黄金产业股票指数',category:'cycle'}),true);
    console.log('record only sector fix: '+names.length+' stock sectors/explicit markers × 6 accounting categories, real lookup/save/refresh/advice chains '+chains+'; physical/futures commodities, broad baskets and dividend factors retained');
  } finally {undo.reverse().forEach(fn=>fn());delete require.cache[serverPath];if(cached)require.cache[serverPath]=cached;}
}
module.exports={NOW,fixture,snapshot,run,profileRoutes,sectorRoutes};

'use strict';
const assert=require('node:assert/strict'),{harness,fixture}=require('./verify_gold_simple_ui');
// Obtain the required field sets from real frozen production outputs rather than a partial toy fixture.
function productionSchemas(){
  const G=require('../lib/goldSignal'),A=require('../lib/activeEquitySignal'),N=require('../lib/nasdaqSignal'),H=require('../lib/hs300Signal');
  const g=G.rules({bias120:-6,bias120Min10:-7.5,rsi14:50,previousRsi14:49,close:100,ma250:94,ma60:101,drawdown60:5,recovery10:2,bias60:0});
  const rows=Array.from({length:300},(_,i)=>({date:new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10),P:100+i*.05+Math.sin(i/5),dailyValid:true,availableAt:new Date(Date.UTC(2025,0,2+i)).toISOString()}));
  const a=A.analyzeAt(rows,299);
  const n=N.evaluate({price:{count:270,close:100,ma:{60:101,250:94},bias:{120:-6,250:6},biasRepair:{120:1.5},pullback:5,recovery:2},week:{count:20,rsi:{14:50},rsiPrev:{14:49}},pe:{state:'ready',percentile:20},quality:{prices:true,weeks:true}});
  const h=H.evaluate({available:true,navDays:300,biases:{120:-4,250:5},repairs:{120:1.5},rsis:{weekly:{14:{valid:true,count:20,current:50,previous:49}}},price:100,mas:{60:101,250:94},dip60:3,recovery10:2},{available:true,percentile:20});
  return {'gold-dual-v1':{A:Object.keys(g.conditions.A),B:Object.keys(g.conditions.B)},'active-equity-buy-v1':{A:Object.keys(a.A.checks),B:Object.keys(a.B.checks)},'nasdaq-dual-v1':{draw:Object.keys(n.draw.conditions),trend:Object.keys(n.trend.conditions)},'hs300-dual-v1':{deep:Object.keys(h.deep.conditions),trend:Object.keys(h.trend.conditions)}};
}
async function run(){
  const h=harness();await h.render();const C=h.context;
  const build=C.buildDecisionExplanation;
  const schemas=productionSchemas();let partialCases=0;
  for(const version of ['nasdaq-dual-v1','hs300-dual-v1','active-equity-buy-v1','gold-dual-v1']){
    const [a,b]=Object.keys(schemas[version]), val=v=>version==='nasdaq-dual-v1'?{value:5,pass:v}:v;
    const fullConditions=Object.fromEntries([a,b].map(path=>[path,Object.fromEntries(schemas[version][path].map(key=>[key,val(true)]))]));
    if(version==='hs300-dual-v1')fullConditions.peGate=true;
    const base={strategyVersion:version,marketVerdict:'add',verdict:'hold',blockedReason:'purchase_suspended',conditions:fullConditions};
    base.conditions[b][schemas[version][b][0]]=val(null);
    if(version!=='hs300-dual-v1')base.pathStates={[a]:'buy',[b]:'unknown'};
    const one=build(base);assert.match(one.reason,/下跌后回稳/);assert.match(one.reason,/未核实/);assert(!one.reason.includes('两种情况重合'));assert.equal(one.paths[1].state,null);
    const both=structuredClone(base);both.conditions[b][schemas[version][b][0]]=val(true);if(both.pathStates)both.pathStates[b]='buy';assert.match(build(both).reason,/重合只形成一条候选/);
    for(const target of [a,b])for(const key of schemas[version][target])for(const mode of ['single','both'])for(const mutation of ['omitted','null',...(version==='nasdaq-dual-v1'?['value_null','value_omitted','pass_omitted']:[])]){
      const partial=structuredClone(both);
      partial.pathStates={[a]:mode==='both'||target===a?'buy':'unknown',[b]:mode==='both'||target===b?'buy':'unknown'};
      if(mutation==='omitted')delete partial.conditions[target][key];else if(mutation==='null')partial.conditions[target][key]=val(null);else if(mutation==='value_null')partial.conditions[target][key].value=null;else if(mutation==='value_omitted')delete partial.conditions[target][key].value;else delete partial.conditions[target][key].pass;
      const saved=JSON.stringify(partial),explanation=build(partial),index=target===a?0:1;
      assert.equal(explanation.paths[index].state,true);assert.match(explanation.summary,/分项依据尚未完整核实/);assert(!explanation.summary.includes('完整条件已成立'));assert.equal(JSON.stringify(partial),saved);assert(explanation.paths[index].unknown.length>0);
      if(mutation==='omitted')assert.equal(explanation.paths[index].hasCompletePathEvidence,false);
      const actual=harness([{...partial,code:'PARTIAL-'+version,name:'分项待核合成基金'}]);await actual.render();
      const det=actual.root.querySelector('.dec-card'),title=det.querySelectorAll('.decision-path')[index].querySelector('h3').textContent;
      assert.match(det.children[0].textContent,/加仓/);assert.match(det.querySelector('.dec-overview').textContent,/分项依据尚未完整核实/);assert.match(title,/分项尚待核实/);assert(!title.includes('分项条件成立'));
      if(mode==='both')assert.match(explanation.summary,/只是一条候选/);
      partialCases++;
    }
    const waiting=structuredClone(base);waiting.marketVerdict='hold';waiting.conditions[a][schemas[version][a][0]]=val(false);waiting.conditions[b][schemas[version][b][0]]=val(false);if(waiting.pathStates)waiting.pathStates={[a]:'hold',[b]:'hold'};assert.match(build(waiting).reason,/尚缺/);assert(!build(waiting).reason.includes('完整条件已成立'));
    const unknown=structuredClone(base);unknown.marketVerdict=null;unknown.matrix={dataErrorLabel:'日频采样尚未核验'};assert.match(build(unknown).reason,/日频采样尚未核验/);assert(!build(unknown).reason.includes('完整条件已成立'));
    const stale=structuredClone(base);stale.marketState='insufficient';assert(!build(stale).reason.includes('完整条件已成立'));
    const conflict=structuredClone(base);conflict.conditions[a][schemas[version][a][0]]=val(false);if(conflict.pathStates)assert.match(build(conflict).reason,/不一致/);
    const card=C.decisionStatusCard(base);assert.match(card.textContent,/暂停申购/);assert.match(card.textContent,/加仓/);
  }
  for(const mutation of ['omitted','null'])for(const mode of ['single','both']){
    const conditions=Object.fromEntries(Object.entries(schemas['hs300-dual-v1']).map(([path,fields])=>[path,Object.fromEntries(fields.map(key=>[key,true]))]));
    if(mutation==='null')conditions.peGate=null;
    const record={strategyVersion:'hs300-dual-v1',marketVerdict:'add',verdict:'add',conditions,pathStates:{deep:'buy',trend:mode==='both'?'buy':'unknown'}};
    const reading=build(record);assert.equal(reading.paths[0].state,true);assert.match(reading.reason,/分项依据尚未完整核实/);assert(!reading.reason.includes('完整条件已成立'));
    const actual=harness([{...record,code:'HS-GATE',name:'共同入口待核'}]);await actual.render();assert.match(actual.root.querySelector('.decision-path').querySelector('h3').textContent,/分项尚待核实/);partialCases++;
  }
  const sparseGold=build({strategyVersion:'gold-dual-v1',marketVerdict:'add',conditions:{A:{negativeBias:true},B:{}},pathStates:{A:'buy',B:'unknown'}});assert.match(sparseGold.summary,/分项依据尚未完整核实/);
  const empty=build({strategyVersion:'hs300-dual-v1',marketVerdict:null,conditions:{peGate:false,deep:{},trend:{}}});assert.equal(empty.paths[0].state,null);assert(!empty.summary.includes('已成立'));
  for(const pathStates of [{deep:'buy',trend:'unknown'},{deep:'buy',trend:'buy'}]){
    const commonOnly={code:'HS300-EMPTY',name:'沪深300共同门槛合成记录',strategyVersion:'hs300-dual-v1',marketVerdict:'add',verdict:'add',conditions:{peGate:true,deep:{},trend:{}},pathStates};
    const saved=JSON.stringify(commonOnly),reading=build(commonOnly);assert.equal(reading.paths[0].state,true);assert.equal(reading.paths[0].hasPathEvidence,false);assert.match(reading.summary,/分项依据尚未完整核实/);assert(!reading.summary.includes('完整条件已成立'));assert.equal(JSON.stringify(commonOnly),saved);
    const actual=harness([commonOnly]);await actual.render();const det=actual.root.querySelector('.dec-card');assert.match(det.children[0].textContent,/加仓/);assert.match(det.querySelector('.dec-overview').textContent,/分项依据尚未完整核实/);assert.match(det.querySelector('.decision-path').querySelector('h3').textContent,/分项尚待核实/);assert(!det.querySelector('.decision-path').querySelector('h3').textContent.includes('分项条件成立'));
    if(pathStates.trend==='buy')assert.match(reading.summary,/只是一条候选/);
  }
  for(const [blockedReason,text]of [['daily_sampling_unverified','日频采样'],['price_warmup','历史不足'],['hs300_data_unavailable','完整资料']]){const top=build({strategyVersion:'hs300-dual-v1',marketVerdict:null,blockedReason,conditions:{peGate:null,deep:{},trend:{}}});assert.match(top.summary,new RegExp(text));assert(!top.summary.includes(blockedReason));}
  const suspendedUnknown=build({strategyVersion:'hs300-dual-v1',marketVerdict:null,blockedReason:'purchase_suspended',conditions:{}});assert(!suspendedUnknown.summary.includes('暂停'));
  const ordinary=[
    {name:'普通宽基',marketVerdict:'hold',factors:[{dim:'PE分位',value:'中性',status:'neutral'},{dim:'趋势',value:'跌破半年线',status:'cheap'},{dim:'PE闸',value:'放行'}]},
    {name:'普通主题',marketVerdict:'hold',factors:[{dim:'止跌',value:'否'},{dim:'双均线',value:'金叉(MA20>MA60)'},{dim:'PE闸',value:'放行'}]},
    {name:'其他商品',marketVerdict:'add',factors:[{dim:'250日分位',value:'便宜',status:'cheap'},{dim:'趋势',value:'跌破半年线'},{dim:'急涨闸',value:'急涨放行'}]},
    {name:'普通海外',marketVerdict:'hold',factors:[{dim:'PE滚动156周分位',value:'100%（贵）',status:'expensive'},{dim:'趋势',value:'跌破半年线'},{dim:'PE闸',value:'放行'}]}
  ];
  ordinary.forEach(s=>{const x=build({...s,score:99,title:'下跌后回稳已成立'});assert(!x.summary.includes('足够细分依据'));assert(!x.summary.includes('下跌后回稳'));assert.equal(x.paths.length,0);assert.equal(build({...s,score:1}).summary,x.summary);});
  assert.match(build(ordinary[2]).summary,/不是基本面估值/);
  const fallback=build({marketVerdict:'add',title:'全部达标',detail:'低估强烈建议买入',score:100,factors:[{dim:'PE',value:3}]});assert.match(fallback.summary,/足够细分依据/);
  assert.match(build({...fixture()[0],unsupported:true,unsupportedReason:'profile_unverified'}).summary,/身份/);assert(!build({...fixture()[0],unsupported:true}).summary.includes('按月定投'));
  const funds=ordinary.map((s,i)=>({...s,code:'DEMO-'+i,verdict:s.marketVerdict,score:80,detail:'原依据',conclusion:'原结论'}));
  const mixed=harness([...fixture(),...funds]);await mixed.render();
  for(const d of mixed.root.querySelectorAll('.dec-card').filter(n=>n.attrs['data-strategy-version']!=='gold-monthly-dca-v1')){assert.match(d.textContent,/当前情况/);assert.match(d.textContent,/判断原因/);assert.match(d.textContent,/还缺什么/);const ev=d.querySelector('.decision-evidence');assert.equal(ev.open,false);assert(!d.children[0].textContent.includes('综合分'));assert(!d.querySelector('.dec-overview').textContent.includes('原结论'));}
  assert.equal(mixed.root.querySelectorAll('.dec-card').length,fixture().length+ordinary.length);
  const hostile=C.decisionStatusCard({name:'<img onerror=evil()>',marketVerdict:'hold',factors:[{dim:'PE闸',value:'<script>evil</script>'}]});assert.match(hostile.textContent,/<img/);assert(!hostile.children.some(n=>n.tag==='img'));
  console.log('readable decisions: '+partialCases+' production-schema required-key omission/null × single/both actual DOM cases; tri-state/authority/plan/ordinary factors/XSS passed');
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});module.exports={run};

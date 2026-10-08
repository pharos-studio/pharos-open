'use strict';
const crypto=require('node:crypto'),http=require('../lib/http'),store=require('../lib/store');
const actionsParser=require('../lib/fundAdjustedNav'),NAV=require('../lib/nasdaqNav'),C=require('../lib/nasdaqCalendar'),S=require('../lib/nasdaqSignal');
const identity=require('./nasdaqIdentity'),PE=require('./nasdaqPe'),{eligibility}=require('../lib/nasdaqIdentity');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const rawHistoryValid=rows=>Array.isArray(rows)&&rows.length>0&&rows.every((r,i)=>r&&r.rawFields&&S.validDate(r.date)&&
  r.date===r.rawFields.FSRQ&&Number.isFinite(r.nav)&&r.nav>0&&r.nav===Number(r.rawFields.DWJZ)&&r.navType===r.rawFields.NAVTYPE&&
  (r.dayChange??null)===(r.rawFields.JZZZL===''||r.rawFields.JZZZL==null?null:Number(r.rawFields.JZZZL))&&(!i||r.date<rows[i-1].date));
function initializationError(data,evidence,instant){
  if(evidence?.initializationPolicy!=='first-ten-joint')return null;
  const init=data.initialization;
  if(!Number.isFinite(instant)||!Number.isFinite(data.fetchedAt)||!init||data.code!==evidence.code||
    data.initializationChecksum!==hash(init)||init.code!==evidence.code||init.source!==data.source||
    init.source!==`https://fundf10.eastmoney.com/jjjz_${evidence.code}.html`||
    !Number.isFinite(init.establishedAt)||init.establishedAt>instant||init.establishedAt>data.fetchedAt||
    !S.validDate(evidence.identityNotBefore)||!S.validDate(init.seedDate)||!S.validDate(init.seedEstablishedOn)||
    init.seedDate<evidence.identityNotBefore||init.seedEstablishedOn>C.localDay(init.establishedAt)||
    !rawHistoryValid(init.originHistory)||init.establishedFromChecksum!==hash(init.originHistory)||
    init.originHistory.some(r=>r.date>C.localDay(init.establishedAt)))return 'initialization_cache_invalid';
  const actual=C.findInitialSeed(init.originHistory,evidence.identityNotBefore);
  if(!actual||actual.seedDate!==init.seedDate||actual.seedEstablishedOn!==init.seedEstablishedOn)return 'initialization_seed_not_established';
  // Bind the immutable established prefix to the current own-share source. Earlier additions cannot move it.
  const present=new Map((data.history||[]).map(r=>[r.date,r]));
  for(const r of init.originHistory.filter(r=>r.date>=init.seedDate&&r.date<=init.seedEstablishedOn))
    if(!present.has(r.date)||hash(present.get(r.date))!==hash(r))return 'initialization_source_revision_conflict';
  return null;
}
function createService(deps={}){
  const now=deps.now||Date.now,read=deps.read||store.readJSON,write=deps.write||store.writeJSONSafe,request=deps.fetchText||http.fetchText;
  const memory=new Map(),failures=new Map(),inflight=new Map();
  async function page(code,n){
    const json=JSON.parse(await request(`https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${n}&pageSize=20`,{Referer:'https://fundf10.eastmoney.com/'}));
    const raw=json.Data?.LSJZList,total=Number(json.TotalCount);
    if(!Array.isArray(raw)||!raw.length||!Number.isSafeInteger(total)||total<=0)throw Error('invalid_nav_page');
    const rows=raw.map(r=>({date:r.FSRQ,nav:Number(r.DWJZ),dayChange:r.JZZZL===''||r.JZZZL==null?null:Number(r.JZZZL),navType:r.NAVTYPE,rawFields:r}));
    if(rows.some(r=>!S.validDate(r.date)||!Number.isFinite(r.nav)||r.nav<=0))throw Error('invalid_nav_row');return {rows,total};
  }
  async function actionsOf(code){
    if(deps.fetchActions)return deps.fetchActions(code);
    const url=actionsParser.sourceUrl(code),html=await request(url,{Referer:'https://fundf10.eastmoney.com/'},20000);
    const labels=[...html.matchAll(/<label\b[^>]*class=["']left["'][^>]*>([\s\S]*?)<\/label>/gi)].map(m=>m[1]).filter(x=>/^\s*\d{4}年度/.test(x));
    const codes=[...new Set(labels.flatMap(x=>[...x.matchAll(/https?:\/\/fund\.eastmoney\.com\/(\d{6})\.html/g)].map(m=>m[1])))];
    if(codes.length!==1||codes[0]!==code)throw Error('actions_body_identity_mismatch');
    return {...actionsParser.parseActions(html,code),identityVerified:true,code};
  }
  async function pagesOf(code,count){
    const out=Array(count);let next=0;
    await Promise.all(Array.from({length:Math.min(4,count)},async()=>{while(next<count){const i=next++;out[i]=await page(code,i+2);}}));
    return out;
  }
  function validCache(c,code){return c?.version===1&&c.code===code&&Array.isArray(c.history)&&c.total===c.history.length&&
    Number.isFinite(c.fetchedAt)&&Number.isFinite(c.fullCheckedAt)&&c.fullCheckedAt<=c.fetchedAt&&c.fetchedAt<=now()&&
    c.source===`https://fundf10.eastmoney.com/jjjz_${code}.html`&&c.actions?.code===code&&c.actions?.sourceUrl===actionsParser.sourceUrl(code)&&
    rawHistoryValid(c.history)&&
    c.checksum===hash(c.history)&&c.actionsHash===hash(c.actions)&&NAV.adjust(c.history,c.actions,code).rows;}
  async function load(code){
    const evidence=(await (deps.identity||identity).resolve(code)).evidence;
    let old=memory.get(code),cached=null;
    if(!old)try{cached=read(`cache/nasdaq_nav_${code}.json`);}catch(_){}
    if(cached&&evidence?.initializationPolicy==='first-ten-joint'){
      const error=initializationError(cached,evidence,now());if(error)throw Error(error);
    }
    if(!old&&validCache(cached,code))old=cached;
    if(old){const error=initializationError(old,evidence,now());if(error)throw Error(error);}
    if(old&&now()>=old.fetchedAt&&now()-old.fetchedAt<3600000){memory.set(code,old);return old;}
    const failure=failures.get(code);if(failure&&now()>=failure.at&&now()-failure.at<300000)throw Error(failure.error);
    try{
      const [first,actions]=await Promise.all([page(code,1),actionsOf(code)]);if(actions.error)throw Error(actions.error);
      const incremental=old&&now()-old.fullCheckedAt<86400000&&first.total>=old.total&&hash(actions)===old.actionsHash;
      const pages=incremental?Math.min(Math.ceil(first.total/20),Math.max(2,Math.ceil((first.total-old.total+40)/20))):Math.ceil(first.total/20);
      const rest=await pagesOf(code,pages-1),all=[first,...rest];
      if(all.some((p,i)=>p.total!==first.total||p.rows.length!==Math.min(20,first.total-i*20)))throw Error('nav_page_coverage_mismatch');
      let history=all.flatMap(p=>p.rows),fullCheckedAt=now();
      if(incremental){const byDate=new Map(old.history.map(r=>[r.date,r])),overlap=history.filter(r=>byDate.has(r.date));
        if(!overlap.length||overlap.some(r=>hash(r)!==hash(byDate.get(r.date)))){
          const full=await pagesOf(code,Math.ceil(first.total/20)-1);
          if(full.some((p,i)=>p.total!==first.total||p.rows.length!==Math.min(20,first.total-(i+1)*20)))throw Error('nav_page_coverage_mismatch');
          history=[...first.rows,...full.flatMap(p=>p.rows)];
        }else{const oldest=history.at(-1).date;history=[...history,...old.history.filter(r=>r.date<oldest)];fullCheckedAt=old.fullCheckedAt;}}
      if(history.length!==first.total||history.some((r,i)=>i&&r.date>=history[i-1].date))throw Error('nav_history_coverage_mismatch');
      const check=NAV.adjust(history,actions,code);if(check.error)throw Error(check.error+':'+(check.date||''));
      const value={version:1,code,history,actions,total:first.total,checksum:hash(history),actionsHash:hash(actions),fetchedAt:now(),fullCheckedAt,
        source:`https://fundf10.eastmoney.com/jjjz_${code}.html`};
      if(evidence?.initializationPolicy==='first-ten-joint'){
        if(!S.validDate(evidence.identityNotBefore))throw Error('initialization_identity_boundary_unverified');
        const established=old?.initialization||cached?.initialization;
        if(established&&S.validDate(established.seedDate)&&S.validDate(established.seedEstablishedOn)&&established.seedDate>=evidence.identityNotBefore)
          {value.initialization=established;value.initializationChecksum=(old||cached).initializationChecksum;}
        else {const seed=C.findInitialSeed(history,evidence.identityNotBefore);
          if(seed){value.initialization={...seed,code,source:value.source,establishedAt:value.fetchedAt,
            establishedFromChecksum:value.checksum,originHistory:history};value.initializationChecksum=hash(value.initialization);}}
        const error=initializationError(value,evidence,now());if(error)throw Error(error);
      }
      memory.set(code,value);failures.delete(code);write(`cache/nasdaq_nav_${code}.json`,value);return value;
    }catch(e){failures.set(code,{at:now(),error:e.message});throw e;}
  }
  function fetchFull(code){if(!/^\d{6}$/.test(code||''))return Promise.reject(Error('invalid_fund_code'));
    if(!inflight.has(code))inflight.set(code,load(code).finally(()=>inflight.delete(code)));return inflight.get(code);}
  async function forFund(fund){
    const resolved=await (deps.identity||identity).resolve(fund.code),evidence=resolved.evidence;
    const error=resolved.error||eligibility(evidence);if(error)return {error,evidence};
    const [navResult,peResult]=await Promise.allSettled([fetchFull(fund.code),(deps.peService||PE).fetchFull()]);
    const instant=now(),context=C.orderContext(instant,evidence);
    if(navResult.status==='rejected')return {error:navResult.reason.message,evidence,context};
    const peData=peResult.status==='fulfilled'?peResult.value:{error:peResult.reason.message};
    const input=prepareInput(navResult.value,peData,evidence,context);
    Object.defineProperty(input,'_liveSnapshots',{value:{data:navResult.value,peData},enumerable:false});return input;
  }
  return {fetchFull,forFund};
}
function prepareInput(data,peData,evidence,context){
  const error=eligibility(evidence)||context?.error;if(error)return {error,evidence,context};
  const seedError=initializationError(data,evidence,context.knownAt);if(seedError)return {error:seedError,evidence,context};
  if(data.fetchedAt>context.knownAt||context.knownAt-data.fetchedAt>=3600000||!Number.isFinite(data.fetchedAt))return {error:'nav_snapshot_not_current',evidence,context};
  const adjusted=NAV.adjust(data.history,data.actions,evidence.code);if(adjusted.error)return {error:adjusted.error,evidence,context};
  if(adjusted.rows.some(r=>r.date>context.asOfDate))return {error:'future_nav_observation',evidence,context};
  if(evidence.identityNotBefore&&adjusted.rows.some(r=>r.date<evidence.identityNotBefore))return {error:'pre_identity_nav_observation',evidence,context};
  const initializationFrom=evidence.initializationFrom||data.initialization?.seedDate,seedEstablishedOn=evidence.seedEstablishedOn||data.initialization?.seedEstablishedOn;
  const first=adjusted.rows.find(r=>r.date===initializationFrom);
  if(!first||!S.validDate(seedEstablishedOn)||seedEstablishedOn>context.asOfDate)return {error:'initialization_history_missing',evidence,context};
  // Initialization is frozen from the first established prefix; a later gap never restarts Wilder.
  const rows=adjusted.rows.filter(r=>r.date>=first.date),known=C.selectKnown(rows,evidence,context),pe=PE.atSnapshot(peData,context);
  return {...known,pe,evidence,context,source:data.source,sourceFetchedAt:data.fetchedAt,sourceHash:data.checksum||hash(data.history),
    actionHash:data.actionsHash||hash(data.actions),peSource:peData.source,peFetchedAt:peData.fetchedAt,peHash:peData.checksum,
    initializationFrom:first.date,seedEstablishedOn,adjustment:adjusted.adjustment,repairs:adjusted.repairs,
    dataCaveat:'本次已取得的供应商修订快照；不代表历史当时可知，不保证未来申请日成交'};
}
function revalidateInput(input,instant){
  if(!input||input.error&&!input._liveSnapshots)return input;
  if(input.context?.knownAt>instant)return {...input,error:'historical_asof_not_supported'};
  const context=C.orderContext(instant,input.evidence);
  if(input._liveSnapshots){const {data,peData}=input._liveSnapshots;return prepareInput(data,peData,input.evidence,context);}
  // Dependency-injected, already validated synthetic inputs have no live snapshots.
  return {...input,context:{...context,...(input.context?.futureOrder?{futureOrder:true,orderDate:input.context.orderDate}:{})}};
}
function coverageGap(rows,evidence,from,to){
  if(!S.validDate(from)||!S.validDate(to)||from>to)return 'invalid_coverage_interval';
  if(from<C.DATA.from||to>C.DATA.to)return 'calendar_coverage_short';
  if(!Array.isArray(rows)||rows.some(r=>!r||!S.validDate(r.date)))return 'coverage_series_unverified';
  if(!C.validContract(evidence))return 'fund_calendar_unverified';
  const present=new Set(rows.map(r=>r.date)),expected=C.datesFor(evidence.valuationCalendar).filter(d=>d>=from&&d<=to);
  for(let y=Number(from.slice(0,4));y<=Number(to.slice(0,4));y++)for(const md of evidence.statutoryDates||[]){const d=y+'-'+md;if(d>=from&&d<=to)expected.push(d);}
  return expected.find(d=>!present.has(d))||null;
}
module.exports={...createService(),createService,prepareInput,revalidateInput,coverageGap,initializationError};

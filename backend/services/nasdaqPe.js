'use strict';
const http=require('../lib/http'),store=require('../lib/store'),S=require('../lib/nasdaqSignal'),crypto=require('node:crypto');
const SOURCE='https://danjuanfunds.com/djapi/index_eva/pe_history/NDX?day=all';
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validRows=rows=>Array.isArray(rows)&&rows.length>0&&rows.every((r,i)=>r&&S.validDate(r.date)&&Number.isFinite(r.pe)&&r.pe>0&&(!i||r.date>=rows[i-1].date));
function parse(text){
  const raw=JSON.parse(text)?.data?.index_eva_pe_growths;if(!Array.isArray(raw)||!raw.length)throw Error('pe_source_empty');
  return raw.map(r=>{const ts=Number(r.ts),pe=Number(r.pe);if(!Number.isFinite(ts)||!Number.isFinite(pe)||pe<=0)throw Error('invalid_pe_source_row');
    const date=new Date(ts+8*3600000).toISOString().slice(0,10);if(!S.validDate(date))throw Error('invalid_pe_source_date');return {date,pe,ts};}).sort((a,b)=>a.date.localeCompare(b.date));
}
function createService(deps={}){
  const now=deps.now||Date.now,read=deps.read||store.readJSON,write=deps.write||store.writeJSONSafe,request=deps.fetchText||http.fetchText;
  let memory=null,inflight=null,failure=null;
  async function load(){
    if(!memory)try{const c=read('cache/nasdaq_pe.json');if(c?.version===1&&validRows(c.rows)&&c.checksum===hash(c.rows)&&Number.isFinite(c.fetchedAt)&&c.source===SOURCE)memory=c;}catch(_){}
    if(memory&&now()>=memory.fetchedAt&&now()-memory.fetchedAt<86400000)return memory;
    if(failure&&now()>=failure.at&&now()-failure.at<300000)throw Error(failure.error);
    try{const rows=deps.fetchRows?await deps.fetchRows():parse(await request(SOURCE,{Referer:'https://danjuanfunds.com/'}));
      if(!validRows(rows))throw Error('invalid_pe_source_row');
      const value={version:1,rows,checksum:hash(rows),fetchedAt:now(),source:SOURCE,
        caveat:'供应商NDX TTM PE定义；历史可能修订；本次取得快照只证明本次已知，不证明历史首次公布时刻'};
      memory=value;failure=null;write('cache/nasdaq_pe.json',value);return value;
    }catch(e){failure={at:now(),error:e.message};throw e;}
  }
  function fetchFull(){if(!inflight)inflight=load().finally(()=>{inflight=null;});return inflight;}
  return {fetchFull};
}
function atSnapshot(data,context){
  if(!data||data.error)return {state:'unknown',reason:data?.error||'pe_unavailable'};
  if(!validRows(data.rows))return {state:'unknown',reason:'invalid_pe_snapshot'};
  if(!Number.isFinite(data.fetchedAt)||data.fetchedAt>context.knownAt||context.knownAt-data.fetchedAt>=86400000)return {state:'unknown',reason:'pe_snapshot_not_current'};
  if(data.rows.some(r=>r.date>context.asOfDate))return {state:'unknown',reason:'future_pe_observation'};
  const rows=data.rows.filter(r=>r.date<=context.asOfDate&&r.date<context.orderDate),idx=rows.length-1;
  const result=S.pePercentile(rows,idx,3),latest=rows[idx];
  if(latest&&S.distance(latest.date,context.orderDate)>21)return {...result,state:'unknown',reason:'stale_pe_over_21d'};
  return {...result,pe:latest?.pe??null,observedAt:data.fetchedAt,source:data.source,caveat:data.caveat};
}
module.exports={...createService(),createService,parse,atSnapshot,SOURCE};

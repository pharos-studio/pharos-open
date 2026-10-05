'use strict';
const {createHash}=require('node:crypto');
const store=require('../lib/store');
const {preparePe}=require('../lib/hs300Signal');
const SOURCE='https://legulegu.com/stockdata/sz50-ttm-lyr';
const UA='Mozilla/5.0 (compatible; Pharos/1.0)';
async function fetchMonthly(instant=Date.now()) {
  const landing=await fetch(SOURCE,{headers:{'User-Agent':UA},signal:AbortSignal.timeout(15000)});
  if(!landing.ok)throw Error('pe_source_unavailable');
  const html=await landing.text(),csrf=html.match(/<meta[^>]*name=["']_csrf["'][^>]*content=["']([^"']+)["']/i)?.[1];
  if(!csrf)throw Error('pe_source_changed');
  const cookies=(landing.headers.getSetCookie?.()||[]).map(c=>c.split(';')[0]).join('; ');
  const day=new Date(instant+8*3600000).toISOString().slice(0,10),token=createHash('md5').update(day).digest('hex');
  const response=await fetch(`https://legulegu.com/api/stockdata/index-basic-pe?token=${token}&indexCode=000300.SH`,{
    headers:{'User-Agent':UA,Referer:SOURCE,'X-CSRF-Token':csrf,Cookie:cookies},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('pe_source_unavailable');
  const json=await response.json();
  if(!Array.isArray(json.data)||!json.data.length)throw Error('pe_history_unavailable');
  const rows=json.data.map(r=>({date:r.date,pe:r.addTtmPe,publicationVerified:false,vintageVerified:false,source:'legulegu'}));
  // The monthly schema is part of the contract; daily/duplicate-month responses fail closed.
  preparePe(rows);
  return rows;
}
function createService(deps={}) {
  const fetchRows=deps.fetchRows||fetchMonthly,read=deps.read||store.readJSON,write=deps.write||store.writeJSONSafe,now=deps.now||Date.now;
  let cached=null,inflight=null,failure=null;
  const hash=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  async function load() {
    if(!cached)try {const c=read('cache/hs300_monthly_pe.json');if(c?.version===1&&hash(c.rows)===c.checksum){preparePe(c.rows);cached=c;}}catch(_){}
    if(cached && now()>=cached.updatedAt && now()-cached.updatedAt<86400000)return cached;
    if(failure&&now()-failure.at<300000)throw Error(failure.reason);
    try {
      const rows=await fetchRows(now());preparePe(rows);
      const value={version:1,rows,checksum:hash(rows),updatedAt:now(),source:'legulegu',sourceUrl:SOURCE,
        caveat:'历史发布时间及原始版本未核验，修订数据回放；保守滞后不能消除此风险'};
      write('cache/hs300_monthly_pe.json',value);cached=value;failure=null;return value;
    }catch(e){failure={at:now(),reason:e.message};throw e;}
  }
  function fetchFull(){if(!inflight)inflight=load().finally(()=>inflight=null);return inflight;}
  return {fetchFull};
}
module.exports={...createService(),createService,fetchMonthly};

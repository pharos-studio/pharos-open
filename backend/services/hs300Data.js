'use strict';
// Full-history I/O is isolated from pure strategy computation and holding valuation.
const { createHash } = require('node:crypto');
const http = require('../lib/http');
const store = require('../lib/store');
const adjusted = require('../lib/fundAdjustedNav');
const calendar = require('../lib/hs300Calendar');
const signal = require('../lib/hs300Signal');
const identity = require('./hs300Identity');
const {eligibility} = require('../lib/hs300Identity');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function createService(deps = {}) {
  const request = deps.fetchText || http.fetchText, actionsOf = deps.fetchActions || adjusted.fetchActions;
  const read = deps.read || store.readJSON, write = deps.write || store.writeJSONSafe;
  const now = deps.now || Date.now, inflight = new Map(), memory = new Map(), failures = new Map();
  async function page(code, number) {
    const source = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${number}&pageSize=20`;
    const json = JSON.parse(await request(source, { Referer:'https://fundf10.eastmoney.com/' }));
    const list = json.Data?.LSJZList, total = Number(json.TotalCount);
    if (!Array.isArray(list) || !Number.isSafeInteger(total) || total <= 0 || !list.length) throw Error('invalid_nav_page');
    const rows = list.map(r=>({date:r.FSRQ,nav:Number(r.DWJZ),acc:r.LJJZ === '' ? null:Number(r.LJJZ),dayChange:r.JZZZL === '' || r.JZZZL == null ? null:Number(r.JZZZL)}));
    if (rows.some(r=>!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||!Number.isFinite(r.nav)||r.nav<=0)) throw Error('invalid_nav_row');
    return {rows,total};
  }
  function validCache(c) { return c?.version===1 && Array.isArray(c.history) && c.history.length===c.total && c.checksum===hash(c.history) && c.actionsHash===hash(c.actions); }
  async function load(code) {
    const key = `cache/hs300_nav_${code}.json`;
    let old = memory.get(code);
    if (!old) { try { const disk=read(key); if(validCache(disk)) old=disk; } catch (_) {} }
    if (old && now()>=old.updatedAt && now()-old.updatedAt < 3600000) { memory.set(code,old); return old; }
    const failure=failures.get(code); if(failure && now()-failure.at<300000) throw Error(failure.error);
    try {
      const [first, actions] = await Promise.all([page(code,1),actionsOf(code)]);
      if (actions.error) throw Error(actions.error);
      let history;
      // Reconcile a complete cached prefix; a daily full refresh detects older source corrections.
      const delta=old ? first.total-old.total : -1;
      const incremental=old && delta>=0 && now()-old.fullCheckedAt<86400000 && hash(actions)===old.actionsHash;
      const pages=incremental ? Math.min(Math.ceil(first.total/20),Math.max(2,Math.ceil((delta+40)/20))) : Math.ceil(first.total/20);
      const rest=await Promise.all(Array.from({length:pages-1},(_,i)=>page(code,i+2)));
      const all=[first,...rest];
      if (all.some((p,i)=>p.total!==first.total || p.rows.length!==Math.min(20,first.total-i*20))) throw Error('nav_page_coverage_mismatch');
      const head=all.flatMap(p=>p.rows);
      if (incremental) {
        const oldByDate=new Map(old.history.map(r=>[r.date,r]));
        const overlap=head.filter(r=>oldByDate.has(r.date));
        if (!overlap.length || overlap.some(r=>hash(r)!==hash(oldByDate.get(r.date)))) {
          // Never use a revised partial prefix; retry a full rebuild immediately.
          memory.delete(code); old=null;
          const full=await Promise.all(Array.from({length:Math.ceil(first.total/20)-1},(_,i)=>page(code,i+2)));
          if (full.some((p,i)=>p.total!==first.total||p.rows.length!==Math.min(20,first.total-(i+1)*20))) throw Error('nav_page_coverage_mismatch');
          history=[...first.rows,...full.flatMap(p=>p.rows)];
        } else { const oldest=head.at(-1).date; history=[...head,...old.history.filter(r=>r.date<oldest)]; }
      } else history=head;
      if (history.length!==first.total || history.some((r,i)=>i>0&&r.date>=history[i-1].date)) throw Error('nav_history_coverage_mismatch');
      const check=adjusted.reinvestedNav(history,actions);
      if (check.error) throw Error(check.error);
      const value={version:1,history,actions,total:first.total,checksum:hash(history),actionsHash:hash(actions),
        updatedAt:now(),fullCheckedAt:incremental&&old?old.fullCheckedAt:now(),
        source:'eastmoney',sourceUrl:`https://fundf10.eastmoney.com/jjjz_${code}.html`};
      memory.set(code,value); failures.delete(code); write(key,value); return value;
    } catch(e) { failures.set(code,{at:now(),error:e.message}); throw e; }
  }
  function fetchFull(code) {
    if (!/^\d{6}$/.test(code)) return Promise.reject(Error('invalid_fund_code'));
    if(!inflight.has(code)) inflight.set(code,load(code).finally(()=>inflight.delete(code)));
    return inflight.get(code);
  }

  const official=deps.identity||identity,peService=deps.peService||require('./hs300Pe');
  async function forFund(fund,instant=now()) {
    const context=calendar.orderContext(instant);
    if(context.error)return {error:context.error,context};
    try {
      const resolved=await official.resolve(fund.code),evidence=resolved.evidence;
      const scope=resolved.error||eligibility(evidence);
      if(scope)return {error:scope,evidence,context};
      const [data,peData]=await Promise.all([fetchFull(fund.code),peService.fetchFull()]);
      return prepareInput(data,peData,evidence,context);
    }catch(e){return {error:e.message,context};}
  }
  return {fetchFull,forFund};
}
function prepareInput(data,peData,evidence,context) {
  const error=eligibility(evidence)||context?.error;
  if(error)return {error,evidence,context};
  const result=adjusted.reinvestedNav(data.history,data.actions);
  if(result.error)return {error:result.error,evidence,context};
  const cal=calendar.INDEX,from=evidence.effectiveDate>'2013-01-01'?evidence.effectiveDate:'2013-01-01';
  if(from>context.knownThrough || context.orderDate>cal.to)return {error:'calendar_unverified',evidence,context};
  const rows=result.rows.filter(r=>r.date>=from&&cal.set.has(r.date));
  if(!rows.length)return {error:'price_warmup',evidence,context};
  const expectedStart=cal.dates.find(d=>d>=from);
  if(!expectedStart||signal.days(expectedStart,rows[0].date)>14)return {error:'initialization_history_missing',evidence,context};
  // Complete verified daily interval, not a compressed history with missing trading dates.
  const allDates=new Set(rows.map(r=>r.date)),known=rows.filter(r=>{
    const available=cal.available(r.date);return r.date<context.orderDate&&available&&available<=context.knownThrough;
  });
  const expected=cal.dates.filter(d=>d>=rows[0].date&&d<context.orderDate&&cal.available(d)&&cal.available(d)<=context.knownThrough);
  const missing=expected.filter(d=>!allDates.has(d));
  if(missing.length)return {error:'nav_calendar_coverage_gap',missingDates:missing,evidence,context};
  const p=signal.preparePrice(known,context.orderDate,cal);
  const pe=signal.peAt(signal.preparePe(peData.rows),context.orderDate,cal,context.knownThrough);
  return {p,pe,evidence,context,initializationFrom:rows[0].date,source:data.source,sourceUrl:data.sourceUrl,
    peSource:peData.source,peSourceUrl:peData.sourceUrl,peCaveat:peData.caveat,
    fetchedAt:data.updatedAt,adjustment:'dividend-reinvested; provider-return consistency checked',
    corporateActionSource:data.actions.sourceUrl};
}
module.exports={...createService(),createService,prepareInput};

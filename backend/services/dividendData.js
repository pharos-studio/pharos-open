'use strict';
// Full-history I/O is isolated from pure strategy computation and holding valuation.
const { createHash } = require('node:crypto');
const http = require('../lib/http');
const store = require('../lib/store');
const adjusted = require('../lib/fundAdjustedNav');
const calendar = require('../lib/domesticCalendar');
const { eligibility } = require('../lib/dividendTrend');
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
    const key = `cache/dividend_nav_${code}.json`;
    let old = memory.get(code);
    if (!old) { try { const disk=read(key); if(validCache(disk)) old=disk; } catch (_) {} }
    if (old && now()-old.updatedAt < 3600000) { memory.set(code,old); return old; }
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
  async function forFund(fund, instant=now()) {
    const scope=eligibility(fund); if(scope) return {error:scope};
    try {
      const data=await fetchFull(fund.code), result=adjusted.reinvestedNav(data.history,data.actions);
      if(result.error) return {error:result.error};
      const rows=result.rows.filter(r=>{const d=new Date(r.date+'T00:00:00Z').getUTCDay();return d!==0&&d!==6;});
      const context=calendar.orderContext(instant), prepared=calendar.prepare(rows,context);
      if(prepared.error) return {error:prepared.error,context,source:data.source,latestDate:rows.at(-1)?.date||null};
      return { ...prepared,source:data.source,sourceUrl:data.sourceUrl,corporateActionSource:data.actions.sourceUrl,
        adjustment:'dividend-reinvested; provider-return consistency checked', fetchedAt:data.updatedAt };
    } catch(e) { return {error:e.message}; }
  }
  return {fetchFull,forFund};
}
const service=createService();
module.exports={...service,createService};

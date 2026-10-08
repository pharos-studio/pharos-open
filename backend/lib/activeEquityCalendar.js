'use strict';
// CN exchange evidence is not proof that a particular fund accepts subscriptions.
const S=require('./activeEquitySignal'),MARKETS=require('../data/nasdaqCalendar.json');
const EXTRA_2009={from:'2009-01-01',to:'2009-12-31',source:'https://www.sse.com.cn/aboutus/mediacenter/hotandd/c/c_20150912_3988267.shtml',sourceSha256:'1b138884b024bde186f8bdac440ce977d4a6d9e07cae52da1bb5f5e83d391188',ranges:[['2009-01-01','2009-01-03'],['2009-01-25','2009-01-31'],['2009-04-04','2009-04-06'],['2009-05-01','2009-05-03'],['2009-05-28','2009-05-30'],['2009-10-01','2009-10-08']]};
const DATA={version:'active-equity-cn-v1',from:EXTRA_2009.from,to:MARKETS.to},shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10),localDay=t=>new Date(Number(t)+28800000).toISOString().slice(0,10);
const dates=[];for(let d=DATA.from;d<=DATA.to;d=shift(d,1)){const ranges=d<MARKETS.from?EXTRA_2009.ranges.map(([from,to])=>({from,to})):MARKETS.cn.ranges;if(![0,6].includes(new Date(d+'T00:00:00Z').getUTCDay())&&!ranges.some(r=>d>=r.from&&d<=r.to))dates.push(d);}
const dateSet=new Set(dates);
// Some funds narrow their open days to CN trading days LESS Hong Kong Connect non-service days.
// Prospectus wording is permissive ("若该工作日为非港股通交易日，则本基金可以不开放"), so a fund may
// stay open on a declared non-service day — measured on 016874: open on 2024-12-31, 2025-12-24/25/26/31,
// 2026-04-03/07, 2026-05-25 while every measured closure fell inside the official list. The exclusion
// list must therefore come from the exchanges' annual HK Connect notices — published in advance and so
// knowable at the time — and NOT from the fund's own NAV rows: deriving it from the data under test
// would let the fund define its own rule (the same self-certification trap as a calendar read out of
// NAV). The result is deliberately a CONSERVATIVE over-approximation: it may under-count open days,
// but it can never claim a closed day is open.
function openExceptionEvidence(e){if(e?.openCalendar!=='cn-minus-hkconnect')return null;
  const a=e.openExceptions,from=e.openExceptionsFrom,src=e.openExceptionsSources;
  if(!S.validDate(from)||from<DATA.from)return null;
  if(S.validDate(e.initializationFrom)&&from>e.initializationFrom)return null;
  if(!Array.isArray(src)||!src.length||!src.every(s=>s&&/^https:\/\//.test(String(s.url||''))&&/^[0-9a-f]{64}$/.test(String(s.sha256||''))))return null;
  if(!Array.isArray(a)||!a.length)return null;
  if(!a.every((d,i)=>S.validDate(d)&&d>=from&&d<=DATA.to&&dateSet.has(d)&&(!i||d>a[i-1])))return null;
  return {from,dates:a};
}
function openDates(e){if(e?.openCalendar!=='cn-minus-hkconnect')return dates;
  const ex=openExceptionEvidence(e);if(!ex)return null;const skip=new Set(ex.dates);
  return dates.filter(d=>!skip.has(d));}
// QDII evidence is per share: valuation days and subscription days need not coincide.
// Publication timing is a declared POLICY (lag + hour, Beijing time) — not a per-day instant.
// Why: no source publishes per-valuation-day disclosure timestamps for QDII funds (measured
// 2026-10-08: Eastmoney returns PUBLISHDATE at 00:00 and cninfo normalises announcementTime to
// midnight; QDII funds issue no daily NAV announcement at all). Requiring them made the gate
// unopenable, not safer. A declared lag is real evidence — it comes from the fund's own
// disclosure clause — and must be set conservatively (later is safe; earlier is not).
function qdiiPolicy(c){const p=c?.publicationPolicy;if(!p||typeof p!=='object')return null;
  if(!Number.isInteger(p.lagValuationDays)||p.lagValuationDays<1||p.lagValuationDays>10)return null;
  if(!Number.isInteger(p.beijingHour)||p.beijingHour<0||p.beijingHour>23)return null;return p;}
function qdiiDeadline(date,c){if(!c||!S.validDate(date))return null;const p=qdiiPolicy(c);if(!p)return null;
  const after=c.valuationDates.filter(d=>d>date);if(after.length<p.lagValuationDays)return null;
  return Date.parse(after[p.lagValuationDays-1]+'T'+String(p.beijingHour).padStart(2,'0')+':00:00+08:00');}
function qdiiContract(e){const c=e?.qdiiCalendar;
  const validDays=a=>Array.isArray(a)&&a.length>0&&a.every((d,i)=>S.validDate(d)&&d>=c.from&&d<=c.to&&(!i||d>a[i-1]));
  if(e?.rulesVerified!==true||!e.contractSource||c?.verified!==true||c.code!==e.code||!c.version||!c.source||!c.publicationSource||!S.validDate(c.from)||!S.validDate(c.to)||c.from>c.to||!validDays(c.subscriptionDates)||!validDays(c.valuationDates)||!qdiiPolicy(c))return null;
  return c;
}
function validContract(e){if(e?.qdii===true)return !!qdiiContract(e);
  if(e?.rulesVerified!==true||!e.contractSource||e.valuationCalendar!=='cn')return false;
  if(e.openCalendar==='cn')return true;
  return !!openExceptionEvidence(e);}
function deadline(date,e){if(e?.qdii===true)return qdiiDeadline(date,qdiiContract(e));if(!S.validDate(date)||date<DATA.from||date>DATA.to)return null;const day=dates.filter(d=>d>date)[1];return day?Date.parse(day+'T18:00:00+08:00'):null;}
function orderContext(t,e){if(!Number.isFinite(Number(t)))return {error:'invalid_view_time'};const day=localDay(t),common={computedAt:new Date(Number(t)).toISOString(),asOfDate:day,knownAt:Number(t),inputVersion:S.INPUT_VERSION,calendarVersion:e?.qdii===true?e.qdiiCalendar?.version||null:DATA.version};
  if(e?.qdii===true){const c=qdiiContract(e);if(!c)return {...common,error:'fund_calendar_unverified'};if(day<c.from||day>c.to)return {...common,error:'calendar_coverage_short'};const before15=Number(t)<Date.parse(day+'T15:00:00+08:00'),orderDate=before15&&c.subscriptionDates.includes(day)?day:c.subscriptionDates.find(d=>d>day);return orderDate?{...common,orderDate,futureOrder:orderDate>day,contractSource:e.contractSource}:{...common,error:'calendar_coverage_short'};}
  if(day<DATA.from||day>DATA.to)return {...common,error:'calendar_coverage_short'};if(!validContract(e))return {...common,error:'fund_calendar_unverified'};const open=openDates(e);if(!open)return {...common,error:'fund_calendar_unverified'};const ex=openExceptionEvidence(e);if(ex&&day<ex.from)return {...common,error:'calendar_coverage_short'};const before15=Number(t)<Date.parse(day+'T15:00:00+08:00'),orderDate=open.includes(day)&&before15?day:open.find(d=>d>day);return orderDate?{...common,orderDate,futureOrder:orderDate>day,contractSource:e.contractSource}:{...common,error:'calendar_coverage_short'};}
function selectKnown(rows,e,context){const out={rows:[],waitingForPublication:[],missingDates:[]};if(context?.error)return {...out,error:context.error};if(!validContract(e))return {...out,error:'fund_calendar_unverified'};if(!rows.length||e.qdii!==true&&(rows[0].date<DATA.from||context.asOfDate>DATA.to))return {...out,error:'calendar_coverage_short'};
  // All economic NAV rows remain present. Unknown daily sampling cannot be inferred from a market calendar.
  if(e.samplingVerified!==true||e.sampling!=='all-economic-nav')return {...out,error:'daily_sampling_unverified'};
  const calendar=e.qdii===true?qdiiContract(e):null;
  if(calendar&&(rows[0].date<calendar.from||context.asOfDate>calendar.to))return {...out,error:'calendar_coverage_short'};
  const expected=calendar?calendar.valuationDates:dates;
  const expectedSet=new Set(expected),endOf=d=>calendar?qdiiDeadline(d,calendar):deadline(d);
  if(calendar&&rows.some(r=>r.date<=context.asOfDate&&!expectedSet.has(r.date)))return {...out,error:'valuation_date_unverified'};
  const byDate=new Map(rows.map(r=>[r.date,r]));for(const d of expected.filter(d=>d>=e.initializationFrom&&d<=context.asOfDate)){const end=endOf(d);if(end===null)return {...out,error:calendar?'publication_time_unverified':'calendar_coverage_short'};if(end>context.knownAt){out.waitingForPublication.push(d);continue;}if(!byDate.has(d))out.missingDates.push(d);}
  if(out.missingDates.length)return {...out,error:'expected_nav_gap:'+out.missingDates[0]};
  for(const r of rows){if(r.date>context.asOfDate)continue;const end=endOf(r.date);if(end===null)return {...out,error:calendar?'publication_time_unverified':'calendar_coverage_short'};if(end>context.knownAt)continue;out.rows.push({date:r.date,P:r.close,dailyValid:true,availableAt:new Date(end).toISOString()});}
  if(!out.rows.length)return {...out,error:'no_known_nav'};if((Date.parse(context.asOfDate)-Date.parse(out.rows.at(-1).date))/86400000>14)return {...out,error:'stale_nav_over_14d'};return out;
}
module.exports={DATA,EXTRA_2009,dates,shift,localDay,openExceptionEvidence,openDates,qdiiPolicy,qdiiDeadline,qdiiContract,validContract,deadline,orderContext,selectKnown};

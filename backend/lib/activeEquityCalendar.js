'use strict';
// CN exchange evidence is not proof that a particular fund accepts subscriptions.
const S=require('./activeEquitySignal'),MARKETS=require('../data/nasdaqCalendar.json');
const EXTRA_2009={from:'2009-01-01',to:'2009-12-31',source:'https://www.sse.com.cn/aboutus/mediacenter/hotandd/c/c_20150912_3988267.shtml',sourceSha256:'1b138884b024bde186f8bdac440ce977d4a6d9e07cae52da1bb5f5e83d391188',ranges:[['2009-01-01','2009-01-03'],['2009-01-25','2009-01-31'],['2009-04-04','2009-04-06'],['2009-05-01','2009-05-03'],['2009-05-28','2009-05-30'],['2009-10-01','2009-10-08']]};
const DATA={version:'active-equity-cn-v1',from:EXTRA_2009.from,to:MARKETS.to},shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10),localDay=t=>new Date(Number(t)+28800000).toISOString().slice(0,10);
const dates=[];for(let d=DATA.from;d<=DATA.to;d=shift(d,1)){const ranges=d<MARKETS.from?EXTRA_2009.ranges.map(([from,to])=>({from,to})):MARKETS.cn.ranges;if(![0,6].includes(new Date(d+'T00:00:00Z').getUTCDay())&&!ranges.some(r=>d>=r.from&&d<=r.to))dates.push(d);}
// QDII evidence is per share: valuation days and subscription days need not coincide.
// Publication times are explicit zoned instants, never guessed from a CN weekday.
function qdiiContract(e){const c=e?.qdiiCalendar;
  const validDays=a=>Array.isArray(a)&&a.length>0&&a.every((d,i)=>S.validDate(d)&&d>=c.from&&d<=c.to&&(!i||d>a[i-1]));
  if(e?.rulesVerified!==true||!e.contractSource||c?.verified!==true||c.code!==e.code||!c.version||!c.source||!c.publicationSource||!S.validDate(c.from)||!S.validDate(c.to)||c.from>c.to||!validDays(c.subscriptionDates)||!validDays(c.valuationDates)||!c.availableAt||typeof c.availableAt!=='object')return null;
  const valued=new Set(c.valuationDates);
  for(const [d,t] of Object.entries(c.availableAt)){if(!valued.has(d)||typeof t!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(t)||!Number.isFinite(Date.parse(t))||Date.parse(t)<Date.parse(d+'T00:00:00+08:00'))return null;}
  return c;
}
function validContract(e){return e?.qdii===true?!!qdiiContract(e):e?.rulesVerified===true&&!!e.contractSource&&e.openCalendar==='cn'&&e.valuationCalendar==='cn';}
function deadline(date,e){if(e?.qdii===true){const c=qdiiContract(e);return c&&Object.hasOwn(c.availableAt,date)?Date.parse(c.availableAt[date]):null;}if(!S.validDate(date)||date<DATA.from||date>DATA.to)return null;const day=dates.filter(d=>d>date)[1];return day?Date.parse(day+'T18:00:00+08:00'):null;}
function orderContext(t,e){if(!Number.isFinite(Number(t)))return {error:'invalid_view_time'};const day=localDay(t),common={computedAt:new Date(Number(t)).toISOString(),asOfDate:day,knownAt:Number(t),inputVersion:S.INPUT_VERSION,calendarVersion:e?.qdii===true?e.qdiiCalendar?.version||null:DATA.version};
  if(e?.qdii===true){const c=qdiiContract(e);if(!c)return {...common,error:'fund_calendar_unverified'};if(day<c.from||day>c.to)return {...common,error:'calendar_coverage_short'};const before15=Number(t)<Date.parse(day+'T15:00:00+08:00'),orderDate=before15&&c.subscriptionDates.includes(day)?day:c.subscriptionDates.find(d=>d>day);return orderDate?{...common,orderDate,futureOrder:orderDate>day,contractSource:e.contractSource}:{...common,error:'calendar_coverage_short'};}
  if(day<DATA.from||day>DATA.to)return {...common,error:'calendar_coverage_short'};if(!validContract(e))return {...common,error:'fund_calendar_unverified'};const before15=Number(t)<Date.parse(day+'T15:00:00+08:00'),orderDate=dates.includes(day)&&before15?day:dates.find(d=>d>day);return orderDate?{...common,orderDate,futureOrder:orderDate>day,contractSource:e.contractSource}:{...common,error:'calendar_coverage_short'};}
function selectKnown(rows,e,context){const out={rows:[],waitingForPublication:[],missingDates:[]};if(context?.error)return {...out,error:context.error};if(!validContract(e))return {...out,error:'fund_calendar_unverified'};if(!rows.length||e.qdii!==true&&(rows[0].date<DATA.from||context.asOfDate>DATA.to))return {...out,error:'calendar_coverage_short'};
  // All economic NAV rows remain present. Unknown daily sampling cannot be inferred from a market calendar.
  if(e.samplingVerified!==true||e.sampling!=='all-economic-nav')return {...out,error:'daily_sampling_unverified'};
  const calendar=e.qdii===true?qdiiContract(e):null;
  if(calendar&&(rows[0].date<calendar.from||context.asOfDate>calendar.to))return {...out,error:'calendar_coverage_short'};
  const expected=calendar?calendar.valuationDates:dates;
  const expectedSet=new Set(expected),endOf=d=>calendar?(Object.hasOwn(calendar.availableAt,d)?Date.parse(calendar.availableAt[d]):null):deadline(d);
  if(calendar&&rows.some(r=>r.date<=context.asOfDate&&!expectedSet.has(r.date)))return {...out,error:'valuation_date_unverified'};
  const byDate=new Map(rows.map(r=>[r.date,r]));for(const d of expected.filter(d=>d>=e.initializationFrom&&d<=context.asOfDate)){const end=endOf(d);if(end===null)return {...out,error:calendar?'publication_time_unverified':'calendar_coverage_short'};if(end>context.knownAt){out.waitingForPublication.push(d);continue;}if(!byDate.has(d))out.missingDates.push(d);}
  if(out.missingDates.length)return {...out,error:'expected_nav_gap:'+out.missingDates[0]};
  for(const r of rows){if(r.date>context.asOfDate)continue;const end=endOf(r.date);if(end===null)return {...out,error:calendar?'publication_time_unverified':'calendar_coverage_short'};if(end>context.knownAt)continue;out.rows.push({date:r.date,P:r.close,dailyValid:true,availableAt:new Date(end).toISOString()});}
  if(!out.rows.length)return {...out,error:'no_known_nav'};if((Date.parse(context.asOfDate)-Date.parse(out.rows.at(-1).date))/86400000>14)return {...out,error:'stale_nav_over_14d'};return out;
}
module.exports={DATA,EXTRA_2009,dates,shift,localDay,qdiiContract,validContract,deadline,orderContext,selectKnown};

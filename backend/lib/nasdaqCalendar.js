'use strict';
// Exchange dates and explicit fund contracts are separate inputs.
const S=require('./nasdaqSignal'),DATA=require('../data/nasdaqCalendar.json');
const shift=(d,n)=>new Date(S.time(d)+n*86400000).toISOString().slice(0,10);
const monday=d=>shift(d,-((new Date(S.time(d)).getUTCDay()+6)%7));
const localDay=instant=>new Date(Number(instant)+8*3600000).toISOString().slice(0,10);
const cnClosed=d=>DATA.cn.ranges.some(r=>d>=r.from&&d<=r.to),usClosed=new Set(DATA.us.closedDates);
const cn=[],us=[],joint=[];
for(let d=DATA.from;d<=DATA.to;d=shift(d,1)){
  if([0,6].includes(new Date(S.time(d)).getUTCDay()))continue;
  if(!cnClosed(d))cn.push(d);if(!usClosed.has(d))us.push(d);
  if(!cnClosed(d)&&!usClosed.has(d))joint.push(d);
}
const DATES={cn,us,joint};
function findInitialSeed(rows,notBefore){
  const legal=rows.filter(r=>r.date>=notBefore).slice().sort((a,b)=>a.date.localeCompare(b.date)),present=new Set(legal.map(r=>r.date));
  for(const r of legal){const next=joint.filter(d=>d>r.date).slice(0,10);
    if(next.length===10&&next.every(d=>present.has(d)))return {seedDate:r.date,seedEstablishedOn:next[9]};}
  return null;
}
function datesFor(rule){return DATES[rule]||null;}
function validContract(e){return e?.rulesVerified===true&&e.contractSource&&datesFor(e.workCalendar)&&
  datesFor(e.valuationCalendar)&&datesFor(e.openCalendar)&&Number.isInteger(e.navLagWorkDays)&&e.navLagWorkDays>=0;}
function deadline(date,e){
  const dates=datesFor(e.workCalendar);if(!dates||date<DATA.from||date>DATA.to)return null;
  const later=dates.filter(d=>d>date),day=e.navLagWorkDays?later[e.navLagWorkDays-1]:date;
  return day?Date.parse(shift(day,1)+'T00:00:00+08:00'):null;
}
function orderContext(instant,e){
  if(!Number.isFinite(Number(instant)))return {error:'invalid_view_time'};
  const day=localDay(instant),common={computedAt:new Date(Number(instant)).toISOString(),asOfDate:day,
    mode:'live-observed',inputVersion:'nasdaq-live-input-v1',calendarVersion:DATA.version};
  if(day<DATA.from||day>DATA.to||!validContract(e))return {...common,error:'fund_calendar_unverified'};
  const dates=datesFor(e.openCalendar),hour=new Date(Number(instant)+8*3600000).getUTCHours();
  const todayOpen=dates.includes(day),orderDate=todayOpen&&hour<15?day:dates.find(d=>d>day);
  if(!orderDate)return {...common,error:'calendar_coverage_short'};
  return {...common,orderDate,futureOrder:orderDate>day,contractSource:e.contractSource,
    calendarSource:DATA.cn.sources.concat(DATA.us.sources).map(s=>s.url),knownAt:Number(instant)};
}
function selectKnown(rows,e,context){
  const out={price:null,week:null,quality:{prices:false,weeks:false},waitingForPublication:[],missingDates:[]};
  if(context.error||!validContract(e)){out.quality.reason=context.error||'fund_calendar_unverified';return out;}
  if(!rows.length){out.quality.reason='price_quality_or_warmup';return out;}
  const date=context.asOfDate,instant=context.knownAt,known=rows.filter(r=>r.date<=date&&r.date<context.orderDate);
  // Plan the whole week, including a statutory valuation day that has not arrived yet.
  const weekEnd=shift(monday(date),6),scheduleTo=weekEnd>DATA.to?DATA.to:weekEnd;
  const from=rows[0].date;
  const statutory=[];for(let y=Number(from.slice(0,4));y<=Number(scheduleTo.slice(0,4));y++)for(const md of e.statutoryDates||[]){const d=y+'-'+md;if(d>=from&&d<=scheduleTo)statutory.push(d);}
  const expected=[...new Set([...datesFor(e.valuationCalendar).filter(d=>d>=from&&d<=scheduleTo),...statutory,...known.map(r=>r.date)])].sort();
  const byDate=new Map(known.map(r=>[r.date,r]));
  for(const d of expected){if(d>date||byDate.has(d))continue;const end=deadline(d,e);
    if(end==null||end<=instant)out.missingDates.push(d);else out.waitingForPublication.push(d);}
  if(out.missingDates.length){out.quality.reason='expected_nav_gap:'+out.missingDates[0];return out;}
  const prices=S.preparePrices(known),last=prices.at(-1);
  if(!last){out.quality.reason='no_known_nav';return out;}
  if(S.distance(last.date,context.orderDate)>14){out.quality.reason='stale_nav_over_14d';return out;}
  out.price=last;out.quality.prices=true;
  if(weekEnd>DATA.to){out.quality.weekReason='week_calendar_coverage_short';out.quality.reason=out.quality.weekReason;return out;}
  const groups=new Map();for(const d of expected){const w=monday(d);if(!groups.has(w))groups.set(w,[]);groups.get(w).push(d);}
  const bars=[];let waiting=false;
  for(const [week,dates] of groups){
    const end=dates.at(-1);
    if(week<from||end>=date)continue;
    const missing=dates.filter(d=>!byDate.has(d));
    if(missing.length){waiting=true;continue;}
    if(waiting){out.quality.weekReason='known_week_sequence_gap';out.quality.reason=out.quality.weekReason;return out;}
    const row=byDate.get(end);bars.push({...row,week,completedOn:end});
  }
  out.week=S.prepareWeeks(bars).at(-1)||null;out.quality.weeks=!!out.week;
  if(!out.week)out.quality.reason='no_known_completed_week';
  return out;
}
module.exports={DATA,DATES,shift,monday,localDay,datesFor,validContract,deadline,orderContext,selectKnown,findInitialSeed};

'use strict';
// Source-backed fund work, valuation and application calendars are distinct.
// Never synthesize a fund calendar from weekdays or a Chinese-market proxy.
const S=require('./goldSignal'),day=t=>new Date(Number(t)+28800000).toISOString().slice(0,10);
function validCalendar(c){return c?.verified===true&&!!c.source&&!!c.version&&S.validDate(c.from)&&S.validDate(c.to)&&Array.isArray(c.dates)&&c.dates.length>0&&c.dates.every((d,i)=>S.validDate(d)&&d>=c.from&&d<=c.to&&(!i||d>c.dates[i-1]));}
function validContract(e){return e?.rulesVerified===true&&!!e.contractSource&&['work','valuation','subscription'].every(k=>validCalendar(e.calendars?.[k]));}
function compile(e){if(!validContract(e))return null;return {work:e.calendars.work,deadlines:new Map(),evidence:e};}
function deadline(d,e,view){view=view||compile(e);if(!view||view.evidence!==e||!S.validDate(d))return null;const c=view.work;if(d<c.from||d>c.to)return null;if(view.deadlines.has(d))return view.deadlines.get(d);let low=0,high=c.dates.length;while(low<high){const mid=(low+high)>>1;if(c.dates[mid]<=d)low=mid+1;else high=mid;}const target=c.dates[low+1],value=target?Date.parse(target+'T14:00:00+08:00'):null;view.deadlines.set(d,value);return value;}
function orderContext(t,e){if(!Number.isFinite(Number(t)))return {error:'invalid_view_time'};const current=day(t),common={computedAt:new Date(Number(t)).toISOString(),knownAt:Number(t),asOfDate:current,inputVersion:S.INPUT_VERSION};if(!validContract(e))return {...common,error:'fund_calendar_unverified'};
  const calendars=Object.values(e.calendars);if(calendars.some(c=>current<c.from||current>c.to))return {...common,error:'calendar_coverage_short'};
  const c=e.calendars.subscription,before=Number(t)<Date.parse(current+'T15:00:00+08:00'),orderDate=c.dates.includes(current)&&before?current:c.dates.find(d=>d>current);
  return orderDate?{...common,orderDate,futureOrder:orderDate>current,calendarVersion:['work','valuation','subscription'].map(k=>e.calendars[k].version).join('|'),contractSource:e.contractSource}:{...common,error:'calendar_coverage_short'};}
function selectKnown(economicRows,e,context){const out={rows:[],waitingForPublication:[],missingDates:[],segmentFrom:null};if(context?.error||!validContract(e))return {...out,error:context?.error||'fund_calendar_unverified'};
  const c=e.calendars.valuation,view=compile(e);if(e.initializationFrom<c.from||context.asOfDate>c.to)return {...out,error:'calendar_coverage_short'};
  const byDate=new Map(economicRows.map(r=>[r.date,r]));if(!byDate.has(e.initializationFrom))return {...out,error:'initialization_history_missing'};
  for(const date of c.dates.filter(d=>d>=e.initializationFrom&&d<=context.asOfDate)){const knownAt=deadline(date,e,view);if(knownAt===null)return {...out,error:'calendar_coverage_short'};if(knownAt>context.knownAt){out.waitingForPublication.push(date);continue;}const r=byDate.get(date);
    // A gap resets only when its expected observation has become knowable.
    if(!r){out.missingDates.push(date);out.rows=[];out.segmentFrom=null;continue;}
    if(String(r.navType)!=='1')return {...out,error:'daily_sampling_conflict'};
    if(!out.rows.length)out.segmentFrom=date;out.rows.push({date,close:r.close,availableAt:new Date(knownAt).toISOString()});}
  if(!out.rows.length)return {...out,error:'no_known_nav'};
  if((Date.parse(context.asOfDate)-Date.parse(out.rows.at(-1).date))/86400000>14)return {...out,error:'stale_nav_over_14d'};return out;}
module.exports={day,validCalendar,validContract,compile,deadline,orderContext,selectKnown};

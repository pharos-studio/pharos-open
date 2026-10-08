'use strict';
// Operational, verified source ledger (2013–2026). Annual schedules include subsequent special closures.
const SSE = 'https://www.sse.com.cn/';
const ANNUAL = {
  2013: ['aboutus/mediacenter/hotandd/c/c_20150912_3988635.shtml', '01-01:01-03 02-09:02-15 04-04:04-06 04-29:05-01 06-10:06-12 09-19:09-21 10-01:10-07'],
  2014: ['aboutus/mediacenter/hotandd/c/c_20150912_3988725.shtml', '01-01:01-01 01-31:02-06 04-07:04-07 05-01:05-03 06-02:06-02 09-08:09-08 10-01:10-07'],
  2015: ['disclosure/dealinstruc/closed/list/c/c_20160104_3979217.shtml', '01-01:01-03 02-18:02-24 04-05:04-06 05-01:05-03 06-20:06-22 09-27:09-27 10-01:10-07'],
  2016: ['disclosure/dealinstruc/closed/list/c/c_20160104_4028872.shtml', '01-01:01-03 02-07:02-13 04-02:04-04 04-30:05-02 06-09:06-11 09-15:09-17 10-01:10-07'],
  2017: ['disclosure/announcement/general/c/c_20161222_4218613.shtml', '01-01:01-02 01-27:02-02 04-02:04-04 04-29:05-01 05-28:05-30 10-01:10-08'],
  2018: ['disclosure/announcement/general/c/c_20171222_4438363.shtml', '01-01:01-01 02-15:02-21 04-05:04-07 04-29:05-01 06-16:06-18 09-22:09-24 10-01:10-07'],
  2019: ['disclosure/announcement/general/c/c_20181220_4696473.shtml', '01-01:01-01 02-04:02-10 04-05:04-07 05-01:05-01 06-07:06-09 09-13:09-15 10-01:10-07'],
  2020: ['disclosure/announcement/general/c/c_20191220_4969627.shtml', '01-01:01-01 01-24:01-30 04-04:04-06 05-01:05-05 06-25:06-27 10-01:10-08'],
  2021: ['disclosure/dealinstruc/closed/c/c_20201224_5286951.shtml', '01-01:01-03 02-11:02-17 04-03:04-05 05-01:05-05 06-12:06-14 09-19:09-21 10-01:10-07'],
  2022: ['disclosure/dealinstruc/closed/c/c_20211220_5663057.shtml', '01-01:01-03 01-31:02-06 04-03:04-05 04-30:05-04 06-03:06-05 09-10:09-12 10-01:10-07'],
  2023: ['disclosure/announcement/general/c/c_20221227_5714458.shtml', '01-01:01-02 01-21:01-27 04-05:04-05 04-29:05-03 06-22:06-24 09-29:10-06'],
  2024: ['disclosure/dealinstruc/closed/c/c_20231226_5733941.shtml', '01-01:01-01 02-09:02-17 04-04:04-06 05-01:05-05 06-10:06-10 09-15:09-17 10-01:10-07'],
  2025: ['disclosure/announcement/general/c/c_20241223_10767108.shtml', '01-01:01-01 01-28:02-04 04-04:04-06 05-01:05-05 05-31:06-02 10-01:10-08'],
  2026: ['disclosure/announcement/general/c/c_20251222_10802507.shtml', '01-01:01-03 02-15:02-23 04-04:04-06 05-01:05-05 06-19:06-21 09-25:09-27 10-01:10-07']
};
const CORRECTIONS = [
  { year: 2015, url: SSE + 'disclosure/dealinstruc/closed/list/c/c_20160104_3979337.shtml', ranges: '09-03:09-05', check: '70周年' },
  { year: 2019, url: SSE + 'disclosure/announcement/general/c/c_20190418_4771364.shtml', ranges: '05-01:05-04', check: '劳动节' },
  { year: 2020, url: SSE + 'disclosure/announcement/general/c/c_20200127_4991582.shtml', ranges: '01-31:02-02', check: '延长' }
];

const { addDays, calendarIndex, upperBound } = require('./hs300Signal');
function isOpen(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !ANNUAL[Number(day.slice(0,4))]) return null;
  const year=Number(day.slice(0,4)), date=new Date(day+'T00:00:00Z');
  if (!Number.isFinite(date.getTime())) return null;
  if (date.toISOString().slice(0,10)!==day) return null;
  const ranges=[ANNUAL[year][1],...CORRECTIONS.filter(c=>c.year===year).map(c=>c.ranges)].join(' ').split(' ');
  return ![0,6].includes(date.getUTCDay()) && !ranges.some(r=>{const [a,b]=r.split(':');return day>=year+'-'+a&&day<=year+'-'+b;});
}
const openDates=[];
for(let d='2013-01-01';d<='2026-12-31';d=addDays(d,1)) if(isOpen(d)) openDates.push(d);
const DATA=Object.freeze({state:'verified',from:'2013-01-01',to:'2026-12-31',openDates:Object.freeze(openDates),
  sources:Object.freeze([...Object.values(ANNUAL).map(a=>SSE+a[0]),...CORRECTIONS.map(c=>c.url)])});
const INDEX=calendarIndex(DATA);
function orderContext(instant=Date.now()) {
  const local=new Date(Number(instant)+8*3600000);
  if(!Number.isFinite(local.getTime())) return {error:'invalid_view_time'};
  const day=local.toISOString().slice(0,10), open=isOpen(day);
  if(open==null) return {error:'calendar_unverified'};
  const orderDate=open&&local.getUTCHours()<15?day:openDates[upperBound(openDates,day)];
  if(!orderDate || isOpen(addDays(orderDate,-14))==null) return {error:'calendar_unverified'};
  return {orderDate,knownThrough:day,viewedAt:new Date(instant).toISOString(),source:SSE+ANNUAL[Number(orderDate.slice(0,4))][0],
    calendarFrom:DATA.from,calendarTo:DATA.to,marketCalendarOnly:true};
}
module.exports = { SSE, ANNUAL, CORRECTIONS, DATA, INDEX, isOpen, orderContext };

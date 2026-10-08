'use strict';
// Operational calendar, not research data. Unsupported years fail closed.
const { weekKey } = require('./priceIndicators');
const CALENDARS = {
  2025: { source: 'https://www.sse.com.cn/disclosure/announcement/general/c/c_20241223_10767108.shtml',
    ranges: [['01-01','01-01'],['01-28','02-04'],['04-04','04-06'],['05-01','05-05'],['05-31','06-02'],['10-01','10-08']] },
  2026: { source: 'https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml',
    ranges: [['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']] }
};
function addDays(day, n) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function isOpen(day) {
  const year = Number(day.slice(0, 4)), cal = CALENDARS[year];
  if (!cal || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day + 'T00:00:00Z'))) return null;
  if(new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day) return null;
  const wd = new Date(day + 'T00:00:00Z').getUTCDay();
  return wd !== 0 && wd !== 6 && !cal.ranges.some(([a,b]) => day >= year + '-' + a && day <= year + '-' + b);
}
function nextOpen(day, count = 1) {
  let d = day;
  for (let i = 0; i < 40; i++) { d = addDays(d, 1); const open = isOpen(d);
    if (open == null) return null; if (open && --count === 0) return d; }
  return null;
}
function orderContext(now) {
  const local = new Date(now + 8 * 3600000), day = local.toISOString().slice(0,10);
  const open = isOpen(day);
  if (open == null) return { error: 'calendar_unverified' };
  const orderDate = open && local.getUTCHours() < 15 ? day : nextOpen(day);
  if (!orderDate || Array.from({length:15},(_,i)=>isOpen(addDays(orderDate,-i))).some(v=>v==null)) return { error: 'calendar_unverified' };
  return { orderDate, knownThrough: day, source: CALENDARS[Number(orderDate.slice(0,4))].source,
    checkedAt: '2026-10-02', marketCalendarOnly: true };
}
function prepare(rows, context) {
  if (!context || context.error) return { error: context?.error || 'calendar_unverified' };
  const orderDate = context.orderDate;
  const knownThrough = context.knownThrough || orderDate;
  const known = rows.filter(r => {
    if (r.date >= orderDate) return false;
    // Old observations already predate the conservative availability window.
    if (r.date < addDays(orderDate,-40)) return true;
    const available=nextOpen(r.date,2);
    return isOpen(r.date) === true && available != null && available <= knownThrough;
  });
  if (!known.length || (Date.parse(orderDate)-Date.parse(known.at(-1).date))/86400000 > 14) return { error:'stale_nav_history' };
  const weekEndDates = new Map();
  for (const r of rows) if (r.date < addDays(orderDate,-21)) weekEndDates.set(weekKey(r.date),r.date);
  for (let day = addDays(orderDate,-21); day < weekKey(orderDate); day = addDays(day,1)) {
    const open = isOpen(day); if (open == null) return { error:'calendar_unverified' };
    if (open) weekEndDates.set(weekKey(day),day);
  }
  // Do not substitute Thursday for an unpublished Friday (or holiday week's actual last day).
  const previousWeek = addDays(weekKey(orderDate),-7), expected = weekEndDates.get(previousWeek);
  if (expected && expected <= known.at(-1).date && !known.some(r=>r.date===expected)) return {error:'incomplete_week_close'};
  if (expected && expected > known.at(-1).date) return {error:'incomplete_week_close'};
  const knownDates=new Set(known.map(r=>r.date));
  for(let day=addDays(orderDate,-21);day<=known.at(-1).date;day=addDays(day,1)) {
    const open=isOpen(day);if(open==null)return {error:'calendar_unverified'};
    if(open&&!knownDates.has(day))return {error:'nav_calendar_coverage_gap'};
  }
  return { known, weekEndDates, context };
}
module.exports = { CALENDARS, addDays, isOpen, nextOpen, orderContext, prepare };

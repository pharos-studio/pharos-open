'use strict';
// Frozen trend route: callers own publication filtering and completed-week evidence.
const { rsiWilder, weeklyCloses } = require('./priceIndicators');
const VERSION = 'dividend-trend-v1';
const PARAMS = Object.freeze({ trendMinDip: 2, trendMaxDip: 6, trendRecovery: 1.5,
  trendMaxBias: 8, trendRsiMin: 45, trendRsiMax: 65 });
const average = rows => rows.reduce((s, r) => s + r.close, 0) / rows.length;
function conditionsOf(x) {
  return {navAboveMa250:x.close>x.ma250,ma60AboveMa250:x.ma60>x.ma250,
    dip60InRange:x.dip60<=-PARAMS.trendMinDip&&x.dip60>=-PARAMS.trendMaxDip,
    recovery10Ready:x.recovery10>=PARAMS.trendRecovery,bias250Allowed:x.bias250<=PARAMS.trendMaxBias,
    weeklyRsiInRange:x.weeklyRsi14>=PARAMS.trendRsiMin&&x.weeklyRsi14<=PARAMS.trendRsiMax,
    weeklyRsiRising:x.weeklyRsi14>x.previousWeeklyRsi14};
}
function evaluate(rows, orderDate, options = {}) {
  if (!Array.isArray(rows) || rows.length < 260) return { available: false, reason: 'insufficient_adjusted_nav' };
  const last = rows.at(-1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate) || last.date >= orderDate || rows.some((r, i) =>
    !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(r.close) || r.close <= 0 || i > 0 && r.date <= rows[i - 1].date))
    return { available: false, reason: 'invalid_or_future_adjusted_nav' };
  const weeks = weeklyCloses(rows, orderDate).filter(w => !options.weekEndDates || options.weekEndDates.get(w.week) <= last.date);
  if (weeks.length < 16) return { available: false, reason: 'insufficient_completed_weeks' };
  const rsi = rsiWilder(weeks.map(w => w.close)), previous = rsiWilder(weeks.slice(0, -1).map(w => w.close));
  if (!Number.isFinite(rsi) || !Number.isFinite(previous)) return { available: false, reason: 'invalid_weekly_rsi' };
  const ma250 = average(rows.slice(-250)), ma60 = average(rows.slice(-60));
  const bias250 = (last.close / ma250 - 1) * 100;
  const dip60 = (last.close / Math.max(...rows.slice(-60).map(r => r.close)) - 1) * 100;
  const recovery10 = (last.close / Math.min(...rows.slice(-10).map(r => r.close)) - 1) * 100;
  const conditions = conditionsOf({close:last.close,ma250,ma60,dip60,recovery10,bias250,weeklyRsi14:rsi,previousWeeklyRsi14:previous});
  return { available: true, trend: Object.values(conditions).every(Boolean), conditions, metrics: {
    navDate: last.date, bias250, ma60, ma250, dip60, recovery10,
    weeklyRsi14: rsi, previousWeeklyRsi14: previous,
    percentile250: rows.slice(-250).filter(r => r.close <= last.close).length / 250 * 100 } };
}
function eligibility(fund) {
  if (!fund || fund.profileState === 'needs_review') return 'profile_unverified';
  if (fund.market && fund.market !== 'A' || /QDII|混合|主动|债券|货币/.test(fund.fundType || '')) return 'scope_unsupported';
  if (/港股|香港|恒生|全球|海外|美股|标普|纳斯达克/.test(fund.indexName || '')) return 'scope_unsupported';
  if (fund.market !== 'A' || !fund.fundType || !fund.indexCode || !fund.indexName) return 'profile_unverified';
  if (!/^指数型/.test(fund.fundType) || !/红利|股息/.test(fund.indexName)) return 'scope_unsupported';
  return null;
}
module.exports = { VERSION, PARAMS, conditionsOf, evaluate, eligibility };

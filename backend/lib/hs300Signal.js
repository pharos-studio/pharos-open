'use strict';
// Frozen production mathematics. No I/O, configuration, or research dependencies.
const { weekKey, rsiWilder } = require('./priceIndicators');
const VERSION = 'hs300-dual-v1';
const DEEP = Object.freeze({ biasPeriod: 120, biasMax: -3.0084, repair: 1, frequency: 'weekly', period: 14, rsiMax: null });
const TREND = Object.freeze({ frequency: 'weekly', period: 14, minDip: 2, maxDip: 6,
  recovery: 1.5, maxBias: 8, rsiMin: 45, rsiMax: 65, slopeDays: null, maOrder: false, maxBias60: null });
const BASELINE = Object.freeze({ deep: DEEP, trend: TREND, structure: 'A', peCap: 25 });
const dayMs = d => Date.parse(d + 'T00:00:00Z');
const days = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 86400000);
function addDays(day, n) { const d = new Date(dayMs(day)); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function monthKey(day, lag = 0) { const d = new Date(day.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + lag); return d.toISOString().slice(0, 7); }
function upperBound(dates, day) { let lo = 0, hi = dates.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (dates[m] <= day) lo = m + 1; else hi = m; } return lo; }
function calendarIndex(calendar) {
  if (!calendar || calendar.state !== 'verified' || !calendar.sources?.length || !Array.isArray(calendar.openDates) ||
    calendar.openDates.some((d, i) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || i && d <= calendar.openDates[i - 1])) throw Error('invalid_verified_calendar');
  const dates = calendar.openDates, set = new Set(dates), end = new Map();
  for (const d of dates) end.set(weekKey(d), d);
  return { dates, set, end, from: calendar.from, to: calendar.to,
    available: day => { if (day < calendar.from || day > calendar.to) return null; return dates[upperBound(dates, day) + 1] || null; } };
}
function preparePe(rows) {
  const byMonth = new Map();
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(row.pe) || row.pe <= 0) throw Error('invalid_pe_row');
    const key = monthKey(row.date);
    if (byMonth.has(key)) throw Error('duplicate_pe_month');
    byMonth.set(key, row);
  }
  return rows.slice().sort((a, b) => a.date.localeCompare(b.date)).map(row => {
    const previous = Array.from({ length: 60 }, (_, i) => byMonth.get(monthKey(row.date, -i - 1)));
    return { ...row, percentile: previous.every(Boolean) ? previous.filter(x => x.pe < row.pe).length / 60 * 100 : null,
      historyMonths: previous.filter(Boolean).length,
      missingMonths: previous.flatMap((x, i) => x ? [] : [monthKey(row.date, -i - 1)]) };
  });
}
function peAt(prepared, orderDate, calendar, knownThrough = orderDate) {
  const latest = prepared.filter(p => {
    const available = p.availableDate || calendar.available(p.date);
    return available && available <= knownThrough && p.date < orderDate;
  }).at(-1);
  if (!latest) return { available: false, reason: 'pe_not_yet_available' };
  const availableDate = latest.availableDate || calendar.available(latest.date);
  return { ...latest, availableDate, replay: latest.publicationVerified && latest.vintageVerified ? 'point_in_time' : 'revised_data_replay',
    available: latest.percentile != null && days(latest.date, orderDate) <= 50,
    reason: latest.percentile == null ? 'pe_missing_prior_months' : days(latest.date, orderDate) > 50 ? 'stale_pe' : null };
}
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
function preparePrice(known, orderDate, calendar) {
  if (known.length < 260) return { available: false, reason: 'price_warmup', navDays: known.length };
  if (known.some((r, i) => !Number.isFinite(r.close) || r.close <= 0 || r.date >= orderDate || i && r.date <= known[i - 1].date))
    return { available: false, reason: 'invalid_or_future_price' };
  if (days(known.at(-1).date, orderDate) > 14) return { available: false, reason: 'stale_price' };
  const dates = new Set(known.map(r => r.date)), first = known[0].date, last = known.at(-1).date;
  const values = known.map(r => r.close), price = values.at(-1), mas = {}, biases = {}, repairs = {};
  for (const n of [60, 120, 250]) {
    mas[n] = mean(values.slice(-n)); biases[n] = (price / mas[n] - 1) * 100;
    const recent = Array.from({ length: 10 }, (_, i) => {
      const end = values.length - i; return (values[end - 1] / mean(values.slice(end - n, end)) - 1) * 100;
    });
    repairs[n] = biases[n] - Math.min(...recent);
  }
  const weekRows = new Map();
  for (const row of known) weekRows.set(weekKey(row.date), row);
  const complete = [], missingWeeks = [];
  for (const [week, endDate] of calendar.end) {
    if (week >= weekKey(orderDate) || endDate < first || endDate > last) continue;
    const row = weekRows.get(week);
    if (!row || row.date !== endDate || !dates.has(endDate)) missingWeeks.push(week);
    else complete.push({ week, date: endDate, close: row.close });
  }
  const rsis = {};
  for (const [frequency, closes] of [['daily', values], ['weekly', complete.map(r => r.close)]]) {
    rsis[frequency] = {};
    for (const n of [9, 14, 21]) rsis[frequency][n] = { current: rsiWilder(closes, n), previous: rsiWilder(closes.slice(0, -1), n),
      count: closes.length, valid: frequency === 'daily' || missingWeeks.length === 0 };
  }
  return { available: true, navDays: known.length, navDate: last, price, mas, biases, repairs, rsis,
    weeklyDate: complete.at(-1)?.date || null, missingWeeks,
    dip60: (1 - price / Math.max(...values.slice(-60))) * 100,
    recovery10: (price / Math.min(...values.slice(-10)) - 1) * 100,
    position250: values.slice(-250).filter(v => v <= price).length / 250 * 100,
    slopes: Object.fromEntries([10, 20, 40].map(lag => [lag, known.length >= 250 + lag ? mas[250] - mean(values.slice(-250 - lag, -lag)) : null])) };
}
function evaluatePath(p, config, path) {
  if (!p.available) return { available: false, triggered: false, reason: p.reason };
  const rsi = p.rsis[config.frequency]?.[config.period];
  if (!rsi || !rsi.valid || rsi.count < config.period + 2 || !Number.isFinite(rsi.current) || !Number.isFinite(rsi.previous))
    return { available: false, triggered: false, reason: 'rsi_incomplete_or_warmup' };
  let conditions;
  if (path === 'deep') conditions = { negativeBias: p.biases[config.biasPeriod] <= config.biasMax,
    repair: config.repair == null || p.repairs[config.biasPeriod] >= config.repair,
    rsiRising: rsi.current > rsi.previous, rsiCap: config.rsiMax == null || rsi.current <= config.rsiMax };
  else {
    if (config.slopeDays && p.navDays < Math.max(260, 250 + config.slopeDays))
      return { available: false, triggered: false, reason: 'ma_slope_warmup' };
    conditions = { priceAbove: p.price > p.mas[250], maAbove: p.mas[60] > p.mas[250],
      dip: p.dip60 >= config.minDip && p.dip60 <= config.maxDip,
      recovery: p.recovery10 >= config.recovery, bias: p.biases[250] <= config.maxBias,
      rsiRange: rsi.current >= config.rsiMin && rsi.current <= config.rsiMax, rsiRising: rsi.current > rsi.previous };
    if (config.slopeDays) conditions.slope = p.slopes[config.slopeDays] > 0;
    if (config.maOrder) conditions.maOrder = p.mas[60] > p.mas[120] && p.mas[120] > p.mas[250];
    if (config.maxBias60 != null) conditions.bias60 = p.biases[60] <= config.maxBias60;
  }
  return { available: true, triggered: Object.values(conditions).every(Boolean), conditions,
    rsi: rsi.current, previousRsi: rsi.previous, rsiFrequency: config.frequency, rsiPeriod: config.period };
}
function evaluate(p, pe) {
  const arm=BASELINE;
  const d = evaluatePath(p, arm.deep, 'deep'), t = evaluatePath(p, arm.trend, 'trend');
  const applyPe = (r, required) => !required ? r : !pe.available ? { ...r, available: false, triggered: false, reason: pe.reason }
    : { ...r, triggered: r.triggered && pe.percentile <= arm.peCap, conditions: { ...r.conditions, peGate: pe.percentile <= arm.peCap } };
  const deep = applyPe(d, true), trend = applyPe(t, arm.structure === 'A');
  return { deep, trend, triggered: deep.triggered || trend.triggered,
    available: deep.available && trend.available || deep.triggered || trend.triggered,
    route: deep.triggered && trend.triggered ? 'both' : deep.triggered ? 'deep' : trend.triggered ? 'trend' : null };
}
module.exports = {VERSION, DEEP, TREND, BASELINE, days, addDays, monthKey, upperBound, calendarIndex, preparePe, peAt, preparePrice, evaluatePath, evaluate};

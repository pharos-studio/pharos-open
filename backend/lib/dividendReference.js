'use strict';
// Optional daily reference only. The monthly plan never consumes this result.
const { rsiWilder } = require('./priceIndicators');
const calendar = require('./domesticCalendar');
const VERSION = 'dividend-low-daily-rsi-reference-v1';
const PARAMS = Object.freeze({ lowWindow: 60, distancePct: 3, rsiPeriod: 14 });
const LABELS = { ready: '参考条件满足', not_met: '尚未满足', unavailable: '数据不足' };
const REASONS = {
  scope_unsupported: '这只基金不在国内红利指数基金的参考范围内。',
  profile_unverified: '基金身份资料尚不足以计算可靠的加投参考。',
  calendar_unverified: '当前交易日历尚未核验。',
  stale_nav_history: '可用净值已过期，等待数据更新后再查看。',
  nav_calendar_coverage_gap: '近期净值存在缺口，等待数据补齐后再查看。',
  insufficient_adjusted_nav: '计算需要至少61个可用净值观察值。',
  invalid_adjusted_nav: '净值序列未通过检查。',
};
function unavailable(reason) {
  return { version: VERSION, state: 'unavailable', label: LABELS.unavailable,
    reason, explanation: REASONS[reason] || '复权净值或分红资料暂不可用，请稍后重试。',
    parameters: PARAMS, metrics: null, conditions: null };
}

// Publication filtering is daily-only: do not inherit the old completed-week gate.
function prepareDaily(rows, context) {
  if (!context || context.error) return { error: context?.error || 'calendar_unverified' };
  const { orderDate } = context, knownThrough = context.knownThrough || orderDate;
  const known = rows.filter(r => {
    const weekday = new Date(r.date + 'T00:00:00Z').getUTCDay();
    if (weekday === 0 || weekday === 6 || r.date >= orderDate || r.date > knownThrough) return false;
    if (r.date < calendar.addDays(orderDate, -40)) return true;
    const available = calendar.nextOpen(r.date, 2);
    return calendar.isOpen(r.date) === true && available != null && available <= knownThrough;
  });
  if (!known.length || (Date.parse(orderDate) - Date.parse(known.at(-1).date)) / 86400000 > 14)
    return { error: 'stale_nav_history' };
  const dates = new Set(known.map(r => r.date));
  for (let day = calendar.addDays(orderDate, -21); day <= known.at(-1).date; day = calendar.addDays(day, 1)) {
    const open = calendar.isOpen(day);
    if (open == null) return { error: 'calendar_unverified' };
    if (open && !dates.has(day)) return { error: 'nav_calendar_coverage_gap' };
  }
  return { known };
}
function evaluate(rows) {
  if (!Array.isArray(rows) || rows.length < PARAMS.lowWindow + 1) return unavailable('insufficient_adjusted_nav');
  if (rows.some((r, i) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
      !Number.isFinite(r.close) || r.close <= 0 || i > 0 && r.date <= rows[i - 1].date))
    return unavailable('invalid_adjusted_nav');
  const current = rows.at(-1), previous = rows.at(-2);
  const priorLow60 = Math.min(...rows.slice(-PARAMS.lowWindow - 1, -1).map(r => r.close));
  const closes = rows.map(r => r.close);
  const dailyRsi14 = rsiWilder(closes, PARAMS.rsiPeriod);
  const previousDailyRsi14 = rsiWilder(closes.slice(0, -1), PARAMS.rsiPeriod);
  if (![dailyRsi14, previousDailyRsi14].every(Number.isFinite)) return unavailable('invalid_adjusted_nav');
  const conditions = { lowPosition: current.close <= priorLow60 * (1 + PARAMS.distancePct / 100),
    dailyRsiRising: dailyRsi14 - previousDailyRsi14 > 1e-12 };
  const state = Object.values(conditions).every(Boolean) ? 'ready' : 'not_met';
  const missing = [!conditions.lowPosition ? '距离近期低点超过3%' : null,
    !conditions.dailyRsiRising ? '日RSI尚未上升' : null].filter(Boolean);
  return { version: VERSION, state, label: LABELS[state], reason: null, parameters: PARAMS, conditions,
    explanation: state === 'ready' ? '位置接近近期低点，日RSI开始回升。是否增加投入由你决定。' : missing.join('；') + '。是否增加投入由你决定。',
    metrics: { navDate: current.date, previousNavDate: previous.date,
      distancePct: (current.close / priorLow60 - 1) * 100, dailyRsi14, previousDailyRsi14 } };
}
module.exports = { VERSION, PARAMS, unavailable, prepareDaily, evaluate };

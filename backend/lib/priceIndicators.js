'use strict';
// Pure price indicators. Callers own publication-date filtering and completed-week availability.
function weekKey(day) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
function weeklyCloses(rows, asOf) {
  const currentWeek = weekKey(asOf), weeks = [];
  for (const r of rows) {
    const w = weekKey(r.date);
    if (w >= currentWeek) continue; // 当周即使已有周五报价，仍等到下周才使用。
    if (!weeks.length || weeks[weeks.length - 1].week !== w) weeks.push({ week: w, close: r.close });
    else weeks[weeks.length - 1].close = r.close;
  }
  return weeks;
}
function rsiWilder(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    gain += Math.max(d, 0); loss += Math.max(-d, 0);
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

module.exports = { weekKey, weeklyCloses, rsiWilder };

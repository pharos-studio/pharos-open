'use strict';
const store = require('../lib/store');
const data = require('./dividendData');
const adjusted = require('../lib/fundAdjustedNav');
const calendar = require('../lib/domesticCalendar');
const { eligibility } = require('../lib/dividendTrend');
const reference = require('../lib/dividendReference');

function createService(deps = {}) {
  const read = deps.read || store.readJSON, fetchFull = deps.fetchFull || (code => data.fetchFull(code));
  const now = deps.now || Date.now;
  async function get(code) {
    if (!/^\d{6}$/.test(code || '')) throw Object.assign(Error('invalid_fund_code'), { statusCode: 400 });
    const fund = (read('holdings.json').funds || []).find(f => f.code === code);
    if (!fund) throw Object.assign(Error('fund_not_found'), { statusCode: 404 });
    const instant = now(), computedAt = new Date(instant).toISOString();
    const result = value => ({ code, computedAt, ...value });
    const reason = fund.category === 'dividend' ? eligibility(fund) : 'scope_unsupported';
    if (reason) return result(reference.unavailable(reason));
    const context = calendar.orderContext(instant);
    if (context.error) return result(reference.unavailable(context.error));
    try {
      const full = await fetchFull(code);
      // Find the knowable cutoff before adjustment: later NAV/action values cannot
      // change earlier RSI, and the latest unpublished observation is not compared.
      const raw = full.history.slice().sort((a, b) => a.date.localeCompare(b.date));
      const prepared = reference.prepareDaily(raw, context);
      if (prepared.error) return result(reference.unavailable(prepared.error));
      const cutoff = prepared.known.at(-1).date, dates = new Set(prepared.known.map(r => r.date));
      const actions = full.actions && !full.actions.error ? { ...full.actions,
        dividends: full.actions.dividends.filter(a => a.date <= cutoff),
        splits: full.actions.splits.filter(a => a.date <= cutoff) } : full.actions;
      const economic = adjusted.reinvestedNav(raw.filter(r => r.date <= cutoff), actions);
      if (economic.error) return result(reference.unavailable(economic.error));
      return result({ ...reference.evaluate(economic.rows.filter(r => dates.has(r.date))),
        source: full.source || 'eastmoney', sourceUrl: full.sourceUrl || null,
        corporateActionSource: actions.sourceUrl || null,
        availability: 'conservative_T_plus_2_open_days', fetchedAt: full.updatedAt });
    } catch (_) { return result(reference.unavailable('reference_data_unavailable')); }
  }
  return { get };
}
module.exports = { ...createService(), createService };

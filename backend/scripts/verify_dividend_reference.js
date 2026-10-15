'use strict';
// Synthetic data only; no setup, real holdings, cache writes or external requests.
const assert = require('node:assert/strict');
const R = require('../lib/dividendReference');
const C = require('../lib/domesticCalendar');
const { createService } = require('../services/dividendReference');
const monthly = require('../engines/strategies/dividend');
const NOW = Date.parse('2026-10-12T06:00:00Z');
const FUND = { code: '999001', name: '合成红利基金', category: 'dividend', market: 'A',
  profileState: 'ready', fundType: '指数型-股票', indexCode: 'TEST', indexName: '合成红利低波指数' };
function sample() {
  const dates = [];
  for (let d = '2026-01-01'; d <= '2026-10-15'; d = C.addDays(d, 1)) if (C.isOpen(d)) dates.push(d);
  const cutoff = dates.indexOf('2026-10-08');
  return { history: dates.map((date, i) => ({ date, nav: i < cutoff ? 1 + (cutoff - 1 - i) * .001 : i === cutoff ? 1.01 : 4, dayChange: null })),
    actions: { dividends: [], splits: [], sourceUrl: 'https://example.invalid/actions' },
    source: 'synthetic', sourceUrl: 'https://example.invalid/nav', updatedAt: NOW };
}
function service(data, fund = FUND, options = {}) {
  return createService({ now: () => NOW, read: key => { assert.equal(key, 'holdings.json'); return { funds: fund ? [fund] : [] }; },
    fetchFull: async code => { assert.equal(code, FUND.code); return data; }, ...options });
}
async function routeChecks(svc) {
  const http = require('node:http'), target = require('../services/dividendReference');
  const originalCreate = http.createServer, originalGet = target.get;
  let handle;
  try {
    http.createServer = callback => { handle = callback; return {}; };
    target.get = svc.get;
    delete require.cache[require.resolve('../server')]; require('../server');
    const call = async url => {
      let status = 200, body;
      await handle({ url, method: 'GET', headers: {} }, { writeHead: code => { status = code; }, end: value => { body = JSON.parse(value); } });
      return { status, body };
    };
    assert.equal((await call('/api/dividend-reference?code=999001')).body.state, 'ready');
    for (const q of ['', '?code=../../bad', '?code=999001&code=999002', '?code=999001&asOf=2099-01-01'])
      assert.equal((await call('/api/dividend-reference' + q)).status, 400);
    assert.equal((await call('/api/dividend-reference?code=999002')).status, 404);
  } finally { http.createServer = originalCreate; target.get = originalGet; delete require.cache[require.resolve('../server')]; }
}
async function run() {
  const data = sample(), svc = service(data), before = monthly(FUND), ready = await svc.get(FUND.code);
  assert.equal(ready.state, 'ready'); assert.equal(ready.metrics.navDate, '2026-10-08');
  assert(Math.abs(ready.metrics.distancePct - 1) < 1e-10); assert(ready.metrics.dailyRsi14 > ready.metrics.previousDailyRsi14);
  assert.deepEqual(monthly(FUND), before);
  for (const k of ['action', 'marketVerdict', 'verdict', 'positionScore']) assert.equal(before[k], null);
  assert.equal(before.executable, false); assert.equal(before.matrix.marketState, 'monthly_dca');
  for (const k of ['action', 'verdict', 'marketVerdict', 'score', 'executable']) assert(!Object.hasOwn(ready, k));

  // Monday's unpublished Friday is not used or required by this daily reference.
  const prepared = R.prepareDaily(data.history, C.orderContext(NOW));
  assert.equal(prepared.known.at(-1).date, '2026-10-08');
  const future = structuredClone(data);
  future.history.filter(r => r.date > '2026-10-08').forEach(r => { r.nav *= 77; });
  future.actions.dividends.push({ date: '2026-10-13', amount: 10 });
  assert.deepEqual(await service(future).get(FUND.code), ready, 'future NAV/action values cannot change reference');
  const removed = structuredClone(data); removed.history = removed.history.filter(r => r.date <= '2026-10-08');
  assert.deepEqual(await service(removed).get(FUND.code), ready, 'future removal cannot change reference');

  const rows = data.history.filter(r => r.date <= '2026-10-08').map(r => ({ date: r.date, close: r.nav }));
  const boundary = structuredClone(rows); boundary.at(-1).close = 1.03;
  assert.equal(R.evaluate(boundary).conditions.lowPosition, true, '3% inclusive');
  boundary.at(-1).close = 1.030001;
  const high = R.evaluate(boundary); assert.equal(high.state, 'not_met'); assert.equal(high.conditions.dailyRsiRising, true);
  assert.equal(high.conditions.lowPosition, false);
  boundary.at(-1).close = .99;
  assert(Math.abs(R.evaluate(boundary).metrics.distancePct + 1) < 1e-10, 'prior low excludes current value');
  const flat = rows.map(r => ({ ...r, close: 1 }));
  assert.equal(R.evaluate(flat).metrics.dailyRsi14, 50);
  assert.equal(R.evaluate(flat).state, 'not_met'); assert.equal(R.evaluate(flat).conditions.dailyRsiRising, false);
  assert.equal(R.evaluate(rows.slice(-60)).state, 'unavailable');
  assert.equal(R.evaluate([...rows, rows.at(-1)]).reason, 'invalid_adjusted_nav');

  const gap = structuredClone(data); gap.history = gap.history.filter(r => r.date !== '2026-09-30');
  assert.equal((await service(gap).get(FUND.code)).reason, 'nav_calendar_coverage_gap');
  const stale = structuredClone(data); stale.history = stale.history.filter(r => r.date < '2026-09-01');
  assert.equal((await service(stale).get(FUND.code)).reason, 'stale_nav_history');
  assert.equal((await service(data, FUND, { now: () => Date.parse('2027-01-05T06:00:00Z') }).get(FUND.code)).reason, 'calendar_unverified');
  let fetched = 0;
  for (const mutation of [{ category: 'growth' }, { profileState: 'needs_review' }, { indexName: '海外红利指数' }, { fundType: '混合型' }]) {
    const invalid = service(data, { ...FUND, ...mutation }, { fetchFull: async () => { fetched++; throw Error('must not fetch'); } });
    assert.equal((await invalid.get(FUND.code)).state, 'unavailable');
  }
  assert.equal(fetched, 0);
  assert.equal((await service(data, FUND, { fetchFull: async () => { throw Error('network failed'); } }).get(FUND.code)).state, 'unavailable');
  // A valid ex-dividend raw price drop must be neutral in total return and RSI.
  const dividend = sample(), exDate = '2026-09-29';
  dividend.history.forEach(r => { r.nav = r.date < exDate ? 1 : .9; r.dayChange = 0; });
  dividend.actions.dividends = [{ date: exDate, amount: .1 }];
  const neutral = await service(dividend).get(FUND.code);
  assert.equal(neutral.metrics.distancePct, 0); assert.equal(neutral.metrics.dailyRsi14, 50); assert.equal(neutral.state, 'not_met');
  dividend.history.find(r => r.date === exDate).dayChange = null;
  assert.equal((await service(dividend).get(FUND.code)).state, 'unavailable');
  await routeChecks(svc);
  console.log('dividend reference: frozen formula/boundary, daily T+2/no-week gate, future perturbations, dividend continuity, scope, unavailable recovery, monthly isolation and HTTP query gates passed');
}
if (require.main === module) run().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { run, sample, service, FUND, NOW };

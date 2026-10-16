'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { build } = require('../tools/build-assets.cjs');
async function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-android-runtime-'));
  const assets = path.join(temp, 'assets'); const manifest = build(assets);
  const disk = new Map(), directories = new Set(['/data']); let online = true, injectedFailure = false;
  const context = { console, TextEncoder, TextDecoder, Headers, Response, URL, URLSearchParams, AbortController, AbortSignal, DOMException, Uint8Array, ArrayBuffer, btoa, atob, queueMicrotask, fetch: async () => { throw Error('OS network not allowed in this test'); },
    location: { origin: 'https://app.pharos.invalid', reload() {} },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clearTimeout,
    PharosBridge: {
      call(op, text) {
        const a = JSON.parse(text); let value;
        try {
          if (a.path) assert.ok(a.path === '/data' || a.path.startsWith('/data/'));
          if (op === 'info') value = { key: 'SYNTHETIC-TEST-KEY', online };
          else if (op === 'hash') value = crypto.createHash(a.algorithm).update(Buffer.from(a.base64, 'base64')).digest('hex');
          else if (op === 'exists') value = disk.has(a.path) || directories.has(a.path);
          else if (op === 'mkdir') { directories.add(a.path); value = true; }
          else if (op === 'read') { if (!disk.has(a.path)) throw Error('ENOENT'); value = disk.get(a.path); }
          else if (op === 'write') { if (injectedFailure) throw Error('ENOSPC'); disk.set(a.path, a.base64); value = true; }
          else if (op === 'rename') { if (!disk.has(a.path)) throw Error('ENOENT'); disk.set(a.to, disk.get(a.path)); disk.delete(a.path); value = true; }
          else if (op === 'unlink') { disk.delete(a.path); value = true; }
          else throw Error('unexpected bridge op ' + op);
          return JSON.stringify({ ok: true, value });
        } catch (e) { return JSON.stringify({ ok: false, code: e.message, error: e.message }); }
      },
      request(id, kind) { assert.equal(kind, 'http'); queueMicrotask(() => context.__PharosNativeResult(id, { ok: false, error: 'Synthetic offline' })); }, cancel() {}
    }
  };
  context.window = context; vm.createContext(context);
  for (const name of ['runtime.js', 'backend-bundle.js', 'bootstrap.js']) vm.runInContext(fs.readFileSync(path.join(assets, name), 'utf8'), context, { filename: name });
  await context.PharosMobile.ready;
  return { context, manifest, disk, setOnline: value => { online = value; }, setFail: value => { injectedFailure = value; } };
}
async function run() {
  const f = await fixture(), m = f.context.PharosMobile;
  const state = await m.request('/api/state'); assert.equal(state.holdings.funds.length, 0); assert.equal(state.migration.status, 'complete');
  const fresh = await m.request('/api/refresh'); assert.equal(fresh.funds.length, 0);
  const advice = await m.request('/api/advice?session=am'); assert.equal(advice.funds.length, 0);
  assert.equal(m.load('/backend/lib/http.js').MAX_CONCURRENT, 6);
  assert.equal(f.context.Buffer.from('黄金😀').toString(), '黄金😀');
  assert.equal(f.context.Buffer.from(f.context.Buffer.from('黄金😀').toString('base64url'), 'base64url').toString(), '黄金😀');
  const backup = m.backup(); assert.equal(m.validateBackup(JSON.stringify(backup)).files['state/holdings.json'].funds.length, 0);
  assert.ok(!JSON.stringify(backup).includes('SYNTHETIC-TEST-KEY')); assert.ok(!JSON.stringify(backup).includes('"apiKey"'));
  const bad = JSON.parse(JSON.stringify(backup)); bad.files['config/categories.json'] = []; assert.throws(() => m.validateBackup(JSON.stringify(bad)));
  const incomplete = JSON.parse(JSON.stringify(backup)); delete incomplete.files['state/history.json']; assert.throws(() => m.validateBackup(JSON.stringify(incomplete)));
  const poison = JSON.parse(JSON.stringify(backup)); poison.files['../../escape.json'] = {}; assert.throws(() => m.validateBackup(JSON.stringify(poison)));
  const invalid = JSON.parse(JSON.stringify(backup)); invalid.files['state/holdings.json'].funds.push({ code: '000001', purchases: [{ date: '2026-10-16', amount: -1 }] }); assert.throws(() => m.validateBackup(JSON.stringify(invalid)));
  const impossibleDate = JSON.parse(JSON.stringify(backup)); impossibleDate.files['state/holdings.json'].funds.push({ code: '000001', name: '合成测试', category: 'tech', purchases: [{ date: '2026-02-31', amount: 100, nav: 1, shares: 100 }] }); assert.throws(() => m.validateBackup(JSON.stringify(impossibleDate)), /日期|数值/);
  const synthetic = { funds: [{ code: '000001', verdict: 'add', marketVerdict: 'add', executable: true, marketState: 'buy_candidate' }, { code: '000002', marketState: 'monthly_dca', displayKind: 'plan', strategyVersion: 'gold-monthly-dca-v1' }, { code: '000003', marketState: 'record_only' }], alerts: [{ title: '加仓' }] };
  const safe = m.suppress(synthetic); assert.equal(safe.funds[0].marketVerdict, null); assert.equal(safe.funds[0].executable, false); assert.equal(safe.funds[1].marketState, 'monthly_dca'); assert.equal(safe.funds[1].executable, false); assert.equal(safe.funds[2].marketState, 'record_only'); assert.equal(safe.alerts.length, 0);
  f.setOnline(false); const old = await m.request('/api/refresh'); assert.equal(old.mobileOffline, true); assert.equal(typeof old.mobileAsOf, 'number');
  const offlineAdvice = await m.request('/api/advice?session=am'); assert.equal(offlineAdvice.mobileOffline, true);
  const beforeTiming = [...f.disk.entries()]; await m.request('/api/timing'); assert.deepEqual([...f.disk.entries()], beforeTiming);
  const changed = JSON.parse(m.fs.readFileSync('/data/state/holdings.json', 'utf8'));
  changed.funds.push({ code: '000001', name: 'SYNTHETIC ONLY', category: 'tech', strategyScope: 'record_only', purchases: [], profileState: 'needs_review' });
  m.fs.writeFileSync('/data/state/holdings.json', JSON.stringify(changed));
  const beforeNoCache = [...f.disk.entries()], recalculated = await m.request('/api/refresh');
  assert.equal(recalculated.funds.length, 1); assert.equal(recalculated.funds[0].code, '000001'); assert.equal(recalculated.mobileOffline, true); assert.deepEqual([...f.disk.entries()], beforeNoCache);
  const changedAdvice = await m.request('/api/advice?session=am'); assert.equal(changedAdvice.funds.length, 1); assert.equal(changedAdvice.funds[0].marketState, 'record_only');
  const expected = f.disk.get('/data/state/holdings.json'); f.setFail(true); assert.throws(() => m.fs.writeFileSync('/data/state/holdings.json', '{}')); assert.equal(f.disk.get('/data/state/holdings.json'), expected); f.setFail(false);
  const sourcePaths = f.manifest.manifest.map(r => r.path);
  assert.ok(sourcePaths.every(p => !/backend\/(backtest|scripts|fixtures)|docs\/_local|data\/(state|cache|series)/.test(p)));
  assert.ok(sourcePaths.every(p => p.startsWith('backend/') || p.startsWith('public/') || p.startsWith('mobile/android/') || ['data/config/theme_map.json', 'data/example/holdings.example.json', 'data/example/config.example.json', 'data/example/categories.example.json'].includes(p)));
  console.log('PASS: empty startup, original in-memory APIs, crypto/Buffer, offline suppression/cache, backup validation/secrets, failed write preservation, public packaging allowlist');
}
if (require.main === module) run().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { fixture };

/* Mobile-only compatibility surface. Production business modules are registered unchanged. */
(function (g) {
  'use strict';
  const bridge = g.PharosBridge;
  const pending = new Map();
  let sequence = 0, failures = 0;
  function call(op, args = {}) {
    const answer = JSON.parse(bridge.call(op, JSON.stringify(args)));
    if (!answer.ok) throw Object.assign(new Error(answer.error || op + ' failed'), { code: answer.code || 'EIO' });
    return answer.value;
  }
  function asyncNative(kind, payload, signal) {
    return new Promise((resolve, reject) => {
      const id = String(++sequence);
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      const abort = () => { bridge.cancel(id); pending.delete(id); reject(new DOMException('Aborted', 'AbortError')); };
      pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      try { bridge.request(id, kind, JSON.stringify(payload)); }
      catch (e) { pending.delete(id); signal?.removeEventListener('abort', abort); reject(e); }
    });
  }
  g.__PharosNativeResult = function (id, result) {
    const p = pending.get(id); if (!p) return;
    pending.delete(id); p.cleanup();
    if (result.ok) p.resolve(result.value); else p.reject(new Error(result.error || '操作失败'));
  };
  class MobileBuffer extends Uint8Array {
    static from(value, encoding) {
      if (typeof value !== 'string') return new MobileBuffer(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      if (encoding === 'base64' || encoding === 'base64url') {
        let s = value.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
        return new MobileBuffer(Uint8Array.from(atob(s), c => c.charCodeAt(0)));
      }
      return new MobileBuffer(new TextEncoder().encode(value));
    }
    static byteLength(value) { return typeof value === 'string' ? new TextEncoder().encode(value).length : value.byteLength; }
    static concat(values) { const out = new MobileBuffer(values.reduce((s, v) => s + v.length, 0)); let at = 0; for (const v of values) { out.set(v, at); at += v.length; } return out; }
    toString(encoding = 'utf8') {
      if (encoding === 'base64' || encoding === 'base64url') {
        let s = ''; for (let i = 0; i < this.length; i += 16384) s += String.fromCharCode(...this.subarray(i, i + 16384));
        const b64 = btoa(s); return encoding === 'base64url' ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64;
      }
      return new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding).decode(this);
    }
  }
  const normalize = value => {
    const absolute = value.startsWith('/'), parts = [];
    for (const p of value.split('/')) { if (!p || p === '.') continue; if (p === '..' && parts.length && parts.at(-1) !== '..') parts.pop(); else if (p === '..' && !absolute) parts.push(p); else if (p !== '..') parts.push(p); }
    return (absolute ? '/' : '') + parts.join('/') || (absolute ? '/' : '.');
  };
  const path = {
    normalize, join: (...p) => normalize(p.filter(Boolean).join('/')), isAbsolute: p => p.startsWith('/'),
    dirname: p => { p = normalize(p); const i = p.lastIndexOf('/'); return i === 0 ? '/' : i < 0 ? '.' : p.slice(0, i); },
    basename: p => normalize(p).split('/').pop(), extname: p => { const n = p.split('/').pop(), i = n.lastIndexOf('.'); return i > 0 ? n.slice(i) : ''; },
    relative: (from, to) => { const a = normalize(from).split('/').filter(Boolean), b = normalize(to).split('/').filter(Boolean); let i = 0; while (i < a.length && a[i] === b[i]) i++; return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/'); }
  };
  let staged = null;
  const fs = {
    existsSync: p => staged?.has(p) || call('exists', { path: p }),
    readFileSync: (p, encoding) => {
      const bytes = MobileBuffer.from(staged?.has(p) ? staged.get(p) : call('read', { path: p }), 'base64');
      return encoding ? bytes.toString(encoding) : bytes;
    },
    writeFileSync: (p, data) => { const base64 = MobileBuffer.from(data).toString('base64'); if (staged) staged.set(p, base64); else call('write', { path: p, base64 }); },
    mkdirSync: p => call('mkdir', { path: p }),
    renameSync: (from, to) => {
      if (staged?.has(from)) { staged.set(to, staged.get(from)); staged.delete(from); }
      else call('rename', { path: from, to });
    },
    copyFileSync: (from, to) => fs.writeFileSync(to, fs.readFileSync(from)),
    unlinkSync: p => call('unlink', { path: p }),
    readdirSync: (p, options) => call('list', { path: p }).map(e => options?.withFileTypes ? { name: e.name, isDirectory: () => e.directory, isFile: () => !e.directory } : e.name),
    statSync: p => { const s = call('stat', { path: p }); return { size: s.size, isFile: () => !s.directory, isDirectory: () => s.directory }; },
    createReadStream: () => { throw new Error('HTTP static streams are not exposed on mobile'); }
  };
  const crypto = { createHash: algorithm => { const chunks = []; return { update(value) { chunks.push(MobileBuffer.from(value)); return this; }, digest(encoding) { if (encoding !== 'hex') throw Error('Unsupported digest'); return call('hash', { algorithm, base64: MobileBuffer.concat(chunks).toString('base64') }); } }; } };
  let route;
  const http = { createServer: fn => { route = fn; return { listen() { throw new Error('Mobile must not listen on a port'); } }; } };
  const builtins = { fs, path, crypto, http, os: { networkInterfaces: () => ({}) } };
  const moduleCache = new Map();
  function load(id, parent = '/') {
    const builtin = id.replace(/^node:/, ''); if (builtins[builtin]) return builtins[builtin];
    const base = id.startsWith('/') ? normalize(id) : normalize(path.dirname(parent) + '/' + id);
    const found = [base, base + '.js', base + '.json', base + '/index.js'].find(p => Object.hasOwn(g.__PHAROS_MODULES, p));
    if (!found) throw Error('Unregistered module: ' + id + ' from ' + parent);
    if (moduleCache.has(found)) return moduleCache.get(found).exports;
    const source = g.__PHAROS_MODULES[found], module = { exports: {} };
    moduleCache.set(found, module);
    if (typeof source !== 'function') module.exports = JSON.parse(JSON.stringify(source));
    else { const require = name => load(name, found); require.main = null; source(require, module, module.exports, found, path.dirname(found)); }
    return module.exports;
  }
  const info = () => call('info');
  g.Buffer = MobileBuffer;
  g.global = g;
  g.process = { env: { FUND_API_KEY: info().key }, pid: 1 };
  const browserFetch = g.fetch.bind(g);
  g.fetch = async function (url, options = {}) {
    const value = String(url);
    if (value.startsWith('/') || value.startsWith(location.origin + '/')) return browserFetch(url, options);
    try {
      if (!info().online) throw Error('当前没有网络连接');
      const r = await asyncNative('http', { url: value, method: options.method || 'GET', headers: Object.fromEntries(new Headers(options.headers || {}).entries()), redirect: options.redirect || 'follow' }, options.signal);
      if (r.status < 200 || r.status >= 300) failures++;
      const bytes = MobileBuffer.from(r.body, 'base64');
      const response = new Response(bytes, { status: r.status, headers: r.headers });
      response.headers.getSetCookie = () => r.cookies || [];
      Object.defineProperty(response, 'url', { value: r.url });
      return response;
    } catch (e) { failures++; throw e; }
  };
  if (!AbortSignal.timeout) AbortSignal.timeout = ms => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
  function dispatch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const listeners = {}, headers = Object.fromEntries(new Headers(opts.headers || {}).entries());
      headers['x-api-key'] = info().key;
      const req = { url, method: opts.method || 'GET', headers,
        on: (event, fn) => { (listeners[event] ||= []).push(fn); return req; },
        destroy: () => reject(new Error('请求内容过大')) };
      let status = 200;
      const res = { writeHead(code) { status = code; }, end(text) { let value; try { value = JSON.parse(text); } catch (_) { value = { error: String(text) }; } if (status >= 400) reject(Object.assign(new Error(value.error || 'HTTP ' + status), { status })); else resolve(value); } };
      Promise.resolve(route(req, res)).catch(reject);
      queueMicrotask(() => { if (opts.body) for (const fn of listeners.data || []) fn(opts.body); for (const fn of listeners.end || []) fn(); });
    });
  }
  const clone = value => JSON.parse(JSON.stringify(value));
  const offlineMessage = '当前离线、取数失败或缓存已过期；只展示已保存资料，行情条件与申购状态须联网刷新后核验。';
  function suppress(advice) {
    const value = clone(advice); value.alerts = []; value.mobileOffline = true; value.mobileNotice = offlineMessage;
    value.funds = (value.funds || []).map(f => {
      if (f.marketState === 'record_only') return f;
      const plan = f.displayKind === 'plan' && f.marketState === 'monthly_dca';
      return { ...f, verdict: null, marketVerdict: null, executable: false, statusFresh: false,
        marketState: plan ? f.marketState : 'data_missing', marketStateLabel: plan ? f.marketStateLabel + '（离线）' : '离线／资料待刷新',
        blockedReason: 'purchase_status_unverified', constraints: [...(f.constraints || []), '离线：申购状态待刷新'],
        conclusion: offlineMessage, detail: offlineMessage, reasons: [offlineMessage], score: null,
        matrix: { ...(f.matrix || {}), dataErrorLabel: offlineMessage },
        executionExplanation: offlineMessage, conditions: [], factors: [] };
    });
    return value;
  }
  function accountHash() { return crypto.createHash('sha256').update(fs.readFileSync('/data/state/holdings.json')).digest('hex'); }
  function readCache(name) { try { const c = JSON.parse(fs.readFileSync('/data/cache/' + name, 'utf8')); return c.account === accountHash() && Number.isFinite(c.at) && c.at <= Date.now() ? c : null; } catch (_) { return null; } }
  function saveCache(name, value) { fs.mkdirSync('/data/cache'); fs.writeFileSync('/data/cache/' + name, JSON.stringify({ at: Date.now(), account: accountHash(), value })); }
  let queue = Promise.resolve(), restoring = false;
  const background = new Set();
  function track(p) { background.add(p); p.finally(() => background.delete(p)).catch(() => {}); return p; }
  function enqueue(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; }
  async function api(url, opts) {
    await g.PharosMobile.ready;
    if (restoring) throw Error('恢复已完成，正在重新加载本机账户');
    if (!url.startsWith('/api/')) throw Error('Unsupported local API path');
    const kind = url.split('?')[0], beforeFailures = failures, online = info().online;
    if (kind === '/api/timing' && !online) return load('/backend/engines/timing.js').stats();
    const policyKey = kind === '/api/gold-macro-policy' ? 'mobile_policy_' + crypto.createHash('sha256').update(url).digest('hex') + '.json' : null;
    if (policyKey && !online) { const old = readCache(policyKey); if (!old) throw Error('离线且尚无这页政策缓存，请联网同步'); return { ...old.value, status: 'stale', mobileOffline: true, mobileAsOf: old.at, mobileNotice: offlineMessage }; }
    if (kind === '/api/dividend-reference' && !online) throw Error('离线时不生成加投参考，请联网核验');
    if (kind === '/api/advice' && !online) {
      const old = readCache('mobile_advice.json');
      const value = old?.value || { funds: (load('/backend/lib/store.js').readJSON('holdings.json').funds || []).map(f => ({ ...f, verdict: null, marketVerdict: null, marketState: load('/backend/lib/strategyScope.js').isRecordOnly(f) ? 'record_only' : 'data_missing' })), alerts: [] };
      return suppress(value);
    }
    if (kind === '/api/refresh' && !online) {
      const old = readCache('mobile_refresh.json');
      if (old) return { ...old.value, mobileOffline: true, mobileAsOf: old.at, mobileNotice: offlineMessage };
      // This original pure assembler preserves the ledger and snapshot valuation fallback.
      // Any derived cache writes are discarded; no snapshot/backfill/decision collector runs.
      staged = new Map();
      try { const value = await load('/backend/engines/analysis.js').buildAnalysis(); value.plan = { scoreMap: {} }; return { ...value, mobileOffline: true, mobileNotice: offlineMessage }; }
      finally { staged = null; }
    }
    if (kind === '/api/advice' && online) {
      const fund = load('/backend/lib/store.js').readJSON('holdings.json').funds.find(f => !load('/backend/lib/strategyScope.js').isRecordOnly(f));
      // Cached NAV can otherwise hide a disconnected WiFi/captive portal. Verify the original
      // public NAV source without its one-hour cache before allowing new decision sampling.
      if (fund) {
        const quote = await load('/backend/fetchers.js').fetchNavOnDate(fund.code, load('/backend/lib/util.js').todayStr());
        if (!quote || !Number.isFinite(quote.nav) || quote.nav <= 0 || failures !== beforeFailures) {
          const old = readCache('mobile_advice.json');
          return suppress(old?.value || { funds: load('/backend/lib/store.js').readJSON('holdings.json').funds.map(f => ({ ...f, marketState: load('/backend/lib/strategyScope.js').isRecordOnly(f) ? 'record_only' : 'data_missing' })), alerts: [] });
        }
      }
    }
    try {
      if (kind === '/api/advice' || kind === '/api/refresh') staged = new Map();
      const value = await dispatch(url, opts);
      await Promise.allSettled([...background]);
      if (kind === '/api/advice' || kind === '/api/refresh') {
        const fresh = online && info().online && failures === beforeFailures;
        const writes = staged; staged = null;
        if (fresh) { for (const [p, base64] of writes) call('write', { path: p, base64 }); }
        if (kind === '/api/advice') { if (!fresh) return suppress(value); saveCache('mobile_advice.json', value); }
      }
      if (policyKey) saveCache(policyKey, value);
      if (kind === '/api/refresh') {
        if (online && failures === beforeFailures) saveCache('mobile_refresh.json', value);
        else {
          const old = readCache('mobile_refresh.json');
          if (old) return { ...old.value, mobileOffline: true, mobileAsOf: old.at, mobileNotice: offlineMessage };
          value.mobileOffline = true; value.mobileNotice = offlineMessage;
        }
      }
      return value;
    } finally { staged = null; }
  }
  const backupFiles = ['state/holdings.json', 'state/history.json', 'state/decision_history.json', 'state/signals.json', 'state/timing_state.json', 'state/timing_samples.json', 'config/config.json', 'config/categories.json', 'config/theme_map.json', 'series/yield_history.json'];
  function scrub(value, trail = '') {
    if (Array.isArray(value)) return value.map(v => scrub(v, trail));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/^(apiKey|token|password|secret|backendUrl)$/i.test(k) && !(k === 'key' && /(?:^|\.)news\./.test(trail))).map(([k, v]) => [k, scrub(v, trail ? trail + '.' + k : k)]));
    return value;
  }
  function backup() {
    const files = {}; for (const p of backupFiles) if (fs.existsSync('/data/' + p)) files[p] = scrub(JSON.parse(fs.readFileSync('/data/' + p, 'utf8')));
    for (const [p, value] of Object.entries({ 'state/history.json': [], 'state/decision_history.json': [], 'state/signals.json': {}, 'state/timing_state.json': { version: 1, baselineDate: null, funds: {} }, 'state/timing_samples.json': [] })) if (!(p in files)) files[p] = value;
    return { format: 'pharos-android-backup', version: 1, createdAt: new Date().toISOString(), files };
  }
  function validateBackup(text) {
    if (MobileBuffer.byteLength(text) > 20 * 1024 * 1024) throw Error('备份超过20MB');
    const b = JSON.parse(text); if (b.format !== 'pharos-android-backup' || b.version !== 1 || !b.files || Array.isArray(b.files)) throw Error('不是支持的Pharos安卓备份');
    function safeValues(value, depth = 0) {
      if (depth > 80) throw Error('备份嵌套过深');
      if (typeof value === 'number' && !Number.isFinite(value)) throw Error('备份含无效数值');
      if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('备份包含不支持的字段'); safeValues(child, depth + 1); }
    }
    safeValues(b);
    for (const p of Object.keys(b.files)) if (!backupFiles.includes(p)) throw Error('备份包含不支持的文件：' + p);
    const h = b.files['state/holdings.json'], cfg = b.files['config/config.json'], cat = b.files['config/categories.json'];
    const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
    const date = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
    if (!h || h._schemaVersion !== 2 || !Array.isArray(h.funds) || !object(cfg) || cfg._schemaVersion !== 2 || !object(cat) || !Array.isArray(cat.categories) || !cat.categories.every(c => object(c) && typeof c.key === 'string' && typeof c.name === 'string')) throw Error('备份账户结构或版本不受支持');
    for (const name of ['state/holdings.json', 'state/history.json', 'state/decision_history.json', 'state/signals.json', 'state/timing_state.json', 'state/timing_samples.json', 'config/config.json', 'config/categories.json', 'config/theme_map.json']) if (!Object.hasOwn(b.files, name)) throw Error('备份缺少必需文件：' + name);
    const codes = new Set();
    for (const f of h.funds) {
      if (!f || !/^\d{6}$/.test(f.code) || typeof f.name !== 'string' || typeof f.category !== 'string' || codes.has(f.code) || !Array.isArray(f.purchases)) throw Error('备份基金／流水结构无效'); codes.add(f.code);
      for (const p of f.purchases) {
        if (!p || !date(p.date) || !Number.isFinite(p.amount) || p.amount <= 0 || p.shares != null && (!Number.isFinite(p.shares) || p.shares < 0) || p.nav != null && (!Number.isFinite(p.nav) || p.nav <= 0)) throw Error('备份流水数值无效');
        for (const k of ['pricingDate', 'settleDate', 'navDate', 'confirmDate']) if (p[k] != null && !date(p[k])) throw Error('备份流水日期无效');
      }
    }
    for (const name of ['state/history.json', 'state/decision_history.json', 'state/timing_samples.json']) if (!Array.isArray(b.files[name])) throw Error('备份历史结构无效');
    if (!object(b.files['state/signals.json']) || !object(b.files['state/timing_state.json']) || !object(b.files['state/timing_state.json'].funds) || b.files['state/timing_state.json'].version !== 1 || !object(b.files['config/theme_map.json'])) throw Error('备份状态结构无效');
    for (const row of b.files['state/timing_samples.json']) if (!object(row) || !/^\d{6}$/.test(row.code) || !date(row.eventDate) || !['advice-open', 'advice-close', 'buy'].includes(row.type)) throw Error('备份复盘样本结构无效');
    for (const row of b.files['state/history.json']) if (!object(row) || !date(row.date) || !Array.isArray(row.funds) || !row.funds.every(f => object(f) && /^\d{6}$/.test(f.code) && ['value', 'principal'].every(k => f[k] == null || Number.isFinite(f[k])))) throw Error('备份资产历史无效');
    for (const row of b.files['state/decision_history.json']) if (!object(row) || !date(row.date) || !object(row.funds)) throw Error('备份决策历史无效');
    return scrub(b);
  }
  g.PharosMobile = { version: 1, call, load, fs, info, backup, validateBackup, suppress, track,
    request: (url, opts = {}) => enqueue(() => api(url, opts)),
    exportBackup: () => enqueue(async () => { await g.PharosMobile.ready; return asyncNative('export', { text: JSON.stringify(backup()) }); }),
    importBackup: () => enqueue(async () => { await g.PharosMobile.ready; const text = await asyncNative('import', {}); if (text == null) return false; const b = validateBackup(text); const done = await asyncNative('restore', { text: JSON.stringify(b), count: b.files['state/holdings.json'].funds.length }); if (done) { restoring = true; location.reload(); } return done; }),
    foreground: (refresh = false) => enqueue(async () => { await g.PharosMobile.ready; if (restoring) return; load('/backend/engines/timing.js').buyScan(); if (info().online) await load('/backend/engines/feeSync.js').syncFundFees(); if (refresh && g.dispatchEvent) g.dispatchEvent(new Event('pharos:resume')); }).catch(() => {})
  };
})(window);

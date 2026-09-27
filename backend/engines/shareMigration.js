'use strict';

// v1 → v2 严格迁移：持仓与历史先完整准备、校验，再作为一个事务提交。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../lib/store');
const schema = require('../lib/schema');
const fetchers = require('../fetchers');
const math = require('../lib/purchaseMath');

const VERSION = 2;
const JOURNAL = 'share_migration_journal.json';
let live = { version: VERSION, status: 'pending', errors: [], recalculated: 0, historyRebuilt: 0 };
let inflight = null;

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function hashText(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function hashFile(file) { return fs.existsSync(file) ? hashText(fs.readFileSync(file)) : null; }
function validPositive(v) { return Number.isFinite(Number(v)) && Number(v) > 0; }
function migrationState() { return clone(live); }
function isPending() { return live.status !== 'complete'; }

function writeRaw(file, value) {
  const tmp = file + '.migration-' + process.pid + '-' + Date.now() + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function nearestNav(rows, date) {
  let hit = null;
  for (const row of rows) {
    if (!row || !row.date || !validPositive(row.nav)) continue;
    if (row.date <= date && (!hit || row.date > hit.date)) hit = row;
  }
  return hit;
}

function summarizeFailure(errors) {
  return {
    version: VERSION, status: 'failed', errors,
    recalculated: 0, historyRebuilt: 0,
    rateBasis: 'migration-current-rate', completedAt: null,
  };
}

async function prepare(rawHoldings, rawHistory) {
  const holdings = clone(rawHoldings);
  const history = clone(rawHistory);
  const errors = [];
  if (!holdings || !Array.isArray(holdings.funds)) errors.push({ code: 'INVALID_HOLDINGS', message: 'holdings.funds 必须是数组' });
  if (!Array.isArray(history)) errors.push({ code: 'INVALID_HISTORY', message: 'history 必须是数组' });
  if (errors.length) return { errors };

  const fundByCode = new Map(holdings.funds.filter(Boolean).map((f) => [String(f.code), f]));
  const originalPurchaseCount = holdings.funds.reduce((n, f) => n + (Array.isArray(f.purchases) ? f.purchases.length : 0), 0);
  const oldDates = history.map((s) => s && s.date);
  for (const snap of history) {
    if (!snap || !/^\d{4}-\d{2}-\d{2}$/.test(String(snap.date || ''))) {
      errors.push({ code: 'INVALID_SNAPSHOT_DATE', date: snap && snap.date });
      continue;
    }
    for (const sf of (Array.isArray(snap.funds) ? snap.funds : [])) {
      const current = sf && fundByCode.get(String(sf.code));
      if (!current) {
        errors.push({ code: 'DELETED_FUND_WITHOUT_LEDGER', fund: sf && sf.code, date: snap.date });
      } else if ((!Array.isArray(current.purchases) || !current.purchases.length) &&
        (Number(sf && sf.value || 0) !== 0 || Number(sf && sf.principal || 0) !== 0)) {
        errors.push({ code: 'HISTORICAL_VALUE_WITHOUT_LEDGER', fund: sf && sf.code, date: snap.date });
      }
    }
  }

  let recalculated = 0;
  const rateByCode = new Map();
  for (const f of holdings.funds) {
    if (!f || !Array.isArray(f.purchases) || !f.purchases.length) continue;
    let rate = math.normalizeRate(f.feeRate);
    if (rate === null) {
      const detail = await fetchers.fetchFundRates(f.code);
      rate = math.normalizeRate(detail && detail.sub && detail.sub.rate);
      if (rate !== null) {
        f.feeRate = rate;
        f.feeDetail = Object.assign({}, detail, { src: 'eastmoney', updatedAt: Date.now() });
      }
    }
    if (rate === null) {
      errors.push({ code: 'MISSING_FEE_RATE', fund: f.code, message: '当前申购费率未知或为固定金额费率' });
      continue;
    }
    rateByCode.set(String(f.code), rate);
    for (let i = 0; i < f.purchases.length; i++) {
      const p = f.purchases[i];
      if (!p || !validPositive(p.amount)) {
        errors.push({ code: 'INVALID_AMOUNT', fund: f.code, purchase: i });
        continue;
      }
      if (!validPositive(p.nav)) {
        errors.push({ code: 'MISSING_PURCHASE_NAV', fund: f.code, purchase: i, date: p.date });
        continue;
      }
      const result = math.calculatePurchase({ amount: p.amount, nav: p.nav, quotedFeeRate: rate, feeWaived: false });
      if (!result.ok) {
        errors.push({ code: result.code, fund: f.code, purchase: i });
        continue;
      }
      p.shares = result.shares;
      p.quotedFeeRate = rate;
      delete p.feeWaived;
      p.shareCalcVersion = VERSION;
      p.sharesSource = 'formula-v2';
      p.shareCalcBasis = 'migration-current-rate';
      recalculated++;
    }
  }
  if (errors.length) return { errors };

  const neededCodes = new Set();
  for (const snap of history) {
    for (const sf of (snap.funds || [])) {
      const current = fundByCode.get(String(sf.code));
      if (current && Array.isArray(current.purchases) && current.purchases.length) neededCodes.add(String(sf.code));
    }
  }
  const navByCode = new Map();
  for (const code of neededCodes) {
    const result = await fetchers.fetchNavHistory(code, 4500);
    const rows = result && result.history;
    if (!Array.isArray(rows) || !rows.length || result.failed) errors.push({ code: 'HISTORY_NAV_UNAVAILABLE', fund: code });
    else navByCode.set(code, rows);
  }
  if (errors.length) return { errors };

  const rebuilt = [];
  for (const old of history) {
    const funds = [];
    for (const oldFund of (old.funds || [])) {
      const code = String(oldFund.code);
      const f = fundByCode.get(code);
      if (!Array.isArray(f.purchases) || !f.purchases.length) {
        funds.push(Object.assign({}, oldFund, {
          value: 0, principal: 0, netInvested: 0, profit: 0, profitPct: 0,
        }));
        continue;
      }
      const quote = nearestNav(navByCode.get(code) || [], old.date);
      if (!quote) {
        errors.push({ code: 'HISTORY_NAV_GAP', fund: code, date: old.date });
        continue;
      }
      let shares = 0, transit = 0, principal = 0, confirmedNetInvested = 0;
      for (const p of f.purchases) {
        if (String(p.date || '') > old.date) continue;
        principal += Number(p.amount);
        const pricingDate = p.pricingDate || p.navDate || p.confirmDate || p.date;
        if (pricingDate <= old.date) {
          shares += Number(p.shares);
          confirmedNetInvested += Number(p.shares) * Number(p.nav);
        }
        else {
          const r = math.calculatePurchase({ amount: p.amount, nav: 1, quotedFeeRate: p.quotedFeeRate, feeWaived: !!p.feeWaived });
          if (!r.ok) errors.push({ code: r.code, fund: code, date: old.date });
          else transit += r.netAmount;
        }
      }
      const netInvested = confirmedNetInvested + transit;
      const value = shares * Number(quote.nav) + transit;
      const profit = value - netInvested;
      const profitPct = netInvested > 0 ? profit / netInvested * 100 : 0;
      if (![shares, transit, principal, netInvested, value, profit, profitPct].every(Number.isFinite) || shares < 0 || netInvested < 0 || value < 0) {
        errors.push({ code: 'NON_FINITE_REBUILD', fund: code, date: old.date });
      }
      funds.push(Object.assign({}, oldFund, { value, principal, netInvested, profit, profitPct }));
    }
    const totalPrincipal = funds.reduce((s, f) => s + Number(f.principal || 0), 0);
    const totalNetInvested = funds.reduce((s, f) => s + Number(f.netInvested || 0), 0);
    const totalFee = totalPrincipal - totalNetInvested;
    const totalValue = funds.reduce((s, f) => s + Number(f.value || 0), 0);
    const totalProfit = totalValue - totalNetInvested;
    const totalProfitPct = totalNetInvested > 0 ? totalProfit / totalNetInvested * 100 : 0;
    rebuilt.push(Object.assign({}, old, { funds, totalPrincipal, totalNetInvested, totalFee, totalValue, totalProfit, totalProfitPct }));
  }

  const newCount = holdings.funds.reduce((n, f) => n + (Array.isArray(f.purchases) ? f.purchases.length : 0), 0);
  if (newCount !== originalPurchaseCount) errors.push({ code: 'PURCHASE_COUNT_CHANGED', before: originalPurchaseCount, after: newCount });
  if (rebuilt.length !== history.length) errors.push({ code: 'HISTORY_COUNT_CHANGED' });
  if (JSON.stringify(rebuilt.map((s) => s.date)) !== JSON.stringify(oldDates)) errors.push({ code: 'HISTORY_DATES_CHANGED' });
  if (errors.length) return { errors };

  const completedAt = new Date().toISOString();
  holdings._schemaVersion = VERSION;
  holdings._shareMigration = {
    version: VERSION, status: 'complete', recalculated,
    historyRebuilt: rebuilt.length, rateBasis: 'migration-current-rate', errors: [], completedAt,
  };
  return { holdings, history: rebuilt, recalculated, historyRebuilt: rebuilt.length, completedAt, errors: [] };
}

function recoverJournal() {
  const journalPath = store.dataPath(JOURNAL);
  if (!fs.existsSync(journalPath)) return;
  let j;
  try { j = JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch (_) { return; }
  if (!j || j.state !== 'committing') return;
  const hPath = store.dataPath('holdings.json'), histPath = store.dataPath('history.json');
  const hNew = hashFile(hPath) === j.newHoldingsHash;
  const histNew = hashFile(histPath) === j.newHistoryHash;
  try {
    if (!hNew && fs.existsSync(j.holdingsTemp)) fs.renameSync(j.holdingsTemp, hPath);
    if (!histNew && fs.existsSync(j.historyTemp)) fs.renameSync(j.historyTemp, histPath);
    if (hashFile(hPath) !== j.newHoldingsHash || hashFile(histPath) !== j.newHistoryHash) throw new Error('prepared files unavailable');
    j.state = 'complete'; j.completedAt = new Date().toISOString(); writeRaw(journalPath, j);
  } catch (e) {
    if (j.holdingsBackup && fs.existsSync(j.holdingsBackup)) fs.copyFileSync(j.holdingsBackup, hPath);
    if (j.historyBackup && fs.existsSync(j.historyBackup)) fs.copyFileSync(j.historyBackup, histPath);
    else if (j.oldHistoryHash === null && fs.existsSync(histPath)) fs.unlinkSync(histPath);
    j.state = 'rolled-back'; j.error = e.message; writeRaw(journalPath, j);
  }
}

async function runMigration() {
  return store.withFileLocks(['holdings.json', 'history.json'], async () => {
    recoverJournal();
    const hPath = store.dataPath('holdings.json'), histPath = store.dataPath('history.json');
    if (!fs.existsSync(hPath)) {
      live = { version: VERSION, status: 'complete', errors: [], recalculated: 0, historyRebuilt: 0 };
      return migrationState();
    }
    const rawHoldings = store.readJSONRaw('holdings.json');
    if ((rawHoldings._schemaVersion || 1) >= VERSION) {
      live = Object.assign({ version: VERSION, status: 'complete', errors: [] }, rawHoldings._shareMigration || {});
      live.status = 'complete';
      return migrationState();
    }
    live = { version: VERSION, status: 'migrating', errors: [], recalculated: 0, historyRebuilt: 0 };
    const rawHistory = fs.existsSync(histPath) ? store.readJSONRaw('history.json') : [];
    // 联网准备前就备份：即使缺费率/缺历史净值而失败，也保留本次尝试对应的原始证据。
    const hBackup = schema.backupFile(hPath);
    let histBackup = null;
    if (fs.existsSync(histPath)) histBackup = schema.backupFile(histPath);
    const prepared = await prepare(rawHoldings, rawHistory);
    if (prepared.errors.length) {
      live = summarizeFailure(prepared.errors);
      return migrationState();
    }

    const stamp = Date.now();
    const hTemp = hPath + '.migration-' + stamp + '.prepared';
    const histTemp = histPath + '.migration-' + stamp + '.prepared';
    fs.writeFileSync(hTemp, JSON.stringify(prepared.holdings, null, 2), 'utf8');
    fs.writeFileSync(histTemp, JSON.stringify(prepared.history, null, 2), 'utf8');
    const journal = {
      version: VERSION, state: 'prepared', createdAt: new Date().toISOString(),
      holdingsBackup: hBackup, historyBackup: histBackup,
      holdingsTemp: hTemp, historyTemp: histTemp,
      oldHoldingsHash: hashFile(hPath), oldHistoryHash: hashFile(histPath),
      newHoldingsHash: hashFile(hTemp), newHistoryHash: hashFile(histTemp),
    };
    writeRaw(store.dataPath(JOURNAL), journal);
    journal.state = 'committing'; writeRaw(store.dataPath(JOURNAL), journal);
    try {
      fs.renameSync(hTemp, hPath);
      fs.renameSync(histTemp, histPath);
      if (hashFile(hPath) !== journal.newHoldingsHash || hashFile(histPath) !== journal.newHistoryHash) throw new Error('迁移提交后校验失败');
    } catch (e) {
      if (fs.existsSync(hBackup)) fs.copyFileSync(hBackup, hPath);
      if (histBackup && fs.existsSync(histBackup)) fs.copyFileSync(histBackup, histPath);
      else if (journal.oldHistoryHash === null && fs.existsSync(histPath)) fs.unlinkSync(histPath);
      journal.state = 'rolled-back'; journal.error = e.message; writeRaw(store.dataPath(JOURNAL), journal);
      throw e;
    }
    journal.state = 'complete'; journal.completedAt = prepared.completedAt; writeRaw(store.dataPath(JOURNAL), journal);
    live = clone(prepared.holdings._shareMigration);
    return migrationState();
  });
}

function ensureMigration() {
  if (!inflight) inflight = runMigration().catch((e) => {
    live = summarizeFailure([{ code: 'MIGRATION_EXCEPTION', message: e && e.message || String(e) }]);
    return migrationState();
  }).finally(() => { inflight = null; });
  return inflight;
}

module.exports = { VERSION, migrationState, isPending, ensureMigration, _prepare: prepare, _recoverJournal: recoverJournal };

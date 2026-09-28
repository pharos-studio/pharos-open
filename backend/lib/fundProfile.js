'use strict';
const crypto = require('crypto');
const fetchers = require('../fetchers');
const quotes = require('./indexQuote');
const categories = require('./categories');
const store = require('./store');
const schema = require('./schema');

const FIELDS = ['name', 'fundType', 'market', 'category', 'caliber', 'indexCode', 'indexName', 'trackIndex',
  'estimateIndex', 'estimateIndexName', 'estimateLabel', 'estimateProvider', 'estimateRelation',
  'estimateVerifiedAt', 'profileState', 'profileUpdatedAt'];
const TTL = 24 * 3600000;
const cache = new Map(), inflight = new Map();

function revision(profile) {
  return crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex').slice(0, 24);
}
function cleanProfile(p) {
  return Object.fromEntries(FIELDS.map(k => [k, p[k] === undefined ? null : p[k]]));
}
// 「能否改分类」只看传入值本身是否在内置类别白名单里，**不看** confirmations.category 开关。
// 旧写法把「不要求确认」等价于「不接受分类」，一旦自动化就会连带封死用户改分类的路径。
function choiceIsValid(lookup, confirmations) {
  const c = confirmations || {};
  if (c.category != null && !categories.BASE_CATEGORY_KEYS.includes(c.category)) return false;
  if (lookup.confirmations.proxy && c.proxy !== true && c.proxy !== false) return false;
  if (!lookup.confirmations.proxy && c.proxy != null) return false;
  return true;
}
function selectedProfile(lookup, confirmations = {}) {
  if (!choiceIsValid(lookup, confirmations)) return null;
  const p = { ...lookup.autoProfile };
  if (confirmations.category != null) {
    p.category = confirmations.category;
    p.caliber = p.category === 'broad' ? (p.market === 'QDII' ? 'us' : 'cn') : null;
  }
  // 无条件按最终类别重算：重新识别里把 growth 改成 broad 时，
  // 状态若沿用旧值，决策引擎会因 needs_review 直接跳过算法。
  p.profileState = categories.BASE_CATEGORY_KEYS.includes(p.category) ? 'ready' : 'needs_review';
  if (lookup.confirmations.proxy && confirmations.proxy !== true) {
    p.estimateIndex = null; p.estimateIndexName = null; p.estimateLabel = null;
    p.estimateProvider = null; p.estimateRelation = null; p.estimateVerifiedAt = null;
  }
  return p;
}

async function compute(code) {
  const base = await fetchers.fundAutoFill(code);
  if (!base || !base.found || !base.name) return { ok: true, found: false, code };
  let category = categories.BASE_CATEGORY_KEYS.includes(base.suggestedCategory) ? base.suggestedCategory : null;
  // 置信度只作软提示，不再决定是否拦截确认（自动采用推断值，用户仍可改）。
  let catConfidence = category ? (base.suggestedBy || 'derived') : 'unknown';
  if (/^指数型/.test(base.type || '') && base.indexName && !base.trackIndex && category === 'broad') {
    const n = base.indexName;
    if (/红利|低波|股息/.test(n)) category = 'dividend';
    else if (/黄金|上海金|白银|原油|商品/.test(n)) category = 'cycle';
    else if (/白酒|医药|新能源|半导体|消费|军工|科技|信息|证券|银行|传媒/.test(n)) category = 'growth';
    catConfidence = 'heuristic'; // 指数型-股票只说明基金类型，不能证明一定是宽基。
  }
  const market = base.market === 'QDII' || /QDII|海外/.test(base.type || '') ? 'QDII' : 'A';
  const p = {
    name: base.name, fundType: base.type || null, market,
    category, caliber: category === 'broad' ? (base.suggestedCaliber || (market === 'QDII' ? 'us' : 'cn')) : null,
    indexCode: base.indexCode || null, indexName: base.indexName || null, trackIndex: base.trackIndex || null,
    estimateIndex: null, estimateIndexName: null, estimateLabel: null, estimateProvider: null,
    estimateRelation: null, estimateVerifiedAt: null,
    profileState: category ? 'ready' : 'needs_review', profileUpdatedAt: Date.now(),
  };
  let estimateStatus = market === 'QDII' ? 'not_applicable' : 'unsupported';
  let quote = null, relation = null, symbol = null, provider = null;
  if (market === 'A' && /^指数型/.test(base.type || '') && base.indexCode) {
    symbol = quotes.eastmoneySymbol(base.indexCode);
    if (symbol) { provider = 'eastmoney'; relation = 'tracked'; }
  }
  // 上海金等非证券指数：ETF 行情是代理，须用户确认。
  if (market === 'A' && category === 'cycle' && /黄金|上海金/.test((base.name || '') + (base.indexName || ''))) {
    symbol = 'sz159834'; provider = 'sina'; relation = 'proxy';
  }
  if (symbol) {
    try { quote = await quotes.fetchIndexQuote(provider, symbol); }
    catch (e) { estimateStatus = 'temporarily_unavailable'; }
    if (quote) {
      const label = relation === 'proxy' ? '南方上海金ETF(159834)' : quote.name;
      p.estimateIndex = symbol; p.estimateIndexName = label; p.estimateLabel = label;
      p.estimateProvider = provider; p.estimateRelation = relation;
      p.estimateVerifiedAt = Date.now(); estimateStatus = 'available';
    } else if (estimateStatus !== 'temporarily_unavailable') estimateStatus = 'temporarily_unavailable';
  }
  const autoProfile = cleanProfile(p);
  // category 恒 false = 不再拦截确认（保留字段以稳定 payload）；推断不出时由后端 requireCategory 兜底。
  const confirmations = { category: false, proxy: relation === 'proxy' && !!quote };
  return {
    ok: true, found: true, code, ...base, autoProfile, confirmations,
    confidence: { name: base.source === 'archive' ? 'archive' : 'list', category: catConfidence,
      market: base.type ? 'type' : 'list', caliber: catConfidence === 'unknown' ? 'unknown' : 'derived', estimate: quote ? relation : estimateStatus },
    estimateStatus,
    estimateCandidates: quote ? [{ index: symbol, name: p.estimateIndexName, provider, relation, verifiedAt: p.estimateVerifiedAt }] : [],
    profileRevision: revision(autoProfile),
  };
}
async function lookup(code, force = false) {
  if (!/^\d{6}$/.test(String(code))) throw new Error('code 须为 6 位数字');
  const now = Date.now(), hit = cache.get(code);
  if (!force && hit && hit.expires > now) return hit.value;
  if (inflight.has(code)) return inflight.get(code);
  const task = compute(code).then(value => {
    cache.set(code, { value, expires: Date.now() + (value.estimateStatus === 'temporarily_unavailable' ? 5 * 60000 : TTL) });
    return value;
  }).finally(() => inflight.delete(code));
  inflight.set(code, task);
  return task;
}
// opts.requireCategory：最终类别必须落在内置白名单内，否则返回 CATEGORY_REQUIRED。
// 用于「完全推断不出分类」时由后端兜底 —— 前端闸门可被旧缓存或绕过，后端必须再守一道。
function applySelected(lookupResult, revisionValue, confirmations, opts = {}) {
  if (!lookupResult.found || lookupResult.profileRevision !== revisionValue) return { error: 'PROFILE_REVISION_STALE' };
  const wanted = (confirmations && confirmations.category != null) ? confirmations.category : lookupResult.autoProfile.category;
  if (opts.requireCategory && !categories.BASE_CATEGORY_KEYS.includes(wanted)) return { error: 'CATEGORY_REQUIRED' };
  const p = selectedProfile(lookupResult, confirmations);
  return p ? { profile: p } : { error: 'INVALID_CONFIRMATION' };
}
function diff(oldFund, newProfile) {
  return FIELDS.filter(k => k !== 'profileUpdatedAt' && JSON.stringify(oldFund[k] ?? null) !== JSON.stringify(newProfile[k] ?? null))
    .map(k => ({ field: k, before: oldFund[k] ?? null, after: newProfile[k] ?? null }));
}
function profileWriteError(incoming, current) {
  const old = new Map((current.funds || []).map(f => [f.code, f]));
  for (const f of incoming.funds || []) {
    const src = old.get(f.code);
    if (!src) return '新增基金请使用 /api/funds';
    for (const key of FIELDS) {
      if (JSON.stringify(f[key] ?? null) !== JSON.stringify(src[key] ?? null)) return '自动档案只读：' + f.code + '.' + key;
    }
    if (JSON.stringify(f.legacyCategoryAudit ?? null) !== JSON.stringify(src.legacyCategoryAudit ?? null)) return '分类迁移审计字段只读';
  }
  return null;
}
function migrateFundRecords(holdings, catConfig, profiles, now = new Date().toISOString()) {
  const custom = new Map(((catConfig && catConfig.customCategories) || []).map(c => [c.key, c]));
  const next = { ...holdings, funds: (holdings.funds || []).map(f => ({ ...f })) };
  let changed = false;
  for (const f of next.funds) {
    if (!f || !f.code) continue;
    const p = profiles.get(f.code);
    const hadEstimate = !!f.estimateIndex;
    if (hadEstimate && !f.estimateProvider) { f.estimateProvider = 'sina'; changed = true; }
    if (hadEstimate && !f.estimateIndexName && f.estimateLabel) { f.estimateIndexName = f.estimateLabel; changed = true; }
    if (p) for (const key of FIELDS) {
      if (hadEstimate && key.startsWith('estimate')) continue; // 旧新浪代码不得与新东财元数据拼成错误组合。
      if (f[key] == null && p[key] != null && key !== 'profileState') { f[key] = p[key]; changed = true; }
    }
    if (p && !f.profileState) { f.profileState = p.profileState; changed = true; }
    if (!categories.BASE_CATEGORY_KEYS.includes(f.category)) {
      const oldCategory = f.category;
      const binding = custom.get(oldCategory);
      const base = binding && categories.BASE_CATEGORY_KEYS.includes(binding.category) ? binding.category : null;
      if (!f.legacyCategoryAudit) {
        f.legacyCategoryAudit = { key: oldCategory, name: binding && binding.name || null,
          mappedTo: base, migratedAt: now };
        changed = true;
      }
      if (base) { f.category = base; f.profileState = 'ready'; changed = true; }
      else if (f.profileState !== 'needs_review') { f.profileState = 'needs_review'; changed = true; }
    }
  }
  return { holdings: next, changed };
}
async function migrateExisting() {
  const current = store.readJSON('holdings.json');
  const catConfig = store.readJSON('categories.json');
  const profiles = new Map();
  for (const f of current.funds || []) {
    if (!f || !/^\d{6}$/.test(f.code)) continue;
    if (!f.profileUpdatedAt || !f.fundType || !f.market) {
      try { const result = await lookup(f.code); if (result.found) profiles.set(f.code, result.autoProfile); }
      catch (e) { console.warn('[fund-profile] 补充档案失败:', f.code, e.message); }
    }
  }
  return store.withFileLocks(['holdings.json'], async () => {
    const holdings = store.readJSON('holdings.json');
    const migrated = migrateFundRecords(holdings, catConfig, profiles);
    const changed = migrated.changed;
    if (!changed) return { changed: false };
    const backup = schema.backupFile(store.dataPath('holdings.json'));
    if (!store.writeJSONSafe('holdings.json', migrated.holdings)) throw new Error('自动档案迁移写入失败；备份：' + backup);
    return { changed: true, backup };
  });
}
module.exports = { FIELDS, lookup, applySelected, diff, selectedProfile, profileWriteError, migrateFundRecords, migrateExisting };

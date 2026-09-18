'use strict';
/*
 * 净值报价解析层（缓存 + 并发去重）
 * ------------------------------------------------------------
 * 背景：fetchers 里两个「按日期取净值」的纯抓取函数，本身**零缓存**：
 *   fetchNavOnDate(code, d)     —— 序列中「最后一个 <= d」的净值
 *   fetchNavOnOrAfter(code, d)  —— 序列中「第一个 >= d」的净值（把名义成交日顺延到真实交易日）
 *   买入预览是交互式高频调用（改日期/时段/金额都会触发），若每次都实打实联网，
 *   成交日一改就重复抓同一批页面，既慢又会撞东财限流。
 *
 * 本模块是这两个抓取函数之上的一层薄封装，只解决两件事：
 *   ① TTL 内存缓存  ② 同 key 并发去重（in-flight）
 * 不改动任何抓取逻辑 —— 数据源语义仍由 fetchers 独家负责。
 *
 * ★ 两类语义**必须用不同 key 前缀**区分（'le' / 'ge'），否则同一 (code,date) 会撞键
 *   —— 那会让「当天或之前最近」和「当天或之后最近」互相污染，是静默算错。
 *
 * ★ 刻意不做磁盘缓存：净值会「从无到有」（当天晚间公布），落盘反而制造陈旧真相。
 *   缓存全部在进程内存，重启即清空，符合预期。
 */
const util = require('./util');
const fetchers = require('../fetchers');

const KEY_SEP = '|';
const MAX_ENTRIES = 200;

// TTL 三档（毫秒）
const TTL_TODAY = 10 * 60 * 1000;    // 目标日 >= 今天：净值当晚才公布，短 TTL 才能自动变「已公布」
const TTL_PAST = 6 * 60 * 60 * 1000; // 目标日 <  今天：历史净值不可变，长 TTL 白拿
const TTL_MISS = 60 * 1000;          // 取不到（网络失败/早于最早一条/尚未公布）：短 TTL 防重试风暴

const cache = new Map();   // key -> { quote, updated }
const inflight = new Map(); // key -> Promise

let stat = { hits: 0, misses: 0, coalesced: 0 };

function keyOf(prefix, code, targetDate) {
  return prefix + KEY_SEP + String(code) + KEY_SEP + String(targetDate);
}

// 淘汰最旧（按 updated 升序）；Map 未按 updated 排序，故线性找最小 —— 200 条量级可忽略
function evictIfNeeded() {
  while (cache.size > MAX_ENTRIES) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, v] of cache) {
      if (v.updated < oldest) { oldest = v.updated; oldestKey = k; }
    }
    if (oldestKey == null) break;
    cache.delete(oldestKey);
  }
}

// ★ 判据用 quote.date 而非仅 quote：OnOrAfter 在「尚未公布」时会返回 { date: null, reason }，
//   那属于「取不到」，必须走短 TTL，否则今晚净值公布后界面还会拿着 future 结果不放。
function ttlFor(targetDate, quote) {
  if (!quote || !quote.date) return TTL_MISS;
  return String(targetDate) >= util.todayStr() ? TTL_TODAY : TTL_PAST;
}

// 把「取净值函数」泛化成带缓存/去重的 resolver。两个 resolver 共用同一份 TTL 与淘汰逻辑。
function makeResolver(fetchFn, prefix) {
  return async function resolve(code, targetDate) {
    if (!code || !targetDate) return null;
    const k = keyOf(prefix, code, targetDate);

    const hit = cache.get(k);
    if (hit && Date.now() - hit.updated < ttlFor(targetDate, hit.quote)) {
      stat.hits++;
      return hit.quote;
    }

    const pending = inflight.get(k);
    if (pending) { stat.coalesced++; return pending; }

    stat.misses++;
    const p = (async () => {
      let quote = null;
      try { quote = await fetchFn(code, targetDate); }
      catch (e) { quote = null; } // 抓取异常按「取不到」处理，绝不让预览端点 500
      cache.set(k, { quote: quote || null, updated: Date.now() });
      evictIfNeeded();
      return quote || null;
    })();
    inflight.set(k, p);
    try { return await p; } finally { inflight.delete(k); }
  };
}

// 解析「targetDate 当日或之前最近一个交易日」的净值。
// 返回 { date, nav } 或 null（语义与 fetchers.fetchNavOnDate 完全一致）。
const resolveQuote = makeResolver(fetchers.fetchNavOnDate, 'le');

// 解析「nominalDate 当日或之后最近一个交易日」的净值（名义日顺延到真实成交日）。
// 命中 → { date, nav }；未命中 → { date: null, nav: null, reason: 'future' | 'tooOld' | 'error' }。
const resolveQuoteOnOrAfter = makeResolver(fetchers.fetchNavOnOrAfter, 'ge');

function stats() {
  return { ...stat, size: cache.size, inflight: inflight.size, max: MAX_ENTRIES };
}

function clear() {
  cache.clear();
  inflight.clear();
  stat = { hits: 0, misses: 0, coalesced: 0 };
}

module.exports = { resolveQuote, resolveQuoteOnOrAfter, stats, clear };

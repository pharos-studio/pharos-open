'use strict';
// 降级视图（路线 3）：未通过证据闸门的基金，也要给出**可核对的客观事实**，而不是一片空白。
//
// ★★ 三条硬约束写死在本文件里，不依赖调用方自觉：
//   1. **只产出事实，永不产出判断。** 返回对象里不允许出现
//      action / verdict / marketVerdict / executable / trigger / eligible / positionScore ——
//      连 null 都不给。（给 null 也会诱导前端「有字段就画按钮」，这是本项目吃过的亏。）
//   2. **只用原始单位净值。** 复权净值与定投模拟都依赖「官方分红拆分史」，而那份史书本身要靠
//      identityVerified 才拿得到；未核验就输出复权收益 = 系统性高估。因此这两项一律进
//      unavailable 并写明原因，而不是给一个看起来能用的错数。
//   3. **只接受闸门自己的原因码。** 原因码不认识 ⇒ 不降级（fail-closed）。
//      「不知道为什么不给」和「知道为什么不给」必须能被下游区分开。
//
// 设计依据：`.workbuddy/门禁解除方案-QDII与港股通.md` §4.2 路线 3。

// 复用 activeEquitySignal 的日期校验，避免本仓库出现第二份日期解析实现。
const validDate = require('./activeEquitySignal').validDate;

// 只认闸门真正会吐出的原因码（各策略 strategies/*.js 的 REASONS/LABELS 键 + 两个日历类）。
const KNOWN_BLOCK_REASONS = new Set([
  'profile_unverified',            // 官方身份/自动档案未核验
  'scope_unsupported',             // 超出该策略支持范围
  'daily_sampling_unverified',     // 日频采样未核验
  'initialization_unverified',     // 策略起点/连续性未核验
  'official_actions_history_unverified', // 官方分红拆分史不完整
  'fund_calendar_unverified',      // 基金开放日/估值日规则未核验
  'calendar_coverage_short',       // 核验日历覆盖不足
]);

const LABELS = {
  profile_unverified: '官方身份或自动档案未核验',
  scope_unsupported: '不在本策略的支持范围内',
  daily_sampling_unverified: '日频净值采样未核验',
  initialization_unverified: '策略起点与连续性未核验',
  official_actions_history_unverified: '官方分红拆分史不完整',
  fund_calendar_unverified: '基金开放日与估值日规则未核验',
  calendar_coverage_short: '已核验的日历覆盖不足',
};

const DISCLAIMER = '本视图只陈列净值事实，不构成任何买入／持有／卖出判断；该基金尚未通过本项目的证据核验。';

// rows 约定：**最新在前、日期严格递减**（与 fetchers.fetchNavHistory 的返回顺序一致）。
function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  let prev = null;
  for (const r of rows) {
    if (!r || !validDate(r.date)) return false;
    if (!Number.isFinite(r.nav) || r.nav <= 0) return false;
    if (prev !== null && r.date >= prev) return false;   // 必须严格递减，不接受重复或乱序
    prev = r.date;
  }
  return true;
}

const pct = x => Math.round(x * 10000) / 100;   // 分数 → 百分比，保留 2 位
const round4 = x => Math.round(x * 10000) / 10000;

// 纯描述性统计：只对原始单位净值做算术，不做任何跨期可比性修正。
function describe(rows) {
  const asc = rows.slice().reverse();               // 转为时间升序
  const earliest = asc[0], latest = asc[asc.length - 1];
  let peak = asc[0].nav, peakDate = asc[0].date;
  let mdd = 0, mddPeakDate = null, mddTroughDate = null;
  for (const r of asc) {
    if (r.nav > peak) { peak = r.nav; peakDate = r.date; }
    const dd = 1 - r.nav / peak;                    // 相对历史最高点的回撤
    if (dd > mdd) { mdd = dd; mddPeakDate = peakDate; mddTroughDate = r.date; }
  }
  return {
    observations: asc.length,
    firstDate: earliest.date, firstNav: round4(earliest.nav),
    latestDate: latest.date, latestNav: round4(latest.nav),
    cumulativeReturnUnadjustedPct: pct(latest.nav / earliest.nav - 1),
    maxDrawdownUnadjustedPct: pct(mdd),
    maxDrawdownPeakDate: mddPeakDate, maxDrawdownTroughDate: mddTroughDate,
    coverageNote: '区间为本次抓取到的全部净值，非基金全生命周期',
  };
}

/**
 * 构造降级视图。
 * @param {object}  o
 * @param {string}  o.code            6 位基金代码
 * @param {string} [o.name]           基金名称（展示用）
 * @param {string} [o.fundType]       基金类型（展示用）
 * @param {string} [o.market]         'A' | 'QDII'
 * @param {Array}   o.rows            原始单位净值行，最新在前、严格递减
 * @param {string}  o.blockedReason   闸门给出的原因码（必须是已知码）
 * @param {string} [o.source]         净值来源
 * @param {number} [o.sourceFetchedAt]
 * @returns {{ok:boolean, degraded:false, error:string}|{ok:true, degraded:true, ...}}
 */
function build(o) {
  const code = String((o && o.code) || '');
  if (!/^\d{6}$/.test(code)) return { ok: false, degraded: false, error: 'invalid_fund_code' };
  const reason = String((o && o.blockedReason) || '');
  // ③ 未知原因码 ⇒ 不降级。宁可空白，也不能给人一份「说不清为什么没有判断」的视图。
  if (!KNOWN_BLOCK_REASONS.has(reason)) return { ok: false, degraded: false, error: 'block_reason_not_recognized' };
  if (!validateRows(o.rows)) return { ok: false, degraded: false, error: 'nav_rows_invalid' };

  return {
    ok: true,
    degraded: true,
    isAdvice: false,
    viewVersion: 'degraded-view-v1',
    fund: { code, name: o.name || null, fundType: o.fundType || null, market: o.market || null },
    blockedReason: reason,
    blockedLabel: LABELS[reason],
    // ② 口径显式声明：本视图的所有数字都基于未复权单位净值。
    navBasis: 'raw_unit_nav',
    adjustmentsApplied: false,
    facts: describe(o.rows),
    unavailable: [
      { key: 'adjusted_nav', reason: '复权净值需要经核验的官方分红拆分史；该基金尚未通过身份核验。' },
      { key: 'dca_simulation', reason: '定投模拟必须用复权净值，否则分红会被算成亏损，系统性高估收益。' },
      { key: 'buy_or_sell_judgement', reason: '买入/持有/卖出判断需要先通过证据闸门；本视图按设计不产出判断。' },
    ],
    caveats: [
      '所有数字基于未复权单位净值：分红日会出现人为跳空，累计收益被低估、最大回撤被高估。',
      '区间只是本次抓取到的净值范围，不代表基金全生命周期，也不代表未来。',
      '净值由数据供应商提供，本项目未对该来源做日频完整性核验。',
    ],
    source: o.source || null,
    sourceFetchedAt: Number.isFinite(o.sourceFetchedAt) ? o.sourceFetchedAt : null,
    disclaimer: DISCLAIMER,
  };
}

module.exports = { KNOWN_BLOCK_REASONS, LABELS, DISCLAIMER, build, describe, validateRows };
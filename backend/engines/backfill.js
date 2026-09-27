'use strict';
/*
 * 在途买入记录自动补填引擎
 * ------------------------------------------------------------
 * 职责：遍历持仓里 shares==null 的在途记录，先算出「名义定价日」
 * （显式 pricingDate → 旧名 confirmDate/navDate → session 推算 → 旧 offset 兜底），
 * 再拿**该基金自己的净值序列**把它顺延到真实成交日（序列中第一个 >= 名义日的日期，无需节假日表），
 * 按 v2 外扣公式推导并写回 holdings.json；
 * 同时补上 `settleDate`（份额确认日 = 定价日 +1 工作日 A股 / +2 工作日 QDII）——
 * 它只是「份额何时到账」的说明，**不参与任何计算**。
 * 口径/份额公式/顺延上限统一由 lib/buyPlan.js + lib/tradeDate.js 提供，本文件不再自带副本。
 *
 * ★★ 本文件的顺延判据必须与 lib/buyPlan.js 的 previewOne **严格成对**：
 *    预览说 ok 而这里跳过（或反之）就会出现「界面显示能算、实际永远不补」的静默分叉。
 *
 * 触发：/api/refresh（看板每次加载/刷新自动跑）与 /api/backfill-pending（OpenClaw 每日推送）。
 * 设计约束：
 *   - in-flight 锁防并发写入；
 *   - 仅当「名义日之后已有已公布净值」且顺延 <= MAX_ROLL_DAYS 才解析；未公布/超限/网络失败 → 保持待确认；
 *   - 已确认（shares!=null）记录直接跳过，幂等；
 *   - 写盘后重跑 timing.buyScan() 保持学习样本一致。
 */
const store = require('../lib/store');
const navQuote = require('../lib/navQuote');
const timing = require('./timing');
const tradeDate = require('../lib/tradeDate');
const buyPlan = require('../lib/buyPlan');

const { validFeeRate, computeShares } = buyPlan;

let running = false; // in-flight 锁

async function autoBackfillPending() {
  if (running) return { skipped: 'in-flight', resolved: 0 };
  running = true;
  let resolved = 0;
  const detail = [];
  try {
    return await store.withFileLocks(['holdings.json'], async () => {
    const holdings = store.readJSON('holdings.json');
    if (!holdings || !Array.isArray(holdings.funds)) return { ok: true, resolved: 0, changed: false };
    let changed = false;
    for (const f of holdings.funds) {
      const purchases = Array.isArray(f.purchases) ? f.purchases : [];
      if (!purchases.length) continue;
      const fundFeeRate = validFeeRate(f.feeRate);
      const market = f.market === 'QDII' ? 'QDII' : 'A';
      for (const p of purchases) {
        if (p.shares != null) continue;                         // 已确认，跳过（幂等）
        if (!p.date || typeof p.amount !== 'number') continue;  // 结构保护
        // 名义定价日优先级：显式 pricingDate → 旧名 confirmDate/navDate → session 推算 → 旧 offset 兜底
        let nominal;
        if (p.pricingDate) nominal = p.pricingDate;
        else if (p.confirmDate) nominal = p.confirmDate;        // 旧名，语义就是定价日
        else if (p.navDate) nominal = p.navDate;                // 旧名，语义就是定价日
        else if (p.session) nominal = tradeDate.nominalPricingDate(p.date, p.session);
        else nominal = tradeDate.legacyConfirmDate(p.date, market); // ★ 冻结的历史口径（份额确认日 offset 被误用成定价日），勿动
        // ★ 名义日 → 真实定价日：该基金净值序列中第一个 >= 名义日 的日期
        const navRes = await navQuote.resolveQuoteOnOrAfter(f.code, nominal);
        if (!navRes || !navRes.date || !navRes.nav) continue;   // 尚未公布/早于可查范围/网络失败 → 保持待确认
        const rollDays = tradeDate.naturalDayDiff(nominal, navRes.date);
        if (rollDays > tradeDate.MAX_ROLL_DAYS) continue;        // 顺延太远（长期停牌/清盘）→ 交人工确认，绝不硬写
        const feeRate = p.quotedFeeRate != null ? validFeeRate(p.quotedFeeRate) : fundFeeRate;
        const shares = computeShares(p.amount, feeRate, navRes.nav, !!p.feeWaived);
        if (shares == null) continue;
        p.shares = shares;                                      // 4 位小数（由 buyPlan 保证）
        p.nav = navRes.nav;
        p.quotedFeeRate = feeRate;
        p.shareCalcVersion = 2;
        p.sharesSource = 'formula-v2';
        p.shareCalcBasis = p.shareCalcBasis || 'purchase-current-rate';
        // 补全元数据（不改变任何数值）：
        //   pricingDate = 真实成交净值日（份额由它决定）
        //   settleDate  = 份额确认日（到账时间，不参与计算）
        p.pricingDate = navRes.date;
        const settle = await buyPlan.resolveSettleDate(f.code, navRes.date, market);
        p.settleDate = settle.settleDate;
        changed = true; resolved++;
        detail.push({
          code: f.code, name: f.name, date: p.date, nominalDate: nominal,
          pricingDate: p.pricingDate, settleDate: p.settleDate,
          rollDays, nav: navRes.nav, shares: p.shares,
        });
      }
    }
    if (changed) {
      if (!store.writeJSONSafe('holdings.json', holdings)) {
        return { ok: false, resolved: 0, error: 'write failed (file locked by OneDrive/杀软?)' };
      }
      try { timing.buyScan(); } catch (e) { console.warn('[backfill] buyScan 失败:', e && e.message || e); }
    }
    return { ok: true, resolved, changed, detail };
    });
  } catch (e) {
    return { ok: false, resolved: 0, error: e && e.message || String(e) };
  } finally {
    running = false;
  }
}

module.exports = { autoBackfillPending, validFeeRate };

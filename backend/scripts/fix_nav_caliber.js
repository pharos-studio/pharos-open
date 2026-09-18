'use strict';
/*
 * 历史买入「日期标签」回填 + 净值口径修正
 * ------------------------------------------------------------
 * ★★ 默认只读（dry-run），只有显式 --apply 才写盘，且写盘前自动备份。
 * 背景与逐笔证据见 docs/历史买入核对清单.md。
 *
 * 本脚本做两类事，严格区分「能从数据唯一确定」与「必须人来决定」：
 *
 *  【A】回填日期标签（默认执行，零数值风险）
 *      判据：库内 nav **精确等于**「15:00 前」或「15:00 后」所对应**定价日**的官方净值。
 *      两个候选定价日 = 下单日 / 下单日+1 工作日，各自再过一次净值序列顺延
 *      （非交易日下单时两者会收敛成同一天，如周六 → 下周一）。
 *        命中「前」  → session = 'T'    pricingDate = 下单日（顺延后）
 *        命中「后」  → session = 'T+1'  pricingDate = 下一交易日
 *        两者皆命中  → session = 'T'（非交易日，两档本就无差别）
 *      旧口径 A股+1 恰好等于新口径「15:00 后」⇒ **A 股那批能被自动认出**；
 *      QDII 的 +2 在新口径下根本不存在 ⇒ 必然落进【B】（这正是它必错的原因）。
 *      ★ nav / shares / amount / date 一个字节都不动，只新增三个日期字段。
 *
 *  【B】按新口径重算 nav/shares（**必须显式给 --session**，否则一律跳过）
 *      nav 既对不上「前」也对不上「后」的笔（如当年手填了别天的净值、或 QDII 被旧口径 +2 顶错），
 *      时段无法从数据反推 —— 本脚本绝不猜测，只把它们列出来给你看，由 --session 决定。
 *
 * 用法：
 *   node backend/scripts/fix_nav_caliber.js                  # dry-run：只打印将要改什么
 *   node backend/scripts/fix_nav_caliber.js --session=T      # 追加「【B】按 15:00 前重算」方案
 *   node backend/scripts/fix_nav_caliber.js --session=T+1    # 追加「按 15:00 后重算」方案
 *   node backend/scripts/fix_nav_caliber.js --only=35,36,37  # 只处理指定序号（配合 --session）
 *   node backend/scripts/fix_nav_caliber.js --apply          # 落盘（先备份 holdings.json.bak-<时间>）
 *
 *  【C】给「在途笔」补时段标签（需 `--pending-session=T|T+1`）
 *      在途 = `shares == null`（净值尚未公布，如今天刚下单）。这类笔 nav/shares 无从计算，
 *      但**时段是你知道的**：写下 session 后，等净值公布，`engines/backfill` 会自动补上
 *      pricingDate / nav / shares / settleDate。
 *      ★ 只写 session 一个字段；pricingDate/settleDate **保持 null**，绝不用名义日冒充真实成交日。
 *
 * 幂等：已带 pricingDate 的笔一律跳过；在途笔只在显式给 --pending-session 时才动。
 */

const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const fetchers = require('../fetchers');
const tradeDate = require('../lib/tradeDate');
const buyPlan = require('../lib/buyPlan');

const argv = process.argv.slice(2);
const APPLY = argv.indexOf('--apply') >= 0;
const SESSION = (argv.find(a => a.indexOf('--session=') === 0) || '').slice('--session='.length) || null;
const ONLY_RAW = (argv.find(a => a.indexOf('--only=') === 0) || '').slice('--only='.length);
const ONLY = ONLY_RAW ? new Set(ONLY_RAW.split(',').map(s => Number(s.trim())).filter(n => n > 0)) : null;
// 【C】在途笔（shares==null）的时段：净值还没公布，但下单时段是已知的，可先落标签
const PENDING_SESSION = (argv.find(a => a.indexOf('--pending-session=') === 0) || '').slice('--pending-session='.length) || null;
const HISTORY_DAYS = 400;

if (SESSION && SESSION !== 'T' && SESSION !== 'T+1') {
  console.error('✗ --session 只接受 T（15:00 前）或 T+1（15:00 后）');
  process.exit(1);
}
if (PENDING_SESSION && PENDING_SESSION !== 'T' && PENDING_SESSION !== 'T+1') {
  console.error('✗ --pending-session 只接受 T（15:00 前）或 T+1（15:00 后）');
  process.exit(1);
}

// dates 升序，返回第一个 >= nominal 的日期（与 buyPlan / make_checklist 同一套语义）
function onOrAfter(dates, nominal) {
  let lo = 0, hi = dates.length - 1, ans = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (dates[m] >= nominal) { ans = dates[m]; hi = m - 1; } else lo = m + 1;
  }
  return ans;
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

(async () => {
  const holdings = store.readJSON('holdings.json');
  if (!holdings || !Array.isArray(holdings.funds)) { console.error('读不到 holdings.json'); process.exit(1); }

  console.log('拉取净值序列…');
  const navMap = {}, datesArr = {};
  for (const f of holdings.funds) {
    if (!Array.isArray(f.purchases) || !f.purchases.length) continue;
    let hist = [];
    try {
      const r = await fetchers.fetchNavHistory(f.code, HISTORY_DAYS);
      hist = (r && r.history) || [];
    } catch (e) { console.log('  ⚠️ ' + f.code + ' 拉取失败：' + (e && e.message)); }
    const m = new Map();
    for (const x of hist) if (x && x.date && x.nav != null) m.set(x.date, Number(x.nav));
    navMap[f.code] = m;
    datesArr[f.code] = [...m.keys()].sort();
    console.log('  ' + f.code + '  ' + datesArr[f.code].length + ' 个交易日');
  }

  // ---------- 扫描 ----------
  const tagList = [];   // 【A】可确定
  const review = [];    // 【B】需人工核对
  const pendingList = []; // 【C】在途笔：只补 session，等 backfill 补净值
  let idx = 0, inTransit = 0, alreadyTagged = 0, noNav = 0;

  for (const f of holdings.funds) {
    const market = f.market === 'QDII' ? 'QDII' : 'A';
    const feeRate = buyPlan.validFeeRate(f.feeRate);
    const dates = datesArr[f.code] || [];
    const map = navMap[f.code] || new Map();

    for (const p of (f.purchases || [])) {
      idx++;
      if (p.shares == null) {
        inTransit++;
        // 【C】在途笔：净值未公布，但时段已知 → 先落 session，其余交 backfill
        if (PENDING_SESSION && p.date && !p.session && (!ONLY || ONLY.has(idx))) {
          pendingList.push({
            idx, p, code: f.code, name: f.name, market,
            session: PENDING_SESSION,
            nominal: tradeDate.nominalPricingDate(p.date, PENDING_SESSION),
          });
        }
        continue;
      }
      if (p.pricingDate) { alreadyTagged++; continue; }
      if (!p.date || p.nav == null) { noNav++; continue; }

      const realFront = onOrAfter(dates, p.date);
      const realAfter = onOrAfter(dates, tradeDate.addBusinessDays(p.date, 1));
      const navFront = realFront ? map.get(realFront) : null;
      const navAfter = realAfter ? map.get(realAfter) : null;
      const mFront = navFront != null && Number(p.nav) === navFront;
      const mAfter = navAfter != null && Number(p.nav) === navAfter;

      let pricingDate = null, session = null, converged = false;
      if (mFront && mAfter) { pricingDate = realFront; session = 'T'; converged = true; }
      else if (mFront) { pricingDate = realFront; session = 'T'; }
      else if (mAfter) { pricingDate = realAfter; session = 'T+1'; }

      if (pricingDate) {
        const st = await buyPlan.resolveSettleDate(f.code, pricingDate, market);
        tagList.push({
          idx, p, market, code: f.code, name: f.name,
          pricingDate, session, converged,
          settleDate: st.settleEstimated ? null : st.settleDate,
          settleEstimated: st.settleEstimated
        });
      } else {
        review.push({
          idx, p, market, code: f.code, name: f.name, feeRate, dates,
          realFront, realAfter, navFront, navAfter
        });
      }
    }
  }

  // ---------- 【B】按指定时段重算 ----------
  const recalcList = [];
  if (SESSION) {
    for (const r of review) {
      if (ONLY && !ONLY.has(r.idx)) continue;
      const nominal = tradeDate.nominalPricingDate(r.p.date, SESSION);
      const real = onOrAfter(r.dates, nominal);
      if (!real) continue;
      const roll = tradeDate.naturalDayDiff(nominal, real);
      const nav = (navMap[r.code] || new Map()).get(real);
      if (nav == null) continue;
      const shares = buyPlan.computeShares(r.p.amount, r.feeRate, nav);
      const st = await buyPlan.resolveSettleDate(r.code, real, r.market);
      recalcList.push({
        idx: r.idx, p: r.p, code: r.code, name: r.name, market: r.market,
        nominal, pricingDate: real, rollDays: roll, nav, shares, session: SESSION,
        settleDate: st.settleEstimated ? null : st.settleDate,
        settleEstimated: st.settleEstimated,
        beyondLimit: roll > tradeDate.MAX_ROLL_DAYS
      });
    }
  }

  // ---------- 报告 ----------
  console.log('\n================ 扫描结果 ================');
  console.log('总笔数 ' + idx + ' ｜ 已带标签(跳过) ' + alreadyTagged + ' ｜ 在途(跳过) ' + inTransit +
    ' ｜ 缺日期/净值(跳过) ' + noNav +
    ' ｜ 【A】可确定 **' + tagList.length + '** ｜ 【B】需人工核对 **' + review.length + '**');

  console.log('\n【A】将回填日期标签（' + tagList.length + ' 笔）—— nav/shares/amount/date 一个字节不动，只新增 session/pricingDate/settleDate');
  const nT = tagList.filter(t => t.session === 'T').length;
  const nP = tagList.filter(t => t.session === 'T+1').length;
  const nConv = tagList.filter(t => t.converged).length;
  console.log("    session='T'（15:00 前） " + nT + " 笔 ｜ session='T+1'（15:00 后） " + nP + ' 笔 ｜ 其中非交易日两档收敛 ' + nConv + ' 笔');
  console.log('    ★ 时段不是猜的：库内 nav 精确等于「该时段对应定价日」的官方净值 —— 唯一解');
  const byFund = {};
  for (const t of tagList) {
    const k = t.code + ' ' + String(t.name || '').slice(0, 14);
    byFund[k] = byFund[k] || { n: 0, t: 0 };
    byFund[k].n++;
    if (t.session === 'T+1') byFund[k].t++;
  }
  for (const k in byFund) {
    console.log('    ' + k.padEnd(28) + String(byFund[k].n).padStart(3) + ' 笔' + (byFund[k].t ? '（含 15:00 后 ' + byFund[k].t + ' 笔）' : ''));
  }
  const warnEst = tagList.filter(t => t.settleEstimated);
  if (warnEst.length) console.log('    ⚠️ ' + warnEst.length + ' 笔的确认日序列未覆盖 → settleDate 写 null 交 backfill（绝不用名义日冒充）');
  console.log('    样例（前 6 笔）：');
  for (const t of tagList.slice(0, 6)) {
    console.log('      #' + String(t.idx).padEnd(3) + t.code + ' ' + t.p.date + '  →  ' +
      (t.session === 'T' ? '15:00前' : '15:00后') + ' · 定价日 ' + t.pricingDate + ' · 确认日 ' + (t.settleDate || '(待 backfill)'));
  }

  console.log('\n【B】需人工核对（' + review.length + ' 笔）—— nav 既对不上「15:00 前」也对不上「15:00 后」的定价日净值');
  if (!SESSION) {
    console.log('    未指定 --session ⇒ **本脚本不改动它们**（时段无法从数据反推）');
    console.log('    逐笔看看差在哪：');
    for (const r of review) {
      console.log('      #' + String(r.idx).padEnd(3) + r.code + ' ' + r.p.date + ' [' + r.market + ']  现值 nav ' + r.p.nav +
        ' ｜ 前=' + (r.navFront == null ? '—' : r.navFront + '@' + r.realFront) +
        ' ｜ 后=' + (r.navAfter == null ? '—' : r.navAfter + '@' + r.realAfter));
    }
    console.log('    想看重算方案：加 --session=T 或 --session=T+1');
  } else if (!recalcList.length) {
    console.log('    指定了 --session 但没有可处理的笔（可能被 --only 过滤掉了）');
  } else {
    console.log('    按 --session=' + SESSION + '（' + (SESSION === 'T' ? '15:00 前' : '15:00 后') + '）重算 ' + recalcList.length + ' 笔：');
    for (const r of recalcList) {
      const dNav = (r.nav - Number(r.p.nav)) / Number(r.p.nav) * 100;
      const dSh = (r.shares - Number(r.p.shares)) / Number(r.p.shares) * 100;
      console.log('      #' + String(r.idx).padEnd(3) + r.code + ' ' + r.p.date +
        '  现值 ' + r.p.nav + '/' + r.p.shares +
        '  →  ' + r.nav + '@' + r.pricingDate + '/' + r.shares +
        '   Δnav ' + dNav.toFixed(3) + '%  Δ份额 ' + dSh.toFixed(3) + '%' +
        (r.beyondLimit ? '  ⚠️ 顺延超 ' + tradeDate.MAX_ROLL_DAYS + ' 天' : ''));
    }
    if (ONLY) console.log('    （另有 ' + (review.length - recalcList.length) + ' 笔因 --only 未纳入）');
  }

  // ---------- 【C】在途笔 ----------
  if (PENDING_SESSION) {
    console.log('\n【C】在途笔补时段（' + pendingList.length + ' 笔）—— 只写 session，pricingDate/settleDate 留 null 交 backfill');
    for (const it of pendingList) {
      console.log('    #' + String(it.idx).padEnd(3) + it.code + ' ' + String(it.name || '').slice(0, 16) +
        '  ' + it.p.date + ' ¥' + it.p.amount +
        '  →  ' + (it.session === 'T' ? '15:00前' : '15:00后') +
        ' · 名义定价日 ' + it.nominal + '（等该日净值公布后自动补实）');
    }
    if (!pendingList.length) console.log('    （无符合条件的在途笔：可能已带 session 或没有 date）');
  } else if (inTransit) {
    console.log('\n【C】在途笔 ' + inTransit + ' 笔未处理 —— 想给它们补时段请加 --pending-session=T 或 --pending-session=T+1');
  }

  // ---------- 落盘 ----------
  const toWrite = tagList.concat(recalcList).concat(pendingList);
  if (!APPLY) {
    console.log('\n[dry-run] 未写盘。确认无误后加 --apply 落盘（会自动备份）。');
    return;
  }
  if (!toWrite.length) { console.log('\n没有要写入的改动。'); return; }

  const target = store.dataPath('holdings.json');
  const bak = target + '.bak-' + stamp();
  fs.copyFileSync(target, bak);
  console.log('\n已备份 → ' + bak);

  for (const it of tagList.concat(recalcList)) {
    it.p.session = it.session;
    it.p.pricingDate = it.pricingDate;
    it.p.settleDate = it.settleDate;
    if (it.nav != null) { it.p.nav = it.nav; it.p.shares = it.shares; }
    delete it.p.navDate; delete it.p.confirmDate;   // 旧字段名不再落盘
  }
  // 【C】在途笔：只落 session；pricingDate/settleDate 显式 null，绝不用名义日冒充
  for (const it of pendingList) {
    it.p.session = it.session;
    it.p.pricingDate = null;
    it.p.settleDate = null;
    delete it.p.navDate; delete it.p.confirmDate;
  }
  store.writeJSON('holdings.json', holdings);
  console.log('已写入 ' + target + '（' + toWrite.length + ' 笔）');
  console.log('回滚：把 ' + path.basename(bak) + ' 复制回 holdings.json');
  process.exit(0);
})();

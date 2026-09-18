'use strict';
/*
 * 历史买入净值口径审计（★ 纯只读，绝不写盘）
 * ------------------------------------------------------------
 * 背景：2026-09-16 订正了「按哪天的净值成交」的口径 ——
 *   旧（冻结在 tradeDate.legacyConfirmDate）：A股 +1 工作日 / QDII +2 工作日
 *   新（tradeDate.nominalPricingDate）：      15:00前 = T 日 / 15:00后 = T+1 工作日（A股/QDII 同规则）
 *
 * 本脚本回答一个问题：**如果按新口径把 91 笔历史重算一遍，到底有多少笔会变、变多少？**
 *
 * 对每一笔买入，枚举三种口径：
 *   now   —— 现状（就是库里现在的 nav/shares，当年按 legacy 口径抓的）
 *   front —— 新口径「15:00 前」：名义日 = 下单日 T
 *   after —— 新口径「15:00 后」：名义日 = 下单日 +1 工作日
 * front/after 都带「名义日 → 序列中第一个 >= 名义日」的顺延（与生产逻辑一致）。
 *
 * 用法：node backend/scripts/audit_nav_caliber.js [--verbose]
 */

const store = require('../lib/store');
const fetchers = require('../fetchers');
const tradeDate = require('../lib/tradeDate');
const buyPlan = require('../lib/buyPlan');

const VERBOSE = process.argv.indexOf('--verbose') >= 0;
const HISTORY_DAYS = 400; // 全部买入落在最近 5 个月内，400 天足够

// dates 为升序数组，返回第一个 >= nominal 的日期（二分）
function onOrAfter(dates, nominal) {
  let lo = 0, hi = dates.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] >= nominal) { ans = dates[mid]; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

(async () => {
  const holdings = store.readJSON('holdings.json');
  if (!holdings || !Array.isArray(holdings.funds)) {
    console.error('读不到 holdings.json');
    process.exit(1);
  }

  // ---------- 1. 拉每只基金的净值日期序列（升序） ----------
  console.log('拉取净值序列…');
  const navMap = {};   // code -> Map(date -> nav)
  const datesArr = {}; // code -> 升序日期数组
  for (const f of holdings.funds) {
    if (!Array.isArray(f.purchases) || !f.purchases.length) continue;
    let h = [];
    try {
      const r = await fetchers.fetchNavHistory(f.code, HISTORY_DAYS);
      h = (r && r.history) || [];
    } catch (e) {
      console.log('  ⚠️ ' + f.code + ' 拉取失败：' + (e && e.message));
    }
    const m = new Map();
    for (const x of h) if (x && x.date && x.nav) m.set(x.date, Number(x.nav));
    navMap[f.code] = m;
    datesArr[f.code] = [...m.keys()].sort();
    console.log('  ' + f.code + '  ' + datesArr[f.code].length + ' 个交易日  ' +
      (datesArr[f.code][0] || '-') + ' → ' + (datesArr[f.code][datesArr[f.code].length - 1] || '-'));
  }

  // ---------- 2. 逐笔对拍 ----------
  const rows = [];
  let miss = 0;

  for (const f of holdings.funds) {
    const ps = f.purchases || [];
    if (!ps.length) continue;
    const market = f.market === 'QDII' ? 'QDII' : 'A';
    const feeRate = buyPlan.validFeeRate(f.feeRate);
    const dates = datesArr[f.code] || [];

    for (const p of ps) {
      if (!p.date || typeof p.amount !== 'number') continue;
      if (p.shares == null) { miss++; continue; } // 在途那笔单独交代

      const nominalNow = tradeDate.legacyConfirmDate(p.date, market);          // 旧口径
      const nominalFront = p.date;                                             // 新·15:00前
      const nominalAfter = tradeDate.addBusinessDays(p.date, 1);               // 新·15:00后

      const realNow = onOrAfter(dates, nominalNow);
      const realFront = onOrAfter(dates, nominalFront);
      const realAfter = onOrAfter(dates, nominalAfter);

      const navNow = realNow ? navMap[f.code].get(realNow) : null;
      const navFront = realFront ? navMap[f.code].get(realFront) : null;
      const navAfter = realAfter ? navMap[f.code].get(realAfter) : null;

      const shFront = navFront != null ? buyPlan.computeShares(p.amount, feeRate, navFront) : null;
      const shAfter = navAfter != null ? buyPlan.computeShares(p.amount, feeRate, navAfter) : null;

      rows.push({
        code: f.code, market, name: f.name, date: p.date, amount: p.amount,
        session: p.session || null,
        cur: { nominal: nominalNow, real: realNow, nav: p.nav, shares: p.shares },
        front: { nominal: nominalFront, real: realFront, nav: navFront, shares: shFront },
        after: { nominal: nominalAfter, real: realAfter, nav: navAfter, shares: shAfter },
      });
    }
  }

  // ---------- 3. 汇总 ----------
  function summarize(key, label) {
    let changed = 0, same = 0, unknown = 0;
    let sumCur = 0, sumNew = 0, deltaCost = 0;
    let worst = null;
    for (const r of rows) {
      const n = r[key];
      if (n.shares == null || n.nav == null) { unknown++; continue; }
      const d = n.shares - r.cur.shares;
      sumCur += r.cur.shares;
      sumNew += n.shares;
      deltaCost += d * (r.cur.nav || 0); // 折算成「按原成本价算的金额差」
      if (Math.abs(d) > 1e-9) {
        changed++;
        if (!worst || Math.abs(d) > Math.abs(worst.d)) worst = { d, r, n };
      } else same++;
    }
    console.log('');
    console.log('─── 假设「' + label + '」 ───');
    console.log('  与现状不同 : ' + changed + ' / ' + rows.length + ' 笔');
    console.log('  与现状相同 : ' + same + ' 笔   （无法比对：' + unknown + '）');
    console.log('  份额合计   : ' + sumCur.toFixed(4) + ' → ' + sumNew.toFixed(4) +
      '   Δ ' + (sumNew - sumCur >= 0 ? '+' : '') + (sumNew - sumCur).toFixed(4) +
      '  (' + pct(sumNew, sumCur).toFixed(2) + '%)');
    console.log('  成本影响   : ' + (deltaCost >= 0 ? '+' : '') + deltaCost.toFixed(2) +
      ' 元  （同样的钱买到更多/更少份额，≈ 持仓成本的差额）');
    if (worst) {
      console.log('  最大单笔   : ' + worst.r.code + ' ' + worst.r.date +
        '  ' + worst.r.cur.shares.toFixed(4) + ' → ' + worst.n.shares.toFixed(4) +
        '  (Δ' + (worst.d >= 0 ? '+' : '') + worst.d.toFixed(4) + ')');
    }
    return { changed, sumCur, sumNew, deltaCost };
  }

  console.log('');
  console.log('========================================');
  console.log(' 历史买入净值口径审计（只读）');
  console.log(' 可比对笔数 = ' + rows.length + '   在途跳过 = ' + miss);
  console.log('========================================');
  const rf = summarize('front', '按新口径「15:00 前」重算');
  const ra = summarize('after', '按新口径「15:00 后」重算');

  // ---------- 4. 按市场拆分 ----------
  console.log('');
  console.log('─── 分市场看「15:00 后」假设（QDII 是重灾区） ───');
  for (const mk of ['A', 'QDII']) {
    const sub = rows.filter((r) => r.market === mk);
    if (!sub.length) continue;
    let ch = 0, sc = 0, sn = 0;
    for (const r of sub) {
      if (r.after.shares == null) continue;
      if (Math.abs(r.after.shares - r.cur.shares) > 1e-9) ch++;
      sc += r.cur.shares; sn += r.after.shares;
    }
    console.log('  ' + mk.padEnd(5) + ' 共 ' + String(sub.length).padStart(2) + ' 笔  会变 ' +
      String(ch).padStart(2) + ' 笔   份额 ' + sc.toFixed(4) + ' → ' + sn.toFixed(4) +
      '  (' + pct(sn, sc).toFixed(2) + '%)');
  }

  // ---------- 5. 明细 ----------
  const show = VERBOSE ? rows : rows
    .slice()
    .sort((a, b) => Math.abs(b.after.shares == null ? 0 : b.after.shares - b.cur.shares)
      - Math.abs(a.after.shares == null ? 0 : a.after.shares - a.cur.shares))
    .slice(0, 12);

  console.log('');
  console.log('─── 明细' + (VERBOSE ? '（全部）' : '（按「15:00 后」假设，份额差最大的 12 笔）') + ' ───');
  console.log('市场  基金     下单日       金额   现状净值日/净值/份额           前(T)净值/份额           后(T+1)净值/份额');
  for (const r of show) {
    const f = (s) => (s == null ? '—' : String(s));
    console.log(
      r.market.padEnd(5) + ' ' + r.code + '  ' + r.date + '  ' + String(r.amount).padStart(5) +
      '   ' + f(r.cur.real) + ' ' + f(r.cur.nav) + ' ' + f(r.cur.shares == null ? null : r.cur.shares.toFixed(4)) +
      '   ' + f(r.front.real) + ' ' + f(r.front.nav) + ' ' + f(r.front.shares == null ? null : r.front.shares.toFixed(4)) +
      '   ' + f(r.after.real) + ' ' + f(r.after.nav) + ' ' + f(r.after.shares == null ? null : r.after.shares.toFixed(4))
    );
  }

  // ---------- 6. 现状 nav 溯源：库里那 90 笔的 nav，到底对应序列里的哪一天？ ----------
  console.log('');
  console.log('─── 现状 nav 溯源（库里 nav 值与哪一天的官方净值逐位相等）───');
  const bucket = { T: 0, 'T+1': 0, 'T+2': 0, other: 0 };
  const tally = { T: [], 'T+1': [], 'T+2': [], other: [] };
  for (const r of rows) {
    const dates = datesArr[r.code];
    const m = navMap[r.code];
    const cands = [['T', r.date], ['T+1', tradeDate.addBusinessDays(r.date, 1)], ['T+2', tradeDate.addBusinessDays(r.date, 2)]];
    let hit = null;
    for (const [lab, nd] of cands) {
      const real = onOrAfter(dates, nd);
      if (real && Math.abs(m.get(real) - r.cur.nav) < 1e-9) { hit = lab; break; }
    }
    if (!hit) {
      // 全序列里找一次（排除已试的 T/T+1/T+2 之后仍可能命中，用来识别「另一个偏移」）
      for (const dt of dates) {
        if (Math.abs(m.get(dt) - r.cur.nav) < 1e-9) { hit = 'other'; r._navDay = dt; break; }
      }
      if (!hit) hit = 'other';
    }
    bucket[hit]++;
    if (tally[hit].length < 6) tally[hit].push(r);
  }
  console.log('  nav 落在 T 日（= 15:00 前成交） : ' + bucket.T + ' 笔');
  console.log('  nav 落在 T+1 日（= 15:00 后成交）: ' + bucket['T+1'] + ' 笔');
  console.log('  nav 落在 T+2 日                   : ' + bucket['T+2'] + ' 笔');
  console.log('  落在序列别处 / 对不上             : ' + bucket.other + ' 笔');
  for (const lab of ['other']) {
    for (const r of tally[lab]) {
      const dates = datesArr[r.code];
      const m = navMap[r.code];
      console.log('     · ' + r.code + ' 下单 ' + r.date + '  库内 nav=' + r.cur.nav +
        '  ' + (r._navDay ? '命中序列 ' + r._navDay : '✗ 序列中找不到该净值'));
      const idx = r._navDay ? dates.indexOf(r._navDay) : -1;
      if (idx >= 0) {
        console.log('       该日附近 : ' + dates.slice(Math.max(0, idx - 2), idx + 3)
          .map((d) => d.slice(5) + '=' + m.get(d)).join('  '));
      }
      const i2 = dates.findIndex((d) => d >= r.date);
      if (i2 >= 0) {
        console.log('       下单日附近: ' + dates.slice(i2, i2 + 4)
          .map((d) => d.slice(5) + '=' + m.get(d)).join('  '));
      }
    }
  }

  // ---------- 7. shares 与 nav 是否自洽（排除公式差异的干扰） ----------
  let selfOk = 0, selfBad = 0, feeDiff = 0;
  const badSample = [];
  for (const r of rows) {
    const f = holdings.funds.find((x) => x.code === r.code);
    const fee = buyPlan.validFeeRate(f && f.feeRate);
    const exp = buyPlan.computeShares(r.amount, fee, r.cur.nav);
    if (exp == null) continue;
    if (Math.abs(exp - r.cur.shares) < 1e-9) selfOk++;
    else if (Math.abs(exp - r.cur.shares) < 0.001) feeDiff++;
    else { selfBad++; if (badSample.length < 6) badSample.push(r); }
  }
  console.log('');
  console.log('─── 库内 shares 与「金额×(1−费率)÷nav」是否自洽 ───');
  console.log('  完全一致 : ' + selfOk + '    小数舍入级差异(<0.001份) : ' + feeDiff + '    明显不一致 : ' + selfBad);
  for (const r of badSample) {
    console.log('     · ' + r.code + ' ' + r.date + '  库内 ' + r.cur.shares + '  公式 ' +
      buyPlan.computeShares(r.amount, buyPlan.validFeeRate((holdings.funds.find((x) => x.code === r.code) || {}).feeRate), r.cur.nav));
  }

  console.log('');
  console.log('※ 全程只读，未写入任何文件。');
  process.exit(0);
})().catch((e) => { console.error('审计异常：', e); process.exit(2); });

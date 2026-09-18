'use strict';
/*
 * 科技成长线「金叉通道」改造回测 —— 联网只读，**不写任何文件、不改生产代码**。
 *
 * 要回答（待办清单 §1.1 ★★★ 根问题）：
 *   「状态型条件在趋势资产上长期为真」——科技线 goldenState(MA20>MA60) 占回放点 66.4%，
 *   导致 add 占 68.6% 的时间，信号失去区分度（A 组 R6m 27.1% vs 全期随机入场 24.4%，仅 +2.7pp）。
 *   问：把金叉通道从「状态」改成「回调」或「事件」，能不能大幅降低占空比的同时提升信号质量？
 *
 * ★ 审查阶段实测澄清的准确口径（原讨论稿有误，见计划 §1.2）：
 *   cross='golden' 的**标记点数** = 159，但**独立穿越**只有 16 次（每次被标记约 10 天，因 tech.js:35 的 back=10）。
 *   故金叉不常发生（每 2.5 个月一次），但"状态"占空比累积到 66.4%。
 *
 * ★ 被推翻的假设：不是"均线差在 0 附近抖动"（缓冲带 ±0.5/1/2% 实测无效，占空比仍 69~71%），
 *   而是 MA20−MA60 的差值大部分时间显著为正——趋势真实长期存在。
 *
 * 六组对照（主判据预先声明为 C5 与 E3b，防多重比较）：
 *   A   现状：dipReady ∨ 金叉状态                            （占空比 68.6%，基线）
 *   C5  dipReady ∨ (金叉状态 ∧ 回撤≥5%)                      （回调派代表）
 *   C10 dipReady ∨ (金叉状态 ∧ 回撤≥10%)                     （C 的参数变体）
 *   E3b dipReady ∨ (独立穿越后 3 个交易日内)                  （突破派代表）
 *   E5b dipReady ∨ (独立穿越后 5 个交易日内)                  （E 的参数变体）
 *   E3a dipReady ∨ (cross 标记在最近 3 日，≈穿越后 12 日内)    （E 的宽松变体）
 *
 * ★ 无未来函数：每点只用 date ≤ 当前点 的净值构造 history（生产天然如此，回放显式截断）。
 * ★ 零重实现：直接读生产 buildTechDecision 返回的 dec.matrix。
 * ★ E 组的"独立穿越"在单点内从 hist 算（对齐生产可实现的形态），不依赖跨点状态。
 *
 * 用法：node backend/scripts/backtest_tech_cross.js
 */
const f = require('../fetchers');
const config = require('../lib/config');
const util = require('../lib/util');
const buildTechDecision = require('../engines/strategies/tech');

const FUNDS = [
  { code: '016664', alias: '天弘全球高端制造A' },
  { code: '012920', alias: '易方达全球成长精选A' },
  { code: '016874', alias: '广发远见智选C' },
];
const PEER = '016665';                 // 与 016664 同标的（C 份额），仅同源校验
const NAV_WIN = 120;                   // ★对齐 analysis.js:34（growth histDays=120）
const GAP = 28;                        // 相邻命中 ≤4 周合并为一个事件
const ITERS = 2000;
const DIP_PCT = 15;                    // 生产 tech.dipPct
const DD_DEEP = -20;                   // 深跌期阈值（P3 用）
const DUTY_LO = 3;                     // P0 占空比下限（%）
const DUTY_HI_RATIO = 0.5;             // P0 上限 = A 占空比 × 0.5

const fx = (v, d) => (v == null || isNaN(v) ? '—' : (+v).toFixed(d == null ? 2 : d));
const pct = (v, d) => (v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (+v).toFixed(d == null ? 1 : d) + '%');
const pp = (v, d) => (v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (+v).toFixed(d == null ? 2 : d) + 'pp');
const mean = a => { const b = a.filter(x => x != null && !isNaN(x)); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : null; };
const median = a => { const b = a.filter(x => x != null && !isNaN(x)).sort((x, y) => x - y); if (!b.length) return null; const n = b.length >> 1; return b.length % 2 ? b[n] : (b[n - 1] + b[n]) / 2; };
function quantile(arr, p) { const a = arr.filter(x => x != null && !isNaN(x)).slice().sort((x, y) => x - y); if (!a.length) return null; return a[Math.min(a.length - 1, Math.max(0, Math.round(p / 100 * (a.length - 1))))]; }
function lookup(arr, day) { let lo = 0, hi = arr.length - 1, res = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].date <= day) { res = arr[m]; lo = m + 1; } else hi = m - 1; } return res; }
function addMonths(d, m) { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); }
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
function corr(xs, ys) { const n = Math.min(xs.length, ys.length); if (n < 30) return null; const mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n)); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; } return (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : null; }

function returns(navs, date) {
  const base = lookup(navs, date);
  if (!base || !base.nav) return { r1: null, r3: null, r6: null, r12: null };
  const out = {};
  [['r1', 1], ['r3', 3], ['r6', 6], ['r12', 12]].forEach(([k, h]) => {
    const tgt = lookup(navs, addMonths(date, h));
    out[k] = (!tgt || !tgt.nav || daysBetween(date, tgt.date) < h * 28 - 10) ? null : (tgt.nav / base.nav - 1) * 100;
  });
  return out;
}
function toEvents(hits) {
  const ev = [];
  hits.forEach(h => {
    const last = ev[ev.length - 1];
    if (last && daysBetween(last.date, h.date) <= GAP) last.points.push(h);
    else ev.push({ date: h.date, points: [h] });
  });
  return ev;
}
async function fetchSeries(code) {
  const r = await f.fetchNavHistory(code, 4500);
  const h = (r && r.history) || [];
  return h.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).filter(x => x.nav > 0);
}

// ---------- 回放：读生产 matrix + 自算 diff 序列（判定"独立穿越"）----------
// diffs[k] = MA20(hist.slice(k)) − MA60(hist.slice(k))，k=0 为当日。
// 穿越日：diffs[k] > 0 且 diffs[k+1] ≤ 0（由负转正）。需要 k+1 ≤ 可用长度。
const DIFF_MAX = 20;                   // 需覆盖 E3a 的 k+10 与 E5b，取 20 足够
function replay(navs, cfg) {
  const rows = [];
  for (let i = NAV_WIN - 1; i < navs.length; i++) {
    const cur = navs[i];
    const hist = navs.slice(i - NAV_WIN + 1, i + 1).reverse().map(x => ({ date: x.date, nav: x.nav }));
    const dec = buildTechDecision({ code: 'PROBE', category: 'growth', latestNav: cur.nav, history: hist }, {}, cfg);
    const m = dec.matrix || {};
    // 逐日 diff（k=0 为当日）；computeMA 对 hist.slice(k) 取最新 window 个点
    const diffs = [];
    for (let k = 0; k <= DIFF_MAX; k++) {
      const a = util.computeMA(hist.slice(k), 20);
      const b = util.computeMA(hist.slice(k), 60);
      diffs.push((a != null && b != null) ? (a - b) : null);
    }
    // 独立穿越：最近 N 个交易日内是否发生"由负转正"
    const crossWithin = N => {
      for (let k = 0; k < N; k++) {
        const d0 = diffs[k], d1 = diffs[k + 1];
        if (d0 != null && d1 != null && d0 > 0 && d1 <= 0) return true;
      }
      return false;
    };
    // E3a 用生产 cross 标记：cross(t) = diff(t)>0 ∧ diff(t-10)<0
    let crossMark3 = false;
    for (let k = 0; k < 3; k++) {
      const d0 = diffs[k], d10 = diffs[k + 10];
      if (d0 != null && d10 != null && d0 > 0 && d10 < 0) { crossMark3 = true; break; }
    }
    rows.push({
      date: cur.date, nav: cur.nav, realAction: dec.action,
      drawdown: m.drawdown, dipReady: m.dipReady === true, stopFall: m.stopFall === true,
      goldenState: m.goldenState === true, maZone: m.maZone, gate: m.gate,
      cross: m.cross, crossMark3,
      cross3: crossWithin(3), cross5: crossWithin(5),
      r: returns(navs, cur.date),
    });
  }
  return rows;
}

// ---------- 分组（点层谓词）----------
const G = {
  A: r => r.dipReady || r.goldenState,
  C5: r => r.dipReady || (r.goldenState && r.drawdown != null && r.drawdown <= -5),
  C10: r => r.dipReady || (r.goldenState && r.drawdown != null && r.drawdown <= -10),
  E3b: r => r.dipReady || r.cross3,
  E5b: r => r.dipReady || r.cross5,
  E3a: r => r.dipReady || r.crossMark3,
};
const MAIN = ['C5', 'E3b'];            // ★预先声明的主判据
const VARIANTS = { C5: ['C10'], E3b: ['E5b', 'E3a'] };

// 池化：基金内先事件化，再跨基金合并（事件单元 = 基金×日期）
function pooled(rowsByFund, pred) {
  const out = [];
  Object.keys(rowsByFund).forEach(code => {
    toEvents(rowsByFund[code].filter(pred)).forEach(e => out.push({ fund: code, date: e.date, r: e.points[0].r, row: e.points[0] }));
  });
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
// ★ 点层面差集 → 各自独立事件化（事件层求差会因合并模式不同产生假象）
function pooledDiff(rowsByFund, predFrom, predSub) {
  const out = [];
  Object.keys(rowsByFund).forEach(code => {
    const hits = rowsByFund[code].filter(r => predFrom(r) && !predSub(r));
    toEvents(hits).forEach(e => out.push({ fund: code, date: e.date, r: e.points[0].r, row: e.points[0] }));
  });
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
const stat = ev => {
  const g = k => ev.map(e => (e.r ? e.r[k] : null));
  const v6 = g('r6').filter(x => x != null);
  return { n: ev.length, n6: v6.length, m1: mean(g('r1')), m3: mean(g('r3')), m6: mean(g('r6')), m12: mean(g('r12')), med6: median(g('r6')), worst6: v6.length ? Math.min.apply(null, v6) : null };
};
function bootClusterPaired(evA, evB, iters) {
  const byKey = {};
  const rc = x => x.date.slice(0, 7);
  const touch = k => (byKey[k] = byKey[k] || { a: [], b: [] });
  evA.forEach(e => { if (e.r && e.r.r6 != null) touch(rc(e)).a.push(e.r.r6); });
  evB.forEach(e => { if (e.r && e.r.r6 != null) touch(rc(e)).b.push(e.r.r6); });
  const keys = Object.keys(byKey);
  const out = [];
  for (let it = 0; it < iters; it++) {
    let sa = 0, na = 0, sb = 0, nb = 0;
    for (let j = 0; j < keys.length; j++) {
      const k = keys[Math.floor(Math.random() * keys.length)];
      byKey[k].a.forEach(v => { sa += v; na++; });
      byKey[k].b.forEach(v => { sb += v; nb++; });
    }
    if (na && nb) out.push(sb / nb - sa / na);
  }
  return out.length ? { p10: quantile(out, 10), p50: quantile(out, 50), p90: quantile(out, 90), nClusters: keys.length } : null;
}

(async () => {
  const cfg = config.getConfig();
  const t = (cfg.signals && cfg.signals.tech) || {};

  console.log('=== 科技成长线「金叉通道」改造回测（3 只真实基金）===\n');
  console.log(`阈值（config.signals.tech）：dipPct=${t.dipPct}  dipWindow=${t.dipWindow}  stopWindow=${t.stopWindow}  ma=${JSON.stringify(t.ma)}`);
  console.log(`回放窗口 NAV_WIN=${NAV_WIN}（对齐 analysis.js:34）｜事件合并 GAP=${GAP} 天｜bootstrap ${ITERS} 次`);
  console.log(`主判据（预先声明）：${MAIN.join(' / ')}；变体：C5→${VARIANTS.C5.join('、')}，E3b→${VARIANTS.E3b.join('、')}\n`);

  // ---- ① 抓数 ----
  console.log('--- ① 序列获取 ---');
  const S = {};
  for (const fd of FUNDS) {
    S[fd.code] = await fetchSeries(fd.code);
    console.log(`  ${fd.code} ${fd.alias.padEnd(22)} n=${String(S[fd.code].length).padStart(5)}  ${S[fd.code].length ? S[fd.code][0].date + ' ~ ' + S[fd.code][S[fd.code].length - 1].date : '空'}`);
  }
  const peer = await fetchSeries(PEER);
  console.log(`  ${PEER} (C份额，仅校验)            n=${String(peer.length).padStart(5)}`);

  // ---- ② 同源校验 ----
  console.log('\n--- ② 同源校验：016664 vs 016665（须 >0.99）---');
  const xa = [], xb = [];
  const mainNavs = S['016664'];
  for (let i = 1; i < mainNavs.length; i++) {
    const p0 = lookup(peer, mainNavs[i - 1].date), c0 = lookup(peer, mainNavs[i].date);
    if (!p0 || !c0 || c0.date !== mainNavs[i].date) continue;
    xa.push(mainNavs[i].nav / mainNavs[i - 1].nav - 1); xb.push(c0.nav / p0.nav - 1);
  }
  const rc0 = corr(xa, xb);
  console.log(`  n=${xa.length}  相关系数 = ${fx(rc0, 4)}  ${rc0 != null && rc0 > 0.99 ? '✓' : '⚠ 偏差较大'}`);

  // ---- ③ 回放 + 一致性断言 ----
  console.log('\n--- ③ 回放 + 一致性断言（不通过即作废）---');
  const rowsByFund = {};
  let badA = 0, pts = 0;
  const perFundDuty = [];
  for (const fd of FUNDS) {
    const rows = replay(S[fd.code], cfg);
    rowsByFund[fd.code] = rows;
    pts += rows.length;
    rows.forEach(r => { if (G.A(r) !== (r.realAction === 'add')) badA++; });
    perFundDuty.push({
      code: fd.code, n: rows.length,
      add: rows.filter(r => r.realAction === 'add').length,
      gs: rows.filter(r => r.goldenState).length,
      cross: rows.filter(r => r.cross3).length,
    });
    console.log(`  ${fd.code} 回放点 ${rows.length}`);
  }
  console.log('  按基金：' + perFundDuty.map(x => `${x.code} add=${fx(x.add / x.n * 100, 1)}% 金叉状态=${fx(x.gs / x.n * 100, 1)}% 穿越后3日=${fx(x.cross / x.n * 100, 1)}%`).join(' ｜ '));
  console.log(`  回放点合计 ${pts}`);
  console.log(`  [a] 重建规则 A 与生产 action 不一致 = ${badA}（应为 0）  ${badA === 0 ? '✓' : '✗'}`);
  if (badA > 0) { console.log('\n  ✗ 一致性未通过，结论不可信，终止。'); process.exit(1); }
  console.log('  → 重建规则与生产逐点一致。\n');

  // ---- ④ 占空比（P0 的核心）----
  console.log('--- ④ 各组信号占空比（P0 判据）---');
  const allRows = [];
  Object.keys(rowsByFund).forEach(c => rowsByFund[c].forEach(r => allRows.push(r)));
  const duty = {};
  console.log('  组   占空比    对比 A      性质');
  Object.keys(G).forEach(k => {
    const c = allRows.filter(G[k]).length;
    duty[k] = c / allRows.length * 100;
    const rel = duty.A ? (duty[k] / duty.A) : 0;
    const tag = k === 'A' ? '基线' : (duty[k] <= duty.A * DUTY_HI_RATIO ? `✓ 已降至 A 的 ${(rel * 100).toFixed(0)}%` : `✗ 仍达 A 的 ${(rel * 100).toFixed(0)}%`);
    console.log('  ' + k.padEnd(4) + fx(duty[k], 1).padStart(7) + '%' + (k === 'A' ? '        —' : ('   ' + (duty[k] - duty.A).toFixed(1) + 'pp').padStart(9)) + '   ' + tag);
  });
  console.log('  对照：一直持有 = 100%；病灶（goldenState 为真）= ' + fx(allRows.filter(r => r.goldenState).length / allRows.length * 100, 1) + '%');
  console.log('  P0 门槛：候选 ≤ A×0.5 = ' + fx(duty.A * DUTY_HI_RATIO, 1) + '% 且 ≥ ' + DUTY_LO + '%');

  // ---- ⑤ 事件数 ----
  const ev = {};
  Object.keys(G).forEach(k => { ev[k] = pooled(rowsByFund, G[k]); });
  console.log('\n--- ⑤ 各组事件数（池化：基金内先合并，再跨基金）---');
  console.log('  组   事件数  独立月数');
  Object.keys(G).forEach(k => {
    const m = new Set(ev[k].map(e => e.date.slice(0, 7)));
    console.log('  ' + k.padEnd(4) + String(ev[k].length).padStart(7) + String(m.size).padStart(10));
  });

  // ---- ⑥ 逐年事件数 ----
  const yrs = [...new Set(allRows.map(r => r.date.slice(0, 4)))].sort();
  console.log('\n--- ⑥ 逐年事件数 ---');
  console.log('  年份   ' + Object.keys(G).map(k => k.padStart(5)).join(''));
  yrs.forEach(y => console.log('  ' + y + '  ' + Object.keys(G).map(k => String(ev[k].filter(e => e.date.slice(0, 4) === y).length).padStart(5)).join('')));
  console.log('  合计   ' + Object.keys(G).map(k => String(ev[k].length).padStart(5)).join(''));

  // ---- ⑦ 收益 ----
  console.log('\n--- ⑦ 各组收益（%，事件首日）---');
  console.log('  组   事件数 R6m样本    R1m     R3m     R6m    R12m  R6m中位  最差R6m  R6m超额');
  const st = {};
  const baseR6 = allRows.map(r => r.r.r6).filter(x => x != null);
  const baseM6 = mean(baseR6);
  Object.keys(G).forEach(k => {
    st[k] = stat(ev[k]);
    const s = st[k];
    const excess = (s.m6 != null && baseM6 != null) ? s.m6 - baseM6 : null;
    console.log('  ' + k.padEnd(4) + String(s.n).padStart(5) + String(s.n6).padStart(8) + '  '
      + fx(s.m1, 1).padStart(6) + fx(s.m3, 1).padStart(8) + fx(s.m6, 1).padStart(8) + fx(s.m12, 1).padStart(7)
      + fx(s.med6, 1).padStart(9) + fx(s.worst6, 1).padStart(9) + pp(excess).padStart(9));
  });
  console.log(`  [基准] 全期任意点入场 R6m = ${pct(baseM6)}（n=${baseR6.length}）—— 信号超额 = 组 R6m − 此值`);

  // ---- ⑧ 主判据 Δ + 双向边际信号 ----
  console.log('\n--- ⑧ 主判据 Δ 与 ★双向边际信号 ---');
  const res = {};
  MAIN.forEach(k => {
    const s = st[k], sA = st.A;
    const d = (s.m6 != null && sA.m6 != null) ? s.m6 - sA.m6 : null;
    const dropped = pooledDiff(rowsByFund, G.A, G[k]);   // A \ 候选（被筛掉）
    const added = pooledDiff(rowsByFund, G[k], G.A);     // 候选 \ A（新增）
    const sd = stat(dropped), sa = stat(added);
    const cbt = bootClusterPaired(ev.A, ev[k], ITERS);
    res[k] = { d, dropped, added, sd, sa, cbt, s };
    console.log(`\n  【${k}】事件 ${s.n}  R6m ${pct(s.m6)}  ΔR6m = ${pp(d)}（门槛 +2.0pp）`);
    console.log(`    聚类 bootstrap（按月, nClusters=${cbt ? cbt.nClusters : '—'}）: p10=${cbt ? pp(cbt.p10) : '—'}  p50=${cbt ? pp(cbt.p50) : '—'}  p90=${cbt ? pp(cbt.p90) : '—'}`);
    console.log(`    ★被筛掉(A\\${k}) n=${dropped.length}  R6m ${pct(sd.m6)}  ｜ 保留(${k}) R6m ${pct(s.m6)}  ｜ 差 ${pp((s.m6 != null && sd.m6 != null) ? s.m6 - sd.m6 : null)}`);
    console.log(`    ★新增(${k}\\A) n=${added.length}  R6m ${pct(sa.m6)}${added.length ? '' : '（空集 → 严格为 A 的子集 ✓）'}`);
  });

  // ---- ⑨ 深跌期覆盖（P3）----
  console.log('\n--- ⑨ 深跌期覆盖（净值距120日高点 ≤ -20% 的点）---');
  const deepIdx = allRows.map((r, i) => [r, i]).filter(([r]) => r.drawdown != null && r.drawdown <= DD_DEEP);
  console.log(`  深跌期总点数 = ${deepIdx.length} / ${allRows.length}（${fx(deepIdx.length / allRows.length * 100, 1)}%）`);
  const covOf = (k) => deepIdx.filter(([r]) => G[k](r)).length / deepIdx.length * 100;
  const cov = {};
  Object.keys(G).forEach(k => { cov[k] = covOf(k); console.log('  ' + k.padEnd(4) + ' 覆盖率 ' + fx(cov[k], 1).padStart(6) + '%'); });

  // ---- ⑩ 留一基金（P7）----
  console.log('\n--- ⑩ 留一基金检验 ---');
  const loo = {};
  MAIN.forEach(k => {
    loo[k] = {};
    FUNDS.forEach(fd => {
      const sub = {}; Object.keys(rowsByFund).forEach(c => { if (c !== fd.code) sub[c] = rowsByFund[c]; });
      const mA = stat(pooled(sub, G.A)).m6, mk = stat(pooled(sub, G[k])).m6;
      const d = (mA != null && mk != null) ? mk - mA : null;
      loo[k][fd.code] = d;
      console.log(`  [${k}] 剔除 ${fd.code}: A=${pct(mA)} ${k}=${pct(mk)} Δ=${pp(d)}  ${d != null && Math.sign(d) === Math.sign(res[k].d || 0) ? '✓同号' : '✗变号'}`);
    });
  });

  // ---- ⑪ 判据 P0~P7 ----
  console.log('\n--- ⑪ 落地判据（P0~P7，全过才改）---');
  const verdict = {};
  MAIN.forEach(k => {
    const r = res[k];
    const dVar = VARIANTS[k].map(v => ({ v, d: (st[v].m6 != null && st.A.m6 != null) ? st[v].m6 - st.A.m6 : null }));
    const p0 = duty[k] <= duty.A * DUTY_HI_RATIO && duty[k] >= DUTY_LO;
    const p1 = r.d != null && r.d >= 2.0 && r.cbt != null && r.cbt.p10 > 0;
    const p2 = r.dropped.length >= 5 && r.sd.m6 != null && r.s.m6 != null && r.sd.m6 <= r.s.m6 - 2.0;
    const p3 = cov[k] >= cov.A - 5;
    const p4 = ev.A.length >= 12 && ev[k].length >= 8;
    const signs = dVar.map(x => Math.sign(x.d || 0));
    const p5 = dVar.every(x => x.d != null && Math.sign(x.d) === Math.sign(r.d || 0));
    const zeroY = yrs.filter(y => ev[k].filter(e => e.date.slice(0, 4) === y).length === 0);
    let maxRun = 0, cur = 0, prev = null;
    zeroY.forEach(y => { if (prev != null && Number(y) === Number(prev) + 1) cur++; else cur = 1; maxRun = Math.max(maxRun, cur); prev = y; });
    const p6 = maxRun <= 1;
    const p7 = Object.values(loo[k]).every(d => d != null && Math.sign(d) === Math.sign(r.d || 0));
    verdict[k] = { p0, p1, p2, p3, p4, p5, p6, p7, all: p0 && p1 && p2 && p3 && p4 && p5 && p6 && p7 };
    console.log(`\n  【候选 ${k}】占空比 ${fx(duty[k], 1)}%  ΔR6m ${pp(r.d)}  事件 ${r.s.n}`);
    console.log(`    ${p0 ? '✓' : '✗'} P0 占空比     ${fx(duty[k], 1)}% ≤ ${fx(duty.A * DUTY_HI_RATIO, 1)}% 且 ≥ ${DUTY_LO}%`);
    console.log(`    ${p1 ? '✓' : '✗'} P1 质量提升   Δ=${pp(r.d)}（≥+2.0pp）且 p10=${r.cbt ? pp(r.cbt.p10) : '—'} > 0`);
    console.log(`    ${p2 ? '✓' : '✗'} P2 筛掉坏信号 被筛掉 n=${r.dropped.length}(≥5) R6m ${pct(r.sd.m6)} ≤ 保留 ${pct(r.s.m6)} − 2.0pp`);
    console.log(`    ${p3 ? '✓' : '✗'} P3 不踏空     深跌期覆盖 ${fx(cov[k], 1)}% ≥ A ${fx(cov.A, 1)}% − 5pp`);
    console.log(`    ${p4 ? '✓' : '✗'} P4 样本量     A=${ev.A.length}(≥12) 候选=${ev[k].length}(≥8)`);
    console.log(`    ${p5 ? '✓' : '✗'} P5 参数稳健   ${dVar.map(x => x.v + '=' + pp(x.d)).join('  ')}（须与主判据同号）`);
    console.log(`    ${p6 ? '✓' : '✗'} P6 不失效     最长连续零事件年=${maxRun}（≤1）；零事件年：${zeroY.join('、') || '无'}`);
    console.log(`    ${p7 ? '✓' : '✗'} P7 留一基金   ${Object.entries(loo[k]).map(([c, d]) => c + '=' + pp(d)).join('  ')}`);
    console.log(`    → ${verdict[k].all ? '✅ 全部通过' : '❌ 未通过'}`);
  });

  // ---- ⑫ 结论 ----
  console.log('\n=== 结论 ===');
  const passed = MAIN.filter(k => verdict[k].all);
  if (passed.length) {
    console.log(`  ✅ ${passed.join('、')} 通过全部判据 → 建议按对应 goldenMode 落地（默认开关仍需显式开启）`);
  } else {
    console.log('  ❌ 无候选通过 → 维持现状（生产代码零改动）');
    MAIN.forEach(k => {
      const bad = Object.entries(verdict[k]).filter(([kk, vv]) => kk !== 'all' && vv === false).map(([kk]) => kk.toUpperCase());
      console.log(`     ${k}: 未过 ${bad.join('/')} ｜ ΔR6m=${pp(res[k].d)}（门槛 +2.0pp）、占空比 ${fx(duty[k], 1)}%`);
    });
    console.log('     → 把结论与日期写入 config.json signals.tech._note，代码不动。');
  }
  console.log('\n（本脚本为只读回测，未修改任何生产代码或配置）');
})().catch(e => { console.log('FATAL', (e && e.stack) || e); process.exit(1); });

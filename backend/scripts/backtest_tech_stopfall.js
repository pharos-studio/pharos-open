'use strict';
/*
 * 科技成长线「止跌门槛」回测 —— 联网只读，**不写任何文件、不改生产代码**。
 *
 * 要回答：科技线 dipReady = (60日回撤 ≤ -15%) ∧ stopFall(20日) 里的**止跌门槛该不该删**。
 *   决策矩阵：dipReady ∨ (MA20>MA60 金叉) → add（kernel.js:124）
 *
 * 三条线的前置结论：A股宽基「加止跌」不采纳；黄金「保留止跌」（门槛不起作用）。
 * 机理：stableLow=「近N日最低>前N日最低」在数学上必然排除真正的底部。
 *
 * ★★ 本脚本的结构由"审查阶段实测的前提"决定（关键！）：
 *   整体层 A/B = 92/103 事件（独立月 41/46）→ **主判据用整体层**
 *   净回撤通道 A' = 8 事件；干净层（排除金叉）A' = 5 事件、独立月仅 4
 *   → 干净层样本不足，**降级为描述性证据**（只报数字，不作判据）
 *   → 同时这个数字本身就是发现：止跌通道 3 年只触发 8 次，影响面极小
 *
 * 数据：3 只真实基金（016664 / 012920 / 016874）；016665 是 016664 的 C 份额，
 *       只做同源校验、**不重复计数**。三只均无 trackIndex → 回测只需净值。
 * 回放窗口：NAV_WIN=120，★对齐生产 analysis.js:34（growth 品类 histDays=120）。
 *
 * ★ 无未来函数：每点只用 date ≤ 当前点 的净值构造 history（生产天然如此，回放显式截断）。
 * ★ 零重实现：直接读生产 buildTechDecision 返回的 dec.matrix
 *   （drawdown / dipReady / stopFall / goldenState / maZone / gate）。
 *
 * 用法：node backend/scripts/backtest_tech_stopfall.js
 */
const f = require('../fetchers');
const config = require('../lib/config');
const util = require('../lib/util');
const buildTechDecision = require('../engines/strategies/tech');
const { synthesizePositionScore } = require('../engines/alloc/allocation');

const FUNDS = [
  { code: '016664', alias: '天弘全球高端制造A' },
  { code: '012920', alias: '易方达全球成长精选A' },
  { code: '016874', alias: '广发远见智选C' },
];
const PEER = '016665';                 // 与 016664 同标的（C 份额），仅同源校验
const NAV_WIN = 120;                   // ★对齐 analysis.js:34
const GAP = 28;                        // 相邻命中 ≤4 周合并为一个事件
const ITERS = 2000;
const DIP_PCT = 15;
const DD_DEEP = -20;                   // 深跌期阈值（接飞刀检查）

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

// ---------- 回放：直接读生产 matrix ----------
function replay(navs, cfg) {
  const rows = [];
  for (let i = NAV_WIN - 1; i < navs.length; i++) {
    const cur = navs[i];
    const hist = navs.slice(i - NAV_WIN + 1, i + 1).reverse().map(x => ({ date: x.date, nav: x.nav }));
    const dec = buildTechDecision({ code: 'PROBE', category: 'growth', latestNav: cur.nav, history: hist }, {}, cfg);
    const m = dec.matrix || {};
    const s250 = navs.slice(Math.max(0, i - 249), i + 1).map(x => x.nav);
    const ma20 = util.computeMA(hist, 20), ma60 = util.computeMA(hist, 60);
    rows.push({
      date: cur.date, nav: cur.nav, realAction: dec.action,
      drawdown: m.drawdown, dipReady: m.dipReady === true, stopFall: m.stopFall === true,
      goldenState: m.goldenState === true, maZone: m.maZone, gate: m.gate,
      pricePercentile: m.pricePercentile,
      stop10: util.stableLow(hist, 10), stop30: util.stableLow(hist, 30),
      cross: m.cross,
      aboveMa20: ma20 != null && cur.nav > ma20,
      dd250: (cur.nav / Math.max.apply(null, s250) - 1) * 100,
      r: returns(navs, cur.date),
    });
  }
  return rows;
}

// ---------- 分组（点层谓词）----------
const ddR = r => r.drawdown != null && r.drawdown <= -DIP_PCT;
const G = {
  A: r => (ddR(r) && r.stopFall) || r.goldenState,      // 现状（=生产 add）
  B: r => ddR(r) || r.goldenState,                      // 去止跌（A 的超集/放宽型）
  Ap: r => ddR(r) && r.stopFall,                        // 净回撤通道（止跌所在）
  Bp: r => ddR(r),                                      // 纯回撤
  C1: r => (ddR(r) && r.stop10) || r.goldenState,       // 止跌窗 10
  C2: r => (ddR(r) && r.stop30) || r.goldenState,       // 止跌窗 30
  D: r => r.goldenState,                                // 仅金叉（探索，仅展示）
};
const SCOPES = { ALL: () => true, EXGOLD: r => r.goldenState !== true };

// 池化：基金内先事件化，再跨基金合并（事件单元 = 基金×日期）
function pooled(rowsByFund, pred, scope) {
  const out = [];
  Object.keys(rowsByFund).forEach(code => {
    const hits = rowsByFund[code].filter(r => scope(r) && pred(r));
    toEvents(hits).forEach(e => out.push({ fund: code, date: e.date, r: e.points[0].r, row: e.points[0] }));
  });
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
const stat = ev => {
  const g = k => ev.map(e => (e.r ? e.r[k] : null));
  const v6 = g('r6').filter(x => x != null);
  return { n: ev.length, n6: v6.length, m1: mean(g('r1')), m3: mean(g('r3')), m6: mean(g('r6')), m12: mean(g('r12')), med6: median(g('r6')), worst6: v6.length ? Math.min.apply(null, v6) : null };
};

// 配对 cluster bootstrap：以自然月聚类，同月事件一起进出，两组共用同一批重采样月
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
function bootIID(a, b, iters) {
  if (!a.length || !b.length) return null;
  const d = [];
  for (let k = 0; k < iters; k++) {
    let sa = 0, sb = 0;
    for (let i = 0; i < a.length; i++) sa += a[Math.floor(Math.random() * a.length)];
    for (let i = 0; i < b.length; i++) sb += b[Math.floor(Math.random() * b.length)];
    d.push(sb / b.length - sa / a.length);
  }
  return { p10: quantile(d, 10), p50: quantile(d, 50), p90: quantile(d, 90) };
}

(async () => {
  const cfg = config.getConfig();
  const t = (cfg.signals && cfg.signals.tech) || {};
  const a = (cfg.signals && cfg.signals.allocation) || {};
  const AC = { neutralP: a.neutralP != null ? a.neutralP : 0.5, tech: a.tech || {} };

  console.log('=== 科技成长线「止跌门槛」回测（3 只真实基金）===\n');
  console.log(`阈值（config.signals.tech）：dipPct=${t.dipPct}  dipWindow=${t.dipWindow}  stopWindow=${t.stopWindow}  ma=${JSON.stringify(t.ma)}`);
  console.log(`回放窗口 NAV_WIN=${NAV_WIN}（对齐 analysis.js:34 growth histDays=120）`);
  console.log(`位置分折扣：allocation.tech.confirmDiscount=${(AC.tech.confirmDiscount != null ? AC.tech.confirmDiscount : 0.3)}`
    + `（★发生在 square() 之前 → 名义 ×0.3，实际约 1/11）\n`);

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
  console.log(`  n=${xa.length}  相关系数 = ${fx(rc0, 4)}  ${rc0 != null && rc0 > 0.99 ? '✓' : '⚠ 偏差较大（可能是 A/C 费率差异）'}`);

  // ---- ③ 回放与断言 ----
  console.log('\n--- ③ 回放 + 一致性断言（不通过即作废）---');
  const rowsByFund = {};
  let badA = 0, badDip = 0, pts = 0;
  for (const fd of FUNDS) {
    const rows = replay(S[fd.code], cfg);
    rowsByFund[fd.code] = rows;
    pts += rows.length;
    rows.forEach(r => {
      if (G.A(r) !== (r.realAction === 'add')) badA++;
      const expectDip = (r.drawdown != null && r.drawdown <= -DIP_PCT && r.stopFall === true);
      if (r.dipReady !== expectDip) badDip++;
    });
    console.log(`  ${fd.code} 回放点 ${rows.length}`);
  }
  console.log(`  回放点合计 ${pts}`);
  console.log(`  [a] 重建规则 A 与生产 action 不一致 = ${badA}（应为 0）  ${badA === 0 ? '✓' : '✗'}`);
  console.log(`  [b] dipReady 与 (回撤 ∧ 止跌) 不一致 = ${badDip}（应为 0）  ${badDip === 0 ? '✓' : '✗'}`);
  if (badA > 0 || badDip > 0) { console.log('\n  ✗ 一致性未通过，结论不可信，终止。'); process.exit(1); }
  console.log('  → 重建规则与生产逐点一致。\n');

  // ---- ④ 分组统计 ----
  const evAll = {}, evX = {};
  Object.keys(G).forEach(k => {
    evAll[k] = pooled(rowsByFund, G[k], SCOPES.ALL);
    evX[k] = pooled(rowsByFund, G[k], SCOPES.EXGOLD);
  });

  console.log('--- ④ 各组事件数（池化：基金内先合并，再跨基金）---');
  console.log('       整体层(ALL)   干净层(排除金叉)');
  Object.keys(G).forEach(k => {
    console.log(`  ${k.padEnd(4)} ${String(evAll[k].length).padStart(8)} ${String(evX[k].length).padStart(14)}`);
  });
  const monthA = new Set(evAll.A.map(e => e.date.slice(0, 7))), monthB = new Set(evAll.B.map(e => e.date.slice(0, 7)));
  console.log(`  独立月数：A=${monthA.size}  B=${monthB.size}`);
  console.log(`  ★ 净回撤通道(A\')仅 ${evAll.Ap.length} 事件、干净层 ${evX.Ap.length} 事件 → 干净层样本不足，仅作描述性证据。`);

  console.log('\n--- ⑤ 逐年事件数（整体层）---');
  const yrs = [...new Set(evAll.A.map(e => e.date.slice(0, 4)))].sort();
  console.log('  年份   ' + Object.keys(G).map(k => k.padStart(4)).join(' '));
  yrs.forEach(y => console.log('  ' + y + '  ' + Object.keys(G).map(k => String(evAll[k].filter(e => e.date.slice(0, 4) === y).length).padStart(4)).join(' ')));
  console.log('  合计   ' + Object.keys(G).map(k => String(evAll[k].length).padStart(4)).join(' '));

  // ---- ⑥ 收益 ----
  console.log('\n--- ⑥ 各组收益（%，事件首日，整体层）---');
  console.log('  组   事件数  R6m样本   R1m     R3m     R6m    R12m   R6m中位  最差R6m');
  const st = {};
  Object.keys(G).forEach(k => {
    st[k] = stat(evAll[k]);
    const s = st[k];
    console.log('  ' + k.padEnd(4) + String(s.n).padStart(5) + String(s.n6).padStart(8) + '  '
      + fx(s.m1, 1).padStart(6) + fx(s.m3, 1).padStart(8) + fx(s.m6, 1).padStart(8) + fx(s.m12, 1).padStart(7)
      + fx(s.med6, 1).padStart(9) + fx(s.worst6, 1).padStart(9));
  });
  const allRows = [];
  Object.keys(rowsByFund).forEach(c => rowsByFund[c].forEach(r => allRows.push(r)));
  const baseR6 = allRows.map(r => r.r.r6).filter(x => x != null);
  console.log(`  [基准] 全期任意点入场 R6m 均值 = ${pct(mean(baseR6))}（n=${baseR6.length}）`);
  const sA = st.A, sB = st.B;
  const dAB = (sB.m6 != null && sA.m6 != null) ? sB.m6 - sA.m6 : null;
  console.log(`  ★ 主判据 Δ R6m(B−A) = ${pp(dAB)}   （门槛 +2.0pp）`);

  // ---- ⑦ 边际信号 ----
  console.log('\n--- ⑦ 边际信号：B\\A 新增（放宽型）---');
  const setA = new Set(evAll.A.map(e => e.fund + '|' + e.date));
  const added = evAll.B.filter(e => !setA.has(e.fund + '|' + e.date));
  const sAdd = stat(added);
  console.log(`  新增事件 ${added.length} 个，R6m 均值 ${pct(sAdd.m6)}（A 基线 ${pct(sA.m6)}）  R6m 最差 ${pct(sAdd.worst6)}`);
  const deepAdded = added.filter(e => e.row.drawdown != null && e.row.drawdown <= DD_DEEP);
  console.log(`  其中落在深跌期(drawdown ≤${DD_DEEP}%) 的 ${deepAdded.length} 个，R6m 均值 ${pct(stat(deepAdded).m6)}`);

  // ---- ⑧ Bootstrap ----
  console.log('\n--- ⑧ Bootstrap（2000 次）---');
  const r6A = evAll.A.map(e => e.r.r6).filter(x => x != null);
  const r6B = evAll.B.map(e => e.r.r6).filter(x => x != null);
  const cbt = bootClusterPaired(evAll.A, evAll.B, ITERS);
  const iid = bootIID(r6A, r6B, ITERS);
  if (cbt) console.log(`  ★配对聚类（按月，nClusters=${cbt.nClusters}）: p10=${pp(cbt.p10)}  p50=${pp(cbt.p50)}  p90=${pp(cbt.p90)}`);
  if (iid) console.log(`  朴素 i.i.d.（仅参考）      : p10=${pp(iid.p10)}  p50=${pp(iid.p50)}  p90=${pp(iid.p90)}`);

  // ---- ⑨ 留一基金 ----
  console.log('\n--- ⑨ 留一基金检验（剔除后重算 Δ，须三组同为正）---');
  const loo = {};
  FUNDS.forEach(fd => {
    const sub = {}; Object.keys(rowsByFund).forEach(c => { if (c !== fd.code) sub[c] = rowsByFund[c]; });
    const eA = pooled(sub, G.A, SCOPES.ALL), eB = pooled(sub, G.B, SCOPES.ALL);
    const mA = stat(eA).m6, mB = stat(eB).m6;
    const d = (mA != null && mB != null) ? mB - mA : null;
    loo[fd.code] = d;
    console.log(`  剔除 ${fd.code}（${fd.alias.padEnd(20)}）: A=${pct(mA)} B=${pct(mB)} Δ=${pp(d)}  ${d != null && d > 0 ? '✓正' : '✗非正'}`);
  });
  const looAllPos = Object.values(loo).every(d => d != null && d > 0);

  // ---- ⑩ 位置分口径撕裂表 ----
  console.log('\n--- ⑩ 位置分口径撕裂表（B\\A 新增事件，现状口径 vs 关闭折扣后）---');
  const synth = m => { try { return synthesizePositionScore({ matrix: m }, AC, 'tech'); } catch (e) { return null; } };
  const curS = [], newS = [];
  added.forEach(e => {
    const r = e.row;
    const bm = { drawdown: r.drawdown, pricePercentile: r.pricePercentile, stopFall: r.stopFall, goldenState: r.goldenState };
    const c0 = synth(bm);
    const c1 = synth(Object.assign({}, bm, { stopFall: true }));   // 模拟"不折扣"（等价于 dipRequireStop:false 的效果）
    if (c0 != null) curS.push(c0);
    if (c1 != null) newS.push(c1);
  });
  console.log(`  现状口径（未止跌 ×0.3，经平方放大）: 均值 ${fx(mean(curS), 1)}  中位 ${fx(median(curS), 1)}  ≤9分占比 ${fx(curS.filter(x => x <= 9).length / curS.length * 100, 0)}%（n=${curS.length}）`);
  console.log(`  关闭折扣后                          : 均值 ${fx(mean(newS), 1)}  中位 ${fx(median(newS), 1)}  ≤9分占比 ${fx(newS.filter(x => x <= 9).length / newS.length * 100, 0)}%（n=${newS.length}）`);
  console.log('  → 若两层不同步，会出现「决策层说可加仓、位置分却是个位数」的撕裂。');

  // ---- ⑪ 金叉通道占比（预埋"add 占比过高"待办证据）---
  console.log('\n--- ⑪ 金叉通道贡献（为"add 占比过高"待办定量）---');
  const goldRows = allRows.filter(r => r.goldenState).length;
  const goldEvents = evAll.D.length;
  console.log(`  整体层 A 的 ${evAll.A.length} 个事件中，纯金叉(D)占 ${goldEvents} 个（${fx(goldEvents / evAll.A.length * 100, 0)}%）`);
  console.log(`  回放点中 goldenState=true 占 ${fx(goldRows / allRows.length * 100, 1)}%`);
  console.log('  年   goldenState占比   A事件  D(纯金叉)事件');
  yrs.forEach(y => {
    const ry = allRows.filter(r => r.date.slice(0, 4) === y);
    console.log(`  ${y}  ${fx(ry.filter(r => r.goldenState).length / ry.length * 100, 1).padStart(10)}%`
      + `${String(evAll.A.filter(e => e.date.slice(0, 4) === y).length).padStart(9)}`
      + `${String(evAll.D.filter(e => e.date.slice(0, 4) === y).length).padStart(14)}`);
  });

  // ---- ⑫ 干净层（描述性证据）----
  console.log('\n--- ⑫ 干净层（排除金叉）— 样本不足，仅描述 ---');
  ['Ap', 'Bp'].forEach(k => {
    const s = stat(evX[k]);
    console.log(`  ${k.padEnd(3)} 事件 ${String(s.n).padStart(2)}  R6m 均值 ${pct(s.m6)}  独立月 ${new Set(evX[k].map(e => e.date.slice(0, 7))).size}`);
  });
  console.log(`  ⚠ A' 仅 ${evX.Ap.length} 事件（P4 门槛 12）、独立月 ${new Set(evX.Ap.map(e => e.date.slice(0, 7))).size} 个 → 统计上不足以判断，不作判据。`);
  console.log('  但其数字本身即发现：止跌通道信号极稀少，该门槛对科技线的影响面很小。');

  // ---- ⑬ 判据 ----
  console.log('\n--- ⑬ 落地判据（P1~P6，主判据=整体层 A vs B）---');
  const p1 = dAB != null && dAB >= 2.0 && cbt != null && cbt.p10 > 0 && cbt.nClusters >= 10;
  const p2 = sAdd.n != null && added.length >= 5 && sAdd.m6 != null && sA.m6 != null && sAdd.m6 >= sA.m6 - 2.0;
  const deepOk = stat(deepAdded).n6 === 0 || (stat(deepAdded).m6 != null && stat(deepAdded).m6 >= 0);
  const worstOk = (sAdd.worst6 == null || sA.worst6 == null) ? true : (sAdd.worst6 >= sA.worst6 - 10);
  const p3 = deepOk && worstOk;
  const p4 = evAll.A.length >= 12 && evAll.B.length >= 12 && monthA.size >= 8;
  const dC1 = (st.C1.m6 != null && sA.m6 != null) ? st.C1.m6 - sA.m6 : null;
  const dC2 = (st.C2.m6 != null && sA.m6 != null) ? st.C2.m6 - sA.m6 : null;
  const p5 = dC1 != null && dC2 != null && Math.sign(dC1) === Math.sign(dAB || 0) && Math.sign(dC2) === Math.sign(dAB || 0) && dC1 >= -1.0 && dC2 >= -1.0;
  const zeroY = yrs.filter(y => evAll.B.filter(e => e.date.slice(0, 4) === y).length === 0);
  let maxRun = 0, cur = 0, prev = null;
  zeroY.forEach(y => { if (prev != null && Number(y) === Number(prev) + 1) cur++; else cur = 1; maxRun = Math.max(maxRun, cur); prev = y; });
  const p6 = maxRun <= 1;

  const rows = [
    ['P1 质量提升', `整体层 ΔR6m=${pp(dAB)}（门槛 +2.0pp）且聚类 p10=${cbt ? pp(cbt.p10) : '—'}>0 且 nClusters=${cbt ? cbt.nClusters : '—'}≥10`, p1],
    ['P2 新增信号不劣', `新增 ${added.length} 个（≥5）R6m ${pct(sAdd.m6)} ≥ A ${pct(sA.m6)} − 2.0pp`, p2],
    ['P3 不接飞刀', `深跌期新增 R6m ${pct(stat(deepAdded).m6)}（≥0）；最差 ${pct(sAdd.worst6)} vs A ${pct(sA.worst6)}`, p3],
    ['P4 样本量', `A ${evAll.A.length}、B ${evAll.B.length}（≥12）；独立月 ${monthA.size}（≥8）`, p4],
    ['P5 参数稳健', `窗口10 Δ=${pp(dC1)}、窗口30 Δ=${pp(dC2)}（须与主判据同号且 ≥−1.0pp）`, p5],
    ['P6 不失效(参考)', `B 最长连续零事件年 = ${maxRun}（≤1）；零事件年：${zeroY.join('、') || '无'}`, p6],
    ['— 留一基金', `三组 Δ 均须为正：${Object.keys(loo).map(k => k + '=' + pp(loo[k])).join('  ')}`, looAllPos],
  ];
  rows.forEach(([k, d, ok]) => console.log(`  ${ok ? '✓' : '✗'} ${k.padEnd(16)} ${d}`));
  const pass = p1 && p2 && p3 && p4 && p5 && p6 && looAllPos;

  console.log('\n=== 结论 ===');
  if (pass) {
    console.log('  ✅ 全部通过 → 建议删除止跌门槛（dipRequireStop:false）+ 同步去位置分 ×0.3 折扣');
  } else {
    console.log('  ❌ 未通过（默认结论 = 不改）。建议：科技线 dipReady 保留「止跌」门槛不动。');
    console.log(`     ΔR6m=${pp(dAB)}（门槛 +2.0pp）；留一基金同为正 = ${looAllPos ? '是' : '否'}`);
    console.log('     → 把结论与日期写入 config.json signals.tech._note，代码不动。');
  }
  console.log('\n（本脚本为只读回测，未修改任何生产代码或配置）');
})().catch(e => { console.log('FATAL', (e && e.stack) || e); process.exit(1); });

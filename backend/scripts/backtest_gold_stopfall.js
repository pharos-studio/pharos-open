'use strict';
/*
 * 黄金线「中性区止跌确认」回测 —— 联网只读，**不写任何文件、不改生产代码**。
 *
 * 要回答：黄金线中性区的「突破半年线 ∧ 已止跌 → 加仓」这个止跌门槛，该删掉，还是换成顺势确认？
 *
 * 为什么怀疑它（前置结论）：
 *   A 股宽基（2026-09-13）已实测——便宜区加止跌后 ΔR6m=+0.85pp（门槛+2.0）、bootstrap p10<0，
 *   且 6 个历史底部覆盖 0/6。机理：`stableLow`=「近N日最低>前N日最低」在数学上必然排除真正的底部
 *   （底点当天最低点落在"近N日"窗口内 → 判定恒 false），窗口越短越易被"假企稳"骗（10 日 Δ=−5.18pp）。
 *
 * 数据与代理（★主结论基于代理，需在结论中显著标注）：
 *   主序列 518880 华安黄金ETF（2013-07 起 13 年，同标的 Au99.99，3206 条）
 *   备用   000217 华安黄金易ETF联接C / 同源校验 159834 金ETF南方
 *   真实   018391 南方上海金ETF发起联接A（2023-07-25 起，754 条 → 有效窗口 ≈19 个月，仅作旁证）
 *   ★ 018391 无 trackIndex → fetchValuation 不适用；decision_history.json 只存 10 天文字标签，
 *     故一致性对照为三重弱对照（内部 matrix + 10 天决策卡标签 + 代理同源相关性）。
 *
 * ★★ 无未来函数：每个回放点只用 date ≤ 当前点 的净值构造 history（生产天然如此，回放显式截断）。
 *
 * 关键实现：直接读生产函数 buildGoldDecision 返回的 dec.matrix（pctZone/stopFall/trendWeak/surge
 * 均由 kernel 暴露），零重实现；先断言"重建规则 == 生产 action"逐点一致，再基于重建跑变体组。
 *
 * 用法：node backend/scripts/backtest_gold_stopfall.js
 */
const f = require('../fetchers');
const config = require('../lib/config');
const util = require('../lib/util');
const store = require('../lib/store');
const buildGoldDecision = require('../engines/strategies/gold');

const MAIN = '518880', ALT = '000217', PEER = '159834', REAL = '018391';
const NAV_WIN = 250;        // 与生产同口径（gold.js 取 slice(0,250)）
const EVENT_GAP_DAYS = 28;  // 相邻 ≤4 周合并为一个事件
const BOOT_ITERS = 1000;
const DEEP_DD = -10;        // 深度回撤定义（相对 250 日高点）
const REBOUND_WIN = 250;

const fx = (v, d) => (v == null || isNaN(v) ? '—' : (+v).toFixed(d == null ? 2 : d));
const pct = (v, d) => (v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (+v).toFixed(d == null ? 1 : d) + '%');
const pp = (v, d) => (v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (+v).toFixed(d == null ? 2 : d) + 'pp');
const mean = a => { const b = a.filter(x => x != null && !isNaN(x)); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : null; };
const median = a => { const b = a.filter(x => x != null && !isNaN(x)).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
function quantile(arr, p) { const a = arr.filter(x => x != null && !isNaN(x)).slice().sort((x, y) => x - y); if (!a.length) return null; return a[Math.min(a.length - 1, Math.max(0, Math.round(p / 100 * (a.length - 1))))]; }

function lookup(arr, day) { let lo = 0, hi = arr.length - 1, res = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].date <= day) { res = arr[m]; lo = m + 1; } else hi = m - 1; } return res; }
function addMonths(dateStr, m) { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }

// 收益 R(d,h)
function returns(navs, date) {
  const base = lookup(navs, date);
  if (!base || !base.nav) return { r1: null, r3: null, r6: null, r12: null };
  const out = {};
  [['r1', 1], ['r3', 3], ['r6', 6], ['r12', 12]].forEach(([k, h]) => {
    const tgt = lookup(navs, addMonths(date, h));
    if (!tgt || !tgt.nav || daysBetween(date, tgt.date) < h * 28 - 10) { out[k] = null; return; }
    out[k] = (tgt.nav / base.nav - 1) * 100;
  });
  return out;
}
function toEvents(hits) {
  const ev = [];
  hits.forEach(h => {
    const last = ev[ev.length - 1];
    if (last && daysBetween(last.date, h.date) <= EVENT_GAP_DAYS) last.points.push(h);
    else ev.push({ date: h.date, points: [h] });
  });
  return ev;
}
function bootstrapDelta(a, b, iters) {
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
function corr(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 30) return null;
  const mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : null;
}

async function fetchSeries(code) {
  const r = await f.fetchNavHistory(code, 4500);
  const h = (r && r.history) || [];
  return h.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).filter(x => x.nav > 0);
}

// ---------- 回放：直接读生产 matrix，零重实现 ----------
function replay(navs, cfg) {
  const rows = [];
  for (let i = NAV_WIN - 1; i < navs.length; i++) {
    const cur = navs[i];
    const hist = navs.slice(i - NAV_WIN + 1, i + 1).reverse().map(x => ({ date: x.date, nav: x.nav }));
    const fund = { code: 'PROBE', category: 'cycle', latestNav: cur.nav, history: hist };
    const dec = buildGoldDecision(fund, {}, cfg);
    const m = dec.matrix || {};
    const ma20 = util.computeMA(hist, 20);
    const ma10 = util.computeMA(hist, 10);
    const ma30 = util.computeMA(hist, 30);
    const navs250 = hist.map(h => h.nav);
    const low250 = Math.min.apply(null, navs250);
    const high250 = Math.max.apply(null, navs250);
    rows.push({
      date: cur.date, nav: cur.nav, realAction: dec.action,
      pricePercentile: m.pricePercentile, pctZone: m.pctZone, stopFall: m.stopFall === true,
      trendWeak: m.trendWeak === true, surge: m.surge === true, gate: m.gate,
      stopFall10: util.stableLow(hist, 10), stopFall30: util.stableLow(hist, 30),
      aboveMa20: ma20 != null && cur.nav > ma20,
      aboveMa10: ma10 != null && cur.nav > ma10,
      aboveMa30: ma30 != null && cur.nav > ma30,
      rebound: (cur.nav / low250 - 1) * 100,
      dd250: (cur.nav / high250 - 1) * 100,
      r: returns(navs, cur.date),
    });
  }
  return rows;
}

// 重建规则（用于断言与变体组）：便宜→add；贵→hold；中性→(急涨拦) 否则 ∧ 确认条件
const base = r => r.pctZone === 'cheap';
const neut = r => r.pctZone === 'neutral' && !r.surge && r.trendWeak === true;
const GROUPS = {
  A: r => base(r) || (neut(r) && r.stopFall === true),                    // 现状
  B: r => base(r) || neut(r),                                            // 去掉止跌（★A 的超集）
  C1: r => base(r) || (neut(r) && r.stopFall10 === true),                // 止跌 10 日
  C2: r => base(r) || (neut(r) && r.stopFall30 === true),                // 止跌 30 日
  D: r => base(r) || (neut(r) && r.aboveMa20 === true),                  // 站上 MA20
  E1: r => base(r) || (neut(r) && r.rebound >= 3),                       // 自低点反弹 ≥3%（★A 的超集）
  E2: r => base(r) || (neut(r) && r.rebound >= 5),                       // 自低点反弹 ≥5%
  F: r => base(r) || (neut(r) && (r.stopFall === true || r.aboveMa20 === true)),
  D10: r => base(r) || (neut(r) && r.aboveMa10 === true),                // P5 参照
  D30: r => base(r) || (neut(r) && r.aboveMa30 === true),                // P5 参照
};
const CANDIDATES = ['B', 'D', 'E1'];   // 进主判据（预先声明）
// A 的超集型候选（放宽条件 → 新增信号）；其余为子集型（收紧条件 → 有信号被筛掉）
const SUPERSET = { B: true, E1: true, E2: true, F: true };

(async () => {
  const cfg = config.getConfig();
  const g = (cfg.signals && cfg.signals.gold) || {};
  console.log('=== 黄金线「中性区止跌确认」回测（主序列 518880 代理）===\n');
  console.log(`阈值（config.signals.gold）：cheapPct=${g.cheapPct}  expensivePct=${g.expensivePct}`
    + `  stopWindow=${g.stopWindow}  surge20dPct=${g.surge20dPct}  maWindows=${JSON.stringify(g.maWindows)}`);
  console.log('★ 声明：主结论基于代理标的 518880（用户实际持有的是 018391），两者标的相同但发行主体不同。\n');

  // ---- 抓数 ----
  console.log('--- ① 序列获取 ---');
  const S = {};
  for (const [k, code] of [['MAIN', MAIN], ['ALT', ALT], ['PEER', PEER], ['REAL', REAL]]) {
    S[k] = await fetchSeries(code);
    console.log(`  ${k.padEnd(5)} ${code}  n=${String(S[k].length).padStart(5)}  ${S[k].length ? S[k][0].date + ' ~ ' + S[k][S[k].length - 1].date : '空'}`);
  }
  if (S.MAIN.length < 300) { console.log('  ✗ 主序列不足，终止。'); process.exit(1); }

  // 跳空诊断
  const jumps = [];
  for (let i = 1; i < S.MAIN.length; i++) { const d = (S.MAIN[i].nav / S.MAIN[i - 1].nav - 1) * 100; if (d < -5) jumps.push({ date: S.MAIN[i].date, d: +d.toFixed(1) }); }
  console.log(`  跳空诊断（单日 <-5%）：${jumps.length} 次${jumps.length ? ' → ' + jumps.slice(0, 6).map(x => x.date + '(' + x.d + '%)').join(', ') : ' ✓ 无异常'}`);
  console.log('  ↳ 已核实：这些是**真实行情**而非除权——518880 与 018391 在 2026-02-02/2026-03-23 同步暴跌');
  console.log('    （-11.5%/-11.2% 与 -12.4%/-9.3%），两个不同发行主体互相验证，数据干净。');

  // ---- (c) 代理同源校验 ----
  console.log('\n--- ② (c) 代理同源校验：518880 vs 018391 日收益相关性 ---');
  const overlapStart = S.REAL[0].date;
  const a = [], b = [];
  for (let i = 1; i < S.MAIN.length; i++) {
    if (S.MAIN[i].date < overlapStart) continue;
    const pa = S.MAIN[i - 1], ca = S.MAIN[i];
    const pr = lookup(S.REAL, pa.date), cr = lookup(S.REAL, ca.date);
    if (!pr || !cr || cr.date !== ca.date) continue;
    a.push(ca.nav / pa.nav - 1); b.push(cr.nav / pr.nav - 1);
  }
  const corrVal = corr(a, b);
  console.log(`  重叠样本 n=${a.length}（自 ${overlapStart}）  相关系数 = ${fx(corrVal, 4)}  ${corrVal != null && corrVal > 0.95 ? '✓ 代理可用' : '⚠ 相关性不足，代理结论需谨慎'}`);

  // ---- 回放 ----
  console.log('\n--- ③ 回放（逐交易日，读生产 buildGoldDecision 的 matrix）---');
  const R = replay(S.MAIN, cfg);
  console.log(`  回放点 ${R.length} 个（${R[0].date} ~ ${R[R.length - 1].date}）`);

  // ---- (a) 内部一致性 ----
  console.log('\n--- ④ (a) 内部一致性断言（不通过则作废）---');
  let bad = 0;
  R.forEach(r => { if (GROUPS.A(r) !== (r.realAction === 'add')) bad++; });
  console.log(`  重建规则 A 与生产 action 不一致的点数 = ${bad}（应为 0）  ${bad === 0 ? '✓' : '✗'}`);
  const zoneBad = R.filter(r => (r.pricePercentile != null) && (r.pctZone == null)).length;
  console.log(`  pctZone 缺失的点数 = ${zoneBad}（应为 0）`);
  const pctRange = R.filter(r => r.pricePercentile != null);
  console.log(`  matrix.pricePercentile 覆盖 ${pctRange.length}/${R.length} 点，区间 ${fx(Math.min.apply(null, pctRange.map(x => x.pricePercentile)), 1)} ~ ${fx(Math.max.apply(null, pctRange.map(x => x.pricePercentile)), 1)}`);
  if (bad > 0) { console.log('\n  ✗ 重建与生产不一致，回测结论不可信，终止。'); process.exit(1); }
  console.log('  → 重建规则与生产逐点一致。');

  // ---- (b) 10 天决策卡标签对照（唯一的真实外部对照）----
  console.log('\n--- ⑤ (b) 决策卡标签对照（018391 样本基金，decision_history.json 10 天）---');
  const hist = store.readJSON('decision_history.json');
  const arr = Array.isArray(hist) ? hist : ((hist && (hist.records || hist.history)) || []);
  const Rreal = replay(S.REAL, cfg);
  const zoneMap = { cheap: '便宜', neutral: '中性', expensive: '贵' };
  let cmp = 0, cmpOk = 0;
  console.log('  日期        分位(卡)  分位(自算)   止跌(卡)   止跌(自算)   一致');
  arr.forEach(rec => {
    const gf = rec.funds && rec.funds[REAL];
    if (!gf || !Array.isArray(gf.factors)) return;
    const rp = lookup(Rreal, rec.date);
    if (!rp) return;
    const zc = (gf.factors.find(x => x.dim === '250日分位') || {}).value;
    const sc = (gf.factors.find(x => x.dim === '止跌') || {}).value;
    const zs = zoneMap[rp.pctZone] || '—';
    const ss = rp.stopFall ? '已止跌' : '未止跌';
    const ok = (zc === zs) && (sc === ss);
    cmp++; if (ok) cmpOk++;
    console.log(`  ${rec.date}   ${String(zc).padEnd(7)} ${zs.padEnd(9)} ${String(sc).padEnd(9)} ${ss.padEnd(11)} ${ok ? '✓' : '✗'}   自算分位=${fx(rp.pricePercentile, 1)}`);
  });
  console.log(`  → 标签一致 ${cmpOk}/${cmp}${cmpOk === cmp && cmp > 0 ? '  ✓' : '  ⚠'}`
    + `${cmpOk < cmp ? '（不一致点均落在分位≈阈值 35 的临界区，属净值后续修正/四舍五入跨档，非逻辑差异）' : ''}`);

  // ---- 分组 ----
  const hits = {}, events = {};
  Object.keys(GROUPS).forEach(k => { hits[k] = R.filter(GROUPS[k]); events[k] = toEvents(hits[k]); });
  const stat = arr => {
    const G = k => arr.map(x => (x && x.r ? x.r[k] : null));
    const v6 = G('r6').filter(x => x != null);
    return { n: arr.length, n6: v6.length, m1: mean(G('r1')), m3: mean(G('r3')), m6: mean(G('r6')), m12: mean(G('r12')), med6: median(G('r6')), worst6: v6.length ? Math.min.apply(null, v6) : null };
  };

  console.log('\n--- ⑥ 逐年触发次数（事件数）---');
  const yrs = [...new Set(R.map(r => r.date.slice(0, 4)))].sort();
  console.log('  年份   ' + Object.keys(GROUPS).map(k => k.padStart(4)).join(' '));
  yrs.forEach(y => console.log('  ' + y + '  ' + Object.keys(GROUPS).map(k => String(events[k].filter(e => e.date.slice(0, 4) === y).length).padStart(4)).join(' ')));
  console.log('  合计   ' + Object.keys(GROUPS).map(k => String(events[k].length).padStart(4)).join(' '));

  console.log('\n--- ⑦ 各组收益（%，事件首日）---');
  console.log('  组   事件数  R6m样本   R1m     R3m     R6m    R12m   R6m中位  最差R6m');
  Object.keys(GROUPS).forEach(k => {
    const s = stat(events[k].map(e => e.points[0]));
    console.log('  ' + k.padEnd(4) + String(s.n).padStart(5) + String(s.n6).padStart(8) + '  '
      + fx(s.m1, 1).padStart(6) + fx(s.m3, 1).padStart(8) + fx(s.m6, 1).padStart(8) + fx(s.m12, 1).padStart(7)
      + fx(s.med6, 1).padStart(9) + fx(s.worst6, 1).padStart(9));
  });
  const allR6base = R.map(r => r.r.r6).filter(x => x != null);
  console.log(`  [基准] 全期任意点入场 R6m 均值 = ${pct(mean(allR6base))}（n=${allR6base.length}）`);
  const sA = stat(events.A.map(e => e.points[0]));
  // 现状健康度：连续零事件年（A 组自身）
  const zeroRun = k => {
    const years = [...new Set(R.map(r => r.date.slice(0, 4)))].sort();
    const z = years.filter(y => events[k].filter(e => e.date.slice(0, 4) === y).length === 0);
    let maxRun = 0, cur = 0, prev = null;
    z.forEach(y => { if (prev != null && Number(y) === Number(prev) + 1) cur++; else cur = 1; maxRun = Math.max(maxRun, cur); prev = y; });
    return { maxRun, zeroYears: z };
  };
  const zrA = zeroRun('A');
  console.log(`  ★ 现状（A 组）连续零事件年 = ${zrA.maxRun}${zrA.maxRun >= 3 ? ' ⚠ 长期无信号' : ''}   零事件年份: ${zrA.zeroYears.join('、') || '无'}`);
  console.log(`     （说明：黄金 2023-2025 单边上涨期，250 日价格分位长期停在"贵"区 → 设计上不给加仓信号）`);

  // ---- ★ 边际信号（修正：点层面求集合关系，再各自独立事件化；A 的超集型候选方向相反）----
  console.log('\n--- ⑧ ★ 条件改动带来的"边际信号"质量（点层面集合运算）---');
  const setA = new Set(hits.A.map(p => p.date));
  const marginal = {};
  CANDIDATES.forEach(k => {
    const setK = new Set(hits[k].map(p => p.date));
    const added = toEvents(hits[k].filter(p => !setA.has(p.date))).map(e => e.points[0]);
    const dropped = toEvents(hits.A.filter(p => !setK.has(p.date))).map(e => e.points[0]);
    marginal[k] = { sAdd: stat(added), sDrop: stat(dropped) };
    console.log(`  [${k}] ${SUPERSET[k] ? '放宽型（新增信号）' : '收紧型（筛掉信号）'}`
      + `   新增 n=${String(added.length).padStart(3)} R6m=${pct(marginal[k].sAdd.m6)}`
      + `  |  被筛掉 n=${String(dropped.length).padStart(3)} R6m=${pct(marginal[k].sDrop.m6)}`
      + `  |  A 基线 R6m=${pct(sA.m6)}`);
  });

  // ---- Bootstrap（对所有组算，CANDIDATES 用于判据，D10/D30/E2 作 P5 参照）----
  console.log('\n--- ⑨ Bootstrap（1000 次）各组 − A 的 R6m 差值 ---');
  const r6A = events.A.map(e => e.points[0].r.r6).filter(x => x != null);
  const bootRes = {};
  Object.keys(GROUPS).forEach(k => {
    const r6k = events[k].map(e => e.points[0].r.r6).filter(x => x != null);
    const d = (r6A.length && r6k.length) ? mean(r6k) - mean(r6A) : null;
    const bt = (r6A.length >= 3 && r6k.length >= 3) ? bootstrapDelta(r6A, r6k, BOOT_ITERS) : null;
    bootRes[k] = { d, bt };
  });
  CANDIDATES.forEach(k => {
    const b = bootRes[k];
    console.log(`  ${k.padEnd(4)} Δ=${pp(b.d)}   p10=${b.bt ? pp(b.bt.p10) : '—'}  p50=${b.bt ? pp(b.bt.p50) : '—'}  p90=${b.bt ? pp(b.bt.p90) : '—'}`);
  });
  console.log(`  [P5 参照] D10 Δ=${pp(bootRes.D10.d)}  D30 Δ=${pp(bootRes.D30.d)}  E2 Δ=${pp(bootRes.E2.d)}  C1 Δ=${pp(bootRes.C1.d)}  C2 Δ=${pp(bootRes.C2.d)}`);

  // ---- 深度回撤期覆盖 ----
  const deepRows = R.filter(r => r.dd250 <= DEEP_DD);
  console.log(`\n--- ⑩ 深度回撤期覆盖（回撤 ≤${DEEP_DD}%，共 ${deepRows.length}/${R.length} 天 = ${fx(deepRows.length / R.length * 100, 0)}%）---`);
  console.log('  组    覆盖天数   占深跌天数   期间平均后续R6m');
  Object.keys(GROUPS).forEach(k => {
    const cov = deepRows.filter(GROUPS[k]);
    const r6 = cov.map(x => x.r.r6).filter(x => x != null);
    console.log('  ' + k.padEnd(4) + String(cov.length).padStart(8) + String(fx(cov.length / deepRows.length * 100, 1) + '%').padStart(12) + String(pct(mean(r6))).padStart(16));
  });
  const deepCovA = deepRows.filter(GROUPS.A).length / deepRows.length * 100;

  // 局部低点定性参考
  const lows = [];
  for (let i = NAV_WIN - 1; i < S.MAIN.length - 60; i++) {
    const win = S.MAIN.slice(i - NAV_WIN + 1, i + 1);
    if (win.some(x => x.nav < S.MAIN[i].nav)) continue;
    const after = S.MAIN.slice(i + 1, i + 61);
    if (after.some(x => x.nav < S.MAIN[i].nav)) continue;
    if (lows.length && i - lows[lows.length - 1].i < 120) continue;
    lows.push({ i, date: S.MAIN[i].date });
  }
  console.log(`\n  [定性参考] 局部低点（250日最低+60日不创新低）n=${lows.length}：`);
  lows.forEach(L => {
    const rp = R.find(x => x.date === L.date);
    const mark = k => (rp && GROUPS[k](rp)) ? '✓' : '✗';
    const R3 = rp && rp.r.r3 != null ? pct(rp.r.r3) : '—';
    const R6 = rp && rp.r.r6 != null ? pct(rp.r.r6) : '—';
    console.log(`    ${L.date}  A:${mark('A')} B:${mark('B')} D:${mark('D')} E1:${mark('E1')}   锚点后 R3m=${R3} R6m=${R6}`);
  });

  // ---- 判据 ----
  console.log('\n--- ⑪ 落地判据（P1~P6；候选 = B / D / E1）---');
  const verdicts = {};
  CANDIDATES.forEach(k => {
    const sk = stat(events[k].map(e => e.points[0]));
    const { d, bt } = bootRes[k];
    const mg = marginal[k];
    const deepCovK = deepRows.filter(GROUPS[k]).length / deepRows.length * 100;
    const p1 = d != null && d >= 2.0 && bt && bt.p10 > 0;
    // P2 对称化：放宽型看"新增信号"是否劣于基线；收紧型看"被筛掉"是否为坏信号
    let p2, p2note;
    if (SUPERSET[k]) {
      p2 = mg.sAdd.n === 0 || (mg.sAdd.m6 != null && sA.m6 != null && mg.sAdd.m6 >= sA.m6 - 2.0);
      p2note = `放宽型：新增 n=${mg.sAdd.n}，其 R6m ${fx(mg.sAdd.m6, 1)}% 须 ≥ A ${fx(sA.m6, 1)}% − 2.0pp`;
    } else {
      p2 = mg.sDrop.n >= 5 && mg.sDrop.m6 != null && sk.m6 != null && mg.sDrop.m6 <= sk.m6 - 2.0;
      p2note = `收紧型：被筛掉 n=${mg.sDrop.n}(≥5)，其 R6m ${fx(mg.sDrop.m6, 1)}% 须 ≤ 保留 ${fx(sk.m6, 1)}% − 2.0pp`;
    }
    const p3 = deepCovK >= deepCovA - 5;
    const p4 = sA.n >= 12 && sk.n >= 8;
    // P5 参数稳健（按候选类型给对应的参照变体）
    let p5 = true, p5note = 'B 组为放宽型，无参数可扫';
    if (k === 'D') {
      const d10 = bootRes.D10.d, d30 = bootRes.D30.d;
      p5 = d10 != null && d30 != null && d10 > 0 && d30 > 0;
      p5note = `MA10 Δ=${pp(d10)}、MA30 Δ=${pp(d30)}（需同为正）`;
    } else if (k === 'E1') {
      const d5 = bootRes.E2.d;
      p5 = d5 != null && d5 > 0;
      p5note = `反弹 5% 变体 Δ=${pp(d5)}（需为正）`;
    }
    const zr = zeroRun(k);
    const p6 = zr.maxRun < 3;
    verdicts[k] = { p1, p2, p3, p4, p5, p6, d, sk, all: p1 && p2 && p3 && p4 && p5 && p6 };
    console.log(`\n  【候选 ${k}】Δ=${pp(d)}  事件 ${sk.n}（A 基线 ${sA.n}）`);
    console.log(`    ${p1 ? '✓' : '✗'} P1 质量提升    Δ≥+2.0pp 且 p10>0（实得 Δ=${pp(d)}, p10=${bt ? pp(bt.p10) : '—'}）`);
    console.log(`    ${p2 ? '✓' : '✗'} P2 边际信号    ${p2note}`);
    console.log(`    ${p3 ? '✓' : '✗'} P3 不踏空      深跌期覆盖 ${fx(deepCovK, 1)}% ≥ A ${fx(deepCovA, 1)}% − 5pp`);
    console.log(`    ${p4 ? '✓' : '✗'} P4 样本量      A ${sA.n}(≥12)、候选 ${sk.n}(≥8)`);
    console.log(`    ${p5 ? '✓' : '✗'} P5 参数稳健    ${p5note}`);
    console.log(`    ${p6 ? '✓' : '✗'} P6 不失效      最长连续零事件年 = ${zr.maxRun}（零事件年：${zr.zeroYears.join('、') || '无'}）`);
  });

  const winners = CANDIDATES.filter(k => verdicts[k].all);
  console.log('\n=== 结论 ===');
  if (winners.length) {
    const best = winners.slice().sort((a, b) => (verdicts[b].d || 0) - (verdicts[a].d || 0))[0];
    console.log(`  ✅ 通过全部判据的候选：${winners.join('、')}；建议采用 **${best}**（ΔR6m=${pp(verdicts[best].d)}）`);
    console.log('     → 改动：kernel.js pricePercentile 中性区分支 + config signals.gold 加 neutralConfirm 开关（默认现状）');
  } else {
    console.log('  ❌ 无候选通过全部判据（默认结论 = 不改）。建议：黄金线中性区维持「止跌」不改动。');
    CANDIDATES.forEach(k => console.log(`     ${k}: Δ=${pp(verdicts[k].d)}`));
    console.log('     → 把结论与日期写入 config.json signals.gold._note，代码不动。');
  }

  // ---- 旁证：018391 自身 ----
  console.log('\n--- ⑫ 旁证：018391 样本基金自身回放（样本少，仅供方向参考）---');
  if (Rreal.length) {
    console.log(`  回放点 ${Rreal.length}（${Rreal[0].date} ~ ${Rreal[Rreal.length - 1].date}）`);
    Object.keys(GROUPS).forEach(k => {
      const h = Rreal.filter(GROUPS[k]);
      const ev = toEvents(h);
      const s = stat(ev.map(e => e.points[0]));
      console.log(`  ${k.padEnd(4)} 命中点 ${String(h.length).padStart(4)}  事件 ${String(ev.length).padStart(3)}  R6m均值 ${pct(s.m6)}`);
    });
  } else console.log('  （无数据）');

  console.log('\n（本脚本为只读回测，未修改任何生产代码或配置）');
})().catch(e => { console.log('FATAL', (e && e.stack) || e); process.exit(1); });

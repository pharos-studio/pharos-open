'use strict';
/*
 * 海外宽基（纳指100）算法复验回测 —— 联网只读，**不写任何文件、不改生产代码**。
 *
 * 待办清单 §1.2 的收尾：把 2026-09-12 为「宽基·海外」做的改造用真实数据复验。
 * ★ 它是四条线里**唯一没有回测脚本**的（A股宽基/黄金/科技 都有）→ 当年的"实测结论"全是手写的、不可复现。
 *
 * 要回答：
 *   ① `peDipPct=15` 该定多少？（2024 仍是零触发；改 10% → 13 周、12% → 4 周、20% → 0）
 *      ★ 结论：**已由 15% 放宽至 12%**（C1 8/8 判据全过）——组 A 现为"改参前历史基线"，非当前值。
 *   ② `peWindowWeeks=156` 是否稳健？（78/104/156/260 → ①计数 128/124/101/89，单调无尖峰）
 *   ③ 手写的信号质量数字（"+16.7% 超额"）是否为真？（文档间 29 次 vs 24 次 矛盾）
 *   ④ 并联是否必要？（①独有仅 5 周、②独有 67 周 → 覆盖度不是有效判据，改用"独有贡献"）
 *   ⑤ 逐年占空比健康度（★ 2021: 59.6%、2022: 100%、2024: 0% → 与科技线/黄金"同病"）
 *   ⑥ 静默降级（peHistory 抓不到 → 强制 hold）的暴露面多大？
 *
 * 数据：收益主序列 = 270042（3391 点 / 2012-08 起，覆盖全部关键底部）；
 *       016452 / 018966 作确认（日收益相关 0.9880 / 0.9981）；PE = 蛋卷 NDX 周频 513 点。
 * ★ 无未来函数：每点只用 date ≤ D 的 PE 与净值；PE 截断序列作为 v.peHistory 传入生产函数。
 * ★ 零重实现：直接调生产 buildBroadGlobalDecision；参数敏感性只改 cfg 深拷贝。
 * ★ 美债用 config 常量：ERP 只影响综合分副锚，**不影响 action**（本回测主判据是 action），
 *   且 fetchBond10Y() 只返回当期值、无历史序列。
 *
 * 用法：node backend/scripts/backtest_broad_global_us.js
 */
const f = require('../fetchers');
const config = require('../lib/config');
const util = require('../lib/util');
const build = require('../engines/strategies/broadGlobal');

const MAIN = '270042';
const PEERS = ['016452', '018966'];
const INDEX = 'NDX';
const NAV_WIN = 250;              // 对齐 analysis.js:34（broad 类 needLong → 250）
const GAP = 28;                   // 事件合并：相邻 ≤4 周
const ITERS = 2000;
const WARMUP = 156;               // 与现状 peWindowWeeks 一致（窗口须满）

// ---------- 组定义（★ C1/C3 预先声明为主判据）----------
const GROUPS = {
  A:  { peWindowWeeks: 156, peDipPct: 15 },   // ★改参前的原基线（2026-09-13 已改为 12）——保留作历史对照
  C1: { peWindowWeeks: 156, peDipPct: 12 },   // ★现行值（复验后采用）+ 主候选
  C3: { peWindowWeeks: 156, peDipPct: 20 },   // 主候选：收紧（反向对照）
  C2: { peWindowWeeks: 156, peDipPct: 10 },   // 参考（2024→13 周，但占空比偏高）
  W1: { peWindowWeeks: 104, peDipPct: 15 },   // 参考：窗口变体
  W2: { peWindowWeeks: 260, peDipPct: 15 },   // 参考：窗口变体
};
const MAIN_GROUPS = ['C1', 'C3'];

// ---------- 关键底部（7 个；★ 3 个为本次新增）----------
const BOTTOMS = [
  { label: '2018-12 加息/贸易战底', from: '2018-10-01', to: '2019-01-31' },
  { label: '2020-03 疫情底', from: '2020-02-20', to: '2020-04-15' },
  { label: '2020-09 回调底 ★新增', from: '2020-08-20', to: '2020-10-10' },
  { label: '2022-06 熊市第一底 ★新增', from: '2022-05-01', to: '2022-07-15' },
  { label: '2022-12 熊市大底', from: '2022-11-15', to: '2023-01-31' },
  { label: '2024-08 套息平仓急跌 ★新增', from: '2024-07-25', to: '2024-09-10' },
  { label: '2025-04 关税急跌', from: '2025-03-25', to: '2025-05-15' },
];

// ---------- 工具 ----------
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
const stat = ev => {
  const g = k => ev.map(e => (e.r ? e.r[k] : null));
  const v6 = g('r6').filter(x => x != null);
  return { n: ev.length, n6: v6.length, m1: mean(g('r1')), m3: mean(g('r3')), m6: mean(g('r6')), m12: mean(g('r12')), med6: median(g('r6')), worst6: v6.length ? Math.min.apply(null, v6) : null };
};
function bootClusterPaired(evA, evB, iters) {
  const byKey = {}, rc = x => x.date.slice(0, 7);
  const touch = k => (byKey[k] = byKey[k] || { a: [], b: [] });
  evA.forEach(e => { if (e.r && e.r.r6 != null) touch(rc(e)).a.push(e.r.r6); });
  evB.forEach(e => { if (e.r && e.r.r6 != null) touch(rc(e)).b.push(e.r.r6); });
  const keys = Object.keys(byKey), out = [];
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

async function fetchSeries(code, maxDays) {
  const r = await f.fetchNavHistory(code, maxDays || 4500);
  const h = (r && r.history) || [];
  return h.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).filter(x => x.nav > 0);
}
async function fetchPe() {
  const r = await f.fetchIndexPeHistory(INDEX);
  if (!r || !r.length) return null;
  return r.map(x => ({ date: x.date, pe: +x.pe })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------- 回放：交易日逐点，PE 截断，调生产函数 ----------
function replay(navs, peAll, cfgBase, override, opt) {
  const o = opt || {};
  const cfg = JSON.parse(JSON.stringify(cfgBase));
  Object.assign(cfg.signals.broadGlobal, override);
  const lag = o.peLagDays || 0;            // PE 滞后压力测试
  const rows = [];
  let peIdx = 0;
  let viol = 0;                            // 未来函数违例计数
  for (let i = 0; i < navs.length; i++) {
    if (i < NAV_WIN - 1) continue;
    const D = navs[i].date;
    const cutoff = lag ? new Date(new Date(D + 'T00:00:00Z').getTime() - lag * 86400000).toISOString().slice(0, 10) : D;
    while (peIdx < peAll.length && peAll[peIdx].date <= cutoff) peIdx++;
    const peTrunc = peAll.slice(0, peIdx);
    if (peTrunc.length < WARMUP) continue;
    if (peTrunc.length && peTrunc[peTrunc.length - 1].date > cutoff) viol++;
    const hist = navs.slice(i - NAV_WIN + 1, i + 1).reverse().map(x => ({ date: x.date, nav: x.nav }));
    const series = peTrunc.map(x => x.pe);
    const f0 = { code: MAIN, category: 'broad', caliber: 'us', latestNav: navs[i].nav, history: hist };
    const vm = { [MAIN]: { pe: series[series.length - 1], peHistory: peTrunc, usTreasury10y: cfg.usTreasury10y, recent20dChange: util.recentChangePct(hist, 20) } };
    const dec = build(f0, vm, cfg);
    const m = dec.matrix || {};
    // 静默失败场景：不挂 peHistory（对齐 analysis.js 抓取失败路径）
    const decMissing = build(f0, { [MAIN]: { pe: series[series.length - 1], usTreasury10y: cfg.usTreasury10y, recent20dChange: util.recentChangePct(hist, 20) } }, cfg);
    rows.push({
      date: D, action: dec.action, actual: dec.action === 'add',
      cheap: m.cheap === true, byPct: m.cheapByPct === true, byDip: m.cheapByDip === true,
      pct: m.peRollingPct, dip: m.peDipLevel, gate: m.gate,
      actionMissing: decMissing.action,
      r: returns(navs, D),
    });
  }
  return { rows, viol };
}

// ---------- PE 周网格（复现已知逐年口径，用于断言 [a] 与报表 2）----------
function replayWeekly(peAll, cfgBase, override) {
  const cfg = JSON.parse(JSON.stringify(cfgBase));
  Object.assign(cfg.signals.broadGlobal, override);
  const rows = [];
  for (let i = 0; i < peAll.length; i++) {
    if (i < WARMUP - 1) continue;
    const trunc = peAll.slice(0, i + 1);
    const series = trunc.map(x => x.pe);
    const dec = build({ code: MAIN, category: 'broad', caliber: 'us', latestNav: null, history: [] },
      { [MAIN]: { pe: series[series.length - 1], peHistory: trunc, usTreasury10y: cfg.usTreasury10y } }, cfg);
    const m = dec.matrix || {};
    rows.push({ date: peAll[i].date, cheap: m.cheap === true, byPct: m.cheapByPct === true, byDip: m.cheapByDip === true });
  }
  return rows;
}

(async () => {
  const cfg = config.getConfig();
  const g0 = cfg.signals.broadGlobal || {};
  console.log('=== 海外宽基（纳指100）算法复验回测 ===\n');
  console.log(`当前 config：peWindowWeeks=${g0.peWindowWeeks}  peDipPct=${g0.peDipPct}  peDipWindowWeeks=${g0.peDipWindowWeeks}  cheapPct=${g0.cheapPct}  erpHigh/Low=${g0.erpHigh}/${g0.erpLow}`);
  console.log('★ 组 A = 改参前原基线(15%)，保留作历史对照；组 C1 = 现行值(12%)｜其余为对照/变体');
  console.log(`回放窗口 NAV_WIN=${NAV_WIN}（对齐 analysis.js:34）｜事件合并 ${GAP} 天｜bootstrap ${ITERS} 次`);
  console.log(`主判据（预先声明）：${MAIN_GROUPS.join(' / ')}；参考：C2(10%) W1(104周) W2(260周)`);
  console.log(`★ 美债用 config 常量 ${cfg.usTreasury10y}（ERP 只影响综合分副锚，不影响 action；fetchBond10Y 无历史序列）\n`);

  // ---- ① 抓数 ----
  console.log('--- ① 序列获取 ---');
  const navs = {};
  for (const code of [MAIN, ...PEERS]) {
    navs[code] = await fetchSeries(code);
    console.log(`  ${code}  n=${String(navs[code].length).padStart(5)}  ${navs[code].length ? navs[code][0].date + ' ~ ' + navs[code][navs[code].length - 1].date : '空'}`);
  }
  const peAll = await fetchPe();
  if (!peAll) { console.log('  ✗ NDX PE 抓取失败，终止。'); process.exit(1); }
  console.log(`  ${INDEX} PE  n=${String(peAll.length).padStart(5)}  ${peAll[0].date} ~ ${peAll[peAll.length - 1].date}`);

  // ---- ② 代理同源校验 ----
  console.log('\n--- ② 代理可信度（270042 vs 持仓）---');
  const retMap = code => { const h = navs[code], m = {}; for (let i = 1; i < h.length; i++) m[h[i].date] = h[i].nav / h[i - 1].nav - 1; return m; };
  const R = {}; [MAIN, ...PEERS].forEach(c => R[c] = retMap(c));
  PEERS.forEach(p => {
    const xs = [], ys = [];
    Object.keys(R[MAIN]).forEach(d => { if (R[p][d] != null) { xs.push(R[MAIN][d]); ys.push(R[p][d]); } });
    const c = corr(xs, ys);
    console.log(`  ${MAIN} vs ${p}: n=${xs.length}  corr=${fx(c, 4)}  ${c != null && c > 0.98 ? '✓' : '⚠'}`);
  });

  // ---- ③ 回放 A + 一致性断言 ----
  console.log('\n--- ③ 回放 + 一致性断言（不通过即作废）---');
  const wk = {}; Object.keys(GROUPS).forEach(k => wk[k] = replayWeekly(peAll, cfg, GROUPS[k]));
  const wkA = wk.A;
  const byYearW = k => { const b = {}; wk[k].forEach(r => { const y = r.date.slice(0, 4); b[y] = b[y] || { c: 0, t: 0 }; b[y].t++; if (r.cheap) b[y].c++; }); return b; };
  const yA = byYearW('A');
  const expect = { '2023': 5, '2024': 0, '2025': 10, '2026': 14 };
  const got = ['2023', '2024', '2025', '2026'].map(y => y + ':' + (yA[y] ? yA[y].c : 0)).join(' / ');
  const okA = ['2023', '2024', '2025', '2026'].every(y => yA[y] && yA[y].c === expect[y]);
  console.log(`  [a] 现状逐年并联触发（PE 周网格）: ${got}`);
  console.log(`      期望 2023:5 / 2024:0 / 2025:10 / 2026:14  → ${okA ? '✓' : '✗'}`);

  const rep = replay(navs[MAIN], peAll, cfg, GROUPS.A);
  const rowsA = rep.rows;
  console.log(`  [b] 交易日回放点 = ${rowsA.length}（${rowsA[0].date} ~ ${rowsA[rowsA.length - 1].date}）`);
  console.log(`  [c] 未来函数违例（PE 最大日期 > D）= ${rep.viol}  ${rep.viol === 0 ? '✓' : '✗'}`);
  let badRule = 0, badRoll = 0;
  rowsA.forEach(r => {
    const rule = (r.gate === 'block') ? false : r.cheap;
    if (rule !== r.actual) badRule++;
  });
  const lastPe = peAll.map(x => x.pe);
  const lastRow = rowsA[rowsA.length - 1];
  if (util.rollingPercentile(lastPe, 156) !== lastRow.pct) badRoll++;
  console.log(`  [d] 重建(cheap∧¬gate) vs 生产 action 不一致 = ${badRule}  ${badRule === 0 ? '✓' : '✗'}`);
  console.log(`  [e] 末点自算滚动分位 ${fx(util.rollingPercentile(lastPe, 156), 2)} vs matrix ${fx(lastRow.pct, 2)}（差 ${fx(Math.abs(util.rollingPercentile(lastPe, 156) - lastRow.pct), 3)}）`);
  if (!okA || rep.viol > 0 || badRule > 0) { console.log('\n  ✗ 一致性未通过 → 结论不可信，终止。'); process.exit(1); }
  console.log('  → 前置断言全部通过（复现已知数字 + 无未来函数 + 重建=生产）。\n');

  // ---- ④ 逐年占空比（★ 审查新增：暴露极端化）----
  console.log('--- ④ 逐年占空比（交易日口径 + 周网格口径）---');
  console.log('  年份   A日频%   A周频%   触发周数/总周数');
  const yrs = [...new Set(rowsA.map(r => r.date.slice(0, 4)))].sort();
  yrs.forEach(y => {
    const ry = rowsA.filter(r => r.date.slice(0, 4) === y);
    const dR = ry.filter(r => r.actual).length / ry.length * 100;
    const wy = yA[y] || { c: 0, t: 0 };
    const wR = wy.t ? wy.c / wy.t * 100 : 0;
    const flag = (dR > 50 || dR < 1) ? '  ⚠ 极端' : '';
    console.log(`  ${y}${fx(dR, 1).padStart(8)}${fx(wR, 1).padStart(8)}    ${String(wy.c).padStart(3)} / ${String(wy.t).padStart(3)}${flag}`);
  });
  const dutyA = rowsA.filter(r => r.actual).length / rowsA.length * 100;
  console.log(`  全期 A 占空比 = ${fx(dutyA, 1)}%`);

  // ---- ⑤ 参数网格 ----
  console.log('\n--- ⑤ 参数网格（6 组）---');
  const res = {};
  Object.keys(GROUPS).forEach(k => {
    const rows = (k === 'A') ? rowsA : replay(navs[MAIN], peAll, cfg, GROUPS[k]).rows;
    const hits = rows.filter(r => r.actual);
    const ev = toEvents(hits).map(e => ({ date: e.date, r: e.points[0].r, points: e.points }));
    const duty = hits.length / rows.length * 100;
    const byY = {}; rows.forEach(r => { const y = r.date.slice(0, 4); byY[y] = byY[y] || 0; if (r.actual) byY[y]++; });
    res[k] = { rows, hits, ev, duty, byY, st: stat(ev) };
  });
  console.log('  组  参数             占空比   事件数  R6m样本    R1m     R3m     R6m    R12m  R6m中位  最差R6m');
  Object.keys(GROUPS).forEach(k => {
    const r = res[k], s = r.st, gp = GROUPS[k];
    const tag = (k === 'A') ? ' (基线)' : (MAIN_GROUPS.includes(k) ? ' ★主' : '');
    console.log('  ' + k.padEnd(4) + `${gp.peWindowWeeks}周/${gp.peDipPct}%`.padEnd(16)
      + fx(r.duty, 1).padStart(7) + String(s.n).padStart(8) + String(s.n6).padStart(9)
      + fx(s.m1, 1).padStart(8) + fx(s.m3, 1).padStart(8) + fx(s.m6, 1).padStart(8) + fx(s.m12, 1).padStart(7)
      + fx(s.med6, 1).padStart(9) + fx(s.worst6, 1).padStart(9) + tag);
  });
  const baseR6 = rowsA.map(r => r.r.r6).filter(x => x != null);
  console.log(`  [基准] 270042 全期任意点入场 R6m = ${pct(mean(baseR6))}（n=${baseR6.length}）`);

  // ---- ⑥ 主判据 Δ + 双向边际 ----
  console.log('\n--- ⑥ 主判据 Δ 与双向边际信号 ---');
  const diffHits = (ka, kb) => {
    const setB = new Set(res[kb].hits.map(r => r.date));
    return toEvents(res[ka].hits.filter(r => !setB.has(r.date))).map(e => ({ date: e.date, r: e.points[0].r, points: e.points }));
  };
  const mainRes = {};
  MAIN_GROUPS.forEach(k => {
    const s = res[k].st, sA = res.A.st;
    const d = (s.m6 != null && sA.m6 != null) ? s.m6 - sA.m6 : null;
    const added = diffHits(k, 'A');       // 候选 \ A（放宽型才有）
    const dropped = diffHits('A', k);     // A \ 候选（收紧型才有）
    const cbt = bootClusterPaired(res.A.ev, res[k].ev, ITERS);
    mainRes[k] = { d, added, dropped, sa: stat(added), sd: stat(dropped), cbt };
    console.log(`\n  【${k}】${GROUPS[k].peWindowWeeks}周/${GROUPS[k].peDipPct}%  事件 ${s.n}  R6m ${pct(s.m6)}  ΔR6m = ${pp(d)}`);
    console.log(`    聚类 bootstrap（按月, nClusters=${cbt ? cbt.nClusters : '—'}）: p10=${cbt ? pp(cbt.p10) : '—'}  p50=${cbt ? pp(cbt.p50) : '—'}  p90=${cbt ? pp(cbt.p90) : '—'}`);
    console.log(`    ★新增(${k}\\A) n=${added.length}  R6m ${pct(stat(added).m6)}${added.length ? '' : '（空集→子集）'}`);
    console.log(`    ★被筛(A\\${k}) n=${dropped.length}  R6m ${pct(stat(dropped).m6)}${dropped.length ? '' : '（空集）'}`);
  });

  // ---- ⑦ 关键底部覆盖 ----
  console.log('\n--- ⑦ 关键底部覆盖表（锚点 = 窗口内 270042 净值最低日；覆盖 = 锚 ±28 天内有事件）---');
  const mn = navs[MAIN];
  console.log('  底部                              锚点日      ' + Object.keys(GROUPS).map(k => k.padStart(4)).join(''));
  const cov = {}; Object.keys(GROUPS).forEach(k => cov[k] = 0);
  const anchorOf = [];
  BOTTOMS.forEach(b => {
    const win = mn.filter(x => x.date >= b.from && x.date <= b.to);
    if (!win.length) { console.log('  ' + b.label.padEnd(30) + '  (无数据)'); return; }
    let low = win[0]; win.forEach(x => { if (x.nav < low.nav) low = x; });
    anchorOf.push({ label: b.label, date: low.date });
    const cells = Object.keys(GROUPS).map(k => {
      const hit = res[k].hits.some(r => Math.abs(daysBetween(low.date, r.date)) <= 28);
      if (hit) cov[k]++;
      return (hit ? '✓' : '✗').padStart(4);
    }).join('');
    console.log('  ' + b.label.padEnd(30) + '  ' + low.date + '  ' + cells);
  });
  console.log('  ' + '覆盖合计'.padEnd(30) + '  ' + ''.padEnd(10) + '  ' + Object.keys(GROUPS).map(k => String(cov[k] + '/7').padStart(4)).join(''));

  // ---- ⑧ 通道①/② 独有贡献（并联必要性）----
  console.log('\n--- ⑧ 通道独有贡献（并联是否必要）---');
  const onlyPct = toEvents(rowsA.filter(r => r.byPct && !r.byDip)).map(e => ({ date: e.date, r: e.points[0].r, points: e.points }));
  const onlyDip = toEvents(rowsA.filter(r => r.byDip && !r.byPct)).map(e => ({ date: e.date, r: e.points[0].r, points: e.points }));
  console.log(`  通道①独有（byPct ∧ ¬byDip）: 点 ${rowsA.filter(r => r.byPct && !r.byDip).length} / 事件 ${onlyPct.length}  R6m ${pct(stat(onlyPct).m6)}`);
  console.log(`  通道②独有（byDip ∧ ¬byPct）: 点 ${rowsA.filter(r => r.byDip && !r.byPct).length} / 事件 ${onlyDip.length}  R6m ${pct(stat(onlyDip).m6)}`);
  console.log(`  两通道同时: 点 ${rowsA.filter(r => r.byPct && r.byDip).length}`);
  console.log('  → 若①独有"既稀少又无超额"，则记为观察项（本轮不改条件）。');

  // ---- ⑨ 静默失败暴露面 ----
  console.log('\n--- ⑨ 静默降级暴露面（无 peHistory → 强制 hold）---');
  const lost = rowsA.filter(r => r.actual && r.actionMissing !== 'add');
  console.log(`  真实 add 共 ${res.A.hits.length} 天；其中「若 peHistory 缺失则变 hold」= ${lost.length} 天（${fx(lost.length / res.A.hits.length * 100, 1)}%）`);
  if (lost.length) {
    const near = lost.filter(r => anchorOf.some(a => Math.abs(daysBetween(a.date, r.date)) <= 28));
    console.log(`  其中落在关键底部 ±28 天内 = ${near.length} 次：${near.slice(0, 8).map(r => r.date).join(', ')}${near.length > 8 ? ' …' : ''}`);
    console.log('  ⓘ 注：add 信号本就集中在下跌期，故"多数落在底部附近"属预期；本条的意义是——**抓取一旦失败，这些信号会全部静默消失且无任何提示**。');
    const byY = {}; lost.forEach(r => { const y = r.date.slice(0, 4); byY[y] = (byY[y] || 0) + 1; });
    console.log(`  按年分布: ${Object.keys(byY).sort().map(y => y + ':' + byY[y]).join('  ')}`);
  }

  // ---- ⑩ PE 滞后 +7 天压力测试 ----
  console.log('\n--- ⑩ PE 滞后 +7 天压力测试（周频精度）---');
  const lagRows = replay(navs[MAIN], peAll, cfg, GROUPS.A, { peLagDays: 7 }).rows;
  const lagEv = toEvents(lagRows.filter(r => r.actual)).map(e => ({ date: e.date, r: e.points[0].r, points: e.points }));
  const lagSt = stat(lagEv);
  const lagYear = {}; lagRows.forEach(r => { const y = r.date.slice(0, 4); lagYear[y] = lagYear[y] || { c: 0, t: 0 }; lagYear[y].t++; if (r.actual) lagYear[y].c++; });
  console.log(`  事件 ${lagSt.n}（现状 ${res.A.st.n}）  R6m ${pct(lagSt.m6)}（现状 ${pct(res.A.st.m6)}）`);
  console.log('  ★ 以下同为【交易日】口径（此前误与周网格口径对比，已修）');
  console.log('  年份         ' + ['2023', '2024', '2025', '2026'].map(y => y.padStart(7)).join(''));
  console.log('  滞后 +7 天   ' + ['2023', '2024', '2025', '2026'].map(y => String(lagYear[y] ? lagYear[y].c : 0).padStart(7)).join(''));
  console.log('  现状(交易日) ' + ['2023', '2024', '2025', '2026'].map(y => String(res.A.byY[y] || 0).padStart(7)).join(''));
  console.log('  差异         ' + ['2023', '2024', '2025', '2026'].map(y => String((lagYear[y] ? lagYear[y].c : 0) - (res.A.byY[y] || 0)).padStart(7)).join(''));
  // ★ 判定"结论不变"而非"逐点相同"：事件数与 R6m 都在容差内即可（周频最多滞后 7 天，少量点位偏移属正常）
  const lagCount = lagSt.n, lagM6 = lagSt.m6 != null ? lagSt.m6 : 0, aM6 = res.A.st.m6 != null ? res.A.st.m6 : 0;
  const lagSame = Math.abs(lagCount - res.A.st.n) <= 3 && Math.abs(lagM6 - aM6) <= 1.5;

  // ---- ⑪ 三标的 Δ 同号（P7）----
  console.log('\n--- ⑪ 标的稳健性（P7）：各标的下 候选 vs 现状 的 ΔR6m ---');
  const perFund = {};
  [MAIN, ...PEERS].forEach(code => {
    const nv = navs[code];
    const rr = {};
    ['A', 'C1', 'C3'].forEach(k => {
      const rws = replay(nv, peAll, cfg, GROUPS[k]).rows;
      const evs = toEvents(rws.filter(r => r.actual)).map(e => ({ date: e.date, r: e.points[0].r, points: e.points }));
      rr[k] = stat(evs);
    });
    perFund[code] = rr;
    const d1 = (rr.C1.m6 != null && rr.A.m6 != null) ? rr.C1.m6 - rr.A.m6 : null;
    const d3 = (rr.C3.m6 != null && rr.A.m6 != null) ? rr.C3.m6 - rr.A.m6 : null;
    console.log(`  ${code}: A事件${String(rr.A.n).padStart(3)} R6m ${pct(rr.A.m6).padStart(7)}  |  C1 Δ=${pp(d1)}  C3 Δ=${pp(d3)}`);
  });

  // ---- ⑫ 判据 P0~P7 ----
  console.log('\n--- ⑫ 落地判据 P0~P7（全过才建议改）---');
  const verdict = {};
  MAIN_GROUPS.forEach(k => {
    const r = mainRes[k], s = res[k].st, sA = res.A.st;
    const p0 = res[k].duty >= 3 && res[k].duty <= res.A.duty + 5 && res[k].duty <= 45;
    const p1 = r.d != null && r.d >= -2.0;                     // 非劣底线
    const p1strong = r.d != null && r.d >= 2.0 && r.cbt && r.cbt.p10 > 0;  // 若声称提升
    const tighten = GROUPS[k].peDipPct > GROUPS.A.peDipPct;     // 收紧型
    const p2 = tighten
      ? (r.dropped.length >= 5 ? (r.sd.m6 != null && sA.m6 != null && r.sd.m6 <= sA.m6) : true)
      : (r.added.length >= 5 ? (r.sa.m6 != null && sA.m6 != null && r.sa.m6 >= sA.m6 - 2.0) : true);
    const covK = cov[k], covA = cov.A;
    const y2024 = res[k].byY['2024'] || 0;
    const p3 = covK >= covA && y2024 >= 1;
    const p4 = res.A.st.n >= 10 && s.n >= 8;
    const dC2 = (res.C2.st.m6 != null && sA.m6 != null) ? res.C2.st.m6 - sA.m6 : null;
    const dC3 = (res.C3.st.m6 != null && sA.m6 != null) ? res.C3.st.m6 - sA.m6 : null;
    const dW1 = (res.W1.st.m6 != null && sA.m6 != null) ? res.W1.st.m6 - sA.m6 : null;
    const dW2 = (res.W2.st.m6 != null && sA.m6 != null) ? res.W2.st.m6 - sA.m6 : null;
    const p5 = (dW1 != null && dW2 != null && Math.abs(dW1) <= 2 && Math.abs(dW2) <= 2) && lagSame;
    const zeroY = yrs.filter(y => (res[k].byY[y] || 0) === 0);
    let maxRun = 0, cur = 0, prev = null;
    zeroY.forEach(y => { if (prev != null && Number(y) === Number(prev) + 1) cur++; else cur = 1; maxRun = Math.max(maxRun, cur); prev = y; });
    const p6 = maxRun <= 1;
    let p7 = true;
    Object.keys(perFund).forEach(code => {
      const rr = perFund[code];
      const dk = (rr[k].m6 != null && rr.A.m6 != null) ? rr[k].m6 - rr.A.m6 : null;
      if (dk != null && r.d != null && Math.sign(dk) !== Math.sign(r.d)) p7 = false;
    });
    verdict[k] = { p0, p1, p2, p3, p4, p5, p6, p7, p1strong, all: p0 && p1 && p2 && p3 && p4 && p5 && p6 && p7 };
    console.log(`\n  【${k}】${GROUPS[k].peWindowWeeks}周/${GROUPS[k].peDipPct}%  占空比 ${fx(res[k].duty, 1)}%  ΔR6m ${pp(r.d)}  事件 ${s.n}`);
    console.log(`    ${p0 ? '✓' : '✗'} P0 占空比合理  ${fx(res[k].duty, 1)}% ∈ [3%, ${fx(res.A.duty + 5, 1)}%] 且 ≤45%`);
    console.log(`    ${p1 ? '✓' : '✗'} P1 非劣        Δ=${pp(r.d)} ≥ −2.0pp${p1strong ? '（且达"提升"门槛：≥+2.0pp 且 p10>0）' : ''}`);
    console.log(`    ${p2 ? '✓' : '✗'} P2 ${tighten ? '被筛信号质量' : '新增信号质量'}  ${tighten ? `被筛 n=${r.dropped.length} R6m ${pct(r.sd.m6)} ≤ A ${pct(sA.m6)}` : `新增 n=${r.added.length} R6m ${pct(r.sa.m6)} ≥ A−2.0pp`}`);
    console.log(`    ${p3 ? '✓' : '✗'} P3 底部覆盖+2024  覆盖 ${covK}/7 ≥ A ${covA}/7 且 2024 触发 ${y2024} 天（≥1）`);
    console.log(`    ${p4 ? '✓' : '✗'} P4 样本量      A=${res.A.st.n}(≥10) 候选=${s.n}(≥8)`);
    console.log(`    ${p5 ? '✓' : '✗'} P5 参数稳健    窗口变体 W1 Δ=${pp(dW1)}、W2 Δ=${pp(dW2)}（|·|≤2pp）；PE 滞后+7 天：事件 ${lagCount} vs ${res.A.st.n}、R6m ${pct(lagM6)} vs ${pct(aM6)} → ${lagSame ? '结论不变' : '结论改变'}`);
    console.log(`    ${p6 ? '✓' : '✗'} P6 不失效      最长连续零触发年=${maxRun}（≤1）；零事件年：${zeroY.join('、') || '无'}`);
    console.log(`    ${p7 ? '✓' : '✗'} P7 标的稳健    270042/016452/018966 的 Δ 同号`);
    console.log(`    → ${verdict[k].all ? '✅ 全部通过' : '❌ 未通过'}`);
  });

  // ---- ⑬ 结论 ----
  console.log('\n=== 结论 ===');
  const passed = MAIN_GROUPS.filter(k => verdict[k].all);
  if (passed.length) {
    console.log(`  ✅ ${passed.join('、')} 通过全部判据 → **已采用**（2026-09-13：peDipPct 15→12；组 A 现为改参前历史基线）`);
  } else {
    console.log('  ❌ 无候选通过 → 维持现状（peDipPct=15 不变）');
    MAIN_GROUPS.forEach(k => {
      const bad = Object.entries(verdict[k]).filter(([kk, vv]) => kk !== 'all' && kk !== 'p1strong' && vv === false).map(([kk]) => kk.toUpperCase());
      console.log(`     ${k}（${GROUPS[k].peDipPct}%）: 未过 ${bad.join('/')} ｜ ΔR6m=${pp(mainRes[k].d)}、占空比 ${fx(res[k].duty, 1)}%、2024 触发 ${res[k].byY['2024'] || 0} 天`);
    });
    console.log('     → "2024 零触发"记为「单边高估值期的固有代价」（对标黄金 §1.3 的结案方式），代码不动。');
  }
  console.log('\n（本脚本为只读回测，未修改任何生产代码或配置）');
})().catch(e => { console.log('FATAL', (e && e.stack) || e); process.exit(1); });

'use strict';
/*
 * 黄金线「打破状态型天花板」回测：加回撤通道能否救回 2023-2024 —— 联网只读，不写文件、不改生产代码。
 *
 * 问题：黄金线用「250 日价格分位 ≤35」判便宜，2023-2025 连续三年零信号（黄金同期 +40%）。
 *   根因：价格分位是「状态型条件」——单边上涨时当前价永远在窗口高位 → 永久判"贵"。
 * 要答：加一条「价格距近 250 日高点回撤 ≥X%」的通道，能否打破天花板？代价是什么？
 *
 * ★ 审查已否决原方案的"实际利率锚"（详见 docs/算法设计复盘手册.md 第 4 个案例）：
 *   日频 corr(TIPS变化, 金价收益) 全期仅 +0.032（当日）/ −0.077（滞后）；
 *   分档"预测力"方向与理论相反（低档 R12m +4.2% vs 高档 +21.0%），
 *   且经查证为**时段伪相关**（低档集中在 2016/2019-2021 横盘期，高档含 2022-2024 大牛市）
 *   → 实际利率分位 ≈ "年份的代理变量"，无独立择时信息。故本脚本不引入 TIPS。
 *
 * ★ 已知预期（勘察实测）：518880 各年最深回撤 2023 −7.9% / 2024 −7.2% / 2025 −10.9% / 2026 −30.3%
 *   → -8% 阈值时 2023-2024 都是 0 天；-5% 阈值也只有 5/7 天 → 本脚本的真实价值是给出**定量答案**。
 *
 * ★ 无未来函数：每点只用 date ≤ 当前点 的净值（生产天然如此，回放显式截断）。
 * ★ 零重实现：直接读生产 buildGoldDecision 的 dec.matrix（pctZone/stopFall/trendWeak/surge/pricePercentile）。
 *
 * 用法：node backend/scripts/backtest_gold_dip.js
 */
const f = require('../fetchers');
const config = require('../lib/config');
const util = require('../lib/util');
const buildGoldDecision = require('../engines/strategies/gold');

const MAIN = '518880', REAL = '018391';
const NAV_WIN = 250;        // 与生产同口径
const GAP = 28;             // 相邻命中 ≤4 周合并
const ITERS = 1000;
const DIP_LEVELS = [5, 8, 10, 15];   // 回撤阈值扫描（%）
const DEEP_DD = -10;        // 深回撤期定义（相对近250日高点）

const fx = (v, d) => (v == null || isNaN(v) ? '—' : (+v).toFixed(d == null ? 2 : d));
const pct = (v, d) => (v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (+v).toFixed(d == null ? 1 : d) + '%');
const pp = (v, d) => (v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (+v).toFixed(d == null ? 2 : d) + 'pp');
const mean = a => { const b = a.filter(x => x != null && !isNaN(x)); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : null; };
const median = a => { const b = a.filter(x => x != null && !isNaN(x)).sort((x, y) => x - y); if (!b.length) return null; const n = b.length >> 1; return b.length % 2 ? b[n] : (b[n - 1] + b[n]) / 2; };
function quantile(arr, p) { const a = arr.filter(x => x != null && !isNaN(x)).slice().sort((x, y) => x - y); if (!a.length) return null; return a[Math.min(a.length - 1, Math.max(0, Math.round(p / 100 * (a.length - 1))))]; }
function lookup(arr, day) { let lo = 0, hi = arr.length - 1, res = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].date <= day) { res = arr[m]; lo = m + 1; } else hi = m - 1; } return res; }
function addMonths(d, m) { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); }
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

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
  hits.forEach(h => { const l = ev[ev.length - 1]; if (l && daysBetween(l.date, h.date) <= GAP) l.points.push(h); else ev.push({ date: h.date, points: [h] }); });
  return ev;
}
function bootClusterPaired(evA, evB, iters) {
  const byKey = {}, rc = x => x.date.slice(0, 7);
  const touch = k => (byKey[k] = byKey[k] || { a: [], b: [] });
  const rowOf = e => (e && e.points ? e.points[0] : e);   // ★收益在 points[0].r
  evA.forEach(e => { const r = rowOf(e); if (r && r.r && r.r.r6 != null) touch(rc(e)).a.push(r.r.r6); });
  evB.forEach(e => { const r = rowOf(e); if (r && r.r && r.r.r6 != null) touch(rc(e)).b.push(r.r.r6); });
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

async function fetchSeries(code) {
  const r = await f.fetchNavHistory(code, 4500);
  const h = (r && r.history) || [];
  return h.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).filter(x => x.nav > 0);
}

function replay(navs, cfg) {
  const rows = [];
  for (let i = NAV_WIN - 1; i < navs.length; i++) {
    const cur = navs[i];
    const hist = navs.slice(i - NAV_WIN + 1, i + 1).reverse().map(x => ({ date: x.date, nav: x.nav }));
    const dec = buildGoldDecision({ code: 'PROBE', category: 'cycle', latestNav: cur.nav, history: hist }, {}, cfg);
    const m = dec.matrix || {};
    const s250 = navs.slice(i - NAV_WIN + 1, i + 1).map(x => x.nav);
    const low250 = Math.min.apply(null, s250);
    rows.push({
      date: cur.date, nav: cur.nav, realAction: dec.action,
      pctZone: m.pctZone, pricePercentile: m.pricePercentile, stopFall: m.stopFall === true,
      trendWeak: m.trendWeak === true, surge: m.surge === true,
      low250, dd250: (cur.nav / Math.max.apply(null, s250) - 1) * 100,
      rebound: (cur.nav / low250 - 1) * 100,
      r: returns(navs, cur.date),
    });
  }
  return rows;
}

// 决策重建：黄金矩阵 = 便宜→add / 贵→hold / 中性→(急涨拦) 否则 trendWeak ∧ stopFall
const neutralAdd = r => r.pctZone === 'neutral' && !r.surge && r.trendWeak === true && r.stopFall === true;
const GROUPS = {
  A: r => r.pctZone === 'cheap' || neutralAdd(r),                                   // 现状
};
DIP_LEVELS.forEach(X => {
  GROUPS['B' + X] = r => (r.dd250 <= -X) || (r.pctZone === 'neutral' && !r.surge && r.trendWeak === true && r.stopFall === true);  // 纯回撤替代分位
  GROUPS['C' + X] = r => r.pctZone === 'cheap' || (r.dd250 <= -X) || neutralAdd(r); // 并联（A ⊇ 放宽）
  GROUPS['D' + X] = r => (r.dd250 <= -X && r.pctZone !== 'expensive') || r.pctZone === 'cheap' || neutralAdd(r); // 回撤且不过度贵
});
const MAIN_CAND = ['C5', 'C8', 'C10', 'C15'];   // 主候选（并联）
const REF = ['B8', 'D8'];                        // 参考（不进主判据）

// 入参兼容：事件对象数组（{date, points}）或 row 数组；收益在 row.r.{r1,r3,r6,r12}
const stat = ev => {
  const rows = ev.map(e => (e && e.points ? e.points[0] : e));
  const g = k => rows.map(x => (x && x.r ? x.r[k] : null));
  const v6 = g('r6').filter(x => x != null);
  return { n: rows.length, n6: v6.length, m1: mean(g('r1')), m3: mean(g('r3')), m6: mean(g('r6')), m12: mean(g('r12')), med6: median(g('r6')), worst6: v6.length ? Math.min.apply(null, v6) : null };
};

(async () => {
  const cfg = config.getConfig();
  const g = (cfg.signals && cfg.signals.gold) || {};
  console.log('=== 黄金线「回撤通道」回测（主序列 518880 代理）===\n');
  console.log(`阈值：cheapPct=${g.cheapPct}  expensivePct=${g.expensivePct}  stopWindow=${g.stopWindow}  maWindows=${JSON.stringify(g.maWindows)}`);
  console.log(`回撤档位扫描：${DIP_LEVELS.map(x => '-' + x + '%').join(' / ')}`);
  console.log('★ 声明：主结论基于代理 518880（用户实际持有 018391）；实际利率锚已在审查阶段实测否决，本脚本不引入。\n');

  const navs = await fetchSeries(MAIN);
  const real = await fetchSeries(REAL);
  console.log('--- ① 序列 ---');
  console.log(`  518880 n=${navs.length}  ${navs[0].date} ~ ${navs[navs.length - 1].date}`);
  console.log(`  018391 n=${real.length}  ${real[0].date} ~ ${real[real.length - 1].date}（旁证）`);

  // 跳空诊断
  let jumps = 0;
  for (let i = 1; i < navs.length; i++) if ((navs[i].nav / navs[i - 1].nav - 1) * 100 < -5) jumps++;
  console.log(`  跳空诊断（单日 <-5%）：${jumps} 次（前次已核实为真实行情，非除权）`);

  console.log('\n--- ② 回放 + 一致性断言（不过即作废）---');
  const R = replay(navs, cfg);
  let bad = 0;
  R.forEach(r => { if (GROUPS.A(r) !== (r.realAction === 'add')) bad++; });
  console.log(`  回放点 ${R.length}（${R[0].date} ~ ${R[R.length - 1].date}）`);
  console.log(`  重建 A 与生产 action 不一致 = ${bad}（应为 0）  ${bad === 0 ? '✓' : '✗'}`);
  if (bad > 0) { console.log('  ✗ 终止。'); process.exit(1); }
  console.log('  → 重建与生产逐点一致。');

  // 分组（★保留点层面 hits：新增信号差集必须在点层面求，事件层面会因合并模式不同而虚高）
  const hits = {}, events = {};
  Object.keys(GROUPS).forEach(k => { hits[k] = R.filter(GROUPS[k]); events[k] = toEvents(hits[k]); });
  const sA = stat(events.A);

  console.log('\n--- ③ ★ 逐年事件数（本次核心：看 2023/2024/2025 能否被救回）---');
  const yrs = [...new Set(R.map(r => r.date.slice(0, 4)))].sort();
  const keys = ['A', ...MAIN_CAND, ...REF];
  console.log('  年份   ' + keys.map(k => k.padStart(5)).join(''));
  yrs.forEach(y => {
    const line = keys.map(k => String(events[k].filter(e => e.date.slice(0, 4) === y).length).padStart(5)).join('');
    const mark = ['2023', '2024', '2025'].includes(y) ? '  ★' : '';
    console.log('  ' + y + line + mark);
  });
  console.log('  合计   ' + keys.map(k => String(events[k].length).padStart(5)).join(''));

  console.log('\n--- ④ 各组收益（%，事件首日）---');
  console.log('  组    事件   R6m样本   R1m     R3m     R6m    R12m   R6m中位  最差R6m');
  keys.forEach(k => {
    const s = stat(events[k]);
    console.log('  ' + k.padEnd(5) + String(s.n).padStart(5) + String(s.n6).padStart(8) + '  '
      + fx(s.m1, 1).padStart(6) + fx(s.m3, 1).padStart(8) + fx(s.m6, 1).padStart(8) + fx(s.m12, 1).padStart(7)
      + fx(s.med6, 1).padStart(9) + fx(s.worst6, 1).padStart(9));
  });
  const baseR6 = R.map(r => r.r.r6).filter(x => x != null);
  console.log(`  [基准] 全期任意点入场 R6m = ${pct(mean(baseR6))}（n=${baseR6.length}）`);

  // 主判据：C 各档 vs A
  console.log('\n--- ⑤ 主判据：并联组 C 各档 vs 现状 A ---');
  const setAPts = new Set(hits.A.map(p => p.date));
  const res = {};
  MAIN_CAND.forEach(k => {
    const s = stat(events[k]);
    const d = (s.m6 != null && sA.m6 != null) ? s.m6 - sA.m6 : null;
    const bt = (s.n6 >= 3 && sA.n6 >= 3) ? bootClusterPaired(events.A, events[k], ITERS) : null;
    // ★点层面求差集 → 对差集独立事件化
    const added = toEvents(hits[k].filter(p => !setAPts.has(p.date))).map(e => e.points[0]);
    const sa = stat(added);
    res[k] = { s, d, bt, addedCnt: added.length, sa };
    const y23 = events[k].filter(e => e.date.slice(0, 4) === '2023').length;
    const y24 = events[k].filter(e => e.date.slice(0, 4) === '2024').length;
    console.log(`  [${k}] 事件 ${s.n}  ΔR6m=${pp(d)}  p10=${bt ? pp(bt.p10) : '—'}  nClusters=${bt ? bt.nClusters : '—'}`
      + `  | 新增 ${added.length} 个(R6m ${pct(sa.m6)})  | ★2023:${y23} 2024:${y24}`);
  });

  // 深回撤期覆盖
  const deepRows = R.filter(r => r.dd250 <= DEEP_DD);
  console.log(`\n--- ⑥ 深回撤期覆盖（dd250 ≤${DEEP_DD}%，共 ${deepRows.length}/${R.length} 天）---`);
  keys.forEach(k => {
    const cov = deepRows.filter(GROUPS[k]);
    console.log('  ' + k.padEnd(5) + ' 覆盖 ' + String(cov.length).padStart(4) + ' 天（' + fx(cov.length / deepRows.length * 100, 1) + '%）  期间 R6m 均值 ' + pct(stat(cov).m6));
  });

  // 判据
  console.log('\n--- ⑦ 落地判据 ---');
  // 主候选取 ΔR6m 最高者参与 P2 判定（P1 对全部 C 档检查）
  let bestK = null, bestD = -Infinity;
  MAIN_CAND.forEach(k => { if (res[k].d != null && res[k].d > bestD) { bestD = res[k].d; bestK = k; } });
  const y23ok = MAIN_CAND.some(k => events[k].some(e => e.date.slice(0, 4) === '2023'));
  const y24ok = MAIN_CAND.some(k => events[k].some(e => e.date.slice(0, 4) === '2024'));
  const p1 = y23ok && y24ok;
  const b = bestK ? res[bestK] : null;
  const p2 = b && b.d != null && b.d >= 2.0 && b.bt && b.bt.p10 > 0 && b.bt.nClusters >= 10;
  const p3 = b && (b.addedCnt === 0 || (b.sa.m6 != null && sA.m6 != null && b.sa.m6 >= sA.m6 - 2.0))
    && (b.sa.worst6 == null || sA.worst6 == null || b.sa.worst6 >= sA.worst6 - 10);
  const p4 = sA.n >= 12 && (b ? b.s.n >= 12 : false) && new Set(events.A.map(e => e.date.slice(0, 7))).size >= 8;
  const signs = MAIN_CAND.map(k => (res[k].d == null ? 0 : Math.sign(res[k].d)));
  const p5 = signs.every(s => s === signs[0]);
  const zeroRun = k => { const z = yrs.filter(y => events[k].filter(e => e.date.slice(0, 4) === y).length === 0); let mx = 0, cur = 0, prev = null; z.forEach(y => { if (prev != null && Number(y) === Number(prev) + 1) cur++; else cur = 1; mx = Math.max(mx, cur); prev = y; }); return mx; };
  const p6 = b ? zeroRun(bestK) <= 1 : false;

  const rows = [
    ['★ P1 打破天花板', `2023 有事件=${y23ok}、2024 有事件=${y24ok}（现状 0/0）`, p1],
    ['P2 质量提升', `最优档 ${bestK || '—'}：ΔR6m=${pp(b && b.d)}（≥+2.0pp）、p10=${b && b.bt ? pp(b.bt.p10) : '—'}>0、nClusters=${b && b.bt ? b.bt.nClusters : '—'}≥10`, p2],
    ['P3 放宽不劣化', `新增信号 R6m=${b ? pct(b.sa.m6) : '—'} ≥ A ${pct(sA.m6)} − 2.0pp；最差 ${b ? pct(b.sa.worst6) : '—'} vs A ${pct(sA.worst6)}`, p3],
    ['P4 样本量', `A ${sA.n}、最优档 ${b ? b.s.n : '—'}（各 ≥12）；独立月 ${new Set(events.A.map(e => e.date.slice(0, 7))).size}（≥8）`, p4],
    ['P5 参数稳健', `C 各档 Δ 符号：${MAIN_CAND.map(k => k + '=' + pp(res[k].d)).join('  ')}（需一致）`, p5],
    ['P6 不失效', `最优档最长连续零事件年 = ${bestK ? zeroRun(bestK) : '—'}（≤1）`, p6],
  ];
  rows.forEach(([k, d, ok]) => console.log(`  ${ok ? '✓' : '✗'} ${k.padEnd(16)} ${d}`));
  const pass = p1 && p2 && p3 && p4 && p5 && p6;

  console.log('\n=== 结论 ===');
  if (pass) {
    console.log(`  ✅ 全部通过 → 建议黄金线并联回撤通道（最优档 ${bestK}），config 加 dipEnabled 开关（默认关闭=现状）`);
  } else {
    console.log('  ❌ 未通过（默认结论 = 不改）。建议：黄金线维持「250 日价格分位」现状。');
    console.log(`     关键：P1 打破天花板 = ${p1 ? '通过' : '未通过'}（2023 ${y23ok ? '有' : '无'}事件 / 2024 ${y24ok ? '有' : '无'}事件）`);
    console.log('     → 若 P1 未通过，说明 2023-2024 黄金过于平稳（最深回撤仅 7.9%/7.2%），任何回撤阈值都无法触发；');
    console.log('       此时应把"黄金无可靠择时锚（估值类与实际利率类均已实测否决）"作为结论记录，避免以后重复纠结。');
  }

  // 旁证
  console.log('\n--- ⑧ 旁证：018391 样本基金（样本少，仅方向）---');
  if (real.length > NAV_WIN) {
    const Rr = replay(real, cfg);
    let bad2 = 0; Rr.forEach(r => { if (GROUPS.A(r) !== (r.realAction === 'add')) bad2++; });
    console.log(`  回放点 ${Rr.length}，重建一致性不一致 = ${bad2}`);
    keys.forEach(k => console.log('  ' + k.padEnd(5) + ' 命中点 ' + String(Rr.filter(GROUPS[k]).length).padStart(4) + '  事件 ' + String(toEvents(Rr.filter(GROUPS[k])).length).padStart(3)));
  }

  console.log('\n（本脚本为只读回测，未修改任何生产代码或配置）');
})().catch(e => { console.log('FATAL', (e && e.stack) || e); process.exit(1); });

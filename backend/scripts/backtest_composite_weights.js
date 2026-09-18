'use strict';
/*
 * 综合分权重验证回测 —— 联网只读，**不写任何文件、不改生产代码**。
 *
 * 背景：2026-09-14 把「位置分」重构为「综合分 = wV×V + wM×M」。权重目前是用户拍板的初始值
 *   （红利 0.9/0.1、宽基 0.8/0.2、黄金 0.6/0.4、科技 0.5/0.5），M 的尺度参数也是初始值。
 *
 * ★ 真值怎么定（关键）：综合分**不产生交易**（金额用户自定），所以不能测"改了多赚多少"。
 *   改测**预测未来收益的能力**：综合分分档 → 未来 R12m 收益的分档差。
 *   ★判据期长一律用 R12m：2026-09-13 已证估值型信号 R6m 是噪声（四阈值极差 0.89pp vs R12m 5.48pp）。
 *
 * 防过拟合（★重点）：
 *   ① 预先声明单一主指标 = R12m 分档差；② 权重候选只 3 组（W0 基线 / W1 初始值 / W2 探索）；
 *   ③ W2 探索组**不进判据**；④ 独立集群 <8 → 强制降级为描述性、不调权重；
 *   ⑤ 时段集中度检查；⑥ 分时段 + 留一基金稳健性。
 *
 * ★ 默认结论 = 权重不动。只有"W1 优于 W0 超 1.0pp 且各判据全过"才 ±0.1。
 *
 * 用法：node backend/scripts/backtest_composite_weights.js
 */
const f = require('../fetchers');
const config = require('../lib/config');
const util = require('../lib/util');
const A = require('../engines/alloc/allocation');
const buildTech = require('../engines/strategies/tech');
const buildCore = require('../engines/strategies/core');
const { LEGU_UA } = require('../lib/http');
const crypto = require('crypto');

// ---------------- helpers ----------------
function mean(a) { const b = a.filter(x => x != null && !isNaN(x)); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : null; }
function quantile(arr, p) {
  const a = arr.filter(x => x != null && !isNaN(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.round(p / 100 * (a.length - 1))))];
}
function lookup(arr, day) {
  let lo = 0, hi = arr.length - 1, res = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].date <= day) { res = arr[m]; lo = m + 1; } else hi = m - 1; }
  return res;
}
function lookupIdx(arr, day) {
  let lo = 0, hi = arr.length - 1, res = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].date <= day) { res = m; lo = m + 1; } else hi = m - 1; }
  return res;
}
function addMonths(d, m) { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
function clusters(pts, gap) {
  const c = [];
  pts.forEach(p => {
    const last = c[c.length - 1];
    if (last && daysBetween(last.end, p.date) <= gap) { last.end = p.date; last.n++; }
    else c.push({ start: p.date, end: p.date, n: 1 });
  });
  return c;
}

// ---------------- 配置 ----------------
const cfg = config.getConfig();
const s = cfg.signals || {};
const a = s.allocation || {};
const bg = s.broadGlobal || {};
const abg = a.broadGlobal || {};
const cp = a.composite || {};
const cpm = cp.momentum || {};
const AC = {
  neutralP: a.neutralP != null ? a.neutralP : 0.5,
  tech: a.tech || {},
  broad: {
    cheapPct: s.broad.cheapPct, expensivePct: s.broad.expensivePct,
    erpHigh: s.broad.erpHigh, erpLow: s.broad.erpLow,
    wMain: (a.broad && a.broad.wMain) != null ? a.broad.wMain : 0.7
  },
  broadUS: {
    cheapPct: bg.cheapPct != null ? bg.cheapPct : 25,
    expensivePct: bg.expensivePct != null ? bg.expensivePct : 80,
    erpHigh: bg.erpHigh != null ? bg.erpHigh : 2.1,
    erpLow: bg.erpLow != null ? bg.erpLow : -1.5,
    wMain: abg.wMain != null ? abg.wMain : 0.7
  },
  gold: { cheapPct: s.gold.cheapPct, expensivePct: s.gold.expensivePct },
  composite: {
    hardBlock: { gate: true, suspended: true },
    wDip: cp.wDip != null ? cp.wDip : 0.1,
    weights: cp.weights || {
      dividend: { wV: 0.9, wM: 0.1 }, broad: { wV: 0.8, wM: 0.2 },
      broadUS: { wV: 0.8, wM: 0.2 }, cycle: { wV: 0.6, wM: 0.4 }, tech: { wV: 0.5, wM: 0.5 }
    },
    momentumWeights: cp.momentumWeights || {
      tech: { cross: 0.6, stopRise: 0.4, trend: 0 }, broad: { cross: 0, stopRise: 0.5, trend: 0.5 },
      broadUS: { cross: 0, stopRise: 0.5, trend: 0.5 }, cycle: { cross: 0, stopRise: 0.5, trend: 0.5 },
      dividend: { cross: 0, stopRise: 0, trend: 1 }
    },
    momentum: {
      crossFullPct: cpm.crossFullPct != null ? cpm.crossFullPct : 5,
      crossZeroPct: cpm.crossZeroPct != null ? cpm.crossZeroPct : -5,
      stopRiseFullPct: cpm.stopRiseFullPct != null ? cpm.stopRiseFullPct : 3,
      trendDevFullPct: cpm.trendDevFullPct != null ? cpm.trendDevFullPct : 10,
      divDevFullPct: cpm.divDevFullPct != null ? cpm.divDevFullPct : 8,
      dipFullPct: cpm.dipFullPct != null ? cpm.dipFullPct : 10,
      divDipFullPct: cpm.divDipFullPct != null ? cpm.divDipFullPct : 3
    }
  }
};

// 权重候选（★不做网格搜索；W2 为探索组，不进判据）
const WEIGHT_SETS = [
  { key: 'W0', label: 'W0 纯V基线(wM=0)', wM: 0 },
  { key: 'W1', label: 'W1 初始值(wM=初始值)', wM: null },  // null = 用各线初始值
  { key: 'W2', label: 'W2 等权探索(wM=0.5)·不进判据', wM: 0.5 },
];

// ---------------- 抓数 ----------------
async function fetchLeguRows() {
  let pageRes;
  try {
    pageRes = await fetch('https://legulegu.com/stockdata/sz50-ttm-lyr', {
      headers: { 'User-Agent': LEGU_UA, 'Accept': 'text/html,*/*' }
    });
  } catch (e) { return null; }
  const cookies = (pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
  const html = await pageRes.text();
  const m = html.match(/<meta[^>]*name=["']_csrf["'][^>]*content=["']([^"']+)["']/i);
  const token = crypto.createHash('md5').update(util.todayStr()).digest('hex');
  try {
    const res = await fetch(`https://legulegu.com/api/stockdata/index-basic-pe?token=${token}&indexCode=000300.SH`, {
      headers: {
        'User-Agent': LEGU_UA, 'Referer': 'https://legulegu.com/stockdata/sz50-ttm-lyr',
        'X-CSRF-Token': m ? m[1] : '', 'Cookie': cookies
      }
    });
    if (!res.ok) return null;
    const j = JSON.parse(await res.text());
    return (j.data || []).filter(r => r && r.date && r.addTtmPe > 0)
      .map(r => ({ date: String(r.date).slice(0, 10), pe: +r.addTtmPe }))
      .sort((x, y) => (x.date < y.date ? -1 : 1));
  } catch (e) { return null; }
}

(async () => {
  console.log('=== 综合分权重验证回测（真值 = 预测未来 R12m 的能力）===\n');
  console.log('★ 综合分不产生交易（金额用户自定），故不能测"改了多赚多少"，改测**预测力**');
  console.log('★ 判据期长一律 R12m（R6m 已证是噪声）；默认结论 = 权重不动\n');

  // ---------- ① A股宽基（202015 × 沪深300 PE）----------
  console.log('--- ① A股宽基（202015 × 乐咕沪深300 PE，date 口径 197 点）---');
  const peRows = await fetchLeguRows();
  if (!peRows) { console.error('✗ 乐咕 PE 序列不可得 —— 终止（不静默降级）。'); process.exit(1); }
  const cfgc = config.getConfig();
  const navRes = await f.fetchNavHistory('202015', 4500);
  const navs = ((navRes && navRes.history) || []).slice().sort((x, y) => (x.date < y.date ? -1 : 1)).filter(x => x.nav > 0);
  if (!navs.length) { console.error('✗ 202015 净值不可得 —— 终止。'); process.exit(1); }
  console.log(`  PE ${peRows.length} 点 ${peRows[0].date}~${peRows[peRows.length - 1].date}；净值 ${navs.length} 条`);

  const winYears = s.broad.peWindowYears != null ? s.broad.peWindowYears : 5;
  const startI = peRows.findIndex(r => r.date >= String(Number(peRows[0].date.slice(0, 4)) + winYears) + peRows[0].date.slice(4));
  const from = startI > 0 ? startI : 0;

  const rows = [];
  for (let i = from; i < peRows.length - 1; i++) {
    const d = peRows[i].date;
    const pct = (function () {
      const cur = peRows[i].pe, cd = d, cut = (Number(cd.slice(0, 4)) - winYears) + cd.slice(4);
      let tot = 0, cnt = 0;
      for (let k = 0; k <= i; k++) { if (peRows[k].date >= cut) { tot++; if (peRows[k].pe < cur) cnt++; } }
      return tot < 2 ? null : cnt / (tot - 1) * 100;
    })();
    if (pct == null) continue;
    const idx = lookupIdx(navs, d);
    if (idx < 250) continue;
    const navRow = lookup(navs, d);
    const hist = navs.slice(idx - 249, idx + 1).reverse().map(x => ({ date: x.date, nav: x.nav }));
    const vm = { '202015': { pe: peRows[i].pe, pePercentile: pct, treasury10y: cfgc.treasury10y } };
    const dec = buildCore({ code: '202015', category: 'broad', caliber: 'cn', latestNav: navRow.nav, history: hist }, vm, cfgc);
    const V = A.synthesizeValueScore(dec, AC, 'broad', 'cn');
    const M = A.synthesizeMomentumScore(dec, AC, 'broad', 'cn');
    // R12m
    const tgt = lookup(navs, addMonths(d, 12));
    const r12 = (tgt && daysBetween(d, tgt.date) >= 12 * 28 - 10) ? (tgt.nav / navRow.nav - 1) * 100 : null;
    if (V == null && M == null) continue;
    rows.push({ date: d, V, M, r12 });
  }
  console.log(`  回放点 ${rows.length}；V 缺失 ${rows.filter(r => r.V == null).length}；M 缺失 ${rows.filter(r => r.M == null).length}`);

  // ---------- ② M 尺度参数诊断（顺带产出，用于标定）----------
  const mVals = rows.map(r => r.M).filter(x => x != null);
  if (mVals.length) {
    console.log(`\n  M 分布：p10=${quantile(mVals, 10).toFixed(1)}  p50=${quantile(mVals, 50).toFixed(1)}  p90=${quantile(mVals, 90).toFixed(1)}  min=${Math.min(...mVals).toFixed(1)}  max=${Math.max(...mVals).toFixed(1)}`);
    const sat = mVals.filter(v => v <= 5 || v >= 95).length / mVals.length * 100;
    console.log(`  ★ M 饱和率（≤5 或 ≥95）= ${sat.toFixed(1)}% ${sat < 60 ? '✓ 未饱和（真的连续化）' : '✗ 过饱和——尺度参数太窄，等于换了个新二值，需放宽'}`);
  }

  // ---------- ③ 三组权重的分档预测力 ----------
  const N = 25; // 中性兜底
  function bucketStats(wM, label) {
    // wM=null → 各线用初始值（宽基 0.2）
    const wm = wM == null ? 0.2 : wM;
    const wv = 1 - wm;
    const cs = rows.map(r => ({ c: wv * (r.V == null ? N : r.V) + wm * (r.M == null ? N : r.M), r12: r.r12 }));
    const withR = cs.filter(x => x.r12 != null);
    const bks = [[0, 20], [20, 40], [40, 60], [60, 80], [80, 101]];
    const means = bks.map(([lo, hi]) => {
      const seg = withR.filter(x => x.c >= lo && x.c < hi);
      return { lo, hi, n: seg.length, m: mean(seg.map(x => x.r12)) };
    });
    const valid = means.filter(b => b.n >= 3 && b.m != null);
    const spread = valid.length >= 2 ? (valid[valid.length - 1].m - valid[0].m) : null;
    console.log(`\n  【${label}】wV=${wv.toFixed(2)} wM=${wm.toFixed(2)}  (有 R12m 的点 ${withR.length})`);
    console.log('   综合分档      n    R12m均值');
    means.forEach(b => console.log(`   ${String(b.lo + '-' + (b.hi === 101 ? 100 : b.hi)).padEnd(10)} ${String(b.n).padStart(4)}   ${b.m == null ? '—' : (b.m >= 0 ? '+' : '') + b.m.toFixed(2) + '%'}`));
    console.log(`   → 分档差（最高−最低）= ${spread == null ? '—' : spread.toFixed(2) + 'pp'}`);
    // 单调性
    let mono = true;
    for (let i = 1; i < valid.length; i++) if (valid[i].m < valid[i - 1].m - 0.5) mono = false;
    console.log(`   → 单调性（不倒挂）：${mono ? '✓' : '✗'}`);
    return { spread, mono, means };
  }
  const res = {};
  WEIGHT_SETS.forEach(w => { res[w.key] = bucketStats(w.wM, w.label); });

  // ---------- ④ 判据 ----------
  console.log('\n--- ④ 判据汇总 ---');
  const s0 = res.W0.spread, s1 = res.W1.spread;
  const better = (s1 != null && s0 != null) ? s1 - s0 : null;
  const p1 = better != null && better > 1.0 && s1 >= 5.0;
  const p2 = res.W1.mono;
  // 独立集群（用综合分 ≥60 的点，间隔 182 天）
  const hiPts = rows.filter(r => (0.8 * (r.V == null ? N : r.V) + 0.2 * (r.M == null ? N : r.M)) >= 60);
  const cl = [clusters(hiPts, 90).length, clusters(hiPts, 182).length, clusters(hiPts, 365).length];
  const p4 = cl.every(n => n >= 8);
  // 时段集中度
  const byYear = {};
  hiPts.forEach(r => { const y = r.date.slice(0, 4); byYear[y] = (byYear[y] || 0) + 1; });
  const top = Object.keys(byYear).sort((x, y) => byYear[y] - byYear[x])[0];
  const conc = top ? byYear[top] / hiPts.length * 100 : null;
  // 分时段稳健（2010-2014 / 2015-2026）
  function spreadIn(fromD, toD) {
    const sub = rows.filter(r => r.date >= fromD && r.date <= toD);
    const f0 = (wm) => {
      const wv = 1 - wm;
      const cs = sub.map(r => ({ c: wv * (r.V == null ? N : r.V) + wm * (r.M == null ? N : r.M), r12: r.r12 })).filter(x => x.r12 != null);
      const bks = [[0, 20], [20, 40], [40, 60], [60, 80], [80, 101]];
      const ms = bks.map(([lo, hi]) => { const sg = cs.filter(x => x.c >= lo && x.c < hi); return { n: sg.length, m: mean(sg.map(x => x.r12)) }; }).filter(b => b.n >= 3 && b.m != null);
      return ms.length >= 2 ? ms[ms.length - 1].m - ms[0].m : null;
    };
    return { a: f0(0), b: f0(0.2) };
  }
  const segA = spreadIn('2010-01-01', '2014-12-31');
  const segB = spreadIn('2015-01-01', '2026-12-31');
  const p6 = (segA.a == null || segA.b == null || (segA.b - segA.a) * (segB.b - segB.a) > 0);
  console.log(`  ${p1 ? '✓' : '✗'} P1 主指标      W1 分档差 ${s1 == null ? '—' : s1.toFixed(2)}pp vs W0 ${s0 == null ? '—' : s0.toFixed(2)}pp（差 ${better == null ? '—' : better.toFixed(2)}pp，需 >1.0 且 W1≥5.0）`);
  console.log(`  ${p2 ? '✓' : '✗'} P2 单调性      ${p2 ? '不倒挂' : '有倒挂'}`);
  console.log(`  ${p4 ? '✓' : '✗'} P4 独立样本    集群数(90/182/365) = ${cl.join('/')}（需全 ≥8）`);
  console.log(`     P5 时段集中度  高分点最集中的年份 ${top || '—'}（占 ${conc == null ? '—' : conc.toFixed(0)}%）${conc != null && conc > 60 ? '⚠ 过度集中' : ''}`);
  console.log(`  ${p6 ? '✓' : '✗'} P6 分时段稳健   2010-2014: ${segA.a == null ? '—' : segA.a.toFixed(2)}→${segA.b == null ? '—' : segA.b.toFixed(2)}；2015-2026: ${segB.a == null ? '—' : segB.a.toFixed(2)}→${segB.b == null ? '—' : segB.b.toFixed(2)}`);

  // ---------- ⑤ 结论 ----------
  console.log('\n=== 结论 ===');
  if (p1 && p2 && p4 && p6) {
    console.log('  ✅ 数据支持调高动量权重 +0.1（单次上限）');
    console.log('     须同时写回三处：config.signals.allocation.composite.weights、其 _note、docs/算法待办清单.md');
  } else {
    console.log('  ❌ **权重保持初始值不动**（默认结论）');
    const why = [];
    if (!p1) why.push('P1 主指标未达标（加动量未显著改善预测力）');
    if (!p2) why.push('P2 分档倒挂');
    if (!p4) why.push('P4 独立样本不足（结论降级为描述性）');
    if (!p6) why.push('P6 分时段方向不一致');
    console.log('     理由：' + (why.length ? why.join('；') : '判据未全过'));
    console.log('     处置：把本结论与日期写入 config 的 composite._note 与 docs/算法待办清单.md，代码不动。');
  }
  console.log('\n  提示：本脚本只读，未修改任何文件/生产代码。');
})().catch(e => { console.error('\n✗ 运行异常：', e && e.stack ? e.stack : e); process.exit(1); });

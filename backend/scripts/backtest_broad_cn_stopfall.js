'use strict';
/*
 * A股宽基「便宜区加止跌确认」回测 —— 联网只读，**不写任何文件、不改生产代码**。
 *
 * 要回答的问题：
 *   现在 A股宽基（202015，broad+cn）是「PE分位 ≤25 → 直接 add」，便宜区没有任何趋势门槛。
 *   要不要改成「便宜 且 止跌 → 才 add」？
 *
 * 为什么必须先回测：
 *   海外宽基（纳指）已经实测过——回撤通道加止跌后，信号后 6 月超额从 +16.7% 掉到 +5.9%，
 *   **加了反而变差**。机理：估值信号出现在下跌中途，等"止跌"确认时反弹已走了一截。
 *   所以本次**默认结论 = 不改**，必须过 P1~P6 六道关才建议落地。
 *
 * 数据源（★ 与生产同源，保证口径一致）：
 *   ① 沪深300 PE：乐咕 index-basic-pe 全序列（月频 258 点，2005-04~2026-09，字段 addTtmPe）
 *      —— 生产 fetchLeguValuation 就是用这个接口、这个字段、这个"近N年滚动分位"公式。
 *   ② 202015 净值：东财 f10/lsjz（日频 4252 条，2009-03~2026-09）
 *   ③ 中债10年：东财 RPTA_WEB_TREASURYYIELD / EMM00166466（只影响中性区 ERP 分支，
 *      不影响便宜区；抓不到则回退 config.treasury10y 常量并在报告声明）
 *
 * ★★ 无未来函数（本脚本的生命线）：
 *   - 分位窗口只取 date <= 当前点 的记录（生产是"今天"，天然无未来；回放时必须显式截断）
 *   - 净值只取 date <= 当前点 的记录构造 history
 *   - 收益 R 用"未来"净值算，那是被预测量，不算未来函数
 *
 * 用法：node backend/scripts/backtest_broad_cn_stopfall.js
 */
const f = require('../fetchers');
const config = require('../lib/config');
const util = require('../lib/util');
const buildCoreDecision = require('../engines/strategies/core');
const { LEGU_UA } = require('../lib/http');
const crypto = require('crypto');

const FUND_CODE = '202015';
const LEGU_CODE = '000300.SH';
const NAV_LOOKBACK = 250;      // 与生产 analysis.js 同口径
const EVENT_GAP_DAYS = 28;     // 相邻触发 ≤4 周合并为一个事件
const BOOT_ITERS = 1000;

// 关键底部（搜索窗口内自动取净值最低日为锚点）
const BOTTOMS = [
  { label: '2018-12 贸易战底', from: '2018-11-15', to: '2019-01-31' },
  { label: '2020-03 疫情底', from: '2020-02-20', to: '2020-04-15' },
  { label: '2022-10 大底', from: '2022-09-20', to: '2022-11-30' },
  { label: '2024-01~02 流动性底', from: '2024-01-10', to: '2024-03-05' },
  { label: '2024-09 政策底', from: '2024-08-20', to: '2024-10-10' },
  { label: '2025-04 关税急跌', from: '2025-03-25', to: '2025-05-15' },
];

const fx = (v, d) => (v == null || isNaN(v) ? '—' : (+v).toFixed(d == null ? 2 : d));
const pp = (v, d) => (v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (+v).toFixed(d == null ? 2 : d) + 'pp');

function mean(a) { const b = a.filter(x => x != null && !isNaN(x)); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : null; }
function median(a) { const b = a.filter(x => x != null && !isNaN(x)).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
function quantile(arr, p) { const a = arr.filter(x => x != null && !isNaN(x)).slice().sort((x, y) => x - y); if (!a.length) return null; const i = Math.min(a.length - 1, Math.max(0, Math.round(p / 100 * (a.length - 1)))); return a[i]; }

// 取 ≤ day 的最近一条（升序数组，二分）
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
function addMonths(dateStr, m) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + m);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }

// ---------- 数据抓取 ----------

// ① 乐咕沪深300 PE 全序列（复刻 fetchers.fetchLeguValuation 的两步鉴权；只取序列不做分位）
async function fetchLeguRows() {
  let pageRes;
  try {
    pageRes = await fetch('https://legulegu.com/stockdata/sz50-ttm-lyr', {
      headers: { 'User-Agent': LEGU_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' }
    });
  } catch (e) { return null; }
  const cookies = (pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
  const html = await pageRes.text();
  const m = html.match(/<meta[^>]*name=["']_csrf["'][^>]*content=["']([^"']+)["']/i);
  const csrf = m ? m[1] : '';
  const token = crypto.createHash('md5').update(util.todayStr()).digest('hex');
  try {
    const res = await fetch(`https://legulegu.com/api/stockdata/index-basic-pe?token=${token}&indexCode=${LEGU_CODE}`, {
      headers: {
        'User-Agent': LEGU_UA, 'Referer': 'https://legulegu.com/stockdata/sz50-ttm-lyr',
        'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9',
        'X-CSRF-Token': csrf, 'Cookie': cookies
      }
    });
    if (!res.ok) return null;
    const j = JSON.parse(await res.text());
    const rows = (j && j.data) || [];
    return rows.filter(r => r && r.date && r.addTtmPe != null && r.addTtmPe > 0)
      .map(r => ({ date: String(r.date).slice(0, 10), pe: +r.addTtmPe }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch (e) { return null; }
}

// ③ 中债10年（东财，列 EMM00166466；与 calibrate_broad_global.js 同模板）
async function fetchCnBond(maxPages) {
  const out = [];
  for (let p = 1; p <= (maxPages || 8); p++) {
    try {
      const url = 'https://datacenter.eastmoney.com/api/data/get?type=RPTA_WEB_TREASURYYIELD&sty=ALL'
        + '&st=SOLAR_DATE&sr=-1&token=894050c76af8597a853f5b408b759f5d'
        + `&p=${p}&ps=500&pageNo=${p}&pageNum=${p}`;
      const res = await fetch(url, { headers: { 'User-Agent': LEGU_UA, 'Referer': 'https://data.eastmoney.com/cjsj/zmgzsyl.html' } });
      if (!res.ok) break;
      const j = JSON.parse(await res.text());
      const rows = (j && j.result && j.result.data) || [];
      if (!rows.length) break;
      rows.forEach(r => { if (r.EMM00166466 != null) out.push({ date: String(r.SOLAR_DATE).slice(0, 10), cn: r.EMM00166466 }); });
    } catch (e) { break; }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------- 回放 ----------

// 复刻生产分位公式（fetchers.js:96-103），但★显式截断到当前点（无未来函数）
function rollingPct(rows, i, winYears) {
  const cur = rows[i].pe, curDate = rows[i].date;
  const cutY = Number(curDate.slice(0, 4)) - winYears;
  const cutStr = cutY + curDate.slice(4);
  const win = rows.filter(r => r.date >= cutStr && r.date <= curDate);
  if (win.length < 2) return null;
  return win.filter(r => r.pe < cur).length / (win.length - 1) * 100;
}

// 收益：R(d,h) = navOn(d+h月)/navOn(d) − 1；未到期记 null
function returns(navs, date) {
  const base = lookup(navs, date);
  if (!base || !base.nav) return { r1: null, r3: null, r6: null, r12: null };
  const out = {};
  [['r1', 1], ['r3', 3], ['r6', 6], ['r12', 12]].forEach(([k, h]) => {
    const tgt = lookup(navs, addMonths(date, h));
    if (!tgt || !tgt.nav) { out[k] = null; return; }
    if (daysBetween(date, tgt.date) < h * 28 - 10) { out[k] = null; return; } // 到期不足（数据未覆盖）
    out[k] = (tgt.nav / base.nav - 1) * 100;
  });
  return out;
}

// 事件化：相邻命中点 ≤ EVENT_GAP_DAYS 合并
function toEvents(hits) {
  const ev = [];
  hits.forEach(h => {
    const last = ev[ev.length - 1];
    if (last && daysBetween(last.date, h.date) <= EVENT_GAP_DAYS) {
      last.points.push(h);           // 合并：保留首点为事件日
    } else {
      ev.push({ date: h.date, points: [h] });
    }
  });
  return ev;
}

function bootstrapDelta(a, b, iters) {
  // a=A 组收益数组, b=B 组；返回 mean(b)-mean(a) 的分布分位
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
  const b = (cfg.signals && cfg.signals.broad) || {};
  const cheapPct = b.cheapPct != null ? b.cheapPct : 30;
  const expensivePct = b.expensivePct != null ? b.expensivePct : 70;
  const winYears = b.peWindowYears != null ? b.peWindowYears : 5;
  const stopWindow = b.stopWindow || 20;

  console.log('=== A股宽基「便宜区加止跌」回测（202015 × 沪深300）===\n');
  console.log('阈值（读自 config.json signals.broad）：'
    + `cheapPct=${cheapPct}  expensivePct=${expensivePct}  peWindowYears=${winYears}  stopWindow=${stopWindow}`);
  console.log('（注意：core.js 的硬编码默认值是 30/70，生产值来自 config，不能写死）\n');

  // ---- 抓数 ----
  console.log('--- ① 沪深300 PE 全序列（乐咕 index-basic-pe / addTtmPe）---');
  const peRows = await fetchLeguRows();
  if (!peRows || peRows.length < 60) { console.log('  ✗ 取不到乐咕 PE 序列，无法回测。'); process.exit(1); }
  console.log(`  n=${peRows.length}  范围 ${peRows[0].date} ~ ${peRows[peRows.length - 1].date}  最新 PE=${fx(peRows[peRows.length - 1].pe)}`);

  console.log('\n--- ② 202015 净值历史（东财 f10/lsjz）---');
  const navRes = await f.fetchNavHistory(FUND_CODE, 4500);
  const navsDesc = (navRes && navRes.history) || [];
  if (navsDesc.length < 300) { console.log('  ✗ 净值不足，无法回测。'); process.exit(1); }
  const navs = navsDesc.slice().sort((x, y) => (x.date < y.date ? -1 : 1)); // 升序
  console.log(`  n=${navs.length}  范围 ${navs[0].date} ~ ${navs[navs.length - 1].date}`);

  // 分红跳空诊断（防脏数据）
  let jumpDays = 0, jumpMax = 0;
  for (let i = 1; i < navs.length; i++) {
    const p = navs[i - 1].nav, c = navs[i].nav;
    if (p > 0 && c > 0) { const d = (c / p - 1) * 100; if (d < -5) { jumpDays++; jumpMax = Math.min(jumpMax, d); } }
  }
  console.log(`  分红跳空诊断：单日跌幅 <-5% 的天数 = ${jumpDays}${jumpDays ? '（最大 ' + fx(jumpMax) + '%）⚠ 需人工确认是否除权' : ' ✓ 无异常跳空'}`);

  console.log('\n--- ③ 中债10年（东财 EMM00166466）---');
  const cn = await fetchCnBond(8);
  if (cn.length) console.log(`  n=${cn.length}  范围 ${cn[0].date} ~ ${cn[cn.length - 1].date}  最新 ${fx(cn[cn.length - 1].cn)}%`);
  else console.log(`  ✗ 取不到 → 回退 config.treasury10y 常量 ${cfg.treasury10y}（仅影响中性区 ERP 分支，不影响便宜区结论）`);

  // ---- 一致性断言（先证明"重建 = 生产"，否则整个回测作废）----
  console.log('\n--- ④ 一致性断言（不通过则整个回测作废）---');
  let asrtFail = 0;
  // (a) 最新一点：自算分位 vs 生产 fetchLeguValuation
  const prod = await f.fetchLeguValuation(LEGU_CODE, winYears);
  const lastI = peRows.length - 1;
  const myPct = rollingPct(peRows, lastI, winYears);
  if (prod && prod.pePercentile != null && myPct != null) {
    const diff = Math.abs(prod.pePercentile - myPct);
    const ok = diff <= 0.6; // 允许窗口边界/当日更新造成的微小差异
    console.log(`  [a] 最新点分位 vs 生产：自算 ${fx(myPct, 1)}  生产 ${fx(prod.pePercentile, 1)}  Δ=${fx(diff, 2)}  ${ok ? '✓' : '✗'}`);
    if (!ok) asrtFail++;
  } else { console.log('  [a] 生产值取不到，跳过（不阻断）'); }

  // (b) 抽 40 点：便宜区必须 add，且 matrix.pePercentile 与自算一致
  const sampleIdx = [];
  const startI = peRows.findIndex(r => r.date >= String(Number(peRows[0].date.slice(0, 4)) + winYears) + peRows[0].date.slice(4));
  const from = startI > 0 ? startI : 0;
  const step = Math.max(1, Math.floor((peRows.length - from - 1) / 40));
  for (let i = from; i < peRows.length - 1; i += step) sampleIdx.push(i);

  const fund0 = { code: FUND_CODE, category: 'broad', caliber: 'cn' };
  let chkAdd = 0, chkPct = 0;
  sampleIdx.forEach(i => {
    const d = peRows[i].date;
    const pct = rollingPct(peRows, i, winYears);
    if (pct == null) return;
    const navRow = lookup(navs, d);
    if (!navRow) return;
    const idx = lookupIdx(navs, d);
    if (idx < NAV_LOOKBACK) return;
    const hist = navs.slice(idx - NAV_LOOKBACK + 1, idx + 1).reverse().map(x => ({ date: x.date, nav: x.nav }));
    const cnRow = cn.length ? lookup(cn, d) : null;
    const vm = { [FUND_CODE]: { pe: peRows[i].pe, pePercentile: pct, treasury10y: cnRow ? cnRow.cn / 100 : cfg.treasury10y } };
    const dec = buildCoreDecision(Object.assign({}, fund0, { latestNav: navRow.nav, history: hist }), vm, cfg);
    if (pct <= cheapPct && dec.action !== 'add') chkAdd++;
    const mp = dec.matrix && dec.matrix.pePercentile;
    if (mp != null && Math.abs(mp - pct) > 0.02) chkPct++;
  });
  console.log(`  [b] 抽样 ${sampleIdx.length} 点：便宜区未给 add 的次数 = ${chkAdd}（应为 0）  ${chkAdd === 0 ? '✓' : '✗'}`);
  console.log(`  [c] 抽样点 matrix.pePercentile 与自算不一致次数 = ${chkPct}（应为 0）  ${chkPct === 0 ? '✓' : '✗'}`);
  if (chkAdd > 0 || chkPct > 0) asrtFail++;
  if (asrtFail) { console.log('\n  ✗ 一致性断言未通过——回测公式与生产不一致，结论不可信，终止。'); process.exit(1); }
  console.log('  → 一致性通过：回测重建的判定与生产逐点一致。\n');

  // ---- 正式回放 ----
  console.log('--- ⑤ 回放（每个 PE 点调真实生产函数 buildCoreDecision）---');
  const hits = { A: [], B: [], C1: [], C2: [], D: [], E: [] };
  let scanned = 0;
  for (let i = from; i < peRows.length - 1; i++) {
    const d = peRows[i].date;
    const pct = rollingPct(peRows, i, winYears);
    if (pct == null) continue;
    const navRow = lookup(navs, d);
    if (!navRow || !navRow.nav) continue;
    const idx = lookupIdx(navs, d);
    if (idx < NAV_LOOKBACK) continue;
    scanned++;
    const hist = navs.slice(idx - NAV_LOOKBACK + 1, idx + 1).reverse().map(x => ({ date: x.date, nav: x.nav }));
    const cnRow = cn.length ? lookup(cn, d) : null;
    const vm = { [FUND_CODE]: { pe: peRows[i].pe, pePercentile: pct, treasury10y: cnRow ? cnRow.cn / 100 : cfg.treasury10y } };
    const dec = buildCoreDecision(Object.assign({}, fund0, { latestNav: navRow.nav, history: hist }), vm, cfg);
    const r = returns(navs, d);
    const row = { date: d, pe: peRows[i].pe, pct, action: dec.action, r };
    const isAdd = dec.action === 'add';
    const stop20 = util.stableLow(hist, 20);
    const stop10 = util.stableLow(hist, 10);
    const stop30 = util.stableLow(hist, 30);
    const ma20 = util.computeMA(hist, 20);
    const aboveMa20 = ma20 != null && navRow.nav > ma20;
    row.stop20 = stop20; row.aboveMa20 = aboveMa20;
    if (isAdd) {
      hits.A.push(row);
      if (stop20) hits.B.push(row);
      if (stop10) hits.C1.push(row);
      if (stop30) hits.C2.push(row);
      if (aboveMa20) hits.D.push(row);
      if (stop20 || aboveMa20) hits.E.push(row);
    }
  }
  console.log(`  扫描点 ${scanned} 个（${peRows[from].date} ~ ${peRows[peRows.length - 2].date}）`);

  const events = {};
  Object.keys(hits).forEach(k => { events[k] = toEvents(hits[k]); });
  // 事件收益 = 事件首点收益
  const evR = k => events[k].map(e => e.points[0].r);
  // 入参是 row 数组（收益挂在 row.r.{r1,r3,r6,r12}）
  const stat = arr => {
    const g = k => arr.map(x => (x && x.r ? x.r[k] : null));
    const v6 = g('r6').filter(x => x != null);
    return {
      n: arr.length,
      m1: mean(g('r1')), m3: mean(g('r3')), m6: mean(g('r6')), m12: mean(g('r12')),
      med6: median(g('r6')), worst6: v6.length ? Math.min(...v6) : null, n6: v6.length,
    };
  };

  // 全期随机入场基准（所有扫描点的 R6m 均值）
  const allR6 = [];
  for (let i = from; i < peRows.length - 1; i++) {
    const d = peRows[i].date;
    if (rollingPct(peRows, i, winYears) == null) continue;
    const navRow = lookup(navs, d); if (!navRow) continue;
    const r = returns(navs, d); if (r.r6 != null) allR6.push(r.r6);
  }

  console.log('\n--- ⑥ 逐年触发次数（事件数，相邻 ≤4 周合并）---');
  const years = [...new Set(events.A.map(e => e.date.slice(0, 4)))].sort();
  console.log('  年份   ' + Object.keys(hits).map(k => k.padStart(4)).join(' '));
  years.forEach(y => {
    console.log('  ' + y + '  ' + Object.keys(hits).map(k => String(events[k].filter(e => e.date.slice(0, 4) === y).length).padStart(4)).join(' '));
  });
  console.log('  合计   ' + Object.keys(hits).map(k => String(events[k].length).padStart(4)).join(' '));

  console.log('\n--- ⑦ 各组信号后收益（%，相对信号日）---');
  console.log('  组    事件数  R6m样本  R1m     R3m     R6m     R12m    R6m中位  最差R6m');
  Object.keys(hits).forEach(k => {
    const s = stat(events[k].map(e => e.points[0]));
    console.log('  ' + k.padEnd(5) + String(s.n).padStart(5) + String(s.n6).padStart(8) + '  '
      + fx(s.m1, 1).padStart(7) + fx(s.m3, 1).padStart(8) + fx(s.m6, 1).padStart(8) + fx(s.m12, 1).padStart(8)
      + fx(s.med6, 1).padStart(9) + fx(s.worst6, 1).padStart(9));
  });
  console.log(`  [基准] 全期任意点入场 R6m 均值 = ${fx(mean(allR6), 1)}%（n=${allR6.length}）`);

  // ---- ★ 最关键的一张表 ----
  console.log('\n--- ⑧ ★★ 最关键：被"止跌"筛掉的信号，是不是坏信号？---');
  const bDates = new Set(events.B.map(e => e.date));
  const aOnly = events.A.filter(e => !bDates.has(e.date));   // 便宜但未止跌 → 被 B 筛掉
  const aBoth = events.A.filter(e => bDates.has(e.date));    // 便宜且已止跌
  const stOnly = stat(aOnly.map(e => e.points[0]));
  const stBoth = stat(aBoth.map(e => e.points[0]));
  console.log('  分组              事件数   R6m均值    R6m中位   最差R6m');
  console.log('  A∩B（便宜且止跌）' + String(stBoth.n).padStart(6) + fx(stBoth.m6, 1).padStart(10) + fx(stBoth.med6, 1).padStart(11) + fx(stBoth.worst6, 1).padStart(10));
  console.log('  A_only（被筛掉） ' + String(stOnly.n).padStart(6) + fx(stOnly.m6, 1).padStart(10) + fx(stOnly.med6, 1).padStart(11) + fx(stOnly.worst6, 1).padStart(10));

  // ---- Bootstrap ----
  const r6A = events.A.map(e => e.points[0].r.r6).filter(x => x != null);
  const r6B = events.B.map(e => e.points[0].r.r6).filter(x => x != null);
  const delta = (r6A.length && r6B.length) ? (mean(r6B) - mean(r6A)) : null;
  const boot = (r6A.length >= 3 && r6B.length >= 3) ? bootstrapDelta(r6A, r6B, BOOT_ITERS) : null;
  console.log('\n--- ⑨ Bootstrap（1000 次）B−A 的 R6m 差值分布 ---');
  console.log(`  点估计 Δ = ${pp(delta)}`);
  if (boot) console.log(`  p10 = ${pp(boot.p10)}   p50 = ${pp(boot.p50)}   p90 = ${pp(boot.p90)}   （判据看 p10 是否 > 0）`);

  // ---- 底部覆盖 ----
  console.log('\n--- ⑩ 关键底部覆盖（窗口内净值最低日为锚点，锚点 ±4 周内有事件=覆盖）---');
  const cover = { A: 0, B: 0 };
  const bottomsReport = [];
  BOTTOMS.forEach(bt => {
    const lo = lookupIdx(navs, bt.from), hi = lookupIdx(navs, bt.to);
    if (lo < 0 || hi < 0) { bottomsReport.push({ label: bt.label, anchor: null }); return; }
    let minI = lo;
    for (let i = lo; i <= hi; i++) if (navs[i].nav < navs[minI].nav) minI = i;
    const anchor = navs[minI];
    const near = (arr) => arr.some(e => Math.abs(daysBetween(anchor.date, e.date)) <= 28);
    const cA = near(events.A), cB = near(events.B);
    if (cA) cover.A++; if (cB) cover.B++;
    const rr = returns(navs, anchor.date);
    bottomsReport.push({ label: bt.label, anchor: anchor.date, nav: anchor.nav, cA, cB, r3: rr.r3, r6: rr.r6, r12: rr.r12 });
  });
  console.log('  底部                     锚点日       A覆盖  B覆盖   锚点后R3m  R6m   R12m');
  bottomsReport.forEach(x => {
    if (!x.anchor) { console.log('  ' + x.label.padEnd(24) + '（无净值数据）'); return; }
    console.log('  ' + x.label.padEnd(24) + x.anchor + '   '
      + (x.cA ? ' ✓ ' : ' ✗ ') + '   ' + (x.cB ? ' ✓ ' : ' ✗ ') + '   '
      + fx(x.r3, 1).padStart(8) + fx(x.r6, 1).padStart(7) + fx(x.r12, 1).padStart(7));
  });
  console.log(`  覆盖合计：A=${cover.A}/${BOTTOMS.length}  B=${cover.B}/${BOTTOMS.length}`);

  // ---- 判据 ----
  console.log('\n--- ⑪ 落地判据（P1~P6 全过才建议改）---');
  const sA = stat(events.A.map(e => e.points[0]));
  const sB = stat(events.B.map(e => e.points[0]));
  const sC1 = stat(events.C1.map(e => e.points[0]));
  const sC2 = stat(events.C2.map(e => e.points[0]));
  const missBottoms = bottomsReport.filter(x => x.anchor && x.cA && !x.cB);
  const bigMiss = missBottoms.filter(x => x.r12 != null && x.r12 >= 15);
  const p1 = delta != null && delta >= 2.0 && boot && boot.p10 > 0;
  const p2 = stOnly.n >= 5 && stBoth.m6 != null && stOnly.m6 != null && stOnly.m6 <= stBoth.m6 - 2.0;
  const p3 = cover.B >= cover.A - 1 && bigMiss.length === 0;
  const p4 = sA.n >= 12 && sB.n >= 8;
  const d1 = (sC1.m6 != null && sA.m6 != null) ? sC1.m6 - sA.m6 : null;
  const d2 = (sC2.m6 != null && sA.m6 != null) ? sC2.m6 - sA.m6 : null;
  const p5 = d1 != null && d2 != null && d1 > 0 && d2 > 0;
  const zeroYears = years.filter(y => events.B.filter(e => e.date.slice(0, 4) === y).length === 0);
  let maxZeroRun = 0, cur0 = 0, prevY = null;
  zeroYears.forEach(y => { if (prevY != null && Number(y) === Number(prevY) + 1) cur0++; else cur0 = 1; maxZeroRun = Math.max(maxZeroRun, cur0); prevY = y; });
  const p6 = maxZeroRun < 3;

  const rows = [
    ['P1 质量提升', `ΔR6m = ${pp(delta)}（门槛 ≥+2.0pp）且 bootstrap p10 = ${boot ? pp(boot.p10) : '—'} > 0`, p1],
    ['P2 筛掉的是坏信号', `A_only n=${stOnly.n}（≥5）且 R6m ${fx(stOnly.m6, 1)}% ≤ A∩B ${fx(stBoth.m6, 1)}% − 2.0pp`, p2],
    ['P3 不踏空', `B 覆盖 ${cover.B} vs A 覆盖 ${cover.A}；漏 ${missBottoms.length} 个（其中后12月涨≥15% 的 ${bigMiss.length} 个）`, p3],
    ['P4 样本量', `A 事件 ${sA.n}（≥12）、B 事件 ${sB.n}（≥8）`, p4],
    ['P5 窗口稳健', `stopWindow 10 → Δ=${pp(d1)}，30 → Δ=${pp(d2)}（需同为正）`, p5],
    ['P6 不失效', `B 组最长连续零事件年数 = ${maxZeroRun}（需 <3）`, p6],
  ];
  rows.forEach(([k, d, ok]) => console.log(`  ${ok ? '✓' : '✗'} ${k.padEnd(16)} ${d}`));
  const pass = p1 && p2 && p3 && p4 && p5 && p6;
  console.log('\n=== 结论 ===');
  if (pass) {
    console.log('  ✅ P1~P6 全部通过 → 建议落地：便宜区加止跌确认（改 kernel.js peErp 分支，config 加 requireStopFall）');
  } else {
    console.log('  ❌ 未通过（默认结论 = 不改）。建议：**保持现状**，便宜区不加止跌门槛。');
    console.log(`     本次测得 ΔR6m = ${pp(delta)}（门槛 +2.0pp）；把结论与日期写入 config.json signals.broad._note，代码不动。`);
  }
  console.log('\n（本脚本为只读回测，未修改任何生产代码或配置）');
})().catch(e => { console.log('FATAL', (e && e.stack) || e); process.exit(1); });

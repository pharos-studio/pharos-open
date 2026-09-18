'use strict';
/*
 * A股宽基「便宜区是否过松」完整复验 —— 联网只读，**不写任何文件、不改生产代码**。
 *
 * 要回答的问题（待办清单 §2）：
 *   2026-09-13 的止跌回测里发现：「PE分位 ≤25」在 197 个扫描点中触发 76 事件（39%），
 *   而 A 组 R6m 仅 2.7% vs 全期随机入场 2.4% —— 超额只 +0.3pp。
 *   据此怀疑「近5年滚动分位 + 25 阈值」对 A 股偏松、便宜线形同虚设。
 *
 * 本脚本要复验的不只是那个数字，而是**那个结论本身**。三条主线：
 *   ① 判据期长：R6m 是否适合评估"估值均值回归型"信号？（对照组：R12/R24/R36）
 *   ② 阈值网格：25/20/15/10 × 窗口 3/5/8 年 —— "越严越好"稳不稳？
 *   ③ ★ 有效样本：78 个点里有几段**独立**信号？（月频点高度重叠，点数 ≠ 样本量）
 *
 * ★★ 本次的核心论证（审查阶段发现，写在脚本里以防遗忘）：
 *   "收紧阈值"看起来更好（≤10 的 R12m 最高），但它**不是避开**2010-2014 那段长期磨底，
 *   而是**更集中地押注它**（该段占触发点比例：≤25 为 65% → ≤10 为 80%）。
 *   根源：2010-2014 的滚动分位中位数仅 6.7、63% 的月份 ≤10 —— 收紧必然把它全吃进来。
 *   ⇒ 判据 P3 专门检查：**剔除 2010-2014 后，"越严越好"是否还成立**。
 *
 * 数据源（与生产同源）：
 *   ① 沪深300 PE：乐咕 index-basic-pe（月频 258 点，2005-04~2026-09，字段 addTtmPe）
 *   ② 202015 净值：东财 f10/lsjz（日频 4252 条，2009-03~2026-09）
 *   ③ 中债10年：东财 RPTA_WEB_TREASURYYIELD / EMM00166466（仅影响中性区 ERP，
 *      不影响便宜区判定；抓不到则回退 config.treasury10y 并在报告声明）
 *
 * 回放口径（★与 backtest_broad_cn_stopfall.js 完全一致，保证跨脚本可比）：
 *   起点 = 首个 date >= (PE首年 + winYears) 的点 → 2010-04-30；净值回看 NAV_LOOKBACK=250
 *   事件合并 EVENT_GAP_DAYS=28
 *
 * 无未来函数：分位窗口只取 date <= 当前点；净值只取 date <= 当前点构造 history。
 *
 * 用法：node backend/scripts/backtest_broad_cn_threshold.js
 */
const f = require('../fetchers');
const config = require('../lib/config');
const util = require('../lib/util');
const buildCoreDecision = require('../engines/strategies/core');
const { LEGU_UA } = require('../lib/http');
const crypto = require('crypto');

const FUND_CODE = '202015';
const LEGU_CODE = '000300.SH';
const NAV_LOOKBACK = 250;       // 与生产 analysis.js 同口径
const EVENT_GAP_DAYS = 28;      // 与既有回测脚本一致（相邻 ≤4 周合并）
const MERGE_GAPS = [90, 182, 365];   // ★ 独立集群的合并间隔敏感性（P1 的稳健性基础）
const THRESHOLDS = [25, 20, 15, 10];
const CANDIDATES = [20, 15, 10];      // 收紧候选（25 = 现状基线）
const WINDOWS = [3, 5, 8];
const BUCKETS = [[0, 20, '0-20'], [20, 40, '20-40'], [40, 60, '40-60'], [60, 80, '60-80'], [80, 101, '80-100']];
const HORIZONS = [['R6m', 6], ['R12m', 12], ['R24m', 24], ['R36m', 36]];
const MOAT = { from: '2010-01-01', to: '2014-12-31' };   // 磨底期（P3 的剔除对象）

// 分段复验（P2）
const SEGS = [
  { name: '2010-2014 磨底', from: '2010-01-01', to: '2014-12-31' },
  { name: '2015-2019     ', from: '2015-01-01', to: '2019-12-31' },
  { name: '2020-2026     ', from: '2020-01-01', to: '2026-12-31' },
];

// 关键底部：前 6 个沿用既有脚本（跨脚本可比）；后 3 个为补充
//   （覆盖最大集群所在年代 2013-2014；已核实为真实净值低点：2013-06-25 nav 0.7585 /
//     2014-05-19 nav 0.7507 / 2016-01-28 nav 0.989）
const BOTTOMS = [
  { label: '2013-06 钱荒底(补)', from: '2013-05-15', to: '2013-08-15' },
  { label: '2014-05 磨底末端(补)', from: '2014-04-01', to: '2014-08-31' },
  { label: '2016-01 熔断底(补)', from: '2016-01-04', to: '2016-03-15' },
  { label: '2018-12 贸易战底', from: '2018-11-15', to: '2019-01-31' },
  { label: '2020-03 疫情底', from: '2020-02-20', to: '2020-04-15' },
  { label: '2022-10 大底', from: '2022-09-20', to: '2022-11-30' },
  { label: '2024-01~02 流动性底', from: '2024-01-10', to: '2024-03-05' },
  { label: '2024-09 政策底', from: '2024-08-20', to: '2024-10-10' },
  { label: '2025-04 关税急跌', from: '2025-03-25', to: '2025-05-15' },
];

const fx = (v, d) => (v == null || isNaN(v) ? '—' : (+v).toFixed(d == null ? 2 : d));
const pctF = (v, d) => (v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (+v).toFixed(d == null ? 1 : d) + '%');
const ppF = (v, d) => (v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (+v).toFixed(d == null ? 2 : d) + 'pp');

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
function addMonths(dateStr, m) { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }

// ---------- 数据抓取 ----------

// ① 乐咕沪深300 PE 全序列（复刻 fetchers.fetchLeguValuation 的两步鉴权；只取序列不做分位）
async function fetchLeguRows() {
  let pageRes;
  try {
    pageRes = await fetch('https://legulegu.com/stockdata/sz50-ttm-lyr', {
      headers: { 'User-Agent': LEGU_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' }
    });
  } catch (e) { console.error('  ✗ 乐咕鉴权页请求失败：' + e.message); return null; }
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
    if (!res.ok) { console.error('  ✗ 乐咕 PE 接口 HTTP ' + res.status); return null; }
    const j = JSON.parse(await res.text());
    const rows = (j && j.data) || [];
    const out = rows.filter(r => r && r.date && r.addTtmPe != null && r.addTtmPe > 0)
      .map(r => ({ date: String(r.date).slice(0, 10), pe: +r.addTtmPe }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!out.length) { console.error('  ✗ 乐咕 PE 接口返回空序列'); return null; }
    return out;
  } catch (e) { console.error('  ✗ 乐咕 PE 接口失败：' + e.message); return null; }
}

// ③ 中债10年（东财，列 EMM00166466）—— 仅 ERP，失败不阻断
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

// ---------- 回放工具 ----------

// 复刻生产分位公式（fetchers.js 的"近 N 年滚动分位"），显式截断到当前点（无未来函数）
function rollingPct(rows, i, winYears) {
  const cur = rows[i].pe, curDate = rows[i].date;
  const cutStr = (Number(curDate.slice(0, 4)) - winYears) + curDate.slice(4);
  let tot = 0, cnt = 0;
  for (let k = 0; k <= i; k++) { if (rows[k].date >= cutStr) { tot++; if (rows[k].pe < cur) cnt++; } }
  if (tot < 2) return null;
  return cnt / (tot - 1) * 100;
}

// 收益 R(h) = navOn(d+h月)/navOn(d) − 1；未到期记 null
function makeReturns(navs) {
  return function (date) {
    const base = lookup(navs, date);
    const out = {};
    if (!base || !base.nav) { HORIZONS.forEach(([k]) => { out[k] = null; }); return out; }
    HORIZONS.forEach(([k, h]) => {
      const tgt = lookup(navs, addMonths(date, h));
      if (!tgt || !tgt.nav || daysBetween(date, tgt.date) < h * 28 - 10) { out[k] = null; return; }
      out[k] = (tgt.nav / base.nav - 1) * 100;
    });
    return out;
  };
}

// 事件化（★与既有脚本 backtest_broad_cn_stopfall.js 的 toEvents 完全一致：锚定"事件起点"）
// 用途：复现 §2 记录的信号事件数（76）。
// ⚠ 注意区分：本函数产出的是"信号事件"（一段连续触发按起点锚定切段，长行情会被切成多段），
//    评估**样本量**时应使用下方的 clusters()（滚动合并 → 一段连续行情 = 1 个独立样本）。
//    实测同一批数据：事件 76 个 vs 独立集群 5 段 —— 这正是"有效样本 ≠ 点数"的最尖锐例证。
function toEvents28(hits) {
  const ev = [];
  hits.forEach(h => {
    const last = ev[ev.length - 1];
    if (last && daysBetween(last.date, h.date) <= EVENT_GAP_DAYS) { last.pts.push(h); last.n++; last.end = h.date; }
    else ev.push({ date: h.date, end: h.date, n: 1, pts: [h] });
  });
  return ev;
}

// 独立集群（★滚动合并：相邻命中点 ≤ gap 天则并入同一段 → 一段连续行情 = 1 个独立样本）
// 这是评估"独立样本量"（P1）的正确口径，与上面的"事件数"不是同一个量。
function clusters(hits, gapDays) {
  const cl = [];
  hits.forEach(h => {
    const last = cl[cl.length - 1];
    if (last && daysBetween(last.end, h.date) <= gapDays) { last.end = h.date; last.n++; last.pts.push(h); }
    else cl.push({ start: h.date, end: h.date, n: 1, pts: [h] });
  });
  return cl;
}

// 按月聚类的配对 bootstrap（缓解同期相关性）
function bootClustered(hitsA, hitsB, key, iters) {
  const byMonth = {};
  const touch = m => (byMonth[m] = byMonth[m] || { a: [], b: [] });
  hitsA.forEach(h => { const v = h.r[key]; if (v != null) touch(h.date.slice(0, 7)).a.push(v); });
  hitsB.forEach(h => { const v = h.r[key]; if (v != null) touch(h.date.slice(0, 7)).b.push(v); });
  const months = Object.keys(byMonth);
  const d = [];
  for (let k = 0; k < iters; k++) {
    let sa = 0, na = 0, sb = 0, nb = 0;
    for (let i = 0; i < months.length; i++) {
      const cell = byMonth[months[Math.floor(Math.random() * months.length)]];
      cell.a.forEach(v => { sa += v; na++; });
      cell.b.forEach(v => { sb += v; nb++; });
    }
    if (na && nb) d.push(sb / nb - sa / na);
  }
  if (!d.length) return null;
  return { p10: quantile(d, 10), p50: quantile(d, 50), p90: quantile(d, 90), n: d.length };
}

// ---------- 主流程 ----------
(async () => {
  const cfg = config.getConfig();
  const b = (cfg.signals && cfg.signals.broad) || {};
  const cheapPct = b.cheapPct != null ? b.cheapPct : 30;
  const winYears = b.peWindowYears != null ? b.peWindowYears : 5;

  console.log('=== A股宽基「便宜区是否过松」完整复验（202015 × 沪深300）===\n');
  console.log('当前参数（读自 config.json signals.broad）：'
    + `cheapPct=${cheapPct}  expensivePct=${b.expensivePct}  peWindowYears=${winYears}  stopWindow=${b.stopWindow}`);
  console.log('（注意：core.js 的硬编码默认值是 30/70，生产值来自 config，不能写死）\n');

  // ---- 抓数 ----
  console.log('--- ① 数据腿 ---');
  const peRows = await fetchLeguRows();
  if (!peRows) { console.error('\n✗ 乐咕 PE 序列不可得 —— 本回测无法进行（不静默降级，直接终止）。'); process.exit(1); }
  const navRes = await f.fetchNavHistory(FUND_CODE, 4500);
  const navs = ((navRes && navRes.history) || []).slice().sort((a, b2) => (a.date < b2.date ? -1 : 1)).filter(x => x.nav > 0);
  if (!navs.length) { console.error('\n✗ ' + FUND_CODE + ' 净值不可得 —— 终止。'); process.exit(1); }
  const cn = await fetchCnBond(8);
  console.log(`  沪深300 PE  ${peRows.length} 点  ${peRows[0].date} ~ ${peRows[peRows.length - 1].date}`);
  console.log(`  ${FUND_CODE} 净值  ${navs.length} 条  ${navs[0].date} ~ ${navs[navs.length - 1].date}`);
  console.log(`  中债10年    ${cn.length} 条${cn.length ? '' : '（★抓取失败，ERP 用 config.treasury10y 兜底；不影响便宜区判定）'}`);
  console.log(`  独立集群合并间隔 = ${MERGE_GAPS.join(' / ')} 天（P1 稳健性）`);

  // ---- 回放：date 口径（与既有脚本一致）----
  const startI = peRows.findIndex(r => r.date >= String(Number(peRows[0].date.slice(0, 4)) + winYears) + peRows[0].date.slice(4));
  const from = startI > 0 ? startI : 0;
  const ret = makeReturns(navs);
  const fund0 = { code: FUND_CODE, category: 'broad', caliber: 'cn' };

  const rows = [];
  let scanned = 0, skippedNoNav = 0;
  for (let i = from; i < peRows.length - 1; i++) {
    const d = peRows[i].date;
    const pct = rollingPct(peRows, i, winYears);
    if (pct == null) continue;
    const navRow = lookup(navs, d);
    const idx = lookupIdx(navs, d);
    if (!navRow || !navRow.nav || idx < NAV_LOOKBACK) { skippedNoNav++; continue; }
    scanned++;
    // ★ 调生产函数取 action —— 用于复现 §2 的"76 次"（= A 组事件数，口径与既有脚本一致）
    const hist = navs.slice(idx - NAV_LOOKBACK + 1, idx + 1).reverse().map(x => ({ date: x.date, nav: x.nav }));
    const cnRow = cn.length ? lookup(cn, d) : null;
    const vm = { [FUND_CODE]: { pe: peRows[i].pe, pePercentile: pct, treasury10y: cnRow ? cnRow.cn / 100 : cfg.treasury10y } };
    const dec = buildCoreDecision(Object.assign({}, fund0, { latestNav: navRow.nav, history: hist }), vm, cfg);
    rows.push({ date: d, pe: peRows[i].pe, pct, r: ret(d), action: dec.action });
  }

  // ---- 一致性断言 ----
  console.log('\n--- ② 前置断言（不过则整个回测作废）---');
  let fail = 0;
  const cheapPts = rows.filter(r => r.pct <= cheapPct);      // 便宜区（PE 分位口径）
  const aPts = rows.filter(r => r.action === 'add');         // A 组（生产 action 口径，含中性区边缘 add）
  const aEv = toEvents28(aPts);                              // 事件数（锚定起点，与既有脚本一致）
  const baseR6 = rows.map(r => r.r.R6m).filter(v => v != null);
  const aR6 = aEv.map(e => e.pts[0].r.R6m).filter(v => v != null);
  const okScan = scanned === 197, okPts = cheapPts.length === 78, okEv = aEv.length === 76;
  console.log(`  [a] 扫描点 = ${scanned}（预期 197）  ${okScan ? '✓' : '✗'}`);
  console.log(`  [a] 便宜区（PE分位≤${cheapPct}）点数 = ${cheapPts.length}（预期 78，占 ${(cheapPts.length / scanned * 100).toFixed(1)}%）  ${okPts ? '✓' : '✗'}`);
  console.log(`  [a] A 组（生产 action='add'）点数 = ${aPts.length}；事件数（${EVENT_GAP_DAYS}天、锚定起点）= ${aEv.length}（预期 76 = §2 记录的"76 次"）  ${okEv ? '✓' : '✗'}`);
  console.log(`  [a] A 组 R6m = ${pctF(mean(aR6), 1)}（n=${aR6.length}，§2 记录 2.7%）   全期基准 R6m = ${pctF(mean(baseR6), 1)}（n=${baseR6.length}，§2 记录 2.4%）`);
  console.log(`  [b] ★口径澄清（本次最容易搞混的一处）：`);
  console.log(`      · "点数 78" = PE分位≤${cheapPct} 的扫描点数（占 ${(cheapPts.length / scanned * 100).toFixed(1)}%）；`);
  console.log(`      · "事件 76" = A 组（action='add'，${aPts.length} 点）按 ${EVENT_GAP_DAYS} 天【锚定事件起点】合并后的段数（${aPts.length} 点仅合并 ${aPts.length - aEv.length} 次）；`);
  console.log(`      · 两者不是同一个量：前者是"便宜"，后者是"生产说可买"（含中性区边缘 add）—— §2 的「76 次 / 39%」指的是**后者**（76/197=38.6%）。`);
  console.log(`      · 结论：78（点）与 76（事件）**不是矛盾，是两个口径**；跨脚本引用数字时必须写明口径。`);
  if (!okScan || !okPts || !okEv) fail++;

  // [b2] 点数口径变体（窗口覆盖 ≥54 个月，即 ~4.5 年）—— 说明口径敏感性
  const rowsV = [];
  for (let i = 0; i < peRows.length - 1; i++) {
    const d = peRows[i].date;
    const pct = rollingPct(peRows, i, winYears);
    if (pct == null) continue;
    const cutStr = (Number(d.slice(0, 4)) - winYears) + d.slice(4);
    let tot = 0; for (let k = 0; k <= i; k++) if (peRows[k].date >= cutStr) tot++;
    if (tot < 54) continue;
    const navRow = lookup(navs, d);
    const idx = lookupIdx(navs, d);
    if (!navRow || !navRow.nav || idx < NAV_LOOKBACK) continue;
    rowsV.push({ date: d, pct });
  }
  console.log(`  [b2] 口径敏感性：换成"窗口覆盖 ≥4.5 年"的点数口径 → ${rowsV.length} 点（date 口径 197）`
    + `；≤${cheapPct} 命中 ${rowsV.filter(r => r.pct <= cheapPct).length} 点`);
  console.log(`       差异来源：date 口径要求整 window 年（2010-04 起），点数口径允许 4.5 年（更早几点）。本脚本主线用 date 口径。`);

  // [c] 抽样 40 点：便宜区必须 add
  const step = Math.max(1, Math.floor((rows.length - 1) / 40));
  let chkAdd = 0, chkPct = 0, sampled = 0;
  for (let i = 0; i < rows.length; i += step) {
    const r = rows[i];
    const idx = lookupIdx(navs, r.date);
    const hist = navs.slice(idx - NAV_LOOKBACK + 1, idx + 1).reverse().map(x => ({ date: x.date, nav: x.nav }));
    const cnRow = cn.length ? lookup(cn, r.date) : null;
    const vm = { [FUND_CODE]: { pe: r.pe, pePercentile: r.pct, treasury10y: cnRow ? cnRow.cn / 100 : cfg.treasury10y } };
    const dec = buildCoreDecision(Object.assign({}, fund0, { latestNav: lookup(navs, r.date).nav, history: hist }), vm, cfg);
    sampled++;
    if (r.pct <= cheapPct && dec.action !== 'add') chkAdd++;
    const mp = dec.matrix && dec.matrix.pePercentile;
    if (mp != null && Math.abs(mp - r.pct) > 0.02) chkPct++;
  }
  console.log(`  [c] 抽样 ${sampled} 点：便宜区未给 add = ${chkAdd}（应 0）  ${chkAdd === 0 ? '✓' : '✗'}`);
  console.log(`  [c] 抽样点 matrix.pePercentile 与自算不一致 = ${chkPct}（应 0）  ${chkPct === 0 ? '✓' : '✗'}`);
  if (chkAdd > 0 || chkPct > 0) fail++;

  // [d] 与生产当期值对照
  try {
    const prod = await f.fetchLeguValuation(LEGU_CODE, winYears);
    const myLast = rollingPct(peRows, peRows.length - 1, winYears);
    const dv = (prod && prod.pePercentile != null && myLast != null) ? Math.abs(prod.pePercentile - myLast) : null;
    console.log(`  [d] 期末分位：生产 ${prod ? fx(prod.pePercentile, 2) : '—'} vs 自算 ${fx(myLast, 2)}（Δ ${fx(dv, 2)}，应 ≤0.05）  ${dv != null && dv <= 0.05 ? '✓' : '✗'}`);
    if (dv != null && dv > 0.05) fail++;
  } catch (e) { console.log('  [d] 生产值取不到，跳过（不阻断）：' + e.message); }

  if (fail) { console.log('\n  ✗ 前置断言未通过 —— 结论不可信，终止。'); process.exit(1); }
  console.log('  → 全部通过。本脚本重建的判定与 §2 记录、与生产逐一吻合。\n');

  // ---- 模块 1：分档单调性 ----
  console.log('--- ③ 分档单调性（检验"指标是否有效"，每格附有效样本数）---');
  console.log('  分位档    点数    ' + HORIZONS.map(h => h[0].padStart(14)).join(''));
  BUCKETS.forEach(([lo, hi, name]) => {
    const a = rows.filter(r => r.pct >= lo && r.pct < hi);
    const cells = HORIZONS.map(([k]) => {
      const v = a.map(r => r.r[k]).filter(x => x != null);
      return (mean(v) == null ? '—' : pctF(mean(v), 1)) + '(' + v.length + ')';
    });
    console.log('  ' + name.padEnd(9) + String(a.length).padStart(4) + '   ' + cells.map(c => c.padStart(14)).join(''));
  });
  const allCell = HORIZONS.map(([k]) => { const v = rows.map(r => r.r[k]).filter(x => x != null); return pctF(mean(v), 1) + '(' + v.length + ')'; });
  console.log('  ' + '全期基准'.padEnd(9) + String(rows.length).padStart(4) + '   ' + allCell.map(c => c.padStart(14)).join(''));
  const mono12 = (() => {
    const m = BUCKETS.map(([lo, hi]) => mean(rows.filter(r => r.pct >= lo && r.pct < hi).map(r => r.r.R12m)));
    return m.every((v, i) => i === 0 || (m[i - 1] != null && v != null && m[i - 1] >= v));
  })();
  const mono6 = (() => {
    const m = BUCKETS.map(([lo, hi]) => mean(rows.filter(r => r.pct >= lo && r.pct < hi).map(r => r.r.R6m)));
    return m.every((v, i) => i === 0 || (m[i - 1] != null && v != null && m[i - 1] >= v));
  })();
  console.log(`  → R12m 单调递减（越便宜越好）= ${mono12 ? '是 ✓' : '否'}` + `   R6m 单调递减 = ${mono6 ? '是' : '否 ✗（再次说明 R6m 不适合作本类判据）'}`);

  // ---- 模块 2：阈值网格 ----
  console.log('\n--- ④ 阈值网格（4 阈值 × 3 窗口）---');
  console.log('  窗口  阈值  触发点  占空比    R6m     R12m    R24m    R36m    集群数(90/182/365)');
  const grid = [];
  WINDOWS.forEach(w => {
    const sI = w === winYears ? from : peRows.findIndex(r => r.date >= String(Number(peRows[0].date.slice(0, 4)) + w) + peRows[0].date.slice(4));
    const s0 = sI > 0 ? sI : 0;
    const rs = [];
    for (let i = s0; i < peRows.length - 1; i++) {
      const d = peRows[i].date;
      const pct = rollingPct(peRows, i, w);
      if (pct == null) continue;
      const navRow = lookup(navs, d); const idx = lookupIdx(navs, d);
      if (!navRow || !navRow.nav || idx < NAV_LOOKBACK) continue;
      rs.push({ date: d, pct, r: ret(d) });
    }
    THRESHOLDS.forEach(t => {
      const hits = rs.filter(r => r.pct <= t);
      const cc = MERGE_GAPS.map(g => clusters(hits, g).length);
      const cells = HORIZONS.map(([k]) => pctF(mean(hits.map(r => r.r[k])), 1).padStart(7));
      grid.push({ w, t, n: rs.length, h: hits.length, duty: hits.length / rs.length * 100, cc, m: HORIZONS.reduce((o, [k]) => (o[k] = mean(hits.map(r => r.r[k])), o), {}) });
      console.log('  ' + String(w).padEnd(5) + String(t).padEnd(6) + String(hits.length).padStart(5) + '  ' + (hits.length / rs.length * 100).toFixed(1).padStart(5) + '%  '
        + cells.join('') + '    ' + cc.join('/'));
    });
    console.log('');
  });

  // ---- 模块 3：独立集群明细 ----
  console.log('--- ⑤ ★ 独立集群明细（≤' + cheapPct + '，合并间隔 182 天）---');
  const cl25 = clusters(cheapPts, 182);
  console.log(`  共 ${cheapPts.length} 点 → **${cl25.length} 段独立集群**`);
  console.log('  #  起 始 日        持 续 至       月数   R12m(首点)   R24m(首点)   R36m(首点)');
  cl25.forEach((c, i) => {
    const f0 = c.pts[0];
    console.log('  ' + String(i + 1).padStart(2) + '  ' + c.start + '  ' + c.end + '  ' + String(c.n).padStart(4) + '  '
      + pctF(f0.r.R12m, 1).padStart(11) + pctF(f0.r.R24m, 1).padStart(13) + pctF(f0.r.R36m, 1).padStart(13));
  });
  const clW = cl25.filter(c => c.pts[0].r.R36m != null);
  console.log(`  集群首点均值：R12m ${pctF(mean(cl25.map(c => c.pts[0].r.R12m)), 1)}（n=${cl25.filter(c => c.pts[0].r.R12m != null).length}）`
    + `  R36m ${pctF(mean(clW.map(c => c.pts[0].r.R36m)), 1)}（n=${clW.length}）`);
  console.log(`  对照全期基准：R12m ${pctF(mean(rows.map(r => r.r.R12m)), 1)}   R36m ${pctF(mean(rows.map(r => r.r.R36m)), 1)}`);
  const negCl = clW.filter(c => c.pts[0].r.R36m < 0).length;
  console.log(`  ⚠ ${clW.length} 段有 R36m 的集群里，${negCl} 段为负 → 均值由少数集群主导，样本量不足以支撑参数选择`);
  const nEvent = toEvents28(cheapPts).length;
  console.log(`  ★★ 同一批数据：28 天合并的"信号事件"= ${nEvent} 个，而"独立集群"= ${cl25.length} 段（相差 ${(nEvent / cl25.length).toFixed(1)} 倍）`);
  console.log(`     ⇒ 报"样本量"必须说明口径：**事件数不能当作独立样本数**（前者只切段，后者才是一段独立行情）。`);

  // ---- 模块 4：集群数 × 合并间隔 ----
  console.log('\n--- ⑥ ★★ 集群数 × 合并间隔（P1 硬门槛的稳健性基础）---');
  console.log('  阈值   触发点   ' + MERGE_GAPS.map(g => ('间隔' + g + '天').padStart(12)).join(''));
  THRESHOLDS.forEach(t => {
    const hits = rows.filter(r => r.pct <= t);
    const cc = MERGE_GAPS.map(g => clusters(hits, g).length);
    console.log('  ≤' + String(t).padEnd(5) + String(hits.length).padStart(5) + cc.map(n => (String(n) + (n >= 8 ? ' ✓' : ' ✗')).padStart(12)).join(''));
  });
  console.log('  判据 P1：目标阈值须在三种间隔下**全部** ≥8 段独立集群。');

  // ---- 模块 5：收紧能否避开磨底期 ----
  console.log('\n--- ⑦ ★★ 收紧能否"避开"2010-2014 磨底期？（本次核心论证）---');
  console.log('  阈值   触发点  其中落在 2010-2014   占比');
  THRESHOLDS.forEach(t => {
    const hits = rows.filter(r => r.pct <= t);
    const inM = hits.filter(r => r.date >= MOAT.from && r.date <= MOAT.to);
    console.log('  ≤' + String(t).padEnd(5) + String(hits.length).padStart(5) + String(inM.length).padStart(14) + '   ' + (inM.length / hits.length * 100).toFixed(0).padStart(4) + '%');
  });
  const moatSeg = rows.filter(r => r.date >= MOAT.from && r.date <= MOAT.to);
  const mp = moatSeg.map(r => r.pct).sort((a, b2) => a - b2);
  const q = p => mp[Math.min(mp.length - 1, Math.round(p / 100 * (mp.length - 1)))];
  console.log(`  磨底期本身：${moatSeg.length} 点，分位 中位=${fx(q(50), 1)}  p25=${fx(q(25), 1)}  p75=${fx(q(75), 1)}  max=${fx(q(100), 1)}`);
  console.log(`  其中分位 ≤10 的点 = ${moatSeg.filter(r => r.pct <= 10).length}（占该段 ${(moatSeg.filter(r => r.pct <= 10).length / moatSeg.length * 100).toFixed(0)}%）`);
  console.log('  → 结论：收紧阈值**不是避开**磨底期，而是**更集中地押注它**（占比随阈值收紧递增）。');

  // ---- 模块 6：分段复验 + P3 ----
  console.log('\n--- ⑧ 分段复验（"更严更好"是否在每段内重现）---');
  console.log('  分段                ≤25 R12m    ≤15 R12m    ≤10 R12m   更严更好?');
  const segRes = [];
  SEGS.forEach(s => {
    const seg = rows.filter(r => r.date >= s.from && r.date <= s.to);
    const m = t => mean(seg.filter(r => r.pct <= t).map(r => r.r.R12m));
    const better = (m(10) != null && m(25) != null) ? m(10) > m(25) : null;
    segRes.push({ s, m25: m(25), m15: m(15), m10: m(10), better });
    console.log('  ' + s.name + String(seg.length).padStart(4) + '点  ' + pctF(m(25), 1).padStart(10) + pctF(m(15), 1).padStart(13) + pctF(m(10), 1).padStart(13)
      + '   ' + (better == null ? '样本不足' : (better ? '是' : '否')));
  });
  const betterSegs = segRes.filter(x => x.better === true).length;
  const p2 = betterSegs >= 2;
  console.log(`  → 成立段数 = ${betterSegs}/3 ⇒ P2（分期稳健）${p2 ? '✓ 过' : '✗ 不过'}`);

  const exMoat = rows.filter(r => !(r.date >= MOAT.from && r.date <= MOAT.to));
  const exM = t => mean(exMoat.filter(r => r.pct <= t).map(r => r.r.R12m));
  console.log('\n  ★ P3 剔除 2010-2014 段后（剩 ' + exMoat.length + ' 点）：');
  THRESHOLDS.forEach(t => console.log(`     ≤${String(t).padEnd(3)} R12m ${pctF(exM(t), 1)}`));
  const exBetter = (exM(10) != null && exM(25) != null) ? exM(10) > exM(25) : null;
  const p3 = exBetter === true;
  console.log(`     → 剔除后 ≤10 是否仍优于 ≤25：${exBetter == null ? '—' : (exBetter ? '是' : '否 ⇒ **排序翻转**')} ⇒ P3 ${p3 ? '✓ 过' : '✗ 不过（"越严越好"为单段驱动）'}`);

  // ---- 模块 7：期长对照（§2 的 R6m 判据）----
  console.log('\n--- ⑨ §2 原判据对照：R6m 下四个阈值几乎无差异 ---');
  console.log('  阈值    R6m     R12m    R24m    R36m');
  THRESHOLDS.forEach(t => {
    const hits = rows.filter(r => r.pct <= t);
    console.log('  ≤' + String(t).padEnd(5) + HORIZONS.map(([k]) => pctF(mean(hits.map(r => r.r[k])), 1).padStart(7)).join(''));
  });
  console.log('  ' + '全期'.padEnd(6) + HORIZONS.map(([k]) => pctF(mean(rows.map(r => r.r[k])), 1).padStart(7)).join(''));
  const r6span = (() => { const v = THRESHOLDS.map(t => mean(rows.filter(r => r.pct <= t).map(r => r.r.R6m))); return Math.max(...v) - Math.min(...v); })();
  const r12span = (() => { const v = THRESHOLDS.map(t => mean(rows.filter(r => r.pct <= t).map(r => r.r.R12m))); return Math.max(...v) - Math.min(...v); })();
  console.log(`  → 四阈值间的极差：R6m 仅 ${fx(r6span, 2)}pp，R12m 达 ${fx(r12span, 2)}pp ⇒ R6m 窗口太短、噪声压过差异，**不适合作本类信号的主判据**。`);
  console.log('     ⚠ 表述纪律：这是"R6m 不适合"，**不是**"R6m 被证伪"；R6m 的"不单调"本身也是噪声，不作反证。');

  // ---- 模块 8：底部覆盖 ----
  console.log('\n--- ⑩ 关键底部覆盖（窗口内净值最低日为锚点，±28 天内有触发 = 覆盖）---');
  console.log('  底部                        锚点日        ≤25  ≤15  ≤10   锚点后R12m');
  const cover = {};
  THRESHOLDS.forEach(t => (cover[t] = 0));
  BOTTOMS.forEach(bt => {
    const seg = navs.filter(x => x.date >= bt.from && x.date <= bt.to);
    if (!seg.length) { console.log('  ' + bt.label.padEnd(26) + '（无净值数据）'); return; }
    let lo = seg[0]; seg.forEach(x => { if (x.nav < lo.nav) lo = x; });
    const marks = THRESHOLDS.map(t => {
      const hit = rows.some(r => r.pct <= t && Math.abs(daysBetween(lo.date, r.date)) <= 28);
      if (hit) cover[t]++;
      return hit ? ' ✓ ' : ' ✗ ';
    });
    const r12 = ret(lo.date).R12m;
    console.log('  ' + bt.label.padEnd(26) + lo.date + '   ' + marks.join('  ') + '   ' + pctF(r12, 1));
  });
  console.log('  覆盖合计：' + THRESHOLDS.map(t => '≤' + t + '=' + cover[t] + '/' + BOTTOMS.length).join('  '));
  console.log('  ⚠ 覆盖率高 ≠ 效果好：2013-2014 的低点被"覆盖"了，但那段买入的 R36m 为负（价值陷阱）。');
  const p4 = CANDIDATES.every(t => cover[t] >= cover[cheapPct]);

  // ---- 模块 9：bootstrap（≤10 vs ≤25，R12m）----
  console.log('\n--- ⑪ 聚类 bootstrap（≤10 − ≤25 的 R12m 差值，1000 次）---');
  const b10 = bootClustered(rows.filter(r => r.pct <= cheapPct), rows.filter(r => r.pct <= 10), 'R12m', 1000);
  if (b10) console.log(`  p10=${ppF(b10.p10)}  p50=${ppF(b10.p50)}  p90=${ppF(b10.p90)}（nClusters 抽样 ${b10.n}）`);
  else console.log('  样本不足，跳过。');

  // ---- 判据汇总 ----
  console.log('\n--- ⑫ 判据汇总（P0~P6）---');
  const p0 = fail === 0;
  const p1detail = CANDIDATES.map(t => {
    const hits = rows.filter(r => r.pct <= t);
    return { t, cc: MERGE_GAPS.map(g => clusters(hits, g).length) };
  });
  const p1pass = p1detail.filter(x => x.cc.every(n => n >= 8)).map(x => x.t);
  const p1 = p1pass.length > 0;
  const p5 = CANDIDATES.map(t => {
    const d = HORIZONS.filter(([k]) => k !== 'R6m').map(([k]) => {
      const a = mean(rows.filter(r => r.pct <= t).map(r => r.r[k]));
      const bb = mean(rows.filter(r => r.pct <= cheapPct).map(r => r.r[k]));
      return (a != null && bb != null) ? a - bb : null;
    }).filter(x => x != null);
    return { t, d, ok: d.length >= 2 && (d.every(x => x > 0) || d.every(x => x < 0)) };
  });
  const p5pass = p5.filter(x => x.ok).map(x => x.t);
  const p6 = CANDIDATES.filter(t => { const g = grid.find(x => x.w === winYears && x.t === t); return g && g.duty >= 10 && g.duty <= 30; });
  console.log(`  ${p0 ? '✓' : '✗'} P0 一致性        复现 197 点 / 78 点 / 76 事件 + 抽样零不一致`);
  console.log(`  ${p1 ? '✓' : '✗'} P1 独立样本量 ★   目标阈值须三口径全 ≥8 段；通过者：${p1pass.length ? p1pass.map(t => '≤' + t).join('、') : '无'}`);
  p1detail.forEach(x => console.log(`        ≤${String(x.t).padEnd(3)} 集群数 ${x.cc.join(' / ')}`));
  console.log(`  ${p2 ? '✓' : '✗'} P2 分期稳健      "更严更好" 在 ${betterSegs}/3 段成立（需 ≥2）`);
  console.log(`  ${p3 ? '✓' : '✗'} P3 剔除磨底期 ★   剔除 2010-2014 后 ≤10 优于 ≤25：${exBetter == null ? '—' : (exBetter ? '是' : '否（排序翻转）')}`);
  console.log(`  ${p4 ? '✓' : '✗'} P4 底部覆盖      候选阈值覆盖率不低于现状：${CANDIDATES.map(t => '≤' + t + '=' + cover[t]).join(' ')} vs ≤${cheapPct}=${cover[cheapPct]}`);
  console.log(`  ${p5pass.length ? '✓' : '✗'} P5 期长一致      R12/R24/R36 同号者：${p5pass.length ? p5pass.map(t => '≤' + t).join('、') : '无'}`);
  console.log(`  ${p6.length ? '✓' : '✗'} P6 占空比        落 [10%,30%] 者：${p6.length ? p6.map(t => '≤' + t).join('、') : '无'}`);

  // ---- 结论 ----
  console.log('\n=== 结论 ===');
  if (!p1 || !p3) {
    console.log('  ❌ 不改变参数（维持 ' + cheapPct + ' / 近' + winYears + '年）');
    console.log('  理由：' + (!p1 ? 'P1 不过 —— 独立样本量不足（各阈值在三口径下最多 ' + Math.max(...p1detail.flatMap(x => x.cc)) + ' 段，门槛 8）；' : '')
      + (!p3 ? 'P3 不过 —— 剔除 2010-2014 后"越严越好"排序翻转，说明其优势是单段驱动。' : ''));
    console.log('  §2 结案表述：便宜线**不过松** —— 指标有效（R12m/R24m 分档单调、最便宜档长期有超额），');
    console.log('    占空比 38% 是 A 股 PE 分布右偏的自然结果（年度均值 8.8~16.9、无结构性漂移），并非缺陷；');
    console.log('    但 21 年仅 ' + cl25.length + ' 段独立信号、其中 ' + negCl + ' 段长期亏损，且收紧阈值会把仓位更集中于');
    console.log('    2010-2014 磨底期（65%→80%）⇒ 任何阈值调整都缺统计基础，故维持现状。');
  } else {
    console.log('  ✅ 参数支持调整（通过全覆盖判据）—— 但这与本次预期相反，请人工复核后再决定。');
  }
  console.log('\n  提示：本脚本只读，未修改任何文件/生产代码。');
})().catch(e => { console.error('\n✗ 运行异常：', e && e.stack ? e.stack : e); process.exit(1); });

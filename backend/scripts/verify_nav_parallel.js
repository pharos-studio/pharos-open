'use strict';
/*
 * 验证：净值历史「分页并行化」的数值等价性 + HTTP 全局并发闸门。
 *
 * 做法（不联网，全打桩，可重复跑）：
 *   劫持 globalThis.fetch（lib/http 的 fetchText 是运行时裸取值，故劫持对真实代码生效），
 *   让【改造后的 fetchNavHistory】与【原串行实现逐字副本 fetchNavHistoryLegacy】
 *   吃同一份夹具（含故障注入），逐叶子严格比对。
 *
 * 覆盖：
 *   V1 等价性 —— 11 个场景：正常 / 末页不满 / 总条数少 / 总条数是 20 整数倍 / 首页失败 /
 *      中间页失败 / 中间页返回空 / 中间页返回非 JSON / TotalCount 缺失 / 含 NaN 净值 / 超长窗口(4500)
 *   V2 全叶子严格相等 —— date/nav/acc/dayChange 逐条逐字段，数组顺序也严格（NaN 视同相等）
 *   V3 回归 —— 1h 缓存命中（第二次调用不再发请求）、failed 语义（正常=false、失败=true）
 *   V4 并发闸门 —— 瞬时并发不超过 MAX_CONCURRENT；失败请求也归还名额；非法环境变量不死锁
 *   V5 失败页告警清单 —— 打印每个场景的 failed / 行数，供人工复核
 *
 * 用法：node backend/scripts/verify_nav_parallel.js
 * 子进程模式（内部使用）：FUND_HTTP_CONCURRENCY=abc node ... --child-gate
 */

const path = require('path');
const { execFileSync } = require('child_process');

// ---------- 断言工具 ----------
let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2705 ' + name); }
  else { fail++; fails.push(name + (detail ? ' :: ' + detail : '')); console.log('  \u274c ' + name + (detail ? '\n       ' + detail : '')); }
}
// 逐叶子严格比对：NaN 视同相等（Object.is），-0 与 0 不等，数组按下标比（顺序严格）
function deepDiff(a, b, p) {
  p = p || '$';
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b) return p + ': type ' + typeof a + ' vs ' + typeof b;
  if (a === null || b === null || typeof a !== 'object') return p + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b);
  if (Array.isArray(a) !== Array.isArray(b)) return p + ': 数组性不一致';
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return p + ': 键数 ' + ka.length + ' vs ' + kb.length;
  for (const k of ka) {
    if (!(k in b)) return p + '.' + k + ': 右侧缺失';
    const e = deepDiff(a[k], b[k], p + '.' + k);
    if (e) return e;
  }
  return null;
}

// ================= 子进程模式：验证非法环境变量不会死锁 =================
if (process.argv.includes('--child-gate')) {
  const http = require(path.join(__dirname, '..', 'lib', 'http'));
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
  const got = [];
  Promise.all(Array.from({ length: 12 }, (_, i) => http.fetchText('u' + i).then(() => got.push(i))))
    .then(() => { console.log('MAX=' + http.MAX_CONCURRENT + ' DONE=' + got.length); process.exit(0); });
  return; // eslint-disable-line
}

// ================= 主流程 =================
console.log('== 验证：净值分页并行化 等价性 + 并发闸门 ==\n');

let activeStub = null;
globalThis.fetch = async (url, init) => {
  if (!activeStub) throw new Error('未装载桩：' + url);
  return activeStub(url, init);
};
const httpBase = require(path.join(__dirname, '..', 'lib', 'http'));
const fetchers = require(path.join(__dirname, '..', 'fetchers'));
const { MAX_CONCURRENT } = httpBase;
const fetchText = httpBase.fetchText;

// ---------- 夹具生成 ----------
// 生成 n 条「最新在前」的净值记录（日期降序、跳过周末）。navIdx 集合内的行给非法净值，
// 用于验证 `all.filter(r => !isNaN(r.nav))` 这条过滤在两种实现下行为一致（过滤发生在截断之后）。
function makeSeries(n, navIdx) {
  navIdx = navIdx || new Set();
  const rows = [];
  let d = Date.UTC(2026, 8, 10); // 2026-09-10 起往回走
  while (rows.length < n) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const i = rows.length;
      rows.push({
        FSRQ: new Date(d).toISOString().slice(0, 10),
        DWJZ: navIdx.has(i) ? '--' : (1.2345 - i * 0.0001).toFixed(4),
        LJJZ: navIdx.has(i) ? '--' : (2.3456 - i * 0.0001).toFixed(4),
        JZZZL: (i % 7 === 0) ? '' : (((i % 5) - 2) * 0.31).toFixed(2)
      });
    }
    d -= 86400000;
  }
  return rows;
}

// 打桩的「东财 lsjz 服务端」：按 pageIndex 切片，可注入故障
const PER = 20;
function makeServer(rows, opt) {
  opt = opt || {};
  const pages = [];
  for (let i = 0; i < rows.length; i += PER) pages.push(rows.slice(i, i + PER));
  const st = { calls: 0, pages: [], maxInflight: 0, inflight: 0 };
  const stub = async (url) => {
    const m = /pageIndex=(\d+)/.exec(url);
    const p = Number(m[1]);
    st.calls++; st.pages.push(p);
    st.inflight++; if (st.inflight > st.maxInflight) st.maxInflight = st.inflight;
    try {
      await new Promise((r) => setImmediate(r)); // 制造真实的异步交错
      if (opt.throwOn && opt.throwOn.includes(p)) throw new Error('HTTP 500 注入：第 ' + p + ' 页');
      if (opt.garbageOn && opt.garbageOn.includes(p)) return { ok: true, status: 200, text: async () => '<html>不是 JSON</html>' };
      const list = opt.emptyOn && opt.emptyOn.includes(p) ? [] : (pages[p - 1] || []);
      const body = { Data: { LSJZList: list } };
      if (!opt.omitTotal) body.TotalCount = rows.length;
      const txt = JSON.stringify(body);
      return { ok: true, status: 200, text: async () => txt };
    } finally { st.inflight--; }
  };
  return { stub, st };
}

// ---------- 原实现逐字副本（仅去掉缓存，保证每次都真打网络） ----------
async function fetchNavHistoryLegacy(code, maxDays) {
  const all = [];
  const maxPages = Math.ceil(maxDays / PER) + 1;
  let fetchError = false;
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${page}&pageSize=${PER}`;
    let json;
    try { json = JSON.parse(await fetchText(url, { Referer: 'http://fundf10.eastmoney.com/' })); }
    catch (e) { fetchError = true; break; }
    const list = (json.Data && json.Data.LSJZList) || [];
    if (!list.length) { fetchError = true; break; }
    list.forEach(r => all.push({ date: r.FSRQ, nav: parseFloat(r.DWJZ), acc: parseFloat(r.LJJZ), dayChange: r.JZZZL === '' ? null : parseFloat(r.JZZZL) }));
    if (list.length < PER) break;
    if (all.length >= maxDays) break;
  }
  const history = all.filter(r => !isNaN(r.nav)).slice(0, maxDays);
  const failed = fetchError || history.length === 0;
  return { history, failed };
}

// ---------- 场景表 ----------
const NAV_IDX = new Set([3, 4, 5, 26, 27, 88, 129, 200, 201]);
const CASES = [
  { id: 'normal-600',            desc: '600 条 / 250 日（末页刚好满 20 条）', rows: makeSeries(600), maxDays: 250, opt: {} },
  { id: 'partial-last-263',      desc: '263 条 / 250 日（末页 3 条不满）',     rows: makeSeries(263), maxDays: 250, opt: {} },
  { id: 'short-total-45',        desc: '45 条 / 250 日（总量远不够）',          rows: makeSeries(45),  maxDays: 250, opt: {} },
  { id: 'exact-multiple-240',    desc: '240 条 / 250 日（总量恰为 20 的整数倍）', rows: makeSeries(240), maxDays: 250, opt: {} },
  { id: 'page1-throw',           desc: '第 1 页失败（注入异常）',               rows: makeSeries(600), maxDays: 250, opt: { throwOn: [1] } },
  { id: 'mid-page-throw-7',      desc: '第 7 页失败 → 只保留 1..6 连续前缀',    rows: makeSeries(600), maxDays: 250, opt: { throwOn: [7] } },
  { id: 'mid-page-empty-9',      desc: '第 9 页返回空 → 只保留 1..8 连续前缀',  rows: makeSeries(600), maxDays: 250, opt: { emptyOn: [9] } },
  { id: 'mid-page-garbage-4',    desc: '第 4 页返回非 JSON → 只保留 1..3',      rows: makeSeries(600), maxDays: 250, opt: { garbageOn: [4] } },
  { id: 'omit-total-600',        desc: 'TotalCount 缺失（须退回按天数估页）',    rows: makeSeries(600), maxDays: 250, opt: { omitTotal: true } },
  { id: 'nan-nav',               desc: '含 9 行非法净值（过滤须同序同位置）',    rows: makeSeries(300, NAV_IDX), maxDays: 250, opt: {} },
  { id: 'window-60',             desc: '小窗口 60 日（3 页即够）',              rows: makeSeries(600), maxDays: 60,  opt: {} },
  { id: 'backtest-4500',         desc: '回测口径 4500 日 / 4252 条（213 页）',   rows: makeSeries(4252), maxDays: 4500, opt: {} },
  { id: 'empty-fund',            desc: '基金无净值数据（0 条）',                rows: [],              maxDays: 250, opt: {} }
];

// ---------- V1 + V2 + V3：逐场景对拍 ----------
async function main() {
console.log('【V1/V2 等价性：改造版 vs 原串行版，逐叶子严格比对】');
const rowsOut = [];
for (const c of CASES) {
  const srv = makeServer(c.rows, c.opt);

  activeStub = srv.stub; srv.st.maxInflight = 0;
  const oldRes = await fetchNavHistoryLegacy('L' + c.id, c.maxDays);
  const oldMax = srv.st.maxInflight, oldCalls = srv.st.calls;

  srv.st.calls = 0; srv.st.maxInflight = 0;
  const newRes = await fetchers.fetchNavHistory('N' + c.id, c.maxDays);
  const newMax = srv.st.maxInflight, newCalls = srv.st.calls;

  // V2：history 必须逐叶子完全相同（含数组顺序、NaN 位置、dayChange 的 null）
  const d = deepDiff(oldRes.history, newRes.history);
  check('[' + c.id + '] history 逐叶子相等（' + c.desc + '）', d === null, d || '');
  check('[' + c.id + '] 行数 ' + newRes.history.length + ' / 预期 ' + oldRes.history.length,
        newRes.history.length === oldRes.history.length);

  // failed 语义：唯一允许的差异是「总量恰为 PER 整数倍」时旧版误判 true（见 fetchers.js 注释）
  const failedSame = oldRes.failed === newRes.failed;
  const documented = (oldRes.failed === true && newRes.failed === false &&
                      c.id === 'exact-multiple-240' && newRes.history.length > 0);
  check('[' + c.id + '] failed 语义一致 (旧=' + oldRes.failed + ' / 新=' + newRes.failed + ')',
        failedSame || documented,
        failedSame ? '' : (documented ? '（已记录的有意改进：旧版多翻一页拿到空页 → 误判 failed=true）' : '非预期的 failed 差异'));
  if (documented) console.log('       \u2139\ufe0f  此处为**已记录的有意改进**：旧版页数上限 +1 会多翻一页拿到空页 → 误判 failed=true；新版按 TotalCount 收敛页数 → failed 正确为 false。history 内容仍完全相同。');

  // 预期 failed 的硬校验（防「两边一起错」）
  const expectFailed = ['page1-throw', 'mid-page-throw-7', 'mid-page-empty-9', 'mid-page-garbage-4', 'empty-fund'].includes(c.id);
  check('[' + c.id + '] failed === ' + expectFailed + '（按场景预期）', newRes.failed === expectFailed);

  // 有序前缀：中间页故障时，行数必须恰为「故障页之前」的整页数
  if (c.id === 'mid-page-throw-7') check('[mid-page-throw-7] 连续前缀 = 6 页 × 20 = 120 行', newRes.history.length === 120, '实际 ' + newRes.history.length);
  if (c.id === 'mid-page-empty-9') check('[mid-page-empty-9] 连续前缀 = 8 页 × 20 = 160 行', newRes.history.length === 160, '实际 ' + newRes.history.length);
  if (c.id === 'mid-page-garbage-4') check('[mid-page-garbage-4] 连续前缀 = 3 页 × 20 = 60 行', newRes.history.length === 60, '实际 ' + newRes.history.length);
  if (c.id === 'nan-nav') {
    // 语义：all 先攒满 260 条 → 剔除 9 行非法净值（251 条）→ slice(0,250) 砍掉最老那条。
    // 故窗口末端会「补进」第 258 号行（只截断不过滤时它进不来），第 259 号行则被砍掉。
    const nanDates = [...NAV_IDX].filter(i => i < 260).map(i => c.rows[i].FSRQ);
    const inRes = new Set(newRes.history.map(r => r.date));
    check('[nan-nav] 结果无 NaN 净值，且 ' + nanDates.length + ' 个非法行的日期全被剔除',
          newRes.history.every(r => !isNaN(r.nav)) && nanDates.length === 9 && nanDates.every(d => !inRes.has(d)),
          '实际 ' + newRes.history.length + ' 行');
    check('[nan-nav] 过滤发生在截断之前（末端补进第 258 号、砍掉第 259 号）',
          inRes.has(c.rows[258].FSRQ) && !inRes.has(c.rows[259].FSRQ),
          '258=' + inRes.has(c.rows[258].FSRQ) + ' 259=' + inRes.has(c.rows[259].FSRQ));
  }

  // V3：缓存命中 —— 同 code 同 maxDays 再调一次，不应再发网络请求
  srv.st.calls = 0;
  const cached = await fetchers.fetchNavHistory('N' + c.id, c.maxDays);
  check('[' + c.id + '] 1h 缓存命中：二次调用 0 请求且结果相同',
        srv.st.calls === 0 && deepDiff(cached.history, newRes.history) === null, '二次请求数 ' + srv.st.calls);

  rowsOut.push({ id: c.id, rows: newRes.history.length, failed: newRes.failed, oldCalls, newCalls, oldMax, newMax });
  console.log('       \u2022 请求数 旧/新 = ' + oldCalls + '/' + newCalls + '，瞬时并发 旧/新 = ' + oldMax + '/' + newMax);
}

// ---------- V4：并发闸门 ----------
console.log('\n【V4 全局并发闸门（lib/http）】');
check('MAX_CONCURRENT 默认 6（实测 ' + MAX_CONCURRENT + '）', MAX_CONCURRENT === 6);

let gateInflight = 0, gateMax = 0, gateDone = 0;
activeStub = async () => {
  gateInflight++; if (gateInflight > gateMax) gateMax = gateInflight;
  await new Promise((r) => setTimeout(r, 2));
  gateInflight--;
  gateDone++;
  return { ok: true, status: 200, text: async () => 'ok' };
};
await Promise.all(Array.from({ length: 40 }, (_, i) => fetchText('gate-' + i)));
check('40 个并发请求全部完成（无死锁）', gateDone === 40, '完成 ' + gateDone);
check('瞬时并发 ' + gateMax + ' ≤ ' + MAX_CONCURRENT + '（闸门生效）', gateMax <= MAX_CONCURRENT);

// 失败请求也必须归还名额：先打爆 30 个必失败的，再确认后续请求仍能跑
let boomLeft = 30;
activeStub = async () => {
  if (boomLeft-- > 0) throw new Error('注入失败');
  return { ok: true, status: 200, text: async () => 'ok' };
};
const boom = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => fetchText('boom-' + i)));
check('30 个必失败请求全部 settle（finally 归还名额，无泄漏死锁）',
      boom.length === 30 && boom.every(r => r.status === 'rejected'));
check('失败风暴后闸门仍可放行新请求', (await fetchText('after-boom')) === 'ok');

// 非法环境变量：子进程实测（NaN 会让 inflight<NaN 恒 false → 永久排队）
for (const bad of ['abc', '0', '-3', '9999']) {
  const script = path.join(__dirname, path.basename(__filename));
  let out = '';
  try {
    out = execFileSync(process.execPath, [script, '--child-gate'], {
      env: Object.assign({}, process.env, { FUND_HTTP_CONCURRENCY: bad }),
      timeout: 15000, encoding: 'utf8'
    }).trim();
  } catch (e) { out = 'TIMEOUT/ERR: ' + e.message.split('\n')[0]; }
  check('FUND_HTTP_CONCURRENCY=' + bad + ' → 不死锁且回落默认 (' + out + ')',
        out === 'MAX=6 DONE=12');
}

// ---------- V5：摘要表 ----------
console.log('\n【V5 场景摘要】');
console.log('  场景                      行数  failed  请求数(旧/新)  并发峰值(旧/新)');
for (const r of rowsOut) {
  console.log('  ' + r.id.padEnd(24) + String(r.rows).padStart(5) + '  ' +
              String(r.failed).padEnd(6) + '  ' + (r.oldCalls + '/' + r.newCalls).padStart(12) + '  ' +
              (r.oldMax + '/' + r.newMax).padStart(15));
}

const totalRows = rowsOut.reduce((s, r) => s + r.rows, 0);
const failedRows = rowsOut.filter(r => r.failed);
console.log('\n  \u26a0\ufe0f  failed=true 的场景（须与上表预期一致，否则说明降级兜底已被触发）：' +
            (failedRows.length ? failedRows.map(r => r.id).join(', ') : '（无）'));
console.log('  合计产出净值行数：' + totalRows);

console.log('\n== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==');
if (fail) { console.log('\n失败项：\n  - ' + fails.join('\n  - ')); process.exit(1); }
console.log('\u2705 全部通过：history 与原串行实现逐叶子相同，闸门受控。');
}

main().catch((e) => { console.error('\n脚本异常：', e); process.exit(1); });

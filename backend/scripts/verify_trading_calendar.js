'use strict';
/*
 * 验证：「名义成交日 → 真实成交日」的顺延查找（用基金自身净值序列当交易日历）。
 *
 * 做法（不联网，全打桩，可重复跑）：
 *   劫持 globalThis.fetch（lib/http 的 fetchText 是运行时裸取值），按 lsjz 的分页协议喂夹具，
 *   让**真实的 fetchNavOnOrAfter 分页算法**跑起来，而不是打桩掉它本身。
 *   另用「转发器」劫持 fetchers.fetchNavOnOrAfter 的导出属性（必须在 require navQuote/buyPlan 之前），
 *   以便对阈值边界做受控注入 —— navQuote 在 require 时就把函数引用捕获了，晚改无效。
 *
 * 覆盖：
 *   C1 算法正确性 —— 节假日连休（2023-09-29→10-09，实测最坏 10 天）、已到/未到、跨页命中
 *   C2 ★ 属性测试 —— 对夹具中每一对相邻净值日，区间内**每一个自然日**都应变到较新那天；
 *      这正是「取本页第一个 >= 名义日」那种写法会系统性答错的地方
 *   C3 空结果三态 —— future（未来）/ tooOld（早于可查范围）/ error（首页空）
 *   C4 对偶回归 —— fetchNavOnDate（<= 语义）未被本次改动影响
 *   C5 缓存键隔离 —— 同一 (code,date) 下 'le' / 'ge' 两种语义不得互相污染
 *   C6 阈值边界 —— 顺延 == MAX_ROLL_DAYS → ok；== +1 → pending；future/tooOld/异常 → 对应状态
 *   C7 两档收敛 —— 非交易日下单时 15:00 前/后必须落到同一成交日（converged=true）
 *   C8 buildNavMeta 优先级 —— 新字段 → 旧字段名（navDate/confirmDate）→ 老记录推定；并带出 settleDate
 *   C9 ★ 定价日 vs 份额确认日 —— 新名与旧名等价、+1/+2 offset（≡ legacyConfirmDate —— 旧口径
 *      把「份额确认日」误用成「定价日」的铁证）、真实确认日的序列顺延落位，以及
 *      **份额只由定价日净值唯一决定**（篡改 settleDate 必须不影响 shares）+ 44 组属性测试
 *
 * 用法：node backend/scripts/verify_trading_calendar.js
 */

const DAY = 86400000;

// ---------- 断言工具 ----------
let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2705 ' + name); }
  else { fail++; fails.push(name + (detail ? ' :: ' + detail : '')); console.log('  \u274c ' + name + (detail ? '\n       ' + detail : '')); }
}
// ★ 日历日助手统一走 UTC：本文件是「日期口径」的校验，若自身用本机时区 getter，
//   进程跑到 UTC 就会整体早一天，于是**校验本身**给出错误结论。见 lib/tradeDate.js 顶部铁律。
function fmt(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function parse(s) { return new Date(s + 'T00:00:00Z'); }
function addDays(s, n) { return fmt(new Date(parse(s).getTime() + n * DAY)); }

// ---------- 夹具：按 lsjz 协议分页喂给真实抓取代码 ----------
// skip 集合里的日期视为「休市」——恰好就是节假日表要表达的语义，这里由净值序列天然给出。
function genSeries(startStr, count, skip) {
  const out = [];
  let t = parse(startStr).getTime();
  while (out.length < count) {
    const d = new Date(t);
    const wd = d.getDay();
    const s = fmt(d);
    if (wd !== 0 && wd !== 6 && !skip.has(s)) out.push(s);
    t -= DAY;
  }
  return out; // 降序（与 lsjz 一致）
}
function spanSet(a, b) {
  const set = new Set();
  for (let t = parse(a).getTime(); t <= parse(b).getTime(); t += DAY) set.add(fmt(new Date(t)));
  return set;
}

const PER = 20;
// A：中秋+国庆连休（实测最坏案例所在区间）
const seriesA = genSeries('2023-10-13', 60, spanSet('2023-09-29', '2023-10-08'));
// B：长期停牌（60 天空档）—— 用于验证「顺延超限」在真实抓取路径下也成立
const seriesB = genSeries('2023-10-13', 60, spanSet('2023-08-01', '2023-09-30'));
const seriesMap = { A: seriesA, B: seriesB };
const navOf = (code, date) => { const i = seriesMap[code].indexOf(date); return Number((1 + i * 0.0005).toFixed(4)); };

let fetchCount = 0;
globalThis.fetch = async (url) => {
  fetchCount++;
  const m = /fundCode=([^&]+)&pageIndex=(\d+)/.exec(String(url));
  const code = m ? m[1] : '?';
  const page = m ? Number(m[2]) : 1;
  const all = seriesMap[code] || [];
  const slice = all.slice((page - 1) * PER, page * PER);
  const list = slice.map(d => ({ FSRQ: d, DWJZ: String(navOf(code, d)), LJJZ: '1', JZZZL: '' }));
  return { ok: true, status: 200, text: async () => JSON.stringify({ Data: { LSJZList: list }, TotalCount: all.length }) };
};

// ---------- 装载被测代码 ----------
const fetchers = require('../fetchers');
const tradeDate = require('../lib/tradeDate');

// ★ 转发器：必须在 require navQuote（经 buyPlan 间接引入）**之前**装好 ——
//   navQuote 的 makeResolver 在 require 时就把函数引用捕获进闭包，晚改属性对已建好的 resolver 无效。
const realOnOrAfter = fetchers.fetchNavOnOrAfter;
const proxy = { mode: 'real', fn: null };
fetchers.fetchNavOnOrAfter = async (code, nominalDate) => {
  if (proxy.mode === 'stub') return proxy.fn(code, nominalDate);
  return realOnOrAfter(code, nominalDate);
};

const navQuote = require('../lib/navQuote');
const buyPlan = require('../lib/buyPlan');
const seriesOf = c => seriesMap[c];

(async () => {
  console.log('== C1 算法正确性（真实分页，节假日连休） ==');
  check('MAX_ROLL_DAYS === 15（实测最坏 10 天 + 余量）', tradeDate.MAX_ROLL_DAYS === 15, String(tradeDate.MAX_ROLL_DAYS));
  {
    const worst = seriesA.find(d => d === '2023-10-09');
    check('夹具自检：连休后首个净值日 = 2023-10-09', !!worst, seriesA.slice(0, 3).join(','));
    const r1 = await fetchers.fetchNavOnOrAfter('A', '2023-09-29');
    check('连休首日 2023-09-29 → 2023-10-09（顺延 10 天）',
      r1 && r1.date === '2023-10-09' && tradeDate.naturalDayDiff('2023-09-29', r1.date) === 10, JSON.stringify(r1));
    const r2 = await fetchers.fetchNavOnOrAfter('A', '2023-10-01');
    check('连休中段 2023-10-01 → 2023-10-09', r2 && r2.date === '2023-10-09', JSON.stringify(r2));
    const r3 = await fetchers.fetchNavOnOrAfter('A', '2023-09-28');
    check('交易日 2023-09-28 → 当天（不误顺延）', r3 && r3.date === '2023-09-28', JSON.stringify(r3));
    const r4 = await fetchers.fetchNavOnOrAfter('A', '2023-10-13');
    check('最新净值日当天 → 当天', r4 && r4.date === '2023-10-13', JSON.stringify(r4));
    // 跨页命中：取夹具靠后（第 3 页）的日期，答案必须还落在同一天
    const deep = seriesA[45];
    const r5 = await fetchers.fetchNavOnOrAfter('A', deep);
    check('跨页命中 ' + deep + ' → 当天（第 ' + (Math.floor(seriesA.indexOf(deep) / PER) + 1) + ' 页）', r5 && r5.date === deep, JSON.stringify(r5));
    const r6 = await fetchers.fetchNavOnOrAfter('A', addDays(seriesA[45], -1));
    check('名义日恰为夹具中的一天（' + addDays(seriesA[45], -1) + '）→ 返回当天，不越级', r6 && r6.date === addDays(seriesA[45], -1), JSON.stringify(r6));
    // 跨页 + 跨周末：取靠后的「周五→下周一」相邻对，名义日落在周六 → 必须答出那个周一
    let wi = -1;
    for (let i = 40; i < seriesA.length - 1; i++) {
      if (tradeDate.naturalDayDiff(seriesA[i + 1], seriesA[i]) === 3) { wi = i; break; }
    }
    check('夹具内存在第 ' + (wi + 1) + " 页的「周五→周一」相邻对", wi >= 0, 'indexOf 未命中');
    if (wi >= 0) {
      const mon = seriesA[wi], fri = seriesA[wi + 1], sat = addDays(fri, 1);
      const r7 = await fetchers.fetchNavOnOrAfter('A', sat);
      check('跨页跨周末：' + sat + ' → ' + mon, r7 && r7.date === mon, JSON.stringify(r7));
    }
  }

  console.log('== C2 属性测试：相邻净值日之间每个自然日都应变到较新那天 ==');
  {
    let cases = 0, bad = null, notAfter = null;
    for (let i = 0; i < seriesA.length - 1 && !bad; i++) {
      const newer = seriesA[i], older = seriesA[i + 1];
      for (let t = parse(older).getTime() + DAY; t <= parse(newer).getTime(); t += DAY) {
        const d = fmt(new Date(t));
        const r = await fetchers.fetchNavOnOrAfter('A', d);
        cases++;
        if (!r || r.date !== newer) { bad = d + ' → ' + JSON.stringify(r) + '（应为 ' + newer + '）'; break; }
        if (r.date < d) { notAfter = d + ' → ' + r.date; break; }
      }
    }
    check('全部 ' + cases + ' 个自然日都顺延到正确的「第一个 >= 名义日」', bad === null, bad || '');
    check('顺延结果恒不早于名义日（无序/回退 = 静默算错）', notAfter === null, notAfter || '');
  }

  console.log('== C3 空结果三态 ==');
  {
    const f = await fetchers.fetchNavOnOrAfter('A', '2023-12-01');
    check('名义日在最新净值日之后 → reason=future', f && f.date === null && f.reason === 'future', JSON.stringify(f));
    const o = await fetchers.fetchNavOnOrAfter('A', '2000-01-01');
    check('名义日早于可查范围 → reason=tooOld', o && o.date === null && o.reason === 'tooOld', JSON.stringify(o));
    const e = await fetchers.fetchNavOnOrAfter('ZZZZ_NOT_EXIST', '2023-10-13');
    check('未知基金（首页空）→ reason=error', e && e.date === null && e.reason === 'error', JSON.stringify(e));
  }

  console.log('== C4 对偶回归：fetchNavOnDate 未被影响 ==');
  {
    let bad = null;
    for (const d of [seriesA[0], seriesA[10], seriesA[30]]) {
      const r = await fetchers.fetchNavOnDate('A', d);
      if (!r || r.date !== d) { bad = d + ' → ' + JSON.stringify(r); break; }
    }
    check('fetchNavOnDate(交易日) 仍返回当天', bad === null, bad || '');
    const r2 = await fetchers.fetchNavOnDate('A', '2023-10-01');
    check('fetchNavOnDate(2023-10-01) 仍返回 2023-09-28（<= 语义未变）', r2 && r2.date === '2023-09-28', JSON.stringify(r2));
  }

  console.log('== C5 缓存键隔离（le / ge 不得互相污染） ==');
  {
    navQuote.clear();
    const le1 = await navQuote.resolveQuote('A', '2023-10-01');
    const ge1 = await navQuote.resolveQuoteOnOrAfter('A', '2023-10-01');
    check('首次：le=2023-09-28 / ge=2023-10-09',
      le1 && le1.date === '2023-09-28' && ge1 && ge1.date === '2023-10-09', JSON.stringify({ le1, ge1 }));
    const before = fetchCount;
    const le2 = await navQuote.resolveQuote('A', '2023-10-01');
    const ge2 = await navQuote.resolveQuoteOnOrAfter('A', '2023-10-01');
    check('二次：命中各自缓存且值不变（键已隔离）',
      le2.date === '2023-09-28' && ge2.date === '2023-10-09', JSON.stringify({ le2, ge2 }));
    check('二次未发生新的网络请求（缓存真的命中）', fetchCount === before, 'fetchCount ' + before + ' → ' + fetchCount);
  }

  console.log('== C6 阈值边界与三态（受控注入） ==');
  {
    const stubCase = async (name, ret, expect) => {
      navQuote.clear();
      proxy.mode = 'stub';
      proxy.fn = () => ret;
      const v = await buyPlan.previewOne({ code: 'A', market: 'A', feeRate: 0, date: '2023-10-11', session: 'T', amount: 1000 });
      proxy.mode = 'real';
      check(name, v.status === expect.status && (expect.rollDays === undefined || v.rollDays === expect.rollDays)
        && (expect.nav === undefined || v.nav === expect.nav), JSON.stringify(v));
      return v;
    };
    // nominal(2023-10-11, 'T') = 2023-10-11
    const v15 = await stubCase('顺延 == 15 天 → ok', { date: addDays('2023-10-11', 15), nav: 2 }, { status: 'ok', rollDays: 15 });
    check('  15 天时份额 = 金额 ÷ 净值（1000/2 = 500）', v15.shares === 500, String(v15.shares));
    check('  shifted=true 且 pricingDate 已顺延', v15.shifted === true && v15.pricingDate === addDays('2023-10-11', 15), JSON.stringify(v15));
    await stubCase('顺延 == 16 天 → pending（不硬写份额）', { date: addDays('2023-10-11', 16), nav: 2 }, { status: 'pending', rollDays: 16 });
    await stubCase('顺延 == 0 天 → ok 且 shifted=false', { date: '2023-10-11', nav: 2 }, { status: 'ok', rollDays: 0 });
    await stubCase('reason=future → pending（在途）', { date: null, nav: null, reason: 'future' }, { status: 'pending' });
    await stubCase('reason=tooOld → error', { date: null, nav: null, reason: 'tooOld' }, { status: 'error' });
    await stubCase('reason=error → error', { date: null, nav: null, reason: 'error' }, { status: 'error' });
    navQuote.clear();
    proxy.mode = 'stub';
    proxy.fn = () => { throw new Error('boom'); };
    const vThrow = await buyPlan.previewOne({ code: 'A', market: 'A', feeRate: 0, date: '2023-10-11', session: 'T', amount: 1000 });
    proxy.mode = 'real';
    check('抓取抛异常 → error（绝不 500、绝不置份额）', vThrow.status === 'error' && vThrow.shares === null, JSON.stringify(vThrow));
    navQuote.clear();
    const vBad = await buyPlan.previewOne({ code: 'A', market: 'A', feeRate: 0, date: 'x', session: 'T', amount: 1000 });
    check('非法日期不崩（返回 pending/error 之一且 shares=null）', vBad.shares === null, JSON.stringify(vBad));
  }

  console.log('== C7 两档收敛：非交易日下单前/后结果必须相同 ==');
  {
    navQuote.clear();
    const sat = await buyPlan.previewPurchase({ code: 'A', market: 'A', feeRate: 0, date: '2023-09-30', amount: 1000, selected: 'T' });
    check('周六下单（2023-09-30）→ converged=true', sat.converged === true, JSON.stringify(sat.variants));
    check('  两档真实成交日相同且 = 2023-10-09',
      sat.variants.T.pricingDate === '2023-10-09' && sat.variants['T+1'].pricingDate === '2023-10-09',
      JSON.stringify({ t: sat.variants.T.pricingDate, p: sat.variants['T+1'].pricingDate }));
    check('  两档份额相同（界面据此合并成一行提示）',
      sat.variants.T.shares === sat.variants['T+1'].shares, JSON.stringify({ t: sat.variants.T.shares, p: sat.variants['T+1'].shares }));
    navQuote.clear();
    const wed = await buyPlan.previewPurchase({ code: 'A', market: 'A', feeRate: 0, date: '2023-10-11', amount: 1000, selected: 'T' });
    check('交易日下单（2023-10-11）→ converged=false（两档应真有差别）', wed.converged === false, JSON.stringify(wed.variants));
    check('  前 = 10-11 / 后 = 10-12',
      wed.variants.T.pricingDate === '2023-10-11' && wed.variants['T+1'].pricingDate === '2023-10-12',
      JSON.stringify({ t: wed.variants.T.pricingDate, p: wed.variants['T+1'].pricingDate }));
    navQuote.clear();
    const longStop = await buyPlan.previewPurchase({ code: 'B', market: 'A', feeRate: 0, date: '2023-08-15', amount: 1000, selected: 'T' });
    check('长期停牌区间（空档 60 天）→ 顺延超限，两档都 pending 且不置份额',
      longStop.variants.T.status === 'pending' && longStop.variants['T+1'].status === 'pending'
      && longStop.variants.T.shares === null && longStop.variants.T.rollDays > tradeDate.MAX_ROLL_DAYS,
      JSON.stringify({ t: longStop.variants.T.status, rd: longStop.variants.T.rollDays }));
    check('超限时 converged 必须为 false（两档都 pending ≠ 收敛，否则界面会合并出误导文案）', longStop.converged === false, String(longStop.converged));
  }

  console.log('== C8 buildNavMeta 优先级（新字段 → 旧字段 → 老记录推定） ==');
  {
    // buildNavMeta 未导出，且 server.js 一 require 就 listen。用 Module._compile 载入源码副本：
    //   ① 把 http.createServer 换成空壳，避免真的绑端口；② 源码末尾追加一行导出。
    const serverMod = (() => {
      const fs = require('fs'), path2 = require('path'), Module = require('module');
      const file = path2.join(__dirname, '..', 'server.js');
      let src = fs.readFileSync(file, 'utf8');
      src += '\nmodule.exports.__buildNavMeta = buildNavMeta;\n';
      const http = require('http');
      const orig = http.createServer;
      http.createServer = () => ({ listen() {}, on() {}, close() {} });
      try {
        const m = new Module(file, null);
        m.filename = file;
        m.paths = Module._nodeModulePaths(path2.dirname(file));
        m._compile(src, file);
        return m.exports;
      } finally { http.createServer = orig; }
    })();
    const bnm = serverMod.__buildNavMeta;
    check('能在不监听端口的前提下载入 server.js 并取出 buildNavMeta', typeof bnm === 'function');
    if (typeof bnm === 'function') {
      const mk = (date, extra) => Object.assign({ date, amount: 100, shares: 1, nav: 1 }, extra);
      const meta = bnm({ funds: [
        // A股周五当天成交：legacy(+1 工作日) 会给 09-14，正确值应是 pricingDate 的 09-11
        { code: 'T1', market: 'A', purchases: [mk('2026-09-11', { pricingDate: '2026-09-11' })] },
        // QDII：legacy(+2 工作日) 会给 09-14，正确值应是 09-11
        { code: 'T2', market: 'QDII', purchases: [mk('2026-09-10', { pricingDate: '2026-09-11' })] },
        // 真·老记录（没有任何日期字段）→ 只能走冻结旧口径，且必须标 inferred
        { code: 'T3', market: 'QDII', purchases: [mk('2026-09-10', {})] },
        // 旧字段名兼容（2026-09-17 之前落盘的 navDate / confirmDate 存的都是**定价日**）
        { code: 'T4', market: 'A', purchases: [mk('2026-09-12', { navDate: '2026-09-14', confirmDate: '2026-09-14' })] },
      ] });
      const g = (c, d) => meta[c][d + '|100'];
      check('有 pricingDate（A股）→ 采用它，而非 legacy 的 09-14',
        g('T1', '2026-09-11').pricingDate === '2026-09-11' && g('T1', '2026-09-11').inferred === false, JSON.stringify(g('T1', '2026-09-11')));
      check('有 pricingDate（QDII）→ 采用它，而非 legacy 的 09-14',
        g('T2', '2026-09-10').pricingDate === '2026-09-11' && g('T2', '2026-09-10').inferred === false, JSON.stringify(g('T2', '2026-09-10')));
      check('真·老记录 → 冻结旧口径 QDII +2 = 09-14，且 inferred=true（绝不冒充真实值）',
        g('T3', '2026-09-10').pricingDate === '2026-09-14' && g('T3', '2026-09-10').inferred === true, JSON.stringify(g('T3', '2026-09-10')));
      check('旧字段名 navDate/confirmDate 仍被识别为**定价日**（向后兼容），且 inferred=false',
        g('T4', '2026-09-12').pricingDate === '2026-09-14' && g('T4', '2026-09-12').inferred === false, JSON.stringify(g('T4', '2026-09-12')));
      check('★ 旁挂表带 settleDate：A股 = 定价日+1 工作日（09-11 周五 → 09-14 周一）',
        g('T1', '2026-09-11').settleDate === '2026-09-14', JSON.stringify(g('T1', '2026-09-11')));
      check('★ 旁挂表带 settleDate：QDII = 定价日+2 工作日（09-11 → 09-15）',
        g('T2', '2026-09-10').settleDate === '2026-09-15', JSON.stringify(g('T2', '2026-09-10')));
      check('老记录的 settleDate 也给了值，且整条标 inferred（不冒充真实解析结果）',
        !!g('T3', '2026-09-10').settleDate && g('T3', '2026-09-10').inferred === true, JSON.stringify(g('T3', '2026-09-10')));
    }
  }

  console.log('== C9 ★ 定价日 vs 份额确认日（2026-09-17 拆分：份额只由定价日决定） ==');
  {
    proxy.mode = 'real';
    navQuote.clear(); // 清掉 C6 可能留下的打桩缓存

    // 9.1 旧别名已彻底删除（2026-09-17 用户拍板）：tradeDate 上不允许再出现 confirmDate / sessionFromConfirm
    check('★ 旧别名 confirmDate / sessionFromConfirm 已从 tradeDate 移除',
      tradeDate.confirmDate === undefined && tradeDate.sessionFromConfirm === undefined,
      JSON.stringify({ c: typeof tradeDate.confirmDate, s: typeof tradeDate.sessionFromConfirm }));

    // 9.2 settleNominalDate：A股 +1 工作日 / QDII +2 工作日（只跳周末）
    check('A股 周四定价 → 确认日名义 = 次日周五',
      tradeDate.settleNominalDate('2026-09-10', 'A') === '2026-09-11', tradeDate.settleNominalDate('2026-09-10', 'A'));
    check('A股 周五定价 → 跳过周末 = 下周一',
      tradeDate.settleNominalDate('2026-09-11', 'A') === '2026-09-14', tradeDate.settleNominalDate('2026-09-11', 'A'));
    check('QDII 同一时刻 +2 工作日 = 比 A 股晚一天（09-15）',
      tradeDate.settleNominalDate('2026-09-11', 'QDII') === '2026-09-15', tradeDate.settleNominalDate('2026-09-11', 'QDII'));

    // 9.3 ★★ 铁证：settleNominalDate 与冻结的 legacyConfirmDate offset 完全相同
    //     —— 旧口径算的其实就是「份额确认日」，却被当成了「定价日」去取净值（QDII 因此多取一天）
    let offsetSame = true;
    for (const d of ['2026-09-10', '2026-09-11', '2026-09-28']) {
      if (tradeDate.settleNominalDate(d, 'A') !== tradeDate.legacyConfirmDate(d, 'A')) offsetSame = false;
      if (tradeDate.settleNominalDate(d, 'QDII') !== tradeDate.legacyConfirmDate(d, 'QDII')) offsetSame = false;
    }
    check('★ settleNominalDate ≡ legacyConfirmDate（证明旧口径误用了「确认日 offset」当定价日）', offsetSame);

    // 9.4 resolveSettleDate：真实确认日必须落在净值序列上（顺延过连休，不是拿名义值糊弄）
    const sA = await buyPlan.resolveSettleDate('A', '2023-10-10', 'A');
    const sQ = await buyPlan.resolveSettleDate('A', '2023-10-10', 'QDII');
    check('A股 10-10 定价 → 确认日 10-11', sA.settleDate === '2023-10-11' && sA.settleEstimated === false, JSON.stringify(sA));
    check('QDII 同定价日 → 确认日 10-12（比 A 股晚一天，到账更慢）', sQ.settleDate === '2023-10-12', JSON.stringify(sQ));
    const sLong = await buyPlan.resolveSettleDate('A', '2023-09-28', 'A');
    check('长假：09-28 定价 → 确认日顺延过中秋国庆 = 10-09',
      sLong.settleDate === '2023-10-09' && sLong.settleEstimated === false, JSON.stringify(sLong));

    // 9.4b ★ 确认日必须与定价日共用同一个防呆上限（2026-09-17 用户提问时发现的漏检：
    //      resolveSettleDate 原先只看「取没取到」，不看顺延多远 → 停牌时会把远期日期说成「确认」）
    navQuote.clear();
    proxy.mode = 'stub';
    proxy.fn = () => ({ date: '2024-01-05', nav: 1 }); // 名义确认日 2023-10-12 → 顺延 85 天
    const sFar = await buyPlan.resolveSettleDate('A', '2023-10-11', 'A');
    check('★ 确认日顺延 > MAX_ROLL_DAYS → settleEstimated=true（绝不冒充确定值）',
      sFar.settleEstimated === true && sFar.settleDate === '2024-01-05', JSON.stringify(sFar));
    proxy.fn = () => null;
    navQuote.clear(); // ★ 必须清：否则第二次打桩被上一次的缓存吃掉（key = ge|A|2023-10-12）
    const sNull = await buyPlan.resolveSettleDate('A', '2023-10-11', 'A');
    check('★ 序列取不到 → 退回名义日 + settleEstimated=true',
      sNull.settleDate === '2023-10-12' && sNull.settleEstimated === true, JSON.stringify(sNull));
    proxy.mode = 'real';
    navQuote.clear();

    // 9.5 ★★ 硬不变量：份额只由定价日净值决定
    const v0 = await buyPlan.previewOne({ code: 'A', market: 'A', feeRate: 0, date: '2023-09-28', session: 'T', amount: 1000 });
    const expShares = buyPlan.computeShares(1000, 0, v0.nav);
    check('previewOne 返回 pricingDate，且 shares = [金额÷(1+有效费率)]÷nav(pricingDate)',
      v0.status === 'ok' && v0.pricingDate === '2023-09-28' && v0.shares === expShares,
      JSON.stringify({ p: v0.pricingDate, nav: v0.nav, sh: v0.shares, exp: expShares }));
    check('★ 份额只依赖定价日净值 —— 与 settleDate 无关（篡改它也必须算出同一个数）',
      buyPlan.computeShares(1000, 0, v0.nav) === v0.shares && v0.shares === expShares);
    check('settleDate 严格晚于 pricingDate', v0.settleDate > v0.pricingDate, v0.pricingDate + ' → ' + v0.settleDate);
    check('★ 预览不再下发旧字段名 confirmDate / navDate（杜绝两套口径并存）',
      v0.confirmDate === undefined && v0.navDate === undefined,
      JSON.stringify({ c: v0.confirmDate, n: v0.navDate }));

    // 9.6 属性测试：夹具区间内每个自然日 × {A,QDII} × {前,后}
    let n9 = 0; const bad9 = [];
    for (let t = parse('2023-10-02').getTime(); t <= parse('2023-10-12').getTime(); t += DAY) {
      const d = fmt(new Date(t));
      for (const mk of ['A', 'QDII']) {
        for (const s of ['T', 'T+1']) {
          const v = await buyPlan.previewOne({ code: 'A', market: mk, feeRate: 0, date: d, session: s, amount: 100 });
          n9++;
          const tag = d + '/' + mk + '/' + s;
          if (v.status !== 'ok') { bad9.push(tag + ' status=' + v.status); continue; }
          if (!(v.settleDate > v.pricingDate)) bad9.push(tag + ' settle<=pricing');
          if (!seriesA.includes(v.pricingDate)) bad9.push(tag + ' pricing 不在序列');
          if (v.settleEstimated === false && !seriesA.includes(v.settleDate)) bad9.push(tag + ' settle 不在序列');
          if (v.settleEstimated === true && v.settleDate !== tradeDate.settleNominalDate(v.pricingDate, mk)) bad9.push(tag + ' estimated 值不等于名义日');
          if (v.shares !== buyPlan.computeShares(100, 0, navOf('A', v.pricingDate))) bad9.push(tag + ' shares 与定价日净值不符');
        }
      }
    }
    check('属性测试 ' + n9 + ' 组（自然日 × 市场 × 时段）：定价日/确认日均为交易日、确认日晚于定价日、份额由定价日净值唯一决定',
      bad9.length === 0, bad9.slice(0, 6).join(' | '));

    // 9.7 非交易日下单：两个日期都必须顺延到序列上
    const vsat = await buyPlan.previewOne({ code: 'A', market: 'A', feeRate: 0, date: '2023-09-30', session: 'T', amount: 100 });
    check('周六下单：pricingDate 与 settleDate 都顺延到序列上，且确认日更晚',
      vsat.status === 'ok' && seriesA.includes(vsat.pricingDate) && seriesA.includes(vsat.settleDate) && vsat.settleDate > vsat.pricingDate,
      JSON.stringify({ p: vsat.pricingDate, s: vsat.settleDate }));
  }

  console.log('\n----------------------------------------');
  console.log((fail === 0 ? '\u2705 全部断言通过' : '\u274c 有失败项') + '：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) { console.log('\n失败清单：'); fails.forEach(f => console.log('  - ' + f)); }
  console.log('（打桩网络请求计数 = ' + fetchCount + '，全程未联网）');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('崩溃：', e); process.exit(2); });

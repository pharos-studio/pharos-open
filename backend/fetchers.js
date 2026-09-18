'use strict';
/*
 * 数据抓取层：估值信号 / 净值历史 / 前十大持仓 / 新浪盘中指数。
 * 所有网络请求统一入口；缓存单例（valuationCache / danjuanEvaCache / navHistoryCache）
 * 迁移至本模块作用域，避免散落在 server.js 造成状态不一致。
 * 依赖：仅 Node 内置模块 + lib/http、lib/util、lib/store（零外部依赖）。
 */
const crypto = require('crypto');
const httpBase = require('./lib/http'); // UA / LEGU_UA / fetchText
const util = require('./lib/util');    // todayStr / decodeFetchBody
const store = require('./lib/store');  // readJSON / writeJSON / writeJSONSafe

const { UA, LEGU_UA, fetchText } = httpBase;
const { todayStr, decodeFetchBody } = util;
// 注意：fetchHoldings 需要 arrayBuffer + decodeFetchBody，故用原生 fetch 而非 fetchText
const fetch = globalThis.fetch;

// 键控单飞（in-flight 去重）：同一 key 的并发调用合并成**同一次**网络请求，完成后立刻释放 key。
// 只负责「去重」，不承担结果缓存 —— 缓存语义仍由各自的 cache 负责（TTL、失败重试时机都不变）。
// 为什么必须按 key 分：分析层并行化后，016452/018966 同享 NDX 估值、3 只宽基同享中债表；
// 若用全局单飞，不同 trackIndex（如 NDX 与 SH000300）会串到同一次结果上。
function once(inflightMap, key, run) {
  if (inflightMap[key]) return inflightMap[key];
  const p = run().then(
    (v) => { delete inflightMap[key]; return v; },
    (e) => { delete inflightMap[key]; throw e; }
  );
  inflightMap[key] = p;
  return p;
}

// ---------- 估值信号（便宜/贵，供 computeAllocation 类别内倾斜）----------
// 数据源链（从上往下取第一个可用的）：
//  ① 蛋卷免登录估值列表 index_eva/dj（一次返回 63 指数，含 NDX/CSIH30269/SH000300/SH000905/SH000993，每日更新）
//  ② 乐咕乐股 index-basic-pe（A 股指数，全自动：token=md5(上海日期) + cookie/_csrf 两步，兜底 202015）
//  ③ 蛋卷基金 index_eva 单指数（需登录，留作将来）
//  兜底：PE 分位拿不到 → peFallback 人工锚点（在 config.signals） → 净值历史价格分位（黄金 250 日、其余 120 日）。
const valuationCache = {}; // trackIndex -> { updated, value }
// 蛋卷免登录列表映射：holdings.trackIndex → 蛋卷列表 index_code
//   CSI930955(008163 红利低波50) → CSIH30269 红利低波（用户确认的因子代理；标普指数无免费源）
//     ⚠️ 红利 PE 分位线已砍（用户2026-09-01拍板，永不启用）：该映射仅取 dyr（股息率），不取 pe/pePercentile
//   NDX(016452/018966 纳指100) → NDX（精确）
//   SH000922(000922 中证红利) → SH000922（股息率参考带）
//   SH000993(全指信息,行业代理) → SH000993（蛋卷列表同名直取；原 SH000905 中证500 代理已弃，2026-09-02 换源；映射保留供行业代理复用）
//   SH000300(202015 沪深300) 无蛋卷映射 → 走乐咕 000300.SH（见 LEGU_INDEX）
const DANJUAN_INDEX = {
  'CSI930955': 'CSIH30269',
  'NDX': 'NDX',
  'SH000922': 'SH000922',
  'SH000993': 'SH000993'
};
const danjuanEvaCache = { updated: 0, map: null }; // 整列表缓存 12h
const danjuanEvaInflight = {};                     // 单飞（整列表只有一份，key 固定为 'list'）
async function fetchDanjuanEvaList() {
  if (danjuanEvaCache.map && Date.now() - danjuanEvaCache.updated < 12 * 3600 * 1000) return danjuanEvaCache.map;
  return once(danjuanEvaInflight, 'list', async () => {
    try {
      const txt = await fetchText('https://danjuanfunds.com/djapi/index_eva/dj', { Referer: 'https://danjuanfunds.com/' });
      const j = JSON.parse(txt);
      const items = (j && j.data && j.data.items) || [];
      if (!items.length) return null;
      const map = {};
      items.forEach(it => {
        if (!it.index_code) return;
        map[it.index_code] = {
          pe: it.pe, pePercentile: it.pe_percentile != null ? +(it.pe_percentile * 100).toFixed(1) : null,
          pbPercentile: it.pb_percentile != null ? +(it.pb_percentile * 100).toFixed(1) : null,
          dyr: it.yeild, asOf: it.date || null
        };
      });
      danjuanEvaCache.updated = Date.now();
      danjuanEvaCache.map = map;
      return map;
    } catch (e) { return null; } // 失败 → 调用方降级乐咕/锚点
  });
}
// 乐咕只映射"有准确对应指数"的基金（代理会误判估值）：
//   202015 沪深300 → 000300.SH（乐咕直取）。
//   008163 红利低波50 乐咕无对应指数 → 由蛋卷 CSIH30269 代理（见 DANJUAN_INDEX）。
const LEGU_INDEX = {
  'SH000300': '000300.SH'
};
async function fetchLeguValuation(indexCode, windowYears = 10) {
  // 1) GET 页面拿 cookie + _csrf（乐咕反爬：需带 session cookie 与 X-CSRF-Token）
  let pageRes;
  try {
    pageRes = await fetch('https://legulegu.com/stockdata/sz50-ttm-lyr', {
      headers: { 'User-Agent': LEGU_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' }
    });
  } catch (e) { return null; }
  const cookies = (pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : [])
    .map(c => c.split(';')[0]).join('; ');
  const html = await pageRes.text();
  const m = html.match(/<meta[^>]*name=["']_csrf["'][^>]*content=["']([^"']+)["']/i);
  const csrf = m ? m[1] : '';
  // 2) 指数 PE 历史（返回全量序列；token=md5(上海日期)，北京 0-8 点不偏天）
  const token = crypto.createHash('md5').update(todayStr()).digest('hex');
  try {
    const res = await fetch(`https://legulegu.com/api/stockdata/index-basic-pe?token=${token}&indexCode=${indexCode}`, {
      headers: {
        'User-Agent': LEGU_UA,
        'Referer': 'https://legulegu.com/stockdata/sz50-ttm-lyr',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'X-CSRF-Token': csrf,
        'Cookie': cookies
      }
    });
    if (!res.ok) return null;
    const j = JSON.parse(await res.text());
    const rows = (j && j.data) || [];
    if (!rows.length) return null;
    // 用「近 windowYears 年滚动TTM PE 分位」（用户标定5年窗口；乐咕自带 quantile 是全历史，与市场报告差异大）
    const cur = rows[rows.length - 1].addTtmPe;
    if (cur == null) return null;
    const cutY = Number(todayStr().slice(0, 4)) - windowYears;
    const cutStr = cutY + todayStr().slice(4); // 今天-windowYears年（上海日期）
    const last10 = rows.filter(r => r.date >= cutStr && r.addTtmPe != null);
    if (last10.length < 2) return null;
    const q = last10.filter(r => r.addTtmPe < cur).length / (last10.length - 1) * 100;
    return {
      pe: cur,
      pePercentile: +q.toFixed(1),          // 0-100 分位（近 10 年）
      pb: null, pbPercentile: null, dyr: null,
      asOf: rows[rows.length - 1].date,
      source: 'legulegu'
    };
  } catch (e) { return null; }
}
// peWindowYears：宽基乐咕滚动分位窗口年数（2026-09-13 提为配置项 config.signals.broad.peWindowYears，
// 与海外线 broadGlobal.peWindowWeeks 对齐；缺省 5，行为与提配置前完全一致）。
const valuationInflight = {}; // trackIndex -> Promise（单飞：016452/018966 同享 NDX，避免重复请求）
async function fetchValuation(trackIndex, peWindowYears) {
  if (!trackIndex) return null;
  const c = valuationCache[trackIndex];
  if (c && Date.now() - c.updated < 12 * 3600 * 1000) return c.value;
  // ★ 按 trackIndex 分键：不同指数绝不共享同一次请求（否则 NDX 的结果会串给沪深300）
  return once(valuationInflight, trackIndex, () => doFetchValuation(trackIndex, peWindowYears));
}
// 实际抓取（不含缓存/单飞判定）；「抓不到」一律返回 null，不抛异常（调用方按 null 降级）
async function doFetchValuation(trackIndex, peWindowYears) {
  let val = null;
  const leguCode = LEGU_INDEX[trackIndex];
  const djCode = DANJUAN_INDEX[trackIndex];
  const winYears = (peWindowYears != null && peWindowYears > 0) ? peWindowYears : 5;
  // ① 宽基（沪深300）：强制走乐咕「近N年滚动」分位（用户标定5年窗口+25/80阈值）
  if (leguCode) val = await fetchLeguValuation(leguCode, winYears);
  // ② 蛋卷免登录列表（红利/纳指/全指信息代理）：覆盖非宽基
  if (!val && djCode) {
    const djMap = await fetchDanjuanEvaList();
    const d = djMap && djMap[djCode];
    if (d && d.pePercentile != null) {
      if (trackIndex === 'CSI930955') {
        // 红利 PE 分位线已砍：只取股息率（dyr），绝不带 pe/pePercentile/pb/pbPercentile
        val = { dyr: d.dyr, asOf: d.asOf, source: 'danjuan' };
      } else {
        val = { pe: d.pe, pePercentile: d.pePercentile, pb: null, pbPercentile: d.pbPercentile, dyr: d.dyr, asOf: d.asOf, source: 'danjuan' };
      }
    }
  }
  // ③ 蛋卷单指数（需登录态）：仅非宽基兜底
  if (!val && !leguCode) {
    try {
      const txt = await fetchText(`https://danjuanfunds.com/djapi/index_eva/${trackIndex}`, { Referer: 'https://danjuanfunds.com/' });
      const j = JSON.parse(txt);
      if (j && j.result_code === 0 && j.data) {
        const d = j.data;
        val = {
          pe: d.pe, pePercentile: d.pe_percentile,
          pb: d.pb, pbPercentile: d.pb_percentile, dyr: d.dyr,
          source: 'danjuan'
        };
      }
    } catch (e) { /* 抓取失败 → null → 调用方降级 */ }
  }
  valuationCache[trackIndex] = { updated: Date.now(), value: val };
  return val;
}

// ---------- 天天基金：净值历史 / 最新净值 ----------
// 注意：东方财富 lsjz 接口每页固定约 20 条、忽略 pageSize，需用 pageIndex 翻页。
const navHistoryCache = {}; // code:maxDays -> { updated, history, failed }
const NAV_PER = 20;         // 东财 lsjz 固定每页约 20 条，忽略 pageSize
const NAV_HEADERS = { Referer: 'http://fundf10.eastmoney.com/' };
// 单页抓取。失败页返回 ok:false，绝不抛 —— 由调用方按「连续前缀」语义决定截断位置。
async function fetchNavPage(code, pageNo) {
  try {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${pageNo}&pageSize=${NAV_PER}`;
    const json = JSON.parse(await fetchText(url, NAV_HEADERS));
    const list = (json.Data && json.Data.LSJZList) || [];
    // TotalCount 由接口顶层返回（实测 008163=1600 / 202015=4252），用于算出真实页数上限
    const total = json.TotalCount != null ? Number(json.TotalCount) : null;
    return { ok: true, list, total };
  } catch (e) { return { ok: false, list: null, total: null }; }
}
// 返回 { history, failed }。failed=true 表示本次抓取失败/空结果（调用方应兜底，不得当 0）。
// 本函数是全站最热的网络扇出（9 只基金 × 最多 13 页，回测脚本可到 213 页），改造要点：
//   ① 先「串行」取第 1 页 —— 它同时给出 TotalCount，据此算出真实页数上限，绝不盲翻；
//   ② 其余页 Promise.all 并行（并发上限由 lib/http 的全局闸门兜住，不会被数据源限流）；
//   ③ ★有序前缀拼接：按页号升序回放，遇首个「失败页/空页」立即截断，`length<PER` 视为自然结束。
//      绝不跳过坏页继续拼后面的页 —— percentileOf / MA120/250 / stableLow / recentChangePct
//      全按「连续序列」消费，序列里挖洞会静默算错金融指标（不报错、不崩，只是数字错）。
//   ④ 截断条件与旧串行版逐条对齐，故 history 与旧实现**位级相同**（同序、同解析、同 slice）。
// 唯一有意的行为改进：旧版页数上限是 `ceil(maxDays/PER)+1`，当某基金总条数恰是 20 的整数倍时
//   会多翻一页拿到空页 → 误判 fetchError=true → failed=true（明明已拿到完整历史）。新版按 TotalCount
//   收敛页数，此时 failed 正确为 false。history 内容不受影响。
async function fetchNavHistory(code, maxDays = 60) {
  const c = navHistoryCache[code + ':' + maxDays];
  // 缓存 1h 且带 failed 状态；失败缓存不长期污染（1h 后重试）
  if (c && Date.now() - c.updated < 3600 * 1000) return { history: c.history, failed: c.failed };
  const PER = NAV_PER;

  const p1 = await fetchNavPage(code, 1);
  // 真实页数上限 = min(按需要天数估、按总条数估)；TotalCount 缺失时不设额外上限。
  // 串行版最早在第 ceil(maxDays/PER) 页就会因攒够 maxDays 而 break，故该上限绝不会少取。
  let pages = 0;
  if (p1.ok && p1.list.length) {
    const needByDays = Math.ceil(maxDays / PER);
    const needByTotal = (p1.total != null && p1.total > 0) ? Math.ceil(p1.total / PER) : Infinity;
    pages = Math.max(1, Math.min(needByDays, needByTotal));
  }
  const rest = [];
  for (let p = 2; p <= pages; p++) rest.push(fetchNavPage(code, p));
  const restRes = await Promise.all(rest);

  const all = [];
  let fetchError = false;
  // 第 1 页失败/为空时 rest 必为空数组 → 循环首轮即 break，与串行版一致
  for (const r of [p1].concat(restRes)) {
    if (!r.ok || !r.list.length) { fetchError = true; break; }
    r.list.forEach(x => all.push({ date: x.FSRQ, nav: parseFloat(x.DWJZ), acc: parseFloat(x.LJJZ), dayChange: x.JZZZL === '' ? null : parseFloat(x.JZZZL) }));
    if (r.list.length < PER) break;   // 已到最老一页（自然结束，不算失败）
    if (all.length >= maxDays) break; // 已攒够所需天数
  }
  const history = all.filter(r => !isNaN(r.nav)).slice(0, maxDays); // 最新在前（API 默认按日期降序）
  const failed = fetchError || history.length === 0;
  // 空/失败结果也缓存（防频繁重试），但 1h 后失效重试
  navHistoryCache[code + ':' + maxDays] = { updated: Date.now(), history, failed };
  return { history, failed };
}
async function fetchNavOnDate(code, targetDate) {
  // 逐页翻找 <= targetDate 的「最近」交易日（取日期最大者）。
  // 单页 20 条，最多翻 60 页（约 1200 个交易日，足够覆盖数年）。
  // ★ 首页短路（2026-09-16）：lsjz 按 FSRQ 严格降序返回（见上面 fetchNavHistory 的说明），
  //   故本页一旦出现 <= targetDate 的记录，其最大值即**全局答案**，后续页日期只会更早。
  //   数学依据：设 best = max{r ∈ 本页 | r.date <= target}，minPage = min{本页日期}；
  //   存在 r.date <= target ⟹ best >= minPage；后续页所有日期 <= minPage <= best ⟹ 不可能更优。
  //   收益：016452 这类 1600+ 条历史的基金，原实现每次要翻 45 页 —— 现在 1 页。
  //   已用 probe_nav_reqcount.js 对 6 组 (code,date) 做过新旧实现对拍，quote 逐位相同。
  const PER = NAV_PER;
  let best = null;
  for (let page = 1; page <= 60; page++) {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${page}&pageSize=${PER}`;
    let json;
    try { json = JSON.parse(await fetchText(url, { Referer: 'http://fundf10.eastmoney.com/' })); }
    catch (e) { break; }
    const list = (json.Data && json.Data.LSJZList) || [];
    if (!list.length) break;
    for (const r of list) {
      if (r.FSRQ <= targetDate && (!best || r.FSRQ > best.date)) {
        best = { date: r.FSRQ, nav: parseFloat(r.DWJZ) };
      }
    }
    if (best) break;              // ★ 首页命中即停（见上方证明）
    if (list.length < PER) break; // 已到最老一页
  }
  return best;
}

/*
 * fetchNavOnDate 的**对偶**函数（2026-09-16 新增）：
 *   fetchNavOnDate(code, d)      → 序列中「最后一个 <= d」的净值（"d 那天或之前最近"）
 *   fetchNavOnOrAfter(code, d)   → 序列中「第一个 >= d」的净值（"d 那天或之后最近"）
 * 后者用来把「名义成交日」顺延到真实交易日，从而**不需要节假日表**（见 lib/buyPlan.js）。
 *
 * ★★ 算法不要写错（这是最容易踩的坑）：
 *   lsjz 是**严格降序**流。绝不能「取本页第一个 FSRQ >= nominal」——
 *   名义日 09-12 时，页内 [09-16, 09-15, 09-14, 09-11...] 首个 >= 09-12 的是 **09-16**，
 *   而正确答案是 **09-14**。
 *   正解：沿降序流找「第一条 date <= nominal」的时刻，取它**紧邻的前一条**（`prev`）。
 *   因为此刻流里所有已过目记录都 > nominal，prev 就是其中最小的那个 = 全局答案。
 *   `prev` 必须跨页持有；命中即短路返回，请求量与 fetchNavOnDate 同量级。
 *
 * 返回 { date, nav }（命中）；取不到时 { date: null, nav: null, reason }：
 *   'future' —— 名义日在最新净值日之后（净值尚未公布 ⇒ 正常「在途」）
 *   'tooOld' —— 名义日早于该基金可查范围（翻到最老一页仍未出现 date <= nominal）
 *   'error'  —— 抓取失败（第 1 页就空/异常，拿不到任何可判断的信息）
 */
async function fetchNavOnOrAfter(code, nominalDate) {
  const PER = NAV_PER;
  let prev = null; // 降序流里「已过目的、日期 > nominalDate 的记录中最小的一条」
  for (let page = 1; page <= 60; page++) {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${page}&pageSize=${PER}`;
    let json;
    try { json = JSON.parse(await fetchText(url, NAV_HEADERS)); }
    catch (e) { return { date: null, nav: null, reason: 'error' }; }
    const list = (json.Data && json.Data.LSJZList) || [];
    if (!list.length) break;
    for (const r of list) {
      const nav = parseFloat(r.DWJZ);
      if (!isFinite(nav)) continue;            // 脏行（无净值）跳过：绝不参与定位
      if (r.FSRQ <= nominalDate) {
        if (r.FSRQ === nominalDate) return { date: r.FSRQ, nav };   // 名义日本身就是交易日
        return prev ? { date: prev.date, nav: prev.nav }            // 否则答案 = 紧邻的前一条
                    : { date: null, nav: null, reason: 'future' };// prev 为空 ⇒ 全部记录都晚于名义日
      }
      prev = { date: r.FSRQ, nav };
    }
    if (list.length < PER) break;              // 已到最老一页
  }
  // 走到这里：要么翻遍最老一页都没有 date <= nominal（名义日太老），要么第 1 页就空
  return prev ? { date: null, nav: null, reason: 'tooOld' }
              : { date: null, nav: null, reason: 'error' };
}

// ---------- 天天基金：前十大持仓 ----------
// 结构（实测 016452 等）：td[0]=序号 td[1]=代码(NVDA/6位A股/285A) td[2]=名称 td[3..4]=-- td[5]=股吧行情 td[6]=占净值比例% td[7..]=其他
// 注意：占比列索引必须基于**原始 td 数组**（过滤噪声单元格会左移导致错位）。
function parseHoldingsContent(content) {
  const rows = [];
  const tbodyMatch = content.match(/<tbody>([\s\S]*?)<\/tbody>/);
  const body = tbodyMatch ? tbodyMatch[1] : content;
  // 表头定位"占净值比例"列索引（找不到默认 6）
  const headMatch = content.match(/<thead>([\s\S]*?)<\/thead>/);
  let pctIdx = 6;
  if (headMatch) {
    const ths = [...headMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
      .map(x => x[1].replace(/<[^>]+>/g, '').trim());
    const found = ths.findIndex(t => /占净值比例|占净值/.test(t));
    if (found >= 0) pctIdx = found;
  }
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(body))) {
    // 原始 td（含噪声格，保持索引与表头对齐）
    const rawTds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map(x => x[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').replace(/,/g, '').trim());
    if (rawTds.length < 3) continue;
    const code = rawTds[1]; // 第 2 列固定是代码（NVDA / 285A / 6位A股 / 5位港股）
    if (!code || !/^[A-Z0-9]{1,12}$/.test(code)) continue;
    if (/^\d+$/.test(code)) {
      // 纯数字仅认 A股6位 / 港股5位（东财恒补前导0，如 01888/01347）；序号 1..10 等短串被长度排除
      if (code.length !== 5 && code.length !== 6) continue;
    }
    const name = rawTds[2]; // 第 3 列固定是名称
    // 名称须含 CJK 或拉丁字母：放行 KIOXIA/TSM 等罗马字名，同时挡掉 "--"/纯符号/纯数字噪声行
    if (!name || !/[A-Za-z\u4e00-\u9fff]/.test(name)) continue;
    const pctCell = rawTds[pctIdx] != null ? rawTds[pctIdx] : '';
    const pct = parseFloat(String(pctCell).replace('%', ''));
    if (isNaN(pct) || pct <= 0 || pct > 60) continue; // >60% 明显是持股数/市值误列
    rows.push({ code, name, pct });
  }
  return rows;
}
async function fetchHoldings(code) {
  // 缓存 1 天：配合每日刷新，季报在天天基金发布后最快 1 天内即被拾取（季报感知）。
  // 注：F10 十大重仓股为季度披露，季度内基金经理调仓不可见——这是数据源限制，非刷新频率问题。
  let cache = {};
  try { cache = store.readJSON('holdings_cache.json'); } catch (e) { cache = {}; }
  const now = Date.now();
  const c = cache[code];
  if (c && now - c.updated < 1 * 24 * 3600 * 1000) return c;
  // 代理链：ETF 联接自身 jjcc 为空（持 ETF 无个股）时，用同指数基金代理（holdings.json penetrationProxy）
  const hld = store.readJSON('holdings.json');
  const fundDef = (hld && hld.funds || []).find(f => f.code === code);
  const proxyCode = fundDef && fundDef.penetrationProxy;
  const fetchCode = proxyCode || code;
  const url = `http://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fetchCode}&topline=10`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'http://fundf10.eastmoney.com/' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const txt = decodeFetchBody(Buffer.from(await res.arrayBuffer()));
  const contentMatch = txt.match(/content:"([\s\S]*?)",\s*arryear/);
  const dateMatch = txt.match(/截止至：<font class='px12'>([\d-]+)<\/font>/);
  const content = contentMatch ? contentMatch[1] : txt;
  const stocks = parseHoldingsContent(content);
  const result = { updated: now, date: dateMatch ? dateMatch[1] : null, stocks, proxy: proxyCode || null };
  cache[code] = result;
  store.writeJSONSafe('holdings_cache.json', cache);
  return result;
}

// ---------- 10年期国债收益率（ERP 第二锚）----------
// 东方财富 RPTA_WEB_TREASURYYIELD 同一行同时返回两国10年期：
//   EMM00166466 = 中国国债收益率10年（百分比，如 1.6883）
//   EMG00001310 = 美国国债收益率10年（百分比，如 4.96）
// ★取数规矩（用户硬性要求 + 2026-09-12 扩充）：
//   - 中债仅服务 A 股宽基（core.js）→ config.treasury10y 兜底；
//   - 美债仅服务海外口径（broadGlobal.js）→ config.usTreasury10y 兜底；
//   - 二者**不可互为兜底**（跨市场混算会让 ERP 失真：A股-中债、美股-美债才是同一市场内的股债比）。
//   - 抓取失败返回 null 交由调用方回退各自常量，绝不降级到另一种债。
// ps=5 起逐行回扫「最近非空」是必需的：东财表格实测存在最新日美债列为空的情况（如 2026-09-07 美债全空）。
const bond10yCache = { updated: 0, value: null }; // 会话内缓存 12h（日频数据）
const bond10yInflight = {}; // 单飞：3 只宽基（202015 / 016452 / 018966）并发时共享同一次请求
async function fetchBond10Y() {
  if (bond10yCache.value != null && Date.now() - bond10yCache.updated < 12 * 3600 * 1000) return bond10yCache.value;
  // 注意：本接口走原生 fetch（见下方 doFetchBond10Y），不受 lib/http 全局闸门约束 —— 单次仅 1 个请求，无需约束
  return once(bond10yInflight, 'bond10y', () => doFetchBond10Y());
}
// 实际抓取（不含缓存/单飞判定）；「抓不到」一律返回 null，绝不抛
async function doFetchBond10Y() {
  try {
    const url = 'https://datacenter.eastmoney.com/api/data/get?type=RPTA_WEB_TREASURYYIELD&sty=ALL&st=SOLAR_DATE&sr=-1&token=894050c76af8597a853f5b408b759f5d&p=1&ps=10&pageNo=1&pageNum=1';
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/cjsj/zmgzsyl.html' } });
    if (!res.ok) return null;
    const j = JSON.parse(await res.text());
    const rows = (j && j.result && j.result.data) || [];
    if (!rows.length) return null;
    // 逐行回扫：CN / US 各自取「最近一个非空」，互不牵连（某日只有一边有值时仍可用）
    let cn = null, cnAsOf = null, us = null, usAsOf = null;
    for (const r of rows) {
      const d = r.SOLAR_DATE ? String(r.SOLAR_DATE).slice(0, 10) : null;
      if (cn == null && r.EMM00166466 != null && !isNaN(r.EMM00166466)) { cn = +r.EMM00166466 / 100; cnAsOf = d; }
      if (us == null && r.EMG00001310 != null && !isNaN(r.EMG00001310)) { us = +r.EMG00001310 / 100; usAsOf = d; }
      if (cn != null && us != null) break;
    }
    if (cn == null && us == null) return null;
    const value = { cn, us, asOf: cnAsOf || usAsOf, cnAsOf, usAsOf };
    bond10yCache.value = value;
    bond10yCache.updated = Date.now();
    return value;
  } catch (e) { return null; }
}
// 向后兼容：A 股宽基原先只取中债标量。**只返回中债**，绝不回退美债。
async function fetchCNBond10Y() {
  const b = await fetchBond10Y();
  return b && b.cn != null ? b.cn : null;
}

// ---------- 指数 PE 历史序列（海外宽基的估值/回撤数据源）----------
// 蛋卷 index_eva/pe_history：一次返回该指数全部历史周频 PE（NDX 实测 513 点，2016-09 起）。
// ★必须带 day=all：不带参数报 200007「api参数缺少」、day=1y 报 999001「参数错误」（只有 all 有效）。
// 用途：① 自算滚动窗口分位（替代蛋卷当期 pe_percentile——那个是固定约10年口径，遇水位台阶会失效）
//       ② 算 PE 相对近期高点的回撤（比净值回撤灵敏，纳指 60 日跌 15% 极罕见）。
// 失败返回 null，调用方降级（不报错、不写 0）。
const peHistoryCache = {}; // indexCode -> { updated, rows }
async function fetchIndexPeHistory(indexCode, maxAgeMs) {
  if (!indexCode) return null;
  const ttl = maxAgeMs != null ? maxAgeMs : 24 * 3600 * 1000;
  const c = peHistoryCache[indexCode];
  if (c && Date.now() - c.updated < ttl) return c.rows;
  try {
    const url = `https://danjuanfunds.com/djapi/index_eva/pe_history/${encodeURIComponent(indexCode)}?day=all`;
    const txt = await fetchText(url, { Referer: 'https://danjuanfunds.com/' });
    const j = JSON.parse(txt);
    const raw = (j && j.data && j.data.index_eva_pe_growths) || [];
    if (!raw.length) return null;
    const rows = raw
      .map(x => ({ date: new Date(x.ts).toISOString().slice(0, 10), pe: +x.pe }))
      .filter(x => x.pe > 0 && x.pe < 200 && x.date)   // 过滤异常值（0/负/离谱 PE）
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!rows.length) return null;
    peHistoryCache[indexCode] = { updated: Date.now(), rows };
    return rows;
  } catch (e) { return null; }
}


// ---------- 天天基金：全量基金代码表（添加基金自动带出：名称/类型/市场）----------
// 数据源：fund.eastmoney.com/js/fundcode_search.js（一次约 2.3MB / 2.7 万只，日更）
// 行结构 [code, 拼音缩写, 名称, 类型文本, 全拼]。市场判定：类型含 QDII/海外 → QDII，否则 A。
// 缓存 data/cache/fundlist_cache.json（TTL 7 天）+ 内存驻留，同进程只解析一次；A 主 B 兜底见 fundMetaLookup。
const FUNDLIST_TTL = 7 * 24 * 3600 * 1000;
let fundListMem = { updated: 0, rows: null }; // rows=[[code,jp,name,type,pinyin],...] 原始列序
async function ensureFundList() {
  // ① 内存新鲜 → 直接用
  if (fundListMem.rows && Date.now() - fundListMem.updated < FUNDLIST_TTL) return fundListMem.rows;
  // ② 磁盘缓存新鲜 → 载入内存
  if (!fundListMem.rows) {
    try {
      const c = store.readJSON('fundlist_cache.json');
      if (c && Array.isArray(c.list) && c.list.length && Date.now() - c.updated < FUNDLIST_TTL) {
        fundListMem = { updated: c.updated, rows: c.list };
        return fundListMem.rows;
      }
    } catch (e) { /* 无缓存/损坏 → 重拉 */ }
  }
  // ③ 重拉全量
  try {
    const txt = await fetchText('https://fund.eastmoney.com/js/fundcode_search.js', { Referer: 'https://fund.eastmoney.com/' });
    const arr = txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1);
    const parsed = JSON.parse(arr);
    if (Array.isArray(parsed) && parsed.length) {
      const rows = parsed.filter(r => Array.isArray(r) && /^\d{6}$/.test(String(r[0])) && r[2] && r[3]);
      fundListMem = { updated: Date.now(), rows };
      store.writeJSONSafe('fundlist_cache.json', { updated: fundListMem.updated, list: rows });
      return rows;
    }
  } catch (e) { console.warn('[fundlist] 全量代码表拉取失败:', e && e.message || e); }
  // ④ 拉取失败 → 沿用旧磁盘缓存（即使过期），保证名单仍可用
  if (!fundListMem.rows) {
    try {
      const c = store.readJSON('fundlist_cache.json');
      if (c && Array.isArray(c.list) && c.list.length) fundListMem = { updated: c.updated, rows: c.list };
    } catch (e) {}
  }
  return fundListMem.rows;
}
function marketOfType(typeText) {
  return /QDII|海外/.test(typeText || '') ? 'QDII' : 'A';
}
// A+B 双保险：① 本地全量表精确查；② 名单外（次新基金/名单整体失败）→ 搜索接口逐码兜底
async function fundMetaLookup(code) {
  const rows = await ensureFundList();
  if (rows) {
    const hit = rows.find(r => r[0] === code);
    if (hit) {
      const type = hit[3] || '';
      return { found: true, name: hit[2], type, market: marketOfType(type), source: 'list' };
    }
  }
  try {
    const txt = await fetchText('https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=' + code, { Referer: 'https://fund.eastmoney.com/' });
    const j = JSON.parse(txt);
    const rec = ((j && j.Datas) || []).find(d => d && d.CODE === code);
    if (rec) {
      const type = (rec.FundBaseInfo && rec.FundBaseInfo.FTYPE) || '';
      const name = rec.NAME || (rec.FundBaseInfo && rec.FundBaseInfo.SHORTNAME) || null;
      if (name) return { found: true, name, type, market: marketOfType(type), source: 'suggest' };
    }
  } catch (e) { /* 兜底失败 → found:false，调用方提示手动填写 */ }
  return { found: false };
}
// /api/fund-list 用：精简三列 [code,name,type]（前端联想无需拼音/全拼列）
async function getFundListMeta() {
  const rows = await ensureFundList();
  if (!rows) return null;
  return { updated: fundListMem.updated, total: rows.length, list: rows.map(r => [r[0], r[2], r[3] || '']) };
}

// ---------- 东财：A股个股行业（穿透补词典向导的赛道预选用）----------
// 数据源：push2.eastmoney.com/api/qt/stock/get?secid={mkt}.{code}&fields=f57,f58,f100,f127 → f127=东财行业名（实测 016874 九只重仓 9/9 命中，免鉴权）。
// secid 前缀：6 开头 → 1.（沪市）；0/3 开头 → 0.（深市）。海外/含字母码跳过（返回 null，仍走 theme_map 词典）。
// 缓存 data/cache/stock_industry_cache.json（TTL 7 天）+ 会话内 Map；并行抓取 + 单码容错。
const INDUSTRY_TTL = 7 * 24 * 3600 * 1000;
let stockIndustryDisk = null; // { updated, map:{code:industry|null} } 整块载入
async function ensureStockIndustryDisk() {
  if (stockIndustryDisk) return stockIndustryDisk;
  try { stockIndustryDisk = store.readJSON('stock_industry_cache.json'); } catch (e) { stockIndustryDisk = null; }
  if (!stockIndustryDisk || typeof stockIndustryDisk.map !== 'object') stockIndustryDisk = { updated: 0, map: {} };
  return stockIndustryDisk;
}
function isAShareCode(c) { return /^\d{6}$/.test(c) && /^[036]/.test(c); }
async function fetchStockIndustryBatch(codes) {
  const disk = await ensureStockIndustryDisk();
  // 整盘过期（TTL 7 天）→ 重置 map 全量重抓（防行业分类长期 stale）
  if (!(Date.now() - disk.updated < INDUSTRY_TTL)) disk.map = {};
  const result = {};
  const miss = [];
  for (const raw of codes) {
    const key = String(raw == null ? '' : raw);
    if (!isAShareCode(key)) { result[key] = null; continue; } // 海外码/非法 → null（前端该行无行业 chip、留空手选）
    if (key in disk.map) { result[key] = disk.map[key]; continue; } // 已确认结果（含"确认无行业"的 null）直接复用，绝不重抓
    miss.push(key); // 从未成功抓取过的码 → 每轮都重试（失败不写缓存、不短路）
  }
  if (miss.length) {
    // ⚠️ 失败与"确认无行业"必须区分：失败(network/HTTP)本次返回 null 但不写缓存（下次重试）；
    //    只有抓取成功（f127 空也算确认无行业）才写盘缓存——否则单次瞬时抖动会把 null 固化 7 天。
    const out = await Promise.all(miss.map(async (key) => {
      try {
        const res = await fetch(`https://push2.eastmoney.com/api/qt/stock/get?secid=${key[0] === '6' ? '1.' : '0.'}${key}&fields=f57,f58,f100,f127`, {
          headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' }
        });
        if (!res.ok) return { key, ind: null, err: true };
        const j = await res.json();
        const d = (j && j.data) || {};
        const ind = d.f127 ? String(d.f127) : null;
        return { key, ind, err: false };
      } catch (e) { return { key, ind: null, err: true }; }
    }));
    let anySuccess = false;
    for (const o of out) {
      if (o.err) { result[o.key] = null; continue; }
      disk.map[o.key] = o.ind;
      result[o.key] = o.ind;
      anySuccess = true;
    }
    if (anySuccess) {
      disk.updated = Date.now();
      try { store.writeJSONSafe('stock_industry_cache.json', { updated: disk.updated, map: disk.map }); } catch (e) { /* 写失败下次再写 */ }
    }
  }
  return result;
}

// ---------- 新浪：指数实时（用于 A 股基金盘中估算）----------
async function fetchSinaIndex(codes) {
  if (!codes.length) return {};
  const list = codes.join(',');
  const txt = await fetchText(`https://hq.sinajs.cn/list=${list}`, { Referer: 'https://finance.sina.com.cn/' });
  const out = {};
  const re = /var hq_str_(\w+)="([^"]*)";/g;
  let m;
  while ((m = re.exec(txt))) {
    const code = m[1];
    const f = m[2].split(',');
    if (f.length < 4 || f[0] === '') continue;
    const name = f[0];
    const prevClose = parseFloat(f[2]);
    const current = parseFloat(f[3]);
    const changePct = (prevClose && !isNaN(current)) ? (current - prevClose) / prevClose * 100 : 0;
    out[code] = { name, prevClose, current, changePct };
  }
  return out;
}

module.exports = {
  DANJUAN_INDEX, LEGU_INDEX,
  fetchDanjuanEvaList, fetchLeguValuation, fetchValuation,
  fetchNavHistory, fetchNavOnDate, fetchNavOnOrAfter,
  parseHoldingsContent, fetchHoldings,
  fetchSinaIndex, fetchCNBond10Y, fetchBond10Y, fetchIndexPeHistory,
  fundMetaLookup, getFundListMeta,
  fetchStockIndustryBatch
};

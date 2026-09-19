'use strict';
/*
 * 基金投资管理看板 - 本地服务（路由 / 装配层）
 * 依赖：仅 Node 内置模块（Node 18+，使用全局 fetch）。
 * 纯业务逻辑已拆至 engines/ 与 lib/，本文件只负责 HTTP 路由、鉴权、静态托管与启动装配。
 * 启动：node server.js   然后浏览器打开 http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// 引擎与基础模块
const store = require('./lib/store');
const util = require('./lib/util');
const config = require('./lib/config');
const fetchers = require('./fetchers');
const analysis = require('./engines/analysis');
const allocation = require('./engines/alloc/allocation');
const decisions = require('./engines/decisions');
const advice = require('./engines/advice');
const timing = require('./engines/timing'); // 买入时机复盘：战役采集/buy 补扫/统计（见 docs/买入时机复盘模块-设计v2.md）
const backfill = require('./engines/backfill'); // 在途买入记录自动补填（买入确认日净值 → 份额）
const tradeDate = require('./lib/tradeDate'); // 交易时段口径引擎：成交净值日推算
const buyPlan = require('./lib/buyPlan'); // 买入方案推导：口径→净值→份额（唯一实现，预览/保存共用）
const schema = require('./lib/schema'); // 数据结构版本与迁移（唯一版本口径，见 lib/schema.js 顶部说明）
const trackIndex = require('./lib/trackIndex'); // 指数白名单与类别推断（唯一真相源）

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = store.DATA_DIR;
const PORT = process.env.PORT || 3000;

// /api/fund-list 序列化缓存：2.7 万行只 stringify 一次（刷新名单时重建），避免每次请求烧 CPU
let fundListCacheStr = null;

// 合法类别（fund.category）：**实时读取** categories.json 的 engines + 用户自建分类。
// ★ 这里必须是「函数」而不是启动时算一次的常量：用户在看板里自建分类后要立刻能保存，
//   不能等重启进程。（旧实现启动时只读一次，自建分类会被 400 拦下，且用户看不出原因。）
//   5 秒 TTL 只是为了别每次请求都读盘。
const BASE_CATEGORIES = ['broad', 'dividend', 'growth', 'cycle', 'bond', 'cash'];
let _catCache = null, _catCacheAt = 0;
function allowedCategories() {
  if (_catCache && (Date.now() - _catCacheAt) < 5000) return _catCache;
  const base = new Set(BASE_CATEGORIES);
  try {
    const cats = store.readJSON('categories.json');
    const eng = (cats && Array.isArray(cats.engines)) ? cats.engines : [];
    for (const e of eng) { if (e && e.key) base.add(e.key); }
    const cus = (cats && Array.isArray(cats.customCategories)) ? cats.customCategories : [];
    // 自建分类要登记 **它的 key**（用户实际存进 fund.category 的就是这个），
    // 而不是它绑定的算法 key —— 否则用户自建的类别会被 400 拦下。
    for (const e of cus) { if (e && e.key) base.add(e.key); }
  } catch (e) { /* 读不到就以内置六类兜底 */ }
  _catCache = Array.from(base);
  _catCacheAt = Date.now();
  return _catCache;
}

function json(res, obj, code = 200) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}
function httpError(res, code) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Error ' + code);
}
// /api/state 下发前剥离密钥：apiKey 是 /api/save 的鉴权密钥（防局域网/OpenClaw 远程一次 GET 拿走 Key 后任意改数据），
// llm.apiKey / news.*.key 同理为敏感凭据。前端从不读这些字段（设置页 Key 为用户手输、存浏览器本地）。
// ⚠️ 配套：/api/save 必须 merge 而非整份替换 + restoreSecrets（见该分支），否则剥离后的 state.config 回写会把磁盘 Key 抹掉。
function sanitizeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const c = Object.assign({}, cfg);
  delete c.apiKey;
  if (c.llm && typeof c.llm === 'object') { c.llm = Object.assign({}, c.llm); delete c.llm.apiKey; }
  if (c.news && typeof c.news === 'object') {
    const n = Object.assign({}, c.news);
    for (const k of Object.keys(n)) {
      if (n[k] && typeof n[k] === 'object') { n[k] = Object.assign({}, n[k]); delete n[k].key; }
    }
    c.news = n;
  }
  return c;
}
// 剥离后的 state.config 整份回写时会缺密钥键 → 从磁盘原值恢复，防写一次操作把鉴权 Key 抹掉
function restoreSecrets(merged, cur) {
  if (merged && cur) {
    if (merged.apiKey == null && cur.apiKey != null) merged.apiKey = cur.apiKey;
    if (cur.llm && merged.llm && merged.llm.apiKey == null) merged.llm.apiKey = cur.llm.apiKey;
    if (cur.news && merged.news) {
      for (const k of Object.keys(cur.news)) {
        if (cur.news[k] && merged.news[k] && merged.news[k].key == null && cur.news[k].key != null) {
          merged.news[k] = Object.assign({}, merged.news[k], { key: cur.news[k].key });
        }
      }
    }
  }
  return merged;
}
function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let d = '';
    let tooBig = false;
    req.on('data', c => {
      d += c;
      if (d.length > maxBytes) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => tooBig ? reject(new Error('body too large')) : resolve(d));
    req.on('error', reject);
  });
}

// ---------- 买入记录：共用校验与只读元数据 ----------
// 下单日校验（/api/purchase 与 /api/purchase-preview 共用，避免两份日期规则漂移）。
// 注意：这里只校验「下单日」不得晚于今天；成交净值日**允许**落在明天（那是「尚未公布」，不是非法）。
function validateOrderDate(date) {
  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'date 格式须为 YYYY-MM-DD' };
  const [yy, mm, dd] = date.split('-').map(Number);
  // ★ 用 UTC 锚点 + UTC getter 做「是否真实日期」的往返校验（如 2026-02-30 会被滚动到 03-02 → 不相等）。
  //   若用本机时区 getter，进程跑在 UTC 时会把 2026-09-02 解析成 09-01T16:00Z，
  //   于是拿 9/1 去比对 9/2 → **把合法日期判成非法**。铁律见 lib/tradeDate.js 顶部。
  const dt = new Date(date + 'T00:00:00Z');
  if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() + 1 !== mm || dt.getUTCDate() !== dd) return { error: 'date 不是真实日期' };
  if (date > util.todayStr()) return { error: 'date 不能晚于今天（上海时区）' };
  return { ok: true };
}

// 买入记录的「定价日 / 份额确认日」旁挂表 —— 只读，绝不写回 holdings.json。
// 为什么旁挂而不注入 purchases 数组：前端 addFund/removeFund 会 api.save({holdings: state.holdings})
//   整份回写，注入的字段会被顺手写盘造成意外迁移；而 /api/save 只认 holdings/categories/config 三个顶层键，
//   旁挂字段天然写不进去。
// 键 { code: { '<date>|<amount>': { pricingDate, settleDate, inferred } } }，与前端 editKey/buyTable 同口径。
//   pricingDate —— 成交净值日（**份额由它的净值决定**）
//   settleDate  —— 份额确认日（份额登记到账的时间，**不参与任何计算**）
// 取值优先级：p.pricingDate（真实解析所得）→ 旧名 p.navDate / p.confirmDate → legacyConfirmDate（老记录推定，标 inferred）。
function buildNavMeta(holdings) {
  const out = {};
  const funds = (holdings && Array.isArray(holdings.funds)) ? holdings.funds : [];
  for (const f of funds) {
    if (!f || !f.code) continue;
    const list = Array.isArray(f.purchases) ? f.purchases : [];
    if (!list.length) continue;
    const market = f.market === 'QDII' ? 'QDII' : 'A';
    const bag = {};
    for (const p of list) {
      if (!p || !p.date) continue;
      const amt = Math.round(Number(p.amount) * 100) / 100;
      if (!isFinite(amt)) continue;
      // 新字段优先；同时兼容 2026-09-17 之前的旧字段名（navDate / confirmDate 存的都是**定价日**）
      let pricingDate = p.pricingDate || p.navDate || p.confirmDate || null;
      let settleDate = p.settleDate || null;
      let inferred = false;        // pricingDate 是推定值（老记录，无任何日期字段）
      let settleInferred = false;  // settleDate 只是名义值（未落盘 → 用 +1/+2 工作日粗算，不认节假日）
      if (!pricingDate) {
        // 老记录（2026-09 之前）：没有任何日期字段，其 nav 是按冻结的旧口径（= 份额确认日 offset 被误用成定价日）算的。
        // 给出「推定值」并标记 inferred，前端需以弱化样式呈现 —— 绝不冒充真实解析结果。
        pricingDate = tradeDate.legacyConfirmDate(p.date, market);
        inferred = true;
      }
      // 没有落盘的份额确认日 → 给名义值（+1 工作日 A股 / +2 工作日 QDII，不认节假日），**单独标记**
      // ★ 绝不能复用 inferred：那是 pricingDate 的属性，混用会把「定价日明明是真实值」的老记录误标成推定（实测踩到）
      if (!settleDate) {
        settleDate = tradeDate.settleNominalDate(pricingDate, market);
        settleInferred = true;
      }
      bag[p.date + '|' + amt] = { pricingDate, settleDate, inferred, settleInferred };
    }
    out[f.code] = bag;
  }
  return out;
}

// ---------- HTTP 服务 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, `http://localhost:${PORT}`); }
  catch { return httpError(res, 400); } // 畸形请求路径（如 //）不应击垮整个服务
  const p = u.pathname;
  try {
    if (p === '/api/state') {
      const holdings = store.readJSON('holdings.json');
      // navMeta：买入记录「成交净值日」只读旁挂（老记录由后端按冻结旧口径推定），绝不写回 holdings.json
      return json(res, { holdings, categories: store.readJSON('categories.json'), config: sanitizeConfig(config.getConfig()), history: store.readHistory(), navMeta: buildNavMeta(holdings) });
    }
    if (p === '/api/refresh') {
      // 自动补填：每次看板加载/刷新时，把「确认日净值已发布」的在途记录自动转已确认（零手动）
      try { await backfill.autoBackfillPending(); } catch (e) { console.warn('[backfill] 自动补填失败:', e && e.message || e); }
      return json(res, await analysis.handleRefresh());
    }
    if (p === '/api/advice') {
      const s = u.searchParams.get('session') === 'pm' ? 'pm' : 'am';
      const out = await advice.buildAdvice(s);
      // 买入时机复盘：advice 命中幂等补扫 purchases（buy 样本，仅执行记录）
      try { timing.buyScan(); } catch (e) { console.warn('[timing] buyScan 失败:', e && e.message || e); }
      return json(res, out);
    }
    if (p === '/api/timing') {
      // 买入时机复盘：只读统计（采集进度 / 两账 / 诊断细分 / 候选 / 跟单成效）
      // 懒回填：过期未回填样本异步 fetchNavHistory（in-flight 锁防并发），先响应后回填，绝不阻塞
      const st = timing.stats();
      timing.runBackfill().catch(() => {});
      return json(res, st);
    }
    if (p === '/api/nav-on-date') {
      const code = u.searchParams.get('code');
      const date = u.searchParams.get('date');
      if (!code || !date) return json(res, { error: 'missing code/date' }, 400);
      return json(res, await fetchers.fetchNavOnDate(code, date));
    }
    if (p === '/api/purchase-preview') {
      // 买入预览：口径 + 净值 + 份额一次算好，一次给出「15:00 前 / 后」两档。
      // 只读免鉴权（与 /api/nav-on-date 同级，无副作用、不下发任何凭据），供录入/编辑表单实时对比。
      // ★ 前端不自己算定价日/份额 —— 口径、费率合法化、份额取整三件事只在 lib/buyPlan.js 一份实现。
      const code = (u.searchParams.get('code') || '').trim();
      const date = (u.searchParams.get('date') || '').trim();
      const session = u.searchParams.get('session') === 'T+1' ? 'T+1' : 'T';
      const amount = Number(u.searchParams.get('amount'));
      if (!code) return json(res, { ok: false, error: 'code 必填' }, 400);
      const dv = validateOrderDate(date);
      if (dv.error) return json(res, { ok: false, error: dv.error }, 400);
      if (!isFinite(amount) || amount <= 0) return json(res, { ok: false, error: 'amount 必须是大于 0 的数字' }, 400);
      const holdings = store.readJSON('holdings.json');
      if (!holdings || !Array.isArray(holdings.funds)) return json(res, { ok: false, error: 'holdings.json 结构异常' }, 500);
      const fund = holdings.funds.find(x => x && x.code === code);
      // 基金必须在持仓里：market / feeRate 只能从 holdings 取，否则算出的份额会与保存路径不一致
      if (!fund) return json(res, { ok: false, error: '基金代码不存在：' + code, code: 'NOT_FOUND' }, 404);
      return json(res, await buyPlan.previewPurchase({
        code, market: fund.market === 'QDII' ? 'QDII' : 'A',
        feeRate: fund.feeRate, date, amount, selected: session,
      }));
    }
    if (p === '/api/fund-lookup') {
      // 添加基金自动带出：单只查询。除名称/类型外，还给出**跟踪标的与建议策略线**，
      // 让用户不必自己猜「该挂哪条线」。只读免鉴权。
      const code = (u.searchParams.get('code') || '').trim();
      if (!/^\d{6}$/.test(code)) return json(res, { ok: false, error: 'code 须为 6 位数字' }, 400);
      try {
        return json(res, Object.assign({ ok: true }, await fetchers.fundAutoFill(code)));
      } catch (e) { return json(res, { ok: false, error: (e && e.message) || String(e) }, 500); }
    }
    if (p === '/api/track-index') {
      // 支持「指数估值锚」的指数白名单（前端下拉 + 手填用）。只读免鉴权。
      return json(res, { ok: true, list: trackIndex.listTrackIndexes() });
    }
    if (p === '/api/fund-list') {
      // 添加基金联想：全量精简名单 [code,name,type]，只读免鉴权；字符串缓存避免重复序列化
      try {
        if (!fundListCacheStr) {
          const meta = await fetchers.getFundListMeta();
          if (!meta) return json(res, { ok: false, error: '基金名单暂不可用，请稍后重试' }, 503);
          fundListCacheStr = JSON.stringify({ ok: true, updated: meta.updated, total: meta.total, list: meta.list });
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(fundListCacheStr);
      } catch (e) { return json(res, { ok: false, error: (e && e.message) || String(e) }, 500); }
    }
    if (p === '/api/theme-map' && req.method === 'GET') {
      // 穿透补词典向导：theme_map.json 全对象下发（themeNames 供下拉、industryThemes 供行业翻译预选），只读免鉴权
      return json(res, store.readJSON('theme_map.json') || { error: 'theme_map.json 读取失败' });
    }
    if (p === '/api/stock-industry') {
      // 穿透补词典向导：A股股票代码 → 东财行业（f127）。只读免鉴权。codes 逗号分隔逐个 6 位校验，非法忽略。
      const raw = (u.searchParams.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean);
      const codes = raw.filter(c => /^\d{6}$/.test(c));
      try {
        const map = await fetchers.fetchStockIndustryBatch(codes);
        return json(res, { ok: true, map });
      } catch (e) { return json(res, { ok: false, error: (e && e.message) || String(e) }, 500); }
    }
    if (p === '/api/backfill-pending' && req.method === 'POST') {
      // 在途记录手动/定时触发自动补填（OpenClaw 每日推送可调用）。鉴权同 /api/save。
      const ak = config.getApiKey();
      if (!ak || req.headers['x-api-key'] !== ak) {
        return json(res, { ok: false, error: '鉴权失败：缺少或错误的 API Key（设置页可查看/重置）。' }, 401);
      }
      const r = await backfill.autoBackfillPending();
      return json(res, Object.assign({ ok: true }, r));
    }
    if (p === '/api/save' && req.method === 'POST') {
      // 鉴权：X-API-Key 必须匹配 config.apiKey（防局域网任意设备改数据）；优先取环境变量 FUND_API_KEY
      const ak = config.getApiKey();
      if (!ak || req.headers['x-api-key'] !== ak) {
        return json(res, { ok: false, error: '鉴权失败：缺少或错误的 API Key（设置页可查看/重置）。' }, 401);
      }
      const body = await readBody(req, 2 * 1024 * 1024); // 2MB 上限（防内存 DoS）
      let data;
      try { data = JSON.parse(body); } catch (e) { return json(res, { ok: false, error: 'JSON 解析失败' }, 400); }
      if (!data || typeof data !== 'object') return json(res, { ok: false, error: '请求体必须是 JSON 对象' }, 400);
      // 结构校验：holdings 必须 {funds:[]}；categories 必须 categories 数组（仅 key/name）；config 为对象
      // caliber（口径维度，2026-09-12）：可选，仅允许 'cn'/'us'；缺省合法（旧数据兼容 → util.caliberOf 默认 broad='cn'）
      const fails = [];
      const okCaliber = (v) => v === undefined || v === null || v === 'cn' || v === 'us';
      const okFund = (f) => f && typeof f.code === 'string' && typeof f.name === 'string' &&
        Array.isArray(f.purchases || []) && typeof f.category === 'string' && allowedCategories().includes(f.category) &&
        okCaliber(f.caliber);
      const okHoldings = (h) => h && Array.isArray(h.funds) && h.funds.every(okFund);
      // categories 结构校验。presets / customCategories（2026-09-19 新增）都是**可选段**，
      // 出现时每一项的 category 必须能挂到一条内置算法上 —— 否则自建分类会变成"选了但算不了"的黑洞。
      const okBind = (x) => x && typeof x.name === 'string' && typeof x.category === 'string' && BASE_CATEGORIES.includes(x.category);
      const okCategories = (c) => c && Array.isArray(c.categories) && c.categories.every(x => x && typeof x.key === 'string' && typeof x.name === 'string')
        && (c.presets === undefined || (Array.isArray(c.presets) && c.presets.every(okBind)))
        && (c.customCategories === undefined || (Array.isArray(c.customCategories) && c.customCategories.every(x => okBind(x) && typeof x.key === 'string')));
      const okConfig = (c) => c && typeof c === 'object';
      if (data.holdings !== undefined && !okHoldings(data.holdings)) fails.push('holdings 结构不合法');
      if (data.categories !== undefined && !okCategories(data.categories)) fails.push('categories 结构不合法');
      if (data.config !== undefined && !okConfig(data.config)) fails.push('config 结构不合法');
      if (fails.length) return json(res, { ok: false, error: '校验失败：' + fails.join('；') }, 400);
      if (data.holdings && !store.writeJSONSafe('holdings.json', data.holdings)) fails.push('holdings.json');
      if (data.categories && !store.writeJSONSafe('categories.json', data.categories)) fails.push('categories.json');
      // ★config 必须 merge 而非整份替换：/api/state 已剥离 apiKey/llm.apiKey/news.*.key，
      // 前端（持仓页改日限等）把 state.config 整份回写，若整份替换会把磁盘上的鉴权 Key 抹掉（下次写操作全 401）。
      // 合并 + restoreSecrets：前端改的键生效（dailyLimits/timing/signals…），密钥类字段保留磁盘原值。
      if (data.config) {
        const cur = store.readJSON('config.json') || {};
        const merged = restoreSecrets(Object.assign({}, cur, data.config), cur);
        if (!store.writeJSONSafe('config.json', merged)) fails.push('config.json');
      }
      if (fails.length) return json(res, { ok: false, error: '保存失败（文件被占用，可能是 OneDrive/杀软锁定）：' + fails.join(',') }, 500);
      return json(res, { ok: true });
    }
    if (p === '/api/theme-map' && req.method === 'POST') {
      // 穿透补词典向导：批量追加词典条目（股票→赛道）。鉴权同 /api/save；幂等去重（normalizeStockName 全等比对）。
      const ak = config.getApiKey();
      if (!ak || req.headers['x-api-key'] !== ak) {
        return json(res, { ok: false, error: '鉴权失败：缺少或错误的 API Key（设置页可查看/重置）。' }, 401);
      }
      const body = await readBody(req, 64 * 1024); // 单批条目体量小，上限同 /api/purchase
      let d;
      try { d = JSON.parse(body); } catch (e) { return json(res, { ok: false, error: 'JSON 解析失败' }, 400); }
      if (!d || typeof d !== 'object') return json(res, { ok: false, error: '请求体必须是 JSON 对象' }, 400);
      const themeMap = store.readJSON('theme_map.json');
      if (!themeMap || !Array.isArray(themeMap.entries) || !Array.isArray(themeMap.themeNames)) {
        return json(res, { ok: false, error: 'theme_map.json 结构异常' }, 500);
      }
      const add = Array.isArray(d.add) ? d.add : [];
      if (!add.length) return json(res, { ok: false, error: 'add 数组不能为空' }, 400);
      // 校验：name 非空字符串、theme ∈ 当前 themeNames；任一不过整条 400（不部分落盘）
      for (const it of add) {
        if (!it || typeof it.name !== 'string' || !it.name.trim()) return json(res, { ok: false, error: '存在空 name' }, 400);
        if (typeof it.theme !== 'string' || !themeMap.themeNames.includes(it.theme)) {
          return json(res, { ok: false, error: '非法 theme：' + String(it && it.theme) + '（须 ∈ ' + themeMap.themeNames.join('/') + '）' }, 400);
        }
      }
      // 幂等去重：归一化全等比对现有 entries 的所有 names
      const norm = (s) => util.normalizeStockName(s);
      const existNorm = new Set();
      for (const e of themeMap.entries) for (const n of (e.names || [])) existNorm.add(norm(n));
      const added = [], skipped = [];
      for (const it of add) {
        const name = it.name.trim();
        if (existNorm.has(norm(name))) { skipped.push({ name, reason: 'already' }); continue; }
        themeMap.entries.push({ names: [name], theme: it.theme });
        existNorm.add(norm(name));
        added.push(name);
      }
      if (!added.length) return json(res, { ok: true, added: [], skipped });
      themeMap.updated = util.todayStr();
      if (!store.writeJSONSafe('theme_map.json', themeMap)) {
        return json(res, { ok: false, error: '保存失败（文件被占用，可能是 OneDrive/杀软锁定）' }, 500);
      }
      return json(res, { ok: true, added, skipped });
    }
    if (p === '/api/purchase' && req.method === 'POST') {
      // 记一笔买入：细粒度端点（先记金额后补份额）。鉴权与 /api/save 同款。
      // 不校验 dailyLimits——记录的是历史事实（012920 暂停/超限都允许记）。
      const ak = config.getApiKey();
      if (!ak || req.headers['x-api-key'] !== ak) {
        return json(res, { ok: false, error: '鉴权失败：缺少或错误的 API Key（设置页可查看/重置）。' }, 401);
      }
      const body = await readBody(req, 64 * 1024); // 单笔录入体量小
      let d;
      try { d = JSON.parse(body); } catch (e) { return json(res, { ok: false, error: 'JSON 解析失败' }, 400); }
      if (!d || typeof d !== 'object') return json(res, { ok: false, error: '请求体必须是 JSON 对象' }, 400);
      // ===== 删除模式（action:'delete'，早返回避免被下方 amount 通用校验拦截）=====
      if (d.action === 'delete') {
        const dcode = d.code;
        const ek = d.editKey;
        if (!dcode || typeof dcode !== 'string') return json(res, { ok: false, error: 'code 必填' }, 400);
        if (!ek || ek.date == null || ek.amount == null) return json(res, { ok: false, error: 'editKey{date,amount} 必填' }, 400);
        const h = store.readJSON('holdings.json');
        if (!h || !Array.isArray(h.funds)) return json(res, { ok: false, error: 'holdings.json 结构异常' }, 500);
        const f = h.funds.find(x => x && x.code === dcode);
        if (!f) return json(res, { ok: false, error: '基金代码不存在：' + dcode, code: 'NOT_FOUND' }, 400);
        const ekDate = String(ek.date);
        const ekAmt = Math.round(Number(ek.amount) * 100) / 100;
        const pi = (Array.isArray(f.purchases) ? f.purchases : []).findIndex(p => p.date === ekDate && p.amount === ekAmt);
        if (pi < 0) return json(res, { ok: false, error: '原记录不存在（可能已被删除）', code: 'NOT_FOUND' }, 404);
        f.purchases.splice(pi, 1);
        if (!store.writeJSONSafe('holdings.json', h)) return json(res, { ok: false, error: '保存失败（文件被占用，可能是 OneDrive/杀软锁定）' }, 500);
        try { timing.buyScan(); } catch (e) { console.warn('[timing] buyScan 失败:', e && e.message || e); }
        return json(res, { ok: true, mode: 'delete', name: f.name });
      }
      const { code, date, note } = d;
      const amt = Number(d.amount);
      const sh = d.shares == null ? null : Number(d.shares);
      const nv = d.nav == null ? null : Number(d.nav);
      const session = (d.session === 'T' || d.session === 'T+1') ? d.session : null; // 15:00 前/后；缺省 null（老记录兼容）
      if (!code || typeof code !== 'string') return json(res, { ok: false, error: 'code 必填' }, 400);
      const dv = validateOrderDate(date); // 与 /api/purchase-preview 共用同一份日期规则
      if (dv.error) return json(res, { ok: false, error: dv.error }, 400);
      if (!isFinite(amt) || amt <= 0) return json(res, { ok: false, error: 'amount 必须是大于 0 的数字' }, 400);
      if (sh != null && (!isFinite(sh) || sh <= 0)) return json(res, { ok: false, error: 'shares 必须是大于 0 的数字' }, 400);
      if (d.nav != null && (!isFinite(nv) || nv <= 0)) return json(res, { ok: false, error: 'nav 必须是大于 0 的数字' }, 400);
      const nt = note == null ? '' : String(note).trim();
      if (nt.length > 100) return json(res, { ok: false, error: 'note 最长 100 字符' }, 400);
      const a2 = Math.round(amt * 100) / 100;
      const holdings = store.readJSON('holdings.json');
      if (!holdings || !Array.isArray(holdings.funds)) return json(res, { ok: false, error: 'holdings.json 结构异常' }, 500);
      const fund = holdings.funds.find(x => x && x.code === code);
      if (!fund) return json(res, { ok: false, error: '基金代码不存在：' + code, code: 'NOT_FOUND' }, 400);
      const market = fund.market === 'QDII' ? 'QDII' : 'A';
      // 申购费率外扣法：finalShares 统一推导（新录 / 补填 / 编辑 三分支共用 lib/buyPlan.js）
      const feeRate = buyPlan.validFeeRate(fund.feeRate);
      const purchases = Array.isArray(fund.purchases) ? fund.purchases : [];
      // 预览成功后前端回的**真实成交净值日**（定价日）；缺失则留 null，交给 backfill 按净值序列解析。
      // 兼容前端可能回传的旧字段名（navDate / confirmDate 存的都是定价日）。
      const rawNvDate = d.pricingDate || d.navDate || d.confirmDate;
      const nvDate = (typeof rawNvDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawNvDate)) ? rawNvDate : null;
      // recalc/navAuto：前端「按新成交日重算」勾选框与预览结果的标志。
      // ★ 默认 false —— 老记录（90+ 笔手动填过的真实值）绝不被静默覆盖，这是本改动的第一纪律。
      const recalc = d.recalc === true || d.navAuto === true;

      // ===== 编辑模式（editKey 命中即改已存在记录，区别于新增/补填）=====
      // 前端「记一笔」记错时无需删了重加：点「编辑」→ 带 editKey={原date,原amount} 提交新值覆盖。
      if (d.editKey && d.editKey.date != null && d.editKey.amount != null) {
        const ekDate = String(d.editKey.date);
        const ekAmt = Math.round(Number(d.editKey.amount) * 100) / 100;
        const oi = purchases.findIndex(p => p.date === ekDate && p.amount === ekAmt);
        if (oi < 0) return json(res, { ok: false, error: '原记录不存在（可能已被删除）', code: 'NOT_FOUND' }, 404);
        // 新键值碰撞检测（排除自身）：改成与另一笔同 date+amount → 拒绝，避免产生重复键
        const ci = purchases.findIndex((p, i) => i !== oi && p.date === date && p.amount === a2);
        if (ci >= 0) return json(res, { ok: false, error: '已存在同日期同金额的记录，无法改成该值' }, 409);
        const ex = purchases[oi];
        let shares, nav, pricingDate;
        if (recalc && sh != null) {
          // 显式份额永远最大（券商 App 实际数），连同净值一并信任
          shares = sh; nav = nv != null ? nv : ex.nav;
          pricingDate = nv != null ? (nvDate || ex.pricingDate || ex.navDate || null) : (ex.pricingDate || ex.navDate || null);
        } else if (recalc) {
          if (nv != null) {
            // 预览成功：服务端用**权威 feeRate** 重算份额，不信任客户端传的份额
            nav = nv;
            shares = buyPlan.computeShares(a2, feeRate, nv);
            // ★ 不再用名义定价日（只跳周末，不认节假日）冒充真实成交日。
            //   预览没给定价日就写 null，交给 backfill 按该基金净值序列解析。
            pricingDate = nvDate || null;
          } else {
            // 预览 pending/error：无法给出可信份额 → 置回「在途」，交给 backfill 在净值公布后自动补
            nav = null; shares = null; pricingDate = null;
          }
        } else {
          // ★ 老行为（逐字保留）：未勾选重算 → 原净值/份额原样保留，改日期/时段不动数值
          shares = sh != null ? sh : (nv != null ? buyPlan.computeShares(a2, feeRate, nv) : ex.shares);
          nav = nv != null ? nv : ex.nav;
          pricingDate = ex.pricingDate || ex.navDate || null;
        }
        // 份额确认日（到账日）：**只由后端权威计算**，不信任客户端传值；定价日拿不到 → 置空交 backfill。
        // ★ 它不参与份额计算 —— 上面算 shares 的每一行都与它无关。
        const settleDate = pricingDate ? (await buyPlan.resolveSettleDate(code, pricingDate, market)).settleDate : null;
        const upd = {
          date,
          amount: a2,
          session, // 15:00 前/后；前端三态里的「未知」回传 null（老记录本来就是 null，不丢信息）
          // ★ 只写真实成交净值日：重算且解析成功才有值；置回在途 → null；未重算 → 保留原值
          pricingDate,
          settleDate,
          shares, nav,
          note: nt || ex.note || ''
        };
        purchases[oi] = upd;
        fund.purchases = purchases;
        if (!store.writeJSONSafe('holdings.json', holdings)) return json(res, { ok: false, error: '保存失败（文件被占用，可能是 OneDrive/杀软锁定）' }, 500);
        try { timing.buyScan(); } catch (e) { console.warn('[timing] buyScan 失败:', e && e.message || e); }
        // 改了日期/时段却没勾选重算 → 明确回告「数值未动」，前端据此提示用户，避免"点了保存没变化"的困惑
        // ⚠️ 老记录 ex.session 是 undefined，前端回传的是 null —— 必须归一化后再比，
        //    否则「原样保存」也会被误报成「已改时段」（本轮实测踩到）。
        const sessChanged = (session || null) !== (ex.session || null);
        const movedKey = (date !== ekDate || sessChanged);
        const warn = (!recalc && movedKey) ? '已改日期/时段，但未勾选重算：净值/份额保持原值' : null;
        return json(res, { ok: true, mode: 'edit', purchase: upd, name: fund.name, recalc, warn });
      }

      let finalShares;
      if (sh != null)      finalShares = sh;                                       // 显式份额→信任（券商 App 实际数，不重算）
      else if (nv != null) finalShares = buyPlan.computeShares(a2, feeRate, nv);    // 只给金额+净值→按费率外扣法推导（4 位小数）
      else                 finalShares = null;                                     // 都缺→在途（pending）
      // ★ 一律只写**真实成交净值日**（由预览解析所得）；拿不到就写 null 交给 backfill 按净值序列解析。
      //   绝不用名义定价日（tradeDate.nominalPricingDate，只跳周末）冒充真实成交日 —— 那会在界面上显示错日期。
      const finalPricingDate = (nv != null) ? (nvDate || null) : null;
      // 份额确认日（到账日）：后端权威计算，**不参与份额公式**
      const finalSettleDate = finalPricingDate
        ? (await buyPlan.resolveSettleDate(code, finalPricingDate, market)).settleDate
        : null;
      // 补填规则（防重复、免 id）：同 code+date+amount → 在途行带 shares/nav 就地补填；已确认或纯重复 → 409
      const idx = purchases.findIndex(p => p.date === date && p.amount === a2);
      let mode = 'new';
      if (idx >= 0) {
        const ex = purchases[idx];
        if (ex.shares != null || (sh == null && nv == null)) {
          return json(res, { ok: false, error: '该笔已确认份额或重复，勿重复录入（金额录错请人工改 holdings.json）' }, 409);
        }
        const merged = Object.assign({}, ex, { shares: finalShares, nav: nv, pricingDate: finalPricingDate, settleDate: finalSettleDate, session, note: nt || ex.note || '' });
        // 清掉旧字段名（与 pricingDate 语义重复，留着会造成两套口径）
        delete merged.navDate; delete merged.confirmDate;
        purchases[idx] = merged;
        mode = 'backfill';
      } else {
        purchases.push({ date, amount: a2, shares: finalShares, nav: nv, pricingDate: finalPricingDate, settleDate: finalSettleDate, session, note: nt });
      }
      fund.purchases = purchases;
      if (!store.writeJSONSafe('holdings.json', holdings)) {
        return json(res, { ok: false, error: '保存失败（文件被占用，可能是 OneDrive/杀软锁定）' }, 500);
      }
      // 买入时机复盘：新买入落地后立即幂等补扫（attach 战役 id）
      try { timing.buyScan(); } catch (e) { console.warn('[timing] buyScan 失败:', e && e.message || e); }
      return json(res, { ok: true, mode, purchase: purchases[idx >= 0 ? idx : purchases.length - 1], name: fund.name });
    }
    // 静态文件
    let rel = p === '/' ? '/index.html' : p;
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    // 路径穿越防御：path.relative 判是否仍在 PUBLIC_DIR 内（前缀匹配会误放行 public2/ 等兄弟目录）
    const relCheck = path.relative(PUBLIC_DIR, file);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return httpError(res, 403);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return httpError(res, 404);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, { error: String(e && e.message || e) }, 500);
  }
});

// 被直接运行 → 启动 HTTP 服务；被 require → 只导出函数（供测试/自动化调用，不占端口）
if (require.main === module) {
  // L8: 启动时清理 data/ 下原子写残留的 .tmp 文件（递归覆盖 state/config/cache/series/example 各分区）
  try {
    const sweep = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) sweep(full);
        else if (ent.name.endsWith('.tmp')) { try { fs.unlinkSync(full); } catch (e) {} }
      }
    };
    sweep(DATA_DIR);
  } catch (e) { /* 清理非致命 */ }

  // L9: 数据结构版本检查与迁移（全项目唯一会写用户数据文件的地方；启动时跑一次）。
  // 只对「用户数据」文件；派生状态（timing_state 等）由各自模块自管，不经这里（见 lib/schema.js）。
  // 失败分两类：版本超前（用户回退了程序）→ 警告并以兼容模式继续；
  // 其余（缺迁移函数/迁移自身抛错）属程序 bug → fail fast —— 数据已自动备份，
  // 绝不能带着旧结构静默跑新代码（本项目最忌讳「不报错只算错」）。
  try {
    for (const f of ['holdings.json', 'config.json']) {
      const full = store.dataPath(f);
      if (!fs.existsSync(full)) continue; // 尚未 setup 的新装环境，没有可迁移的东西
      const raw = store.readJSONRaw(f);
      const r = schema.migrateIfNeeded(f, raw, { dataDir: store.DATA_DIR });
      if (r.changed) {
        store.writeJSONSafe(f, r.obj);
        console.log('[schema] ' + f + ' 已迁移到 v' + schema.SCHEMA_VERSION
          + (r.backup ? '（迁移前数据已备份：' + path.basename(r.backup) + '）' : ''));
      }
    }
  } catch (e) {
    if (e && e.code === 'SCHEMA_VERSION_AHEAD') {
      console.warn('[schema] ⚠ ' + (e && e.message || e) + '（继续以兼容模式启动）');
    } else {
      console.error('[schema] ✖ 数据迁移失败，拒绝启动：');
      console.error('         ' + (e && e.message || e));
      console.error('         数据备份位于 data/ 下 *.bak-* 文件；修复后重新启动。');
      process.exit(1);
    }
  }

  server.listen(PORT, () => {
    console.log(`基金看板已启动: http://localhost:${PORT}`);
    // 买入时机复盘：启动即幂等补扫历史 purchases（buy 样本进池，含战役外/历史定投标注；失败不致命）
    try { timing.buyScan(); } catch (e) { console.warn('[timing] 启动 buyScan 失败:', e && e.message || e); }
  });
}

// 透传导出（保持与原 server.js 同名符号，供 require 调用方不报错）
module.exports = {
  buildAnalysis: analysis.buildAnalysis,
  buildAdvice: advice.buildAdvice,
  computeAllocation: allocation.computeAllocation,
  // 基础能力透传（从 lib 模块再导出，保持符号兼容性）
  readJSON: store.readJSON,
  writeJSON: store.writeJSON,
  writeJSONSafe: store.writeJSONSafe,
  fetchNavHistory: fetchers.fetchNavHistory,
  drawdownFromHigh: util.drawdownFromHigh,
  percentileOf: util.percentileOf,
  shanghaiNow: util.shanghaiNow,
  todayStr: util.todayStr,
  DATA_DIR: store.DATA_DIR,
  computeMA: util.computeMA,
  // 决策信号引擎
  buildFundDecision: decisions.buildFundDecision,
  buildDividendDecision: decisions.buildDividendDecision,
  buildTechDecision: decisions.buildTechDecision,
  buildGoldDecision: decisions.buildGoldDecision,
  loadYieldAnchor3y: decisions.loadYieldAnchor3y
};

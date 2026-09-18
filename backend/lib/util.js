'use strict';
// 通用工具：时间/回撤/分位/均线/主题映射。无任何网络 I/O，纯函数。

// 上海时间（显式 UTC+8，不依赖机器时区/ICU；北京 0-8 点与机器时区无关）
function shanghaiNow() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const y = now.getUTCFullYear(), mo = now.getUTCMonth() + 1, d = now.getUTCDate();
  const h = now.getUTCHours(), mi = now.getUTCMinutes(), s = now.getUTCSeconds();
  return {
    year: y, month: mo, date: d, hour: h, minute: mi, second: s,
    ymd: `${y}-${p(mo)}-${p(d)}`,
    dateObj: () => new Date(`${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}Z`),
    getDay: () => new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  };
}
function isTradingHours() {
  const d = shanghaiNow();
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const hm = d.hour * 60 + d.minute;
  return (hm >= 9 * 60 + 30 && hm <= 11 * 60 + 30) || (hm >= 13 * 60 && hm <= 15 * 60);
}
function todayStr() {
  return shanghaiNow().ymd;
}
function daysBetween(from, to) {
  return Math.round((new Date(to) - new Date(from)) / 86400000);
}
// 距区间高点的回撤%（history 最新在前）
function drawdownFromHigh(history) {
  if (!history || !history.length) return null;
  const navs = history.map(h => h.nav).filter(n => !isNaN(n) && n > 0);
  if (navs.length < 2) return null;
  const high = Math.max(...navs);
  if (!high) return null;
  return (navs[0] - high) / high * 100;
}
// 当前净值在区间内的分位（0=最低，100=最高）
function percentileOf(history) {
  if (!history || history.length < 2) return null;
  const navs = history.map(h => h.nav).filter(n => !isNaN(n) && n > 0);
  if (navs.length < 2) return null;
  const cur = navs[0];
  return navs.filter(n => n < cur).length / (navs.length - 1) * 100;
}
// 近 N 个交易日的涨跌幅%（history 最新在前）
function recentChangePct(history, n = 20) {
  if (!history || history.length < 2) return 0;
  const last = history[Math.min(n, history.length) - 1];
  const first = history[0];
  if (!first || !last || !first.nav || !last.nav) return 0;
  return (first.nav / last.nav - 1) * 100;
}
// 止跌确认：近 window 日最低 > 前 window 日最低（下跌动能衰竭，history 最新在前）。
// 数据不足（< window*2 个有效净值）→ false（保守：未确认，与 tech.js 原逻辑一致）。
function stableLow(history, window) {
  if (!history || !history.length) return false;
  const navs = history.map(h => h.nav).filter(n => !isNaN(n) && n > 0);
  const w = window || 20;
  if (navs.length < w * 2) return false;
  const near = navs.slice(0, w);
  const prev = navs.slice(w, w * 2);
  return Math.min(...near) > Math.min(...prev);
}
// 计算 N 日移动平均（MA250=250日年线；history 最新在前）
function computeMA(history, days) {
  if (!history || !history.length) return null;
  const navs = history.map(h => h.nav).filter(n => !isNaN(n) && n > 0);
  const d = days || 250;
  if (navs.length < d) return null; // 数据不足：静默返回 null，不冒充长均线（如 120 日历史不得当 250 日线）
  const win = navs.slice(0, d);
  const sum = win.reduce((s, n) => s + n, 0);
  return sum / win.length;
}
// 编码防御：多数接口 UTF-8；个别（历史东财页）GBK。fatal UTF-8 失败则回退 GBK。
function decodeFetchBody(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) {
    try { return new TextDecoder('gbk').decode(buf); } catch (e2) { return buf.toString('utf8'); }
  }
}
// 股票名归一化（供 theme_map 匹配）：去空白（含全角）、剥括号及内容。
// 不做后缀剥除/大小写折叠——美/日股后缀与英文名差异大，靠 theme_map 别名显式覆盖（如 美光科技↔美光、铠侠控股株式会社↔铠侠）。
function normalizeStockName(name) {
  return String(name || '').replace(/[\s\u3000]/g, '').replace(/[（(].*?[)）]/g, '');
}
// 股票 → 赛道。themeMap = data/config/theme_map.json（{ entries: [{names:[...], theme}] }），由调用方读取注入（util 保持无 IO）。
// 未命中 → '未分类'（区别于旧版误导性"其他"；analysis 层会把未分类收集进 unmapped 提示补表，数据绝不悄悄丢失）。
function themeOf(stockName, themeMap) {
  const norm = normalizeStockName(stockName);
  if (!norm) return '未分类';
  const entries = (themeMap && Array.isArray(themeMap.entries)) ? themeMap.entries : [];
  for (const e of entries) {
    const names = (e && Array.isArray(e.names)) ? e.names : [];
    for (let i = 0; i < names.length; i++) {
      if (normalizeStockName(names[i]) === norm) return e.theme;
    }
  }
  return '未分类';
}
// A/C 类同策略合并键：名称去尾字母份额（A/C/E）+ 去括号，同 category 视为同一底层
function acGroupKey(name, category) {
  const base = String(name || '')
    .replace(/^(.+?)([A-E])$/, '$1')   // 去尾 A/B/C/D/E 份额
    .replace(/[（(].*?[)）]/g, '')      // 去括号（QDII）等
    .replace(/\s+/g, '');
  return category + '|' + base;
}

// 引擎类型(category) → 资金政策桶(key in config.categoryPolicy / allocation policy 判定)。
// 2026-09-09 组合构成展示已改引擎 4 线口径（categories.json categories=engine 键），本函数不再服务展示，
// 仅用于 policy 判定：broad/dividend 都归核心桶 core，growth/cycle 各自原桶（买/冻结/eligible 按桶下判断）。
function engineCategoryToBucket(cat) {
  const map = { broad: 'core', dividend: 'core', growth: 'growth', cycle: 'cycle' };
  return map[cat] || cat;
}

// ---------- 口径维度（caliber）：category 之下的「用哪把尺子量」 ----------
// 2026-09-12 新增：宽基大类下分 A股口径(cn) 与海外口径(us)。category 仍是 4 值（环形图/配置桶/穿透范围不变），
// caliber 只决定走哪套估值算法与阈值，不参与任何分组展示。
// 缺省规则：broad → 'cn'（旧数据无 caliber 时行为与改动前逐位一致）；其他类别无口径概念 → null。
const DEFAULT_CALIBER = { broad: 'cn' };
function caliberOf(fund) {
  if (!fund) return null;
  if (fund.caliber === 'cn' || fund.caliber === 'us') return fund.caliber;
  return DEFAULT_CALIBER[fund.category] || null;
}

// 滚动窗口分位（0~100）：取 series 末尾 window 个值，返回 value（默认末值）在该窗口内的百分位。
// 用途：海外宽基主锚。★必须用滚动窗口而非全样本——纳指 PE 存在「台阶上移」（2016-19 中位 27 → 2023-26 中位 35），
// 固定全样本分位会把「新常态」永久判成偏贵，实测 2023 年后零触发（见 plans §8.6）。
// 样本不足（窗口 < 8 或 series 为空）→ null（交给兜底，不是 0 分）。
function rollingPercentile(series, window, value) {
  if (!Array.isArray(series) || !series.length) return null;
  const w = window > 0 ? window : series.length;
  const win = series.slice(Math.max(0, series.length - w));
  if (win.length < 8) return null;
  const v = (value != null && !isNaN(value)) ? value : win[win.length - 1];
  if (v == null || isNaN(v)) return null;
  return win.filter(x => x < v).length / (win.length - 1) * 100;
}

// 距窗口内高点的回撤%（负数，如 -16.2）。用途：海外宽基通道②。
// ★用 PE 回撤而非净值回撤：纳指 60 日跌 15% 极罕见（实测 2023 起净值回撤仅触发 2 次，PE 回撤 24 次），
// 估值压缩比价格回撤灵敏得多。数据不足 → null。
function peDrawdownLevel(series, window) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const w = window > 0 ? window : series.length;
  const win = series.slice(Math.max(0, series.length - w)).filter(x => typeof x === 'number' && !isNaN(x) && x > 0);
  if (win.length < 2) return null;
  const hi = Math.max.apply(null, win);
  const cur = series[series.length - 1];
  if (!hi || cur == null || isNaN(cur)) return null;
  return (cur / hi - 1) * 100;
}

// ---------- 2026-09-14 新增：动量因子的「连续化」（供评分层的动量分 M 使用）----------
// 背景：旧的位置分里动量是二值补丁（金叉 +0.1 / 未止跌 ×0.3），看不出强弱。
//      本组函数把它们变成连续量，使"强金叉"与"弱金叉"不再是同一个分。
// 设计纪律：
//   ① 与 stableLow / computeMA 完全同风格：history 降序（最新在前）
//   ② 数据不足一律返回 **null**（绝不返回 0）——避免"没数据"被当成"没动量"静默降级
//   ③ 单位统一为**百分点(pp)**，与 config 的尺度参数（crossFullPct / stopRiseFullPct 等）同量纲
//   ④ ★只算不判：这三个函数不参与任何 add/hold 判定，仅供评分层计算

// 低点抬高幅度%（stableLow 的连续化版本）
//   与 stableLow 同窗口、同方向：> 0 表示近 w 日最低点高于前 w 日最低点（即"止跌/低点抬高"）
//   关系：stableLow === true ⟺ 本函数 > 0（符号一致，本函数进一步给出**幅度**）
function lowRaisePct(history, window) {
  if (!history || !history.length) return null;
  const navs = history.map(h => h.nav).filter(n => !isNaN(n) && n > 0);
  const w = window || 20;
  if (navs.length < w * 2) return null;
  const nearMin = Math.min.apply(null, navs.slice(0, w));
  const prevMin = Math.min.apply(null, navs.slice(w, w * 2));
  if (!prevMin || !isFinite(nearMin)) return null;
  return (nearMin - prevMin) / prevMin * 100;
}

// 双均线乖离%（金叉强度）：(MA_short − MA_long) / MA_long × 100
//   > 0 = 短期均线在上方（多头/金叉方向）；0 分界与 goldenState（MA20 > MA60）的临界点一致
//   任一 MA 因数据不足算不出 → null
function maSpreadPct(history, shortDays, longDays) {
  const s = shortDays || 20, l = longDays || 60;
  const maShort = computeMA(history, s);
  const maLong = computeMA(history, l);
  if (maShort == null || maLong == null || !maLong) return null;
  return (maShort - maLong) / maLong * 100;
}

// 现价相对 N 日均线的偏离%（趋势强弱）：(nav − MA_N) / MA_N × 100
//   > 0 = 站上均线；0 分界与 trendWeak（nav < MA_N）的临界点一致
function maDevPct(history, days, nav) {
  const d = days || 120;
  const ma = computeMA(history, d);
  const n = Number(nav);
  if (ma == null || !ma || !isFinite(n) || n <= 0) return null;
  return (n - ma) / ma * 100;
}

module.exports = { shanghaiNow, isTradingHours, todayStr, daysBetween, drawdownFromHigh, percentileOf, recentChangePct, stableLow, computeMA, decodeFetchBody, normalizeStockName, themeOf, acGroupKey, engineCategoryToBucket, DEFAULT_CALIBER, caliberOf, rollingPercentile, peDrawdownLevel, lowRaisePct, maSpreadPct, maDevPct };

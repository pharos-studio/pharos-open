// 通用工具：格式化 / DOM 辅助 / 颜色类
// 红涨绿跌：positive -> up(红) / negative -> down(绿)

export function fmtMoney(n, withSymbol = true) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const s = abs.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? '-' : '';
  return (withSymbol ? sign + '¥' + s : sign + s);
}

export function fmtPct(n, digits = 2) {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(digits) + '%';
}

// 带正负号的百分比（用于盈亏）
export function signPct(n, digits = 2) {
  if (n == null || isNaN(n)) return '—';
  const s = n.toFixed(digits);
  return (n > 0 ? '+' : n < 0 ? '' : '') + s + '%';
}

// 涨红跌绿：返回 class 名
export function cls(n) {
  if (n == null || isNaN(n) || n === 0) return '';
  return n > 0 ? 'up' : 'down';
}

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 轻量 DOM 构造器
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (c == null) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

// 表格外层包裹：窄屏内横向滚动，避免整页左右滑
export function tableWrap(table, wide = false) {
  const wrap = el('div', { class: 'table-wrap' });
  if (wide) table.classList.add('tbl-wide');
  wrap.appendChild(table);
  return wrap;
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

// 加载占位：1px 鎏金细线（扫光）+ 文字。统一首屏与页面内局部等待的视觉语言。
// compact=true → .loading--compact：同形态、上下留白 32px→8px，供页面内局部等待使用。
export function loadingHTML(msg, compact = false) {
  const cls = compact ? 'loading loading--compact' : 'loading';
  return `<div class="${cls}"><span class="thin-line"><span class="sk-sweep"></span></span><span>${msg}</span></div>`;
}

// 概览页骨架屏。整体复用真实容器类（.kpis / .card.kpi / .panel / .panel-head / .chart），
// 故栅格列数、内边距、240px 图表高度全部自动与真实内容一致 —— 不写任何魔法数字。
// 原则：常量文字（KPI 标签、面板标题）保留真实文本；变量数值才换成灰条。
// 灰条高度刻意小于对应文字的行盒（26 < 26×1.7、12 < 12×1.7），行盒高度不变 → 数据到达时零跳动。
// 图表区只给一块平坦灰面，不画折线/柱形 —— 凭空画出走势形状等于伪造数据。
export function skeletonHTML(msg = '正在准备你的看板…') {
  const bar = (h, w) => `<span class="sk-bar" style="height:${h}px;width:${w}"></span>`;
  const kpi = (label) =>
    `<div class="card kpi"><div class="kpi-label">${label}</div>` +
    `<div class="kpi-value">${bar(26, '66%')}</div>` +
    `<div class="kpi-sub">${bar(12, '44%')}</div></div>`;
  const chartPanel = (title) =>
    `<div class="panel"><div class="panel-head"><span>${title}</span>` +
    `<span class="sub">${bar(12, '52px')}</span></div>` +
    `<div class="chart sk-chart"></div></div>`;
  return `<div class="sk-wrap"><div class="sk"><span class="sk-sweep"></span>` +
    `<div class="kpis">${kpi('总资产')}${kpi('今日盈亏')}${kpi('累计收益')}</div>` +
    chartPanel('资产走势') + chartPanel('每月投入') +
    `</div><div class="sk-note">${msg}</div></div>`;
}

// 上海日期（YYYY-MM-DD）
export function todayStr() {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}

// 近 N 日（含今日）日期数组，用于 echarts x 轴
export function lastNDates(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(d.getTime() - i * 86400000);
    const off = t.getTimezoneOffset() * 60000;
    out.push(new Date(t - off).toISOString().slice(0, 10));
  }
  return out;
}

// （prefers-reduced-motion 已由 style.css 的 @media 块承担，JS 侧不再需要分支判断）
// 简易 WCAG 对比度（用于设计系统自检，非运行时必需）
export function luminance(rgb) {
  const a = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
export function contrastRatio(c1, c2) {
  const L1 = luminance(c1), L2 = luminance(c2);
  const lighter = Math.max(L1, L2), darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

// 类别中文显示（单一真相源：state.categories.engines，与 backend/engines/registry.js REGISTRY 一致）
// 命中顺序：engines（引擎策略线）→ categories（分配桶）→ 原样返回（对已是中文的串安全，不抛错）
export function catName(state, key) {
  if (key == null) return '';
  const cat = (state && state.categories) || {};
  const e = (cat.engines || []).find(x => x.key === key);
  if (e) return e.name;
  const b = (cat.categories || []).find(x => x.key === key);
  if (b) return b.name;
  return key;
}

// 口径中文显示（单一真相源：state.categories.calibers，与 data/config/categories.json calibers 段一致）
// 口径是 category 之下的维度（仅 broad 下有值：cn=A股口径 / us=海外口径），不参与环形图分块。
export function caliberName(state, key) {
  if (key == null) return '';
  const list = (state && state.categories && state.categories.calibers) || [];
  const c = list.find(x => x.key === key);
  return c ? c.name : key;
}

// 类别 + 口径的组合显示（仅宽基带口径后缀；其余类别原样返回类别名）
// 例：broad/us → 「宽基 · 海外口径」；broad/cn → 「宽基」；growth → 「科技成长」
export function catNameWithCaliber(state, category, caliber) {
  const base = catName(state, category);
  if (category !== 'broad' || caliber == null) return base;
  const cn = caliberName(state, caliber);
  return cn ? `${base} · ${cn}` : base;
}

// 每日限购标签（数据来自 config.dailyLimits，用户手填纪律性上限，非实时抓取）
// 0 → 暂停(限购)（红色）；null/undefined → 不限；数字 → ¥X/日
export function limitLabel(config, code) {
  const v = config && config.dailyLimits && config.dailyLimits[code];
  if (v === 0) return { text: '暂停(限购)', cls: 'up' }; // 红色强调
  if (v == null) return { text: '不限', cls: '' };
  return { text: '¥' + v + '/日', cls: '' };
}

// 所有后端接口封装。后端地址 + API Key 来自 store（localStorage）。
import { getBackendUrl, getApiKey } from './store.js';

// 是否运行在 Capacitor 打包的 App 内（此时 location.origin = http://localhost，指向 App 自己，
// 不是电脑后端，必须由用户在「设置」里显式填写电脑局域网地址）。
export function isNativeApp() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
    ? window.Capacitor.isNativePlatform()
    : window.Capacitor && window.Capacitor.isNative);
}

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

// 解析后端基地址：
// - 浏览器 + 留空 => 用当前页面同源地址（桌面 localhost:3000 / 手机局域网 IP 都正确，无需手动配）
// - 浏览器 + 历史默认值 http://localhost:3000 在手机上指向手机自身 => 纠正为当前同源
// - App 内 => 必须有显式的非环回地址，否则抛 BACKEND_UNSET 由上层提示去设置
// - 用户显式填了地址（如电脑局域网 IP / 将来的公网域名）=> 原样使用
export function resolveBase() {
  const saved = (getBackendUrl() || '').trim();
  const clean = saved.replace(/\/+$/, '');
  const native = isNativeApp();

  if (native) {
    // App 内环回地址永远指向手机自己，等同于没配
    if (!clean || LOOPBACK.test(clean)) throw new Error('BACKEND_UNSET');
    return clean;
  }
  if (!clean) return location.origin;
  if (clean === 'http://localhost:3000' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    return location.origin;
  }
  return clean;
}

const UNSET_MSG = '还没设置后端地址：请打开「设置 → 连接」，填入电脑的局域网地址（例如 http://192.168.1.5:3000），保存后下拉刷新。';

async function request(path, opts = {}) {
  let base;
  try {
    base = resolveBase();
  } catch (e) {
    throw new Error(e.message === 'BACKEND_UNSET' ? UNSET_MSG : e.message);
  }
  const url = base + path;
  const headers = Object.assign({}, opts.headers || {});
  const ak = getApiKey();
  if (ak) headers['X-API-Key'] = ak;
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.error || data.raw)) || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

export const getState = () => request('/api/state');
export const getRefresh = () => request('/api/refresh');
export const getAdvice = (session = 'am') => request('/api/advice?session=' + session);
export const getTiming = () => request('/api/timing'); // 买入时机复盘（只读统计；触发懒回填）
export const getNavOnDate = (code, date) => request('/api/nav-on-date?code=' + encodeURIComponent(code) + '&date=' + encodeURIComponent(date));
// 买入预览：口径 + 净值 + 份额一次算好，返回 { variants: { T, 'T+1' } } 两档（只读、免鉴权）。
// ★ 前端绝不自己算 confirmDate / 份额 —— 口径与公式只在后端 lib/buyPlan.js 一份实现。
export const getPurchasePreview = (code, date, session, amount) =>
  request('/api/purchase-preview?code=' + encodeURIComponent(code)
    + '&date=' + encodeURIComponent(date)
    + '&session=' + encodeURIComponent(session || 'T')
    + '&amount=' + encodeURIComponent(amount));
export const getFundLookup = (code) => request('/api/fund-lookup?code=' + encodeURIComponent(code)); // 添加基金：单只带出（A名单+B兜底）
export const getFundList = () => request('/api/fund-list'); // 添加基金：全量精简名单（联想下拉）
export const getTrackIndex = () => request('/api/track-index'); // 添加基金：支持的跟踪指数白名单（下拉 + 手填）
export const getThemeMap = () => request('/api/theme-map'); // 穿透：theme_map.json（themeNames/industryThemes/entries）
export const getStockIndustry = (codes) => request('/api/stock-industry?codes=' + encodeURIComponent(codes.join(','))); // 穿透：A股码批量 → 东财行业
export const postThemeMap = (addArr) => request('/api/theme-map', { method: 'POST', body: JSON.stringify({ add: addArr }) }); // 穿透：追加词典词条（股票→赛道）

export async function save(payload) {
  return request('/api/save', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// 记一笔买入（细粒度端点）：{code, date, amount, session?, shares?, nav?, note?}
// session: 'T'=15:00 前 / 'T+1'=15:00 后（缺省 null 时后端不写成交日，走旧 offset 兜底）
// shares/nav 缺省 → 后端存 null = 在途待确认；同 code+date+amount 重提带 shares/nav → 就地补填不新增（409 由 request 抛后端 message）
export function addPurchase(payload) {
  return request('/api/purchase', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// 编辑已存在的买入记录：payload 同 addPurchase（含可选 session），但额外带 editKey={date, amount}（原记录的定位键）。
// 后端据此定位原记录并覆盖新值（date/amount/session/shares/nav/note），自动重算份额、碰撞检测；修改后重新扫入 timing。
// 注意：份额/净值由系统按成交日锁定计算，前端编辑表单默认不传 shares/nav（仅「手动校正」展开并填写时才带）。
export function updatePurchase(payload) {
  return request('/api/purchase', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// 删除一笔买入记录：payload={code, action:'delete', editKey:{date, amount}}（editKey 为原记录定位键）。
// 后端早返回分支定位并 splice 删除，删后重新扫入 timing；前端调用前需二次确认防误删。
export function deletePurchase(payload) {
  return request('/api/purchase', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// 全局状态缓存 + 本地设置（后端地址 / API Key）
// 后端地址与 API Key 仅存于浏览器 localStorage；读接口无需 Key，写接口 /api/save 才需带 X-API-Key。
import * as api from './api.js';

const LS_KEY = 'fund.frontend.settings.v1';

const defaults = {
  backendUrl: '', // 留空=自动用当前页面同源地址（手机/电脑/ PWA 都正确）
  apiKey: '',
};

let settings = load();
let STATE = null;   // /api/state
let LIVE = null;    // /api/refresh
let ADVICE = null;  // /api/advice 缓存（统一 am 可执行模式）

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return Object.assign({}, defaults, JSON.parse(raw));
  } catch (e) {}
  return Object.assign({}, defaults);
}

function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) {}
}

export function getBackendUrl() { return settings.backendUrl; }
export function getApiKey() { return settings.apiKey; }

export function updateSettings(patch) {
  settings = Object.assign({}, settings, patch);
  persist();
}

export function getState() { return STATE; }
export function getLive() { return LIVE; }
export function getAdvice() { return ADVICE; }

export function setState(s) { STATE = s; }
export function setLive(l) { LIVE = l; }
export function setAdvice(a) { ADVICE = a; }

// 启动时拉取 state + refresh（一次性）。返回 {state, live} 供首屏渲染。
// 顺序：先 refresh（触发后端自动补填在途记录 + 行情抓取），再 state（读已更新的 holdings）。
export async function bootstrap() {
  const live = await api.getRefresh();
  const state = await api.getState();
  STATE = state;
  LIVE = live;
  return { state, live };
}

// 重新抓取 refresh（手动刷新按钮）
export async function reloadLive() {
  LIVE = await api.getRefresh();
  STATE = await api.getState(); // 同步刷新买入记录表（含自动补填结果），让页面即时显示已确认
  return LIVE;
}

// 重新抓取 state（买入记录/持仓列表的渲染源是 STATE——录入/整表保存后必须刷新，否则页面仍显示旧数据）
export async function reloadState() {
  STATE = await api.getState();
  return STATE;
}

export async function reloadAdvice(session) {
  // 前端已取消 am/pm 双档：不传 session 时固定走 am（可执行）模式
  ADVICE = await api.getAdvice(session || 'am');
  return ADVICE;
}

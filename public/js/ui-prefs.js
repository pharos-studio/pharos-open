// 界面偏好（侧栏折叠等）—— 与 store.js 的后端连接设置刻意分离。
// 为什么不复用 store.js 的 key：
//   store.js 的 updateSettings() 是「整对象浅 merge + 整体回写」，领域是后端连接凭据。
//   混入 UI 偏好会让「改后端地址」和「改显示偏好」互相覆盖，且两者迁移节奏不同。
//
// ★ 单一真相源：本文件的 LS_KEY 与 index.html <head> 内联前置脚本里的字符串
//   必须严格一致（那个脚本要在首屏渲染前读它，不能等模块加载）。改一处必须改两处。
const LS_KEY = 'fund.frontend.ui.v1';

const defaults = {
  sidebarCollapsed: false, // 默认展开：新用户先看到完整文字导航（可发现性优先）
};

let prefs = load();

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return Object.assign({}, defaults, JSON.parse(raw));
  } catch (e) {
    /* 隐私模式 / 存储被禁 / JSON 损坏：静默回落默认值（沿用 store.js 范式） */
  }
  return Object.assign({}, defaults);
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs));
  } catch (e) {}
}

// 折叠与否以 <html> 上的 class 为准 —— head 里的前置脚本已经落过 class，
// 这里读 DOM 而不是重读 localStorage，保证「只有一个读者」，两者永不打架。
export function isSidebarCollapsed() {
  return document.documentElement.classList.contains('sb-collapsed');
}

export function setSidebarCollapsed(v) {
  prefs = Object.assign({}, prefs, { sidebarCollapsed: !!v });
  persist();
  document.documentElement.classList.toggle('sb-collapsed', prefs.sidebarCollapsed);
}

export function toggleSidebar() {
  setSidebarCollapsed(!isSidebarCollapsed());
}

// 多标签页同步：同一浏览器两个标签，一边收起另一边也跟随
export function watchSidebarPreference(onChange) {
  window.addEventListener('storage', (e) => {
    if (e.key !== LS_KEY) return;
    prefs = load();
    document.documentElement.classList.toggle('sb-collapsed', prefs.sidebarCollapsed);
    if (typeof onChange === 'function') onChange(prefs.sidebarCollapsed);
  });
}

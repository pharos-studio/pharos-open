// 启动 + hash 路由。所有页面模块统一 export render(container)。
import * as store from './store.js';
import * as overview from './pages/overview.js';
import * as decision from './pages/decision.js';
import * as holdings from './pages/holdings.js';
import * as allocation from './pages/allocation.js';
import * as review from './pages/review.js';
import * as settings from './pages/settings.js';
import * as more from './pages/more.js';
import { $, loadingHTML, skeletonHTML } from './util.js';
import { ICONS } from './icons.js';
import * as ui from './ui-prefs.js';

const PAGES = {
  overview:   { mod: overview,  label: '概览', sidebar: true, bottom: true },
  decision:   { mod: decision,  label: '决策', sidebar: true, bottom: true },
  holdings:   { mod: holdings,  label: '我的基金', sidebar: true, bottom: true },
  allocation: { mod: allocation, label: '配置', sidebar: true },
  review:     { mod: review,    label: '复盘', sidebar: true },
  settings:   { mod: settings,  label: '设置', sidebar: true },
  more:       { mod: more,      label: '更多', bottom: true },
};

const view = $('#view');

function currentPage() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  return PAGES[h] ? h : 'overview';
}

function buildNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  Object.entries(PAGES).forEach(([key, p]) => {
    if (!p.sidebar) return;
    nav.appendChild(makeNavItem(key, p, true));
  });

  const bnav = $('#bottomNav');
  bnav.innerHTML = '';
  Object.entries(PAGES).forEach(([key, p]) => {
    if (!p.bottom) return;
    bnav.appendChild(makeNavItem(key, p, false));
  });
}

// 侧栏与底部栏共用同一套结构与类名（沿用 .nav-item），差异只在 CSS。
// 用 <a href="#/key"> 而非 <div>：原生可聚焦、原生 Enter 激活、语义正确，
// 且不再需要 click 处理器（hash 变化由 hashchange 监听处理）。
function makeNavItem(key, p, isSidebar) {
  const node = document.createElement('a');
  node.className = 'nav-item';
  node.href = '#/' + key;
  node.dataset.page = key;
  node.setAttribute('aria-label', p.label);
  if (isSidebar) node.dataset.label = p.label;   // 窄栏 tooltip 的文本源（底部栏不需要）
  node.innerHTML =
    '<span class="nav-icon">' + (ICONS[key] || '') + '</span>' +
    '<span class="nav-label">' + p.label + '</span>';
  return node;
}

function setActive(page) {
  document.querySelectorAll('.nav-item').forEach(el => {
    const on = el.dataset.page === page;
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}

async function renderRoute() {
  const page = currentPage();
  const p = PAGES[page];
  setActive(page);
  // bootstrap 未完成时 store.getLive() 还是 null，各页面模块都假设它非 null。
  // hashchange 可能早于 bootstrap 完成（例如加载途中点了导航项），此时直接返回，
  // 由 init() 末尾那次 renderRoute() 补渲染——否则会在页面上闪一个报错框。
  if (!store.getLive()) return;
  // 切页不再闪全局加载态：七个页面里四个全程同步渲染，另外三个各自提供
  // 同步挂载的局部占位（decision :26 / allocation :85 / review :38），故无空白期。
  try {
    await p.mod.render(view);
  } catch (e) {
    view.innerHTML = `<div class="error-box">页面渲染失败：${e.message}</div>`;
    console.error(e);
  }
  if (window.scrollTo) window.scrollTo(0, 0);
}

async function refreshAll() {
  const btn = $('#refreshBtn');
  // 按钮尺寸小、再加动画就是噪音：禁用态（.btn:disabled opacity:.5）本身已是明确反馈。
  // 纯文字也才使得三点动画的样式能被彻底删除（它命中 pulsing-dot 反模式）。
  if (btn) { btn.disabled = true; btn.textContent = '刷新中…'; }
  try {
    try {
      await store.reloadLive();
    } catch (e) {
      view.insertAdjacentHTML('afterbegin', `<div class="error-box">刷新失败：${e.message}（请检查设置页的后端地址/API Key）</div>`);
    }
    await renderRoute();
  } finally {
    // 必须有 finally：renderRoute 抛错时按钮不能永久卡在禁用态
    if (btn) { btn.disabled = false; btn.textContent = '↻ 刷新'; }
  }
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const h = location.hostname;
  // 仅在安全上下文注册：localhost 或 https；局域网 http 下跳过（不报错，仅无离线）
  if (location.protocol !== 'https:' && h !== 'localhost' && h !== '127.0.0.1') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// 侧栏折叠：状态本身由 ui-prefs 落在 <html> 的 class 上，
// 这里只负责绑定按钮 + 同步无障碍属性。
// ⚠️ 必须容错：public/_sample/*.html 是独立手写的样张外壳，没有 #sidebarToggle。
function setupSidebar() {
  const btn = $('#sidebarToggle');
  const sync = () => {
    if (!btn) return;
    const collapsed = ui.isSidebarCollapsed();
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
  };

  if (btn) btn.addEventListener('click', () => { ui.toggleSidebar(); sync(); });
  ui.watchSidebarPreference(sync);
  sync();
}

async function init() {
  buildNav();
  setupSidebar();
  registerSW();
  $('#refreshBtn').addEventListener('click', refreshAll);
  window.addEventListener('hashchange', renderRoute);

  // 首屏加载态：概览页给真骨架屏（页面形状本身就是「在加载」最好的说明），
  // 其余页给 1px 鎏金细线 + 文案（不确定态活动指示，不做进度条）。
  view.innerHTML = currentPage() === 'overview'
    ? skeletonHTML()
    : loadingHTML('正在准备你的看板…');
  try {
    await store.bootstrap();
  } catch (e) {
    view.innerHTML = `
      <div class="error-box">
        无法连接后端：${e.message}<br/>
        请在「设置」中确认后端地址（默认 http://localhost:3000）与 API Key，并确保电脑端服务已启动。
      </div>`;
    return;
  }
  await renderRoute();
}

init();

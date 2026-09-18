// 导航图标 —— 单一真相源。
// 约定：
//   ① key 必须与 app.js 的 PAGES key 一一对应（7 个：含底部栏专属的 more）；
//   ② 统一线性风格：viewBox 24 格 / stroke-width 1.6 / fill none / stroke currentColor，
//      颜色自动继承 .nav-item（灰 → 悬停白 → active 鎏金），此处不写死任何颜色；
//   ③ 尺寸不在这里写死语义：width/height 只作无 CSS 时的兜底，
//      真实尺寸由 CSS 控制（侧栏 .nav-icon 17px / 底部栏 16px）；
//   ④ aria-hidden：可访问名称由 .nav-item 的 aria-label 提供，避免重复朗读。
//
// 调参：stroke-width 1.6 在 24 格缩到 17px 后实渲染约 1.13px、16px 时约 1.07px。
// 若深色玻璃底上显得发虚，把下面 ATTRS 里的 stroke-width 整体调到 1.8 即可，一处生效。
//
// 许可：齿轮 / 饼图 / 时钟的几何取自 Feather Icons（MIT），可商用；将来若开源需在 NOTICE 注明。
const ATTRS =
  'viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true" focusable="false"';

const svg = (body) => `<svg ${ATTRS}>${body}</svg>`;

export const ICONS = Object.freeze({
  // 概览：2×2 网格（总览）
  overview: svg(
    '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/>' +
      '<rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/>' +
      '<rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/>' +
      '<rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>'
  ),
  // 决策：罗盘（指向 / 判断；17px 下比天平两端秤盘清晰得多）
  decision: svg(
    '<circle cx="12" cy="12" r="8.5"/>' + '<path d="m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3z"/>'
  ),
  // 持仓：饼图（仓位构成）
  holdings: svg('<path d="M21.2 15.9A10 10 0 1 1 8 2.8"/>' + '<path d="M22 12A10 10 0 0 0 12 2v10z"/>'),
  // 配置：双滑杆（调节配比）
  allocation: svg(
    '<path d="M3.8 7.5h16.4"/><circle cx="9.5" cy="7.5" r="2.4"/>' +
      '<path d="M3.8 16.5h16.4"/><circle cx="14.5" cy="16.5" r="2.4"/>'
  ),
  // 复盘：时钟（回看历史）
  review: svg('<circle cx="12" cy="12" r="8.5"/>' + '<path d="M12 6.9v5.3l3.6 2.1"/>'),
  // 设置：齿轮
  settings: svg(
    '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
  ),
  // 更多：横向三点
  // 必须 fill currentColor + stroke none：若沿用 fill:none，半径 1.35 的空心圆在 17px 下几乎不可见。
  more: svg(
    '<circle cx="5" cy="12" r="1.35" fill="currentColor" stroke="none"/>' +
      '<circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/>' +
      '<circle cx="19" cy="12" r="1.35" fill="currentColor" stroke="none"/>'
  ),
});

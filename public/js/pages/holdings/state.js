/* 持仓页 · 共享状态
   职责：跨模块状态（渲染容器、展开项、端形态）+ 数据刷新后的整页重绘。
   导出：setRoot / getRoot / setExpanded / getExpanded / setMobile / isMobile / setRerender / refreshPage
   ★ 重绘回调由 index.js 注册，本文件不得 import './index.js'。
*/

import * as store from '../../store.js';

let _root = null;    // 当前渲染容器（录入/编辑成功后重绘用）
let _expanded = null; // 记住展开买入记录的基金 code（整页重绘后仍保持展开）
let _mobile = false;  // 渲染期判定的客户端形态（桌面/手机），决定录入/编辑表单用 <tr> 还是 <div> 包裹

let _rerender = null;  // 重绘回调，由 index.js 在模块求值时注册（断开 state → index 的循环依赖）

export function setRoot(r) { _root = r; }
export function getRoot() { return _root; }
export function setExpanded(v) { _expanded = v; }
export function getExpanded() { return _expanded; }
export function setMobile(v) { _mobile = v; }
export function isMobile() { return _mobile; }
export function setRerender(fn) { _rerender = fn; }

// 录入/编辑/删除后：刷新 STATE（买入记录源）+ LIVE（市值/在途/月投联动）→ 重绘当前页（保持展开的基金）
export async function refreshPage() {
  try {
    await Promise.all([store.reloadState(), store.reloadLive()]);
  } catch (e) {
    alert('数据刷新失败：' + e.message);
  }
  if (_root && _rerender) await _rerender(_root);
}

/* 持仓页 · 入口
   职责：整页渲染分发（桌面/手机）+ 注册重绘回调。
   导出：render
   ★ 模块地图：constants 常量 / state 共享状态 / fundMeta 元数据 / fundStore 增删落盘
     / formShell 表单外壳 / preview 预览 / purchaseForm 记一笔与编辑 / dailyLimit 每日限购
     / desktop 桌面渲染 / mobile 手机渲染 / bulkAdd 批量添加 / addFundPanel 添加基金面板
   ★ 任何子模块不得 import 本文件；要重绘请用 state.js 的 refreshPage。
*/

import * as store from '../../store.js';
import { setRoot, setMobile, setRerender } from './state.js';
import { renderDesktop } from './desktop.js';
import { renderMobile } from './mobile.js';
import * as api from '../../api.js';
import { el } from '../../util.js';

function pageSettings(state) {
  const checked = !!(state.config && state.config.purchaseDefaults && state.config.purchaseDefaults.feeWaived);
  const input = el('input', { type: 'checkbox' }); input.checked = checked;
  const msg = el('span', { class: 'hint', text: '仅影响新买入；编辑始终读取该笔记录自己的设置。' });
  input.addEventListener('change', async () => {
    input.disabled = true; msg.textContent = '保存中…';
    try {
      const cfg = Object.assign({}, state.config, { purchaseDefaults: Object.assign({}, state.config && state.config.purchaseDefaults, { feeWaived: input.checked }) });
      await api.save({ config: cfg }); state.config = cfg; msg.textContent = '已保存，仅影响新买入。';
    } catch (e) { input.checked = !input.checked; msg.textContent = '保存失败：' + e.message; }
    input.disabled = false;
  });
  return el('div', { class: 'panel', style: 'padding:12px 16px' }, [
    el('div', { class: 'panel-head' }, [el('span', { text: '新买入设置' })]),
    el('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:8px' }, [input, el('span', { text: '默认使用积分抵扣申购费' })]),
    msg,
  ]);
}

function migrationBanner(state) {
  if (!state.migration || state.migration.status === 'complete') return null;
  const retry = el('button', { class: 'btn', text: '按原条件重试迁移' });
  const msg = el('div', { class: 'hint', text: (state.migration.errors || []).map(e => `${e.code}${e.fund ? ' · ' + e.fund : ''}`).join('；') || '迁移正在准备中' });
  retry.addEventListener('click', async () => {
    retry.disabled = true; msg.textContent = '迁移中…';
    try { await api.retryMigration(); location.reload(); } catch (e) { msg.textContent = e.message; retry.disabled = false; }
  });
  return el('div', { class: 'error-box' }, [el('div', { text: '份额与历史 v2 迁移未完成，当前仅可查看，所有写入已暂停。' }), msg, retry]);
}

// 持仓页：基金列表（今日涨跌 / 持仓金额 / 累计收益）+ 添加基金 + 日限编辑 + 展开买入记录（含删除）
// 手机端（≤760px）改卡片式竖排，纯纵向滚、无横滑/无缩放（方案 A）
// 2026-09-03：＋「记一笔买入」录入（先记金额后补份额，QDII T+2 自动补填）+ 在途金额展示
// 2026-09-04：确认记录在持仓页加「编辑」入口（改日期/金额/份额/净值/备注，提交带 editKey 覆盖已有记录）
// 2026-09-08：合并——设置页的「添加基金」表单迁入本页（唯一持仓入口）；加每日限购显示/编辑；买入记录加删除；移除关注池
// 2026-09-18：编辑表单取消勾选框 —— 改日期/时段即自动重算；删除「手动校正」与在途「补填」手动入口（均由系统/数据层负责）
/* ---------- 入口 ---------- */
export async function render(root) {
  setRoot(root);
  setMobile(window.matchMedia('(max-width: 760px)').matches);
  const live = store.getLive();
  const state = store.getState();
  root.innerHTML = '';
  const banner = migrationBanner(state); if (banner) root.appendChild(banner);
  root.appendChild(pageSettings(state));
  if (window.matchMedia('(max-width: 760px)').matches) {
    renderMobile(root, live, state);
  } else {
    renderDesktop(root, live, state);
  }
}

setRerender(render);

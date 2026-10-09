// 决策页：每只基金一行状态一览；证据、核验与交易约束明细在「每日复盘」页查看。
import * as store from '../store.js';
import { el, escapeHtml, loadingHTML } from '../util.js';
import { decisionStatusCard } from './decision-card.js';

export async function render(root) {
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'panel-head', style: 'border:none;margin:0 0 8px;padding:0', text: '每日决策信号' }));
  root.appendChild(el('div', { class: 'hint', style: 'margin-bottom:12px', text: '这里只展示每只基金的当日状态与约束；判断说明、条件指标与数据日期等明细，请到「每日复盘」页查看。' }));
  const list = el('div', { class: 'signals', id: 'decisionList' });
  list.innerHTML = loadingHTML('正在准备你的看板…', true);
  root.appendChild(el('div', { class: 'panel' }, [list]));
  try {
    const advice = await store.reloadAdvice('am');
    const funds = advice.funds || [], alerts = advice.alerts || [];
    list.innerHTML = '';
    if (!funds.length && !alerts.length) {
      list.appendChild(el('div', { class: 'hint', text: '暂无判定结果。先去「我的基金」添加基金。' }));
      return;
    }
    funds.forEach(f => list.appendChild(decisionStatusCard(f)));
    const byCode = new Map(funds.map(f => [f.code, f]));
    alerts.forEach(a => list.appendChild(decisionStatusCard(a, { alert: true, fund: byCode.get(a.code) })));
  } catch (e) {
    list.innerHTML = `<div class="error-box">信号加载失败：${escapeHtml(e.message)}</div>`;
  }
}

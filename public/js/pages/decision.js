// 决策页：状态在摘要，证据与交易约束在折叠详情；评分仍供其他页面使用。
import * as store from '../store.js';
import { el, escapeHtml, loadingHTML } from '../util.js';
import { decisionCard } from './decision-card.js';

export async function render(root) {
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'panel-head', style: 'border:none;margin:0 0 8px;padding:0', text: '每日决策信号' }));
  root.appendChild(el('div', { class: 'hint', style: 'margin-bottom:12px', text: '点击基金展开条件、指标与数据日期。市场判断和申购限制分别展示；金额与节奏由你决定。' }));
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
    funds.forEach(f => list.appendChild(decisionCard(f)));
    const byCode = new Map(funds.map(f => [f.code, f]));
    alerts.forEach(a => list.appendChild(decisionCard(a, { alert: true, fund: byCode.get(a.code) })));
  } catch (e) {
    list.innerHTML = `<div class="error-box">信号加载失败：${escapeHtml(e.message)}</div>`;
  }
}

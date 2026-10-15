// 决策页：状态一览；红利卡片可按需展开加投参考，其余证据在每日复盘查看。
import * as store from '../store.js';
import { el, escapeHtml, loadingHTML } from '../util.js';
import { decisionStatusCard } from './decision-card.js';
import { dividendReferenceSection } from './dividend-reference.js';

export async function render(root) {
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'panel-head', style: 'border:none;margin:0 0 8px;padding:0', text: '长期积累 · 策略参考' }));
  root.appendChild(el('div', { class: 'hint', style: 'margin-bottom:12px', text: '查看当日状态、原因与交易限制；每日复盘展开可看还缺什么，详细依据按需查看。' }));
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
    const recorded = funds.filter(f => f.marketState === 'record_only');
    if (recorded.length) list.appendChild(el('div', {class:'record-only-note',text:`${recorded.length} 只基金仅记账：持仓、收益、占比及历史保留，可在「我的基金」和复盘查看。`}));
    funds.filter(f => f.marketState !== 'record_only').forEach(f => {
      const card = decisionStatusCard(f);
      if (f.strategyVersion === 'dividend-monthly-dca-v1' && f.displayKind === 'plan' &&
          f.marketState === 'monthly_dca' && !f.unsupported) card.appendChild(dividendReferenceSection(f));
      list.appendChild(card);
    });
    const byCode = new Map(funds.map(f => [f.code, f]));
    alerts.filter(a=>byCode.get(a.code)?.marketState!=='record_only'&&byCode.get(a.code)?.strategyScope!=='record_only'&&a.marketState!=='record_only'&&a.strategyScope!=='record_only').forEach(a => list.appendChild(decisionStatusCard(a, { alert: true, fund: byCode.get(a.code) })));
  } catch (e) {
    list.innerHTML = `<div class="error-box">信号加载失败：${escapeHtml(e.message)}</div>`;
  }
}

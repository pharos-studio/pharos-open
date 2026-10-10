/* 我的基金 · 策略问题轻量提醒与处理列表。 */
import { el } from '../../util.js';

export function issueSummary(issues) {
  if (!issues.length) return null;
  const link = el('a', { class: 'fund-issue-link', href: '#fund-issue-details', text: '查看问题 →' });
  return el('div', { class: 'fund-issue-summary', role: 'status' }, [
    el('div', { class: 'fund-issue-summary-copy' }, [
      el('span', { class: 'fund-issue-dot', 'aria-hidden': 'true' }),
      el('strong', { text: `${issues.length} 只基金有待处理问题` }),
      el('span', { class: 'hint', text: '不影响持有记录，暂不生成策略信号' }),
    ]),
    link,
  ]);
}

export function issueDetails(issues, onRetry) {
  if (!issues.length) return null;
  const rows = issues.map(issue => {
    const main = el('div', {}, [
      el('div', { class: 'fund-issue-name', text: issue.name || '基金' }),
      el('div', { class: 'hint', text: `${issue.code} · ${issue.detail}` }),
      el('div', { class: 'fund-issue-next', text: issue.nextStep }),
    ]);
    let action;
    if (issue.action === 'reidentify') {
      action = el('a', { class: 'fund-issue-link', href: `#fund-${issue.code}`, text: '定位并修改类别' });
    } else if (issue.action === 'retry') {
      action = el('button', { class: 'btn fund-issue-action', text: '重新检查' });
      action.addEventListener('click', async () => {
        action.disabled = true; action.textContent = '检查中…';
        try { await onRetry(); }
        catch (error) { action.disabled = false; action.textContent = '重试'; action.title = error.message; }
      });
    } else {
      action = el('span', { class: 'hint fund-issue-wait', text: '等待核验' });
    }
    return el('div', { class: 'fund-issue-row' }, [main, action]);
  });
  return el('section', { class: 'panel fund-issue-details', id: 'fund-issue-details', 'aria-label': '待处理问题' }, [
    el('div', { class: 'panel-head' }, [el('span', { text: '待处理问题' }), el('span', { class: 'sub', text: `${issues.length} 项` })]),
    el('div', { class: 'hint fund-issue-explainer', text: '基金和买入记录会继续保留；问题解决后，策略信号会自动恢复。' }),
    ...rows,
  ]);
}

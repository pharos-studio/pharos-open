import { el } from '../util.js';
import { getDividendReference } from '../api.js';

export function dividendReferenceSection(fund) {
  const details = el('details', { class: 'dividend-reference' }, [el('summary', { text: '查看加投参考' })]);
  const body = el('div', { class: 'dividend-reference-body', 'aria-live': 'polite' });
  details.appendChild(body);
  let busy = false, loaded = false;
  const row = (label, value) => el('div', { class: 'decision-factor' }, [el('span', { text: label }), el('span', { text: value })]);
  const number = value => Number.isFinite(value) ? value.toFixed(2) : '—';
  async function load() {
    if (busy) return;
    busy = true;
    loaded = false;
    body.replaceChildren(el('div', { class: 'hint', text: '正在核对基金净值与加投参考…' }));
    try {
      const data = await getDividendReference(fund.code), m = data.metrics, c = data.conditions;
      const ready = data.state === 'ready' && m && c?.lowPosition === true && c?.dailyRsiRising === true;
      const available = (data.state === 'ready' || data.state === 'not_met') && m && c;
      body.replaceChildren(el('span', { class: 'badge ' + (ready ? 'badge-add' : 'badge-hold'), text: ready ? '参考条件满足' : available ? '尚未满足' : '数据不足' }),
        el('p', { class: 'dividend-reference-copy', text: available ? data.explanation : data.explanation || '加投参考暂不可用，请稍后重试。' }));
      if (available) {
        body.appendChild(row('接近近期低点 · 距此前60日低点≤3%', number(m.distancePct) + '% · ' + (c.lowPosition ? '满足' : '尚未满足')));
        body.appendChild(row('日RSI(14)回升 · 高于前次', number(m.previousDailyRsi14) + ' → ' + number(m.dailyRsi14) + ' · ' + (c.dailyRsiRising ? '上升' : '未上升')));
        body.appendChild(el('div', { class: 'hint dividend-reference-dates', text: '参考净值日 ' + m.navDate + ' · 前次观察 ' + m.previousNavDate + '。采用保守可知时间，可能晚于最新净值。' }));
        const formula = el('details', { class: 'dividend-reference-formula' }, [el('summary', { text: '查看计算口径' }),
          el('div', { class: 'hint', text: '使用本基金分红再投资复权净值。低点取本次净值之前60个净值观察值；日RSI(14)使用完整可用历史，和前一次净值观察比较。两项同时满足才显示参考条件满足，按未四舍五入的数值判断。' })]);
        body.appendChild(formula);
      }
      const limits = [];
      const status = fund.purchaseStatus;
      if (fund.suspended || status?.state === 'suspended') limits.push('暂停申购');
      else if (status?.state === 'unknown' || fund.statusFresh === false) limits.push('申购状态需刷新核验');
      if (status?.state !== 'suspended' && Number(status?.maxBuy) > 0) limits.push('申购上限 ' + status.maxBuy + '元');
      if (fund.dailyLimit != null) limits.push('用户每日上限 ' + fund.dailyLimit + '元');
      if (fund.constraints?.includes('policy_blocked') || fund.blockedReason === 'policy_blocked') limits.push('资金政策限制');
      if (limits.length) body.appendChild(el('div', { class: 'hint dividend-reference-limits', text: '交易限制：' + limits.join('；') + '。' }));
      body.appendChild(el('div', { class: 'hint dividend-reference-note', text: '加投参考不改变每月定投计划。历史回测未显示明显收益优势，是否多投及金额由你决定。' }));
      loaded = true;
    } catch (_) {
      body.replaceChildren(el('span', { class: 'badge badge-hold', text: '数据不足' }),
        el('div', { class: 'hint', text: '加投参考暂时加载失败，每月定投计划仍可查看。' }));
    } finally {
      busy = false;
      const retry = el('button', { class: 'btn', type: 'button', text: loaded ? '刷新参考' : '重试' });
      retry.addEventListener('click', load); body.appendChild(retry);
    }
  }
  details.addEventListener('toggle', () => { if (details.open && !loaded && !busy) load(); });
  return details;
}

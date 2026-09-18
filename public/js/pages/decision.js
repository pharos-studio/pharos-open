// 决策页「每日决策信号」极简版：每只基金 = 名称 + 判定徽章(暂停申购优先) + 综合分徽章（色随判定）
// 完整信号理由/估值信号表格已整合至 复盘页 → 每日 tab（review.js renderDaily），本页不复读。
// 统一模式：单档决策视图（删除了原 am/pm 双档切换）
// 2026-09-08 L2/L3 整合：改单源渲染 advice.funds（每基金一条，verdict/score 直接用）；alerts 追加渲染
//   （trim/statementOnly，无 verdict 字段——沿用 verdictOf(title) 文字推断，见 D3）；空态 = funds 与 alerts 均空（D4）。
import * as store from '../store.js';
import { el, escapeHtml, loadingHTML } from '../util.js';

// alerts 判定：从 title 文字推断（trim title 含"减仓"→stop；alerts 元素本身无 verdict 字段，勿找）
function verdictOf(sig) {
  const t = sig.title || '';
  if (t.includes('减仓') || t.includes('清理')) return 'stop';
  if (t.includes('加仓')) return 'add';
  return 'hold';
}
const VERDICT_BADGE = { add: 'badge-add', hold: 'badge-hold', stop: 'badge-stop' };
const VERDICT_TXT = { add: '加仓', hold: '不动', stop: '减仓' };

export async function render(root) {
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'panel-head', style: 'border:none;margin:0 0 8px;padding:0' }, [el('span', { text: '每日决策信号' })]));
  root.appendChild(el('div', { class: 'hint', style: 'margin-bottom:12px', text: '每只基金只显示 判定 + 综合分：综合分 = 估值分V×wV + 动量分M×wM（0~100，越高越值得买），徽章旁「估X · 动Y」拆解两派贡献；暂停申购的基金分数仅供观察、不可买入。完整信号理由与估值信号表格见 复盘页 → 每日。金额与节奏由你自行决定。' }));

  const panel = el('div', { class: 'panel' });
  const list = el('div', { class: 'signals', id: 'decisionList' });
  // 用紧凑版（.loading--compact）：与全站同为「线上文下」，但上下留白收到 8px，
  // 把数据到达时的收缩位移从块级版的约 +77px 压到约 +29px。
  list.innerHTML = loadingHTML('正在准备你的看板…', true);
  panel.appendChild(list);
  root.appendChild(panel);

  await fill(root);
}

async function fill(root) {
  const list = root.querySelector('#decisionList');
  try {
    const advice = await store.reloadAdvice('am');
    const funds = advice.funds || [];   // 每基金一条统一信号（判定/综合分/金额/文案全同源）
    const alerts = advice.alerts || []; // 非常规信号（trim/statementOnly）
    list.innerHTML = '';
    if (!funds.length && !alerts.length) { // D4: 两源均空才显示兜底，避免 alerts 非空被吞
      list.appendChild(el('div', { class: 'hint', text: '今日无触发信号。' }));
      return;
    }
    // alerts 无 score/suspended 字段：同 code 若在 funds[] 中则复用其综合分/暂停标记（贴近旧 scoreMap 全量取分行为）
    const fundsByCode = new Map(funds.map(x => [x.code, x]));

    const appendCard = (sig, verdict, score, suspended) => {
      const vBadgeCls = suspended ? 'badge-hold' : VERDICT_BADGE[verdict];
      const vBadgeTxt = suspended ? '暂停申购' : VERDICT_TXT[verdict];
      const posCls = (!suspended && verdict === 'add') ? 'badge-add' : 'badge-hold';
      // 综合分 = 估值分V×wV + 动量分M×wM；两派拆开展示，避免混成一个数看不懂
      const vs = (sig && sig.valueScore != null) ? sig.valueScore : null;
      const ms = (sig && sig.momentumScore != null) ? sig.momentumScore : null;
      const vmTxt = (vs != null || ms != null)
        ? `估${vs != null ? vs : '—'} · 动${ms != null ? ms : '—'}` : null;
      const right = el('div', { class: 'sig-right' }, [
        el('div', { style: 'display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap' }, [
          score != null ? el('span', { class: 'badge ' + posCls, text: `综合分 ${score}` }) : null,
          vmTxt ? el('span', { class: 'badge', text: vmTxt }) : null,
          el('span', { class: 'badge ' + vBadgeCls, text: vBadgeTxt }),
        ]),
      ]);
      const left = el('div', {}, [
        el('div', { style: 'font-weight:600;font-size:15px' }, [
          document.createTextNode((sig.name || '') + ' '),
          el('span', { class: 'dec-code', text: sig.code }),
        ]),
      ]);
      const cardCls = suspended ? 'hold' : verdict === 'add' ? 'add' : verdict === 'stop' ? 'stop' : 'hold';
      list.appendChild(el('div', { class: 'sig ' + cardCls }, [left, right]));
    };

    // funds：verdict/score/suspended 直接用（机器判定值，不再靠 title 推断）
    funds.forEach(x => appendCard(x, x.verdict, x.score, !!x.suspended));
    // alerts：verdict 从 title 文字推断（D3），score/suspended 从同 code funds 记录复用
    alerts.forEach(x => {
      const fc = fundsByCode.get(x.code);
      appendCard(x, verdictOf(x), fc ? fc.score : null, !!(fc && fc.suspended));
    });
  } catch (e) {
    list.innerHTML = `<div class="error-box">信号加载失败：${escapeHtml(e.message)}</div>`;
  }
}

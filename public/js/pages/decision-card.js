// 决策页状态行与每日复盘详情段的渲染：状态行只给结论、涨跌与约束徽标，证据明细单独成段。
import { el, cls, signPct } from '../util.js';

const ACTION = { add: '加仓', hold: '不动', stop: '减仓' };
const BADGE = { add: 'badge-add', hold: 'badge-hold', stop: 'badge-stop' };
const BLOCK = {
  release_pending: '待启用', purchase_suspended: '暂停申购',
  purchase_status_unverified: '申购状态待核验', user_limit_zero: '用户限额为零',
  policy_blocked: '资金政策限制', future_order_recheck: '未来申请日需复核',
  official_purchase_suspended: '官方暂停申购', official_resumption_unverified: '官方恢复申购待核',
  official_constraint_unverified: '官方申购约束待核',
};
const FAILURE = { pending: '待建设', rule_disabled: '规则调整中', needs_review: '档案待确认',
  profile_unverified: '档案待确认', initialization_unverified: '档案待确认', scope_unsupported: '暂不支持' };

// 展示现成证据；不把分数分段为状态，不显示评分文案。
export function evidenceText(value) {
  return String(value ?? '').split(/(?<=[。；\n])/u)
    .filter(s => !/综合分|估值分|动量分|估\d+\s*·\s*动|V\/M|(?:value|momentum|composite)Score|\bscore\b/i.test(s)).join('').trim();
}
function alertAction(sig) {
  const t = sig.title || '';
  return /减仓|清理/.test(t) ? 'stop' : t.includes('加仓') ? 'add' : 'hold';
}
export function cardState(sig, { alert = false, fund } = {}) {
  const action = alert ? alertAction(sig) : Object.hasOwn(sig, 'marketVerdict') ? sig.marketVerdict : sig.verdict;
  const market = alert ? ACTION[action] : sig.unsupported
    ? FAILURE[sig.unsupportedReason] || sig.marketStateLabel || '未归类'
    : sig.marketStateLabel || ACTION[action] || '无法判定';
  const execution = alert ? fund || sig : sig;
  const constraint = BLOCK[execution.blockedReason] || (execution.suspended ? '暂停申购' : null)
    || (execution.strategyVersion === 'gold-dual-v1' && execution.releaseEnabled !== true ? '待启用' : null)
    || (action === 'add' && execution.executable === false && execution.statusFresh === false ? '申购状态待核验' : null)
    || (action === 'add' && execution.executable === false ? '当前不可执行' : null);
  const differs = action != null && execution.verdict != null && execution.verdict !== action;
  return { action, market, constraint: constraint || (differs ? '执行：' + (ACTION[execution.verdict] || '受限') : null) };
}
function section(body, heading, children) {
  if (!children.length) return;
  body.appendChild(el('section', { class: 'dec-sec' }, [el('div', { class: 'dec-sec-h', text: heading }), ...children]));
}
function textNode(value) {
  const text = evidenceText(value);
  return text ? el('div', { class: 'dec-raw', text }) : null;
}

// 状态行：只渲染名称与代码、当日涨跌幅、市场判断徽标及约束徽标，不做折叠也不带任何交互。
export function decisionStatusCard(sig, options = {}) {
  const state = cardState(sig, options), meta = options.alert ? options.fund || sig : sig;
  const badges = [el('span', { class: 'badge ' + (BADGE[state.action] || 'badge-hold'), text: (options.alert ? '提醒：' : '市场：') + state.market })];
  if (state.constraint) badges.push(el('span', { class: 'badge badge-hold', text: state.constraint }));
  // ★ 涨跌取 meta 而非 sig：alert 记录（advice.js 的 alerts[]）只带 id/type/code/name/title/detail，
  //   本身没有 dayChange，只有经 options.fund 传进来的基金记录才有。用 sig 会让「持有提醒」行恒为「—」。
  const chg = meta.dayChange;
  const row = el('div', { class: 'dec-status-row' }, [
    el('div', { class: 'decision-name' }, [
      el('span', { class: 'dec-name', text: sig.name || meta.name || '基金提醒' }),
      el('span', { class: 'dec-code', text: sig.code || '' }),
    ]),
    chg == null ? el('span', { class: 'dec-chg', text: '—' })
      : el('span', { class: 'dec-chg ' + cls(chg), text: signPct(chg) }),
    el('div', { class: 'decision-status' }, badges),
  ]);
  return el('div', { class: 'dec-card decision-card' }, [row]);
}

// 详情段：数据核验、数据日期、交易限制三段，供复盘页折叠区展示。
//   ★ 不重复「信号理由」与「因子表」——复盘页已按同源字段渲染过，再印一遍会让同一段文字出现两次；
//     而且复盘页对「全无实测值」有折叠保护，逐行再列会把刚消灭的刷屏引回来。
export function decisionDetailSections(sig, options = {}) {
  const state = cardState(sig, options), meta = options.alert ? options.fund || sig : sig;
  const wrap = el('div', { class: 'dec-detail' });
  const explanations = [sig.matrix?.dataErrorLabel, options.alert ? sig.action : null].map(textNode).filter(Boolean);
  if (sig.valuationAnchor?.degraded) explanations.push(textNode('估值锚缺失，当前判断已降级；详见自动档案。'));
  section(wrap, options.alert ? '持有提醒' : '判断说明', explanations);
  const checks = sig.matrix?.evidenceChecks;
  if (checks) section(wrap, '数据核验', Object.entries({ identity: '官方份额身份', sampling: '日频采样完整性', continuity: '序列起点与策略连续性', calendar: '申购、估值日历与公告时点' })
    .map(([key, label]) => el('div', { class: 'decision-factor' }, [el('span', { text: label }), el('span', { text: checks[key] ? '已核验' : '待核验' })])));
  const dates = [['信号净值日', sig.signalNavDate || sig.matrix?.metrics?.navDate],
    ['最新净值日', sig.latestDate], ['申请日', sig.orderDate], ['PE日期', sig.peDate], ['计算时间', sig.computedAt]];
  section(wrap, '数据日期', dates.filter(([, value]) => value).map(([label, value]) => textNode(label + '：' + value)));
  const limits = [];
  if (state.constraint) limits.push(textNode(state.constraint));
  else if (!options.alert && meta.executable === true) limits.push(textNode('当前交易约束允许执行。'));
  const status = meta.purchaseStatus;
  if (status) {
    const names = { open: '开放', limited: '限额', suspended: '暂停', unknown: '未知' };
    limits.push(textNode('申购状态：' + (names[status.state] || '未知') + (meta.statusFresh === false ? '（待刷新核验）' : '')));
    if (Number(status.maxBuy) > 0 && status.state !== 'suspended') limits.push(textNode('实际申购上限：' + status.maxBuy + '元'));
  }
  if (meta.dailyLimit != null) limits.push(textNode('用户每日上限：' + meta.dailyLimit + '元'));
  section(wrap, '交易限制', limits.filter(Boolean));
  if (!wrap.children.length) wrap.appendChild(textNode('本次未提供详细证据。'));
  return wrap;
}

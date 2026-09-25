/* 持仓页 · 买入预览
   职责：输入防抖、竞态丢弃、净值与份额的预估展示。
   导出：createPreview / pvFmtOne / navDateInfo
   ★ 不要放在这里：表单本体请去 purchaseForm.js。
*/

import * as api from '../../api.js';

/* ---------- 通用：买入预览控制器（防抖 + 竞态丢弃） ---------- */
// 改日期/时段/金额 → 防抖 → GET /api/purchase-preview → 交给 paint() 渲染。
// ★ 竞态处理：seq 单调递增；响应回来时若 seq 已变（说明用户又改过），整条丢弃 ——
//   否则「先发后到」的旧响应会覆盖新结果，用户看到的是上一版数字（静默错，最难查）。
// dispose() 必须在表单被 replaceWith/refreshPage 销毁前调用，否则会往脱离文档的节点写字、白耗请求。
export function createPreview({ code, getDate, getSession, getAmount, getFeeWaived, getKnownNav, getKnownPricingDate, paint }) {
  let seq = 0, timer = null, last = null, dead = false;
  async function run() {
    if (dead) return;
    const date = getDate();
    const session = getSession();
    const amount = Number(getAmount());
    if (!date || !isFinite(amount) || amount <= 0) { last = null; paint(null, null); return; }
    const my = ++seq;
    paint('loading', null);
    try {
      const r = await api.getPurchasePreview(code, date, session, amount, getFeeWaived ? getFeeWaived() : false,
        getKnownNav ? getKnownNav() : null, getKnownPricingDate ? getKnownPricingDate() : null);
      if (dead || my !== seq) return;
      last = r; paint(r, null);
    } catch (e) {
      if (dead || my !== seq) return;
      last = null; paint(null, e);
    }
  }
  return {
    schedule(delay) { clearTimeout(timer); timer = setTimeout(run, delay == null ? 420 : delay); },
    get() { return last; },
    dispose() { dead = true; seq++; clearTimeout(timer); },
  };
}

// 单档预览的一行摘要（前/后对比行共用）；桌面与手机共用同一份格式化，避免两套渲染漂移
// ★ 日期一律以 nominalDate（名义日）为基准：pending 时定价日是 null，拿它 slice 会直接崩。
//   发生顺延时写成 `09-12→09-14`，让「非交易日被顺延了」一眼可见。
export function pvFmtOne(v) {
  if (!v) return '—';
  const nom = v.nominalDate ? v.nominalDate.slice(5) : '—';
  const pd = v.pricingDate;
  if (v.status === 'ok') {
    const day = v.shifted ? (nom + '→' + pd.slice(5)) : pd.slice(5);
    return day + ' · ' + v.nav.toFixed(4) + ' · ' + v.shares.toFixed(2) + '份';
  }
  if (v.status === 'pending') return nom + (v.rollDays != null ? ' · 顺延 ' + v.rollDays + ' 天超限' : ' · 净值未公布');
  return nom + ' · 净值暂不可用';
}

// 「这笔按哪天净值成交、份额哪天确认到账」小字。
// ★ pricingDate（定价日）= 份额由它的净值算出；settleDate（确认日）= 份额登记到账，**不参与计算**。
//   只认真实落盘值（p.pricingDate / 兼容旧名 p.navDate）或后端旁挂 navMeta 给的推定值。
// navMeta 条目带 inferred=true 表示「老记录按冻结旧口径推定」，用弱化样式呈现，不冒充真实解析结果。
export function navDateInfo(p, code, navMeta) {
  let hit = null;
  if (p && (p.pricingDate || p.navDate)) {
    hit = { pricingDate: p.pricingDate || p.navDate, settleDate: p.settleDate || null, inferred: false };
  } else {
    const bag = navMeta && navMeta[code];
    if (bag) {
      const amt = Math.round(Number(p.amount) * 100) / 100;
      hit = bag[p.date + '|' + amt] || null;
    }
  }
  if (!hit || !hit.pricingDate) return null;
  let text = (hit.inferred ? '推定净值 ' : '成交净值 ') + hit.pricingDate.slice(5);
  if (hit.settleDate) text += ' · 份额 ' + hit.settleDate.slice(5) + (hit.settleInferred ? ' 预计到账' : ' 确认');
  return { text, inferred: !!hit.inferred };
}

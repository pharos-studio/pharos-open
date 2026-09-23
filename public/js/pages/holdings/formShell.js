/* 持仓页 · 表单外壳
   职责：时段开关（15:00 前后）+ 买入行容器（桌面表格行 / 手机卡片）。
   导出：sessionToggle / buyRowShell
   ★ 不要放在这里：具体字段渲染请去 purchaseForm.js。
*/

import { el } from '../../util.js';
import { isMobile } from './state.js';

/* ---------- 通用：15:00 前/后 时段开关（默认「前」= T） ---------- */
// 返回 span 元素，.getSession() 读当前值（'T' / 'T+1' / null）。init 缺省按用户要求默认「前」。
// opts（2026-09-16 新增，两个都是可选的 —— 现有调用点不传 → 行为与改动前逐字一致）：
//   allowUnknown: true → 多出第三态「未知（老记录）」，用于 session 为 null 的历史记录。
//                        老记录若被静默赋成 'T'，成交日会被悄悄提前一天 —— 必须显式让用户选。
//   onChange(val)      → 每次真实变更时回调（用于触发买入预览重算）。
// 注意：所有变更都收敛到唯一的 set() 入口，避免「改了内部变量却漏了回调/paint」。
export function sessionToggle(init, opts) {
  const o = opts || {};
  const allowUnknown = o.allowUnknown === true;
  const val0 = (init === 'T' || init === 'T+1') ? init : (allowUnknown ? null : 'T');
  let val = val0;
  const wrap = el('span', { class: 'seg', style: 'display:inline-flex;gap:0;margin-top:3px' });
  const mkBtn = (text) => el('button', { class: 'btn seg-opt', type: 'button', text, style: 'padding:1px 7px;font-size:11px;line-height:1.5' });
  const b1 = mkBtn('15:00前');
  const b2 = mkBtn('15:00后');
  const bU = allowUnknown ? mkBtn('未知') : null;
  const paint = () => {
    // 选中态 = 鎏金底 + 深墨字（与 .btn-primary 同一配色，白字在鎏金上对比度不足）
    const on = 'var(--accent,#D9A441)';
    b1.style.background = val === 'T' ? on : '';
    b2.style.background = val === 'T+1' ? on : '';
    b1.style.color = val === 'T' ? '#1A1206' : '';
    b2.style.color = val === 'T+1' ? '#1A1206' : '';
    if (bU) { // 第三态用弱化灰底：它不是「选择」，而是「尚未填过」的事实
      bU.style.background = val === null ? 'rgba(154,163,192,.22)' : '';
      bU.style.color = val === null ? 'var(--text,#E8ECF7)' : 'var(--text-muted,#9AA3C0)';
    }
  };
  const set = (v) => {
    if (val === v) return;
    val = v; paint();
    if (typeof o.onChange === 'function') o.onChange(val);
  };
  b1.addEventListener('click', () => set('T'));
  b2.addEventListener('click', () => set('T+1'));
  if (bU) bU.addEventListener('click', () => set(null));
  paint();
  wrap.appendChild(b1);
  wrap.appendChild(b2);
  if (bU) wrap.appendChild(bU);
  wrap.getSession = () => val;
  return wrap;
}

// 行容器：桌面返回 <tr>（与子表同构、5 列对齐）；手机返回 <div>（卡片竖排）。
// cellFns: { date, shares, amount, nav, ops } 各返回一个已构建好的子节点
export function buyRowShell(cellFns) {
  if (isMobile()) {
    return el('div', { class: 'buy-edit', style: 'margin:6px 0;padding:6px;border:1px dashed rgba(255,255,255,.22);border-radius:6px;display:flex;flex-direction:column;gap:6px' }, [
      cellFns.date, cellFns.shares, cellFns.amount, cellFns.nav, cellFns.ops,
    ]);
  }
  const tr = el('tr', {});
  tr.appendChild(el('td', { style: 'vertical-align:top' }, [cellFns.date]));
  tr.appendChild(el('td', { class: 'tnum', style: 'vertical-align:top' }, [cellFns.shares]));
  tr.appendChild(el('td', { style: 'vertical-align:top' }, [cellFns.amount]));
  tr.appendChild(el('td', { style: 'vertical-align:top' }, [cellFns.nav]));
  tr.appendChild(el('td', { style: 'vertical-align:top' }, [cellFns.ops]));
  return tr;
}

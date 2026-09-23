/* 持仓页 · 手机渲染
   职责：窄屏卡片整页渲染 + 卡片内展开明细。
   导出：metricCell / buyRow / purchaseList / fundCard / renderMobile
   ★ 零件都在别的模块：改表格去 desktop.js，改表单去 purchaseForm.js。
*/

import * as api from '../../api.js';
import { el, fmtMoney, signPct, cls, catNameWithCaliber } from '../../util.js';
import { getExpanded, setExpanded, refreshPage } from './state.js';
import { purchasesByCode, feeNote } from './fundMeta.js';
import { removeFund } from './fundStore.js';
import { navDateInfo } from './preview.js';
import { addForm, editForm } from './purchaseForm.js';
import { limitRow } from './dailyLimit.js';
import { addFundPanel } from './addFundPanel.js';

/* ---------- 手机端卡片 ---------- */
export function metricCell(label, mainText, mainCls, subText, subCls) {
  const cell = el('div', { class: 'fc-metric' });
  cell.appendChild(el('div', { class: 'fc-label', text: label }));
  const v = el('div', { class: 'fc-value ' + (mainCls || '') });
  v.textContent = mainText;
  cell.appendChild(v);
  if (subText != null) {
    const s = el('div', { class: 'fc-sub ' + (subCls || '') });
    s.textContent = subText;
    cell.appendChild(s);
  }
  return cell;
}

export function buyRow(code, p, navMeta) {
  const pending = p.shares == null;
  const nd = navDateInfo(p, code, navMeta);
  const dateBox = el('div', { class: 'buy-date' }, [el('span', { text: p.date || '—' })]);
  if (nd) dateBox.appendChild(el('div', { class: 'pv-sub', text: nd.text }));
  const row = el('div', { class: 'buy-row', style: 'align-items:center;gap:6px' }, [
    dateBox,
    el('span', { class: 'buy-amt' }, [
      el('span', { text: fmtMoney(p.amount) }),
      pending ? el('span', { class: 'badge badge-muted', style: 'margin-left:4px', text: '待确认' }) : null,
    ]),
    el('span', { class: 'buy-nav', text: p.nav != null ? '净值 ' + p.nav.toFixed(4) : (pending ? '份额 —' : '') }),
  ]);
  const editBtn = el('button', { class: 'btn', text: '编辑', style: 'padding:2px 8px;font-size:11px;margin-left:4px' });
  editBtn.addEventListener('click', () => { row.replaceWith(editForm(code, p)); });
  row.appendChild(editBtn);
  // 删除：二次确认防误删
  const delBtn = el('button', { class: 'btn', text: '删除', style: 'padding:2px 8px;font-size:11px;margin-left:4px' });
  delBtn.addEventListener('click', async () => {
    if (!confirm('确定删除这笔买入记录？删除后不可恢复。')) return;
    try {
      await api.deletePurchase({ code, action: 'delete', editKey: { date: p.date, amount: p.amount } });
      await refreshPage();
    } catch (e) { alert('删除失败：' + e.message); }
  });
  row.appendChild(delBtn);
  return row;
}

export function purchaseList(code, list, navMeta) {
  if (!list.length) return el('div', { class: 'hint', text: '无买入记录。' });
  const wrap = el('div', { class: 'buy-list' });
  list.forEach(p => wrap.appendChild(buyRow(code, p, navMeta)));
  return wrap;
}

export function fundCard(f, list, state) {
  const card = el('div', { class: 'fund-card' });
  const fcMeta = el('div', { class: 'fc-meta', text: `${f.code} · ${catNameWithCaliber(state, f.category, f.caliber)}` });
  const feeTip = feeNote(f); // 申购费：后端抓取写入，界面只读（没有输入框）
  if (feeTip) { fcMeta.textContent += ' · ' + feeTip.text; fcMeta.setAttribute('title', feeTip.title); }
  card.appendChild(el('div', { class: 'fc-head' }, [
    el('div', { class: 'fc-name', text: f.name }),
    fcMeta,
  ]));
  const metrics = el('div', { class: 'fc-metrics' });
  metrics.appendChild(metricCell(
    '今日',
    f.dayChange != null ? signPct(f.dayChange) : '—',
    cls(f.dayChange),
    f.latestNav != null ? '净值 ' + f.latestNav + (f.latestDate ? ' · ' + f.latestDate.slice(5) : '') : null,
    ''
  ));
  metrics.appendChild(metricCell('持仓', fmtMoney(f.currentValue), '', f.pendingAmount > 0 ? '含在途 ' + fmtMoney(f.pendingAmount) : null, ''));
  metrics.appendChild(metricCell(
    '累计',
    f.profit != null ? fmtMoney(f.profit) : '—',
    cls(f.profit),
    f.profitPct != null ? signPct(f.profitPct) : null,
    cls(f.profitPct)
  ));
  card.appendChild(metrics);
  card.appendChild(limitRow(state, f.code)); // 日限显示 + 编辑

  const delFundBtn = el('div', { class: 'fc-expand', text: '删除该基金', style: 'color:var(--up);margin-top:8px' });
  delFundBtn.addEventListener('click', () => removeFund(f.code));
  card.appendChild(delFundBtn);

  const btn = el('div', { class: 'fc-expand', text: '买入记录 ▾' });
  const detail = el('div', { class: 'fc-detail', style: (getExpanded() === f.code) ? '' : 'display:none' });
  const addBtn = el('button', { class: 'btn', text: '＋ 记一笔', style: 'padding:4px 12px;font-size:12px;width:auto;margin-bottom:8px' });
  const formHolder = el('div', { style: 'display:none' });
  formHolder.appendChild(addForm(f.code));
  addBtn.addEventListener('click', () => {
    const open = formHolder.style.display !== 'none';
    formHolder.style.display = open ? 'none' : '';
    addBtn.textContent = open ? '＋ 记一笔' : '收起表单';
  });
  detail.appendChild(el('div', {}, [addBtn, formHolder]));
  detail.appendChild(purchaseList(f.code, list, state && state.navMeta && state.navMeta[f.code]));
  btn.addEventListener('click', () => {
    const open = detail.style.display !== 'none';
    detail.style.display = open ? 'none' : '';
    btn.textContent = open ? '买入记录 ▾' : '收起 ▴';
    setExpanded(open ? null : f.code);
  });
  card.appendChild(btn);
  card.appendChild(detail);
  return card;
}

export function renderMobile(root, live, state) {
  // 2026-09-12：调序——「持仓基金」在上、「添加基金」面板移到下方
  const funds = (live.funds || []).slice().sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0));
  const buys = purchasesByCode(state);
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-head' }, [el('span', { text: '持仓基金' }), el('span', { class: 'sub', text: `${funds.length} 只` })]));
  if (!funds.length) {
    panel.appendChild(el('div', { class: 'hint', text: '还没有基金。在下方表单添加第一只——填好代码后，名称、类别、跟踪指数都会自动带出来。' }));
    root.appendChild(panel);
    root.appendChild(addFundPanel()); // 空仓时也把添加表单放下方
    return;
  }
  const stack = el('div', { class: 'stack' });
  funds.forEach(f => stack.appendChild(fundCard(f, buys[f.code] || [], state)));
  panel.appendChild(stack);
  root.appendChild(panel);
  root.appendChild(addFundPanel()); // 2026-09-12 调序：添加表单移到持仓列表下方
}

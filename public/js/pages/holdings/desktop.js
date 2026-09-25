/* 持仓页 · 桌面渲染
   职责：宽屏表格整页渲染 + 展开的买入子表。
   导出：buyTable / renderDesktop
   ★ 零件都在别的模块：改表单去 purchaseForm.js，改卡片去 mobile.js。
*/

import * as api from '../../api.js';
import { el, tableWrap, fmtMoney, signPct, cls, catNameWithCaliber } from '../../util.js';
import { getExpanded, setExpanded, refreshPage } from './state.js';
import { purchasesByCode, feeNote, purchaseStatusNote } from './fundMeta.js';
import { removeFund } from './fundStore.js';
import { navDateInfo } from './preview.js';
import { addForm, editForm } from './purchaseForm.js';
import { limitCell, fundSettings } from './dailyLimit.js';
import { addFundPanel } from './addFundPanel.js';

/* ---------- 桌面：展开子表（含在途「待确认」标与删除） ---------- */
export function buyTable(f, list, navMeta) {
  const sub = el('table', { class: 'tbl' });
  sub.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: '日期' }), el('th', { text: '份额' }), el('th', { text: '金额' }), el('th', { text: '净值' }), el('th', { text: '操作' }),
  ])]));
  const sb = el('tbody', {}); // 外层声明，供「记一笔」按钮插入首行
  const addBtn = el('button', { class: 'btn', text: '＋ 记一笔', style: 'padding:4px 12px;font-size:12px' });
  let addTr = null; // 记一笔表单行（桌面为 <tr>），切换显隐
  addBtn.addEventListener('click', () => {
    if (addTr && addTr.parentNode) {
      addTr.remove();
      addTr = null;
      addBtn.textContent = '＋ 记一笔';
    } else {
      addTr = addForm(f.code); // 桌面返回 <tr>，直接进 tbody 与子表 5 列对齐
      sb.insertBefore(addTr, sb.firstChild);
      addBtn.textContent = '收起表单';
    }
  });
  const wrap = el('div', { style: 'padding:2px' });
  const delFundBtn = el('button', { class: 'btn', text: '删除该基金', style: 'padding:4px 12px;font-size:12px' });
  delFundBtn.addEventListener('click', () => removeFund(f.code));
  wrap.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin:4px 0' }, [
    el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
      el('span', { class: 'hint', text: list.length ? `${list.length} 笔` : '无买入记录' }),
      delFundBtn,
    ]),
    addBtn,
  ]));
  if (list.length) {
    list.forEach(p => {
      const pending = p.shares == null;
      const tr = el('tr', {});
      // 日期格：主行为下单日，下方小字为「这笔按哪天的净值成交」（需求：一眼看出每笔的定价日）
      const dateTd = el('td', {}, [el('div', { text: p.date || '—' })]);
      const nd = navDateInfo(p, f.code, navMeta);
      if (nd) dateTd.appendChild(el('div', { class: 'pv-sub', text: nd.text }));
      else if (pending) dateTd.appendChild(el('div', { class: 'pv-sub', text: '待确认' }));
      tr.appendChild(dateTd);
      tr.appendChild(el('td', { class: 'tnum', text: pending ? '—' : Number(p.shares).toLocaleString('zh-CN', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) }));
      const amtTd = el('td', { class: 'tnum' }, [el('span', { text: fmtMoney(p.amount) })]);
      if (pending) amtTd.appendChild(el('span', { class: 'badge badge-muted', style: 'margin-left:6px', text: '待确认' }));
      amtTd.appendChild(el('span', { class: 'badge badge-muted', style: 'margin-left:6px', text: p.sharesSource === 'broker' ? '券商真值' : '公式估算' }));
      if (p.feeWaived) amtTd.appendChild(el('span', { class: 'badge badge-muted', style: 'margin-left:6px', text: '积分抵扣' }));
      tr.appendChild(amtTd);
      tr.appendChild(el('td', { class: 'tnum', text: p.nav != null ? p.nav.toFixed(4) : '—' }));
      const opTd = el('td', {});
      const editBtn = el('button', { class: 'btn', text: '编辑', style: 'padding:2px 10px;font-size:12px;margin-left:4px' });
      editBtn.addEventListener('click', () => {
        tr.replaceWith(editForm(f.code, p)); // 桌面返回 <tr>（与子表同构、5 列对齐）
      });
      opTd.appendChild(editBtn);
      // 删除：二次确认防误删
      const delBtn = el('button', { class: 'btn', text: '删除', style: 'padding:2px 10px;font-size:12px;margin-left:4px' });
      delBtn.addEventListener('click', async () => {
        if (!confirm('确定删除这笔买入记录？删除后不可恢复。')) return;
        try {
          await api.deletePurchase({ code: f.code, action: 'delete', editKey: { date: p.date, amount: p.amount } });
          await refreshPage();
        } catch (e) { alert('删除失败：' + e.message); }
      });
      opTd.appendChild(delBtn);
      tr.appendChild(opTd);
      sb.appendChild(tr);
    });
  } else {
    sb.appendChild(el('tr', {}, [el('td', { colspan: '5', class: 'hint', style: 'padding:6px 4px', text: '还没买过，点「＋ 记一笔」录第一笔。' })]));
  }
  sub.appendChild(sb);
  wrap.appendChild(tableWrap(sub));
  return wrap;
}

/* ---------- 桌面：整页渲染 ---------- */
// 2026-09-12：调序——「持仓基金」在上、「添加基金」面板移到下方
export function renderDesktop(root, live, state) {
  const funds = (live.funds || []).slice().sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0));
  const buys = purchasesByCode(state);
  root.appendChild(addFundPanel());
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-head' }, [el('span', { text: '我的基金' }), el('span', { class: 'sub', text: `${funds.length} 只` })]));
  if (!funds.length) {
    panel.appendChild(el('div', { class: 'hint', text: '还没有基金。在上方表单添加第一只——填好代码后，名称、类别、跟踪指数都会自动带出来。' }));
    root.appendChild(panel);
    return;
  }
  const table = el('table', { class: 'tbl' });
  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: '基金' }), el('th', { text: '今日' }), el('th', { text: '持仓金额' }), el('th', { text: '累计收益' }), el('th', { text: '日限' }), el('th', { text: '' }),
  ])]));
  const tbody = el('tbody', {});
  funds.forEach(f => {
    const tr = el('tr', {});
    const nameCell = el('div', { class: 'name-cell' }, [
      el('span', { class: 'nm', text: f.name }),
      el('span', { class: 'meta', text: `${f.code} · ${catNameWithCaliber(state, f.category, f.caliber)}` }),
    ]);
    const feeTip = feeNote(f); // 申购费：后端抓取写入，界面只读（没有输入框）
    const statusTip = purchaseStatusNote(f);
    const autoInfo = el('div', { class: 'meta', style: 'margin-top:4px;padding:4px 6px;border-left:2px solid var(--accent);background:rgba(255,255,255,.035)' });
    autoInfo.appendChild(el('span', { text: '自动信息 · ' + [f.fundType, f.indexName ? ('跟踪 ' + f.indexName) : null, feeTip && feeTip.text, statusTip.text].filter(Boolean).join(' · '), title: [feeTip && feeTip.title, statusTip.title].filter(Boolean).join(' · ') }));
    nameCell.appendChild(autoInfo);
    nameCell.appendChild(fundSettings(state, f.code));
    tr.appendChild(el('td', {}, [nameCell]));
    const dayCell = el('td', { class: cls(f.dayChange) });
    dayCell.textContent = f.dayChange != null ? signPct(f.dayChange) : '—';
    if (f.latestNav != null) dayCell.appendChild(el('div', { class: 'meta', text: '净值 ' + f.latestNav + (f.latestDate ? ' · ' + f.latestDate.slice(5) : '') }));
    tr.appendChild(dayCell);
    const va = el('td', { class: 'tnum' }, [el('span', { text: fmtMoney(f.currentValue) })]);
    if (f.pendingAmount > 0) va.appendChild(el('div', { class: 'meta', text: '含在途 ' + fmtMoney(f.pendingAmount) }));
    tr.appendChild(va);
    const pc = el('td', { class: cls(f.profit) });
    pc.appendChild(el('div', { class: 'tnum', text: fmtMoney(f.profit) }));
    pc.appendChild(el('div', { class: 'meta ' + cls(f.profitPct), text: signPct(f.profitPct) }));
    tr.appendChild(pc);
    tr.appendChild(limitCell(state, f.code)); // 日限显示 + 编辑
    const btn = el('td', {}, [el('span', { class: 'expand-btn', text: '买入记录 ▾' })]);
    tr.appendChild(btn);
    tbody.appendChild(tr);

    const list = buys[f.code] || [];
    const open0 = getExpanded() === f.code;
    const detail = el('tr', { style: open0 ? '' : 'display:none' });
    const dtd = el('td', { colspan: '6', style: 'background:rgba(0,0,0,0.18)' });
    dtd.appendChild(buyTable(f, list, state && state.navMeta && state.navMeta[f.code]));
    detail.appendChild(dtd);
    tbody.appendChild(detail);

    btn.addEventListener('click', () => {
      const open = detail.style.display !== 'none';
      detail.style.display = open ? 'none' : '';
      btn.querySelector('.expand-btn').textContent = open ? '买入记录 ▾' : '收起 ▴';
      setExpanded(open ? null : f.code);
    });
  });
  table.appendChild(tbody);
  panel.appendChild(tableWrap(table, true));
  root.appendChild(panel);
}

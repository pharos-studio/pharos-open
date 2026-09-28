/* 批量添加：逐只复用 fund-lookup 与 POST /api/funds，买入仍逐笔提交。 */
import * as api from '../../api.js';
import * as store from '../../store.js';
import { el, tableWrap, todayStr } from '../../util.js';
import { CATS_FALLBACK } from './constants.js';
import { refreshPage } from './state.js';
import { readFunds } from './fundStore.js';

export async function parseBulkRows(text) {
  const out = [];
  for (const raw of String(text || '').split('\n').map(x => x.trim()).filter(Boolean)) {
    const m = raw.match(/^(\d{6})(?:[\s,，:：]+(.*))?$/);
    if (!m) { out.push({ raw, err: '格式须为「6位代码 [日期] [金额]」' }); continue; }
    const code = m[1];
    let date = null, amount = null, bad = null;
    for (const token of (m[2] || '').split(/[\s,，]+/).filter(Boolean)) {
      if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(token)) {
        const parts = token.split(/[-/]/).map(Number);
        const dt = new Date(parts[0], parts[1] - 1, parts[2]);
        if (dt.getFullYear() !== parts[0] || dt.getMonth() + 1 !== parts[1] || dt.getDate() !== parts[2]) bad = '日期无效';
        else date = parts[0] + '-' + String(parts[1]).padStart(2, '0') + '-' + String(parts[2]).padStart(2, '0');
      } else {
        const value = Number(token.replace(/[¥￥元]/g, ''));
        if (!Number.isFinite(value) || value <= 0) bad = '金额无效';
        else amount = value;
      }
      if (bad) break;
    }
    if (bad) { out.push({ raw, code, err: bad }); continue; }
    try {
      const lookup = await api.getFundLookup(code);
      if (!lookup.found || !lookup.autoProfile) throw new Error('没有找到基金档案');
      out.push({ code, date, amount, lookup, name: lookup.autoProfile.name,
        category: lookup.autoProfile.category, market: lookup.autoProfile.market,
        confirmedCategory: !!lookup.autoProfile.category, proxy: false,
        exists: readFunds(store.getState()).some(f => f.code === code) });
    } catch (e) { out.push({ raw, code, err: e.message }); }
  }
  return out;
}

export async function commitBulkRows(items) {
  const report = [];
  const defaultWaived = !!(store.getState().config && store.getState().config.purchaseDefaults && store.getState().config.purchaseDefaults.feeWaived);
  const created = new Set(readFunds(store.getState()).map(f => f.code));
  for (const r of items) {
    if (r.err) { report.push('✗ ' + (r.code || r.raw) + '：' + r.err); continue; }
    // 只保留「必须有分类」这一条闸门：推断不出的那只单独报错，其余照常写入。
    if (!r.category) { report.push('✗ ' + r.code + '：请选择基础类别'); continue; }
    if (!created.has(r.code)) {
      try {
        await api.createFund(r.code, r.lookup.profileRevision, {
          category: r.category,
          ...(r.lookup.confirmations.proxy ? { proxy: r.proxy } : {}),
        });
        report.push('✓ 新建 ' + r.code);
        created.add(r.code);
      } catch (e) { report.push('✗ 新建 ' + r.code + '：' + e.message); continue; }
    }
    if (r.amount > 0) {
      try {
        await api.addPurchase({ code: r.code, date: r.date || todayStr(), amount: r.amount,
          session: 'T', feeWaived: defaultWaived });
        report.push('✓ 买入 ' + r.code + ' ¥' + r.amount);
      } catch (e) { report.push('✗ 买入 ' + r.code + '：' + e.message); }
    }
  }
  await refreshPage();
  return report;
}

export function renderBulkPreview(container, items) {
  container.innerHTML = '';
  const tbl = el('table', { class: 'tbl' });
  tbl.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: '代码' }), el('th', { text: '名称' }), el('th', { text: '市场' }),
    el('th', { text: '基础分类' }), el('th', { text: '口径' }), el('th', { text: '盘中估算' }),
    el('th', { text: '金额' }), el('th', { text: '状态' }),
  ])]));
  const body = el('tbody');
  items.forEach(r => {
    const tr = el('tr', r.err ? { style: 'background:rgba(192,57,43,.14)' } : {});
    if (r.err) {
      tr.appendChild(el('td', { text: r.code || r.raw }));
      tr.appendChild(el('td', { colspan: 7, text: '✗ ' + r.err }));
      body.appendChild(tr); return;
    }
    const p = r.lookup.autoProfile;
    const cat = el('select', {}, [el('option', { value: '', text: '请选择' }),
      ...CATS_FALLBACK.map(x => el('option', { value: x.key, text: x.name }))]);
    cat.value = r.category || '';
    cat.disabled = false;
    const caliberCell = el('td', { text: p.caliber || '—' });
    cat.addEventListener('change', () => {
      r.category = cat.value; r.confirmedCategory = !!cat.value;
      // 口径随分类联动，否则预览表会显示与最终落库不符的旧口径。
      caliberCell.textContent = (cat.value === 'broad' ? (p.market === 'QDII' ? 'us' : 'cn') : null) || '—';
    });
    const estimateCell = el('td', { text: p.estimateIndex ? (p.estimateIndexName + ' · ' + p.estimateProvider) : '不估算' });
    if (r.lookup.confirmations.proxy) {
      const check = el('input', { type: 'checkbox' });
      check.addEventListener('change', () => { r.proxy = check.checked; });
      estimateCell.appendChild(el('label', { class: 'hint', style: 'display:block' }, [check, el('span', { text: ' 确认代理指数' })]));
    }
    const status = r.exists ? '已存在，仅补买入' : r.category ? '可添加' : '需选择分类';
    [r.code, r.name, r.market].forEach(x => tr.appendChild(el('td', { text: x })));
    tr.appendChild(el('td', {}, [cat]));
    tr.appendChild(caliberCell);
    tr.appendChild(estimateCell);
    tr.appendChild(el('td', { text: r.amount > 0 ? '¥' + r.amount : '—' }));
    tr.appendChild(el('td', { text: status }));
    body.appendChild(tr);
  });
  tbl.appendChild(body); container.appendChild(tableWrap(tbl));
}

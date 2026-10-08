/* 我的基金：代码查询、只读自动档案、受限确认和批量入口。 */
import * as api from '../../api.js';
import * as store from '../../store.js';
import { el, loadingHTML } from '../../util.js';
import { CATS_FALLBACK } from './constants.js';
import { ensureFundList } from './fundMeta.js';
import { readFunds, addFund } from './fundStore.js';
import { parseBulkRows, commitBulkRows, renderBulkPreview } from './bulkAdd.js';
import { renderDegraded, isDegraded } from '../../degraded-view.js';

export function labeled(label, input) {
  return el('div', { class: 'field' }, [el('label', { text: label }), input]);
}

export function addFundPanel() {
  const state = store.getState();
  const base = CATS_FALLBACK;
  const code = el('input', { class: 'input', placeholder: '6 位基金代码', autocomplete: 'off', inputmode: 'numeric' });
  const name = el('input', { class: 'input', readOnly: true, placeholder: '查询后自动带出' });
  const type = el('input', { class: 'input', readOnly: true, placeholder: '基金类型' });
  const market = el('input', { class: 'input', readOnly: true, placeholder: '市场' });
  const category = el('select', {}, [el('option', { value: '', text: '待识别' }), ...base.map(c => el('option', { value: c.key, text: c.name }))]);
  const caliber = el('input', { class: 'input', readOnly: true, placeholder: '口径' });
  const tracked = el('input', { class: 'input', readOnly: true, placeholder: '无' });
  const estimate = el('input', { class: 'input', readOnly: true, placeholder: '不估算' });
  const proxy = el('input', { type: 'checkbox' });
  const proxyRow = el('label', { style: 'display:none;gap:8px;align-items:center' }, [proxy,
    el('span', { text: '确认使用代理指数（代理并非基金真实跟踪指数）' })]);
  const msg = el('div', { class: 'hint', style: 'min-height:20px;white-space:pre-wrap' });
  const addBtn = el('button', { class: 'btn btn-primary', text: '添加基金' });
  addBtn.disabled = true;
  let lookup = null, seq = 0, timer = null;
  const hasFund = value => readFunds(store.getState()).some(f => f.code === value);
  // 未通过证据闸门的基金，在这里补一段「净值事实」（路线 3 降级视图）。
  // ★ 只画事实、不画判断；已核验的基金不重复给事实，避免一只基金两套口径。
  const degradedSlot = el('div');
  const showDegraded = async (value, ticket) => {
    degradedSlot.innerHTML = loadingHTML('正在获取净值事实…', true);
    try {
      const d = await api.getFundDegraded(value, 300);
      if (ticket !== seq) return;
      const node = isDegraded(d) ? renderDegraded(d) : null;
      degradedSlot.innerHTML = '';
      if (node) degradedSlot.appendChild(node);
    } catch (e) {
      if (ticket !== seq) return;
      degradedSlot.innerHTML = '';
      degradedSlot.appendChild(el('div', { class: 'hint', text: '净值事实获取失败：' + e.message }));
    }
  };
  const reset = () => {
    lookup = null; name.value = ''; type.value = ''; market.value = ''; category.value = '';
    caliber.value = ''; tracked.value = ''; estimate.value = ''; proxy.checked = false;
    proxyRow.style.display = 'none'; addBtn.disabled = true;
    degradedSlot.innerHTML = '';   // ★ 换代码时必须清掉上一只基金的降级视图
  };
  const show = d => {
    lookup = d;
    const p = d.autoProfile;
    name.value = p.name || ''; type.value = p.fundType || '未知'; market.value = p.market || '未知';
    category.value = p.category || '';
    category.disabled = false; // 恒可改：猜错时的第一条纠错路径
    caliber.value = p.caliber === 'us' ? '海外口径' : p.caliber === 'cn' ? 'A 股口径' : '不适用';
    tracked.value = [p.indexName, p.indexCode].filter(Boolean).join(' · ') || '无';
    estimate.value = p.estimateIndex
      ? [p.estimateIndexName, p.estimateIndex, p.estimateProvider, p.estimateRelation === 'proxy' ? '代理' : '跟踪指数直连'].filter(Boolean).join(' · ')
      : d.estimateStatus === 'temporarily_unavailable' ? '行情暂不可用，本次不估算' : '不估算';
    estimate.title = estimate.value;
    proxyRow.style.display = d.confirmations.proxy ? 'flex' : 'none';
    msg.textContent = !category.value ? '未识别到基础类别，请从下拉中选择。'
      : d.confirmations.proxy ? '代理指数需确认后启用；不勾选则保存为不估算。'
      : '已自动选好基础分类，可直接添加；猜错可在此下拉或持仓页「重新识别」中修改。盘中估算仅为近似值。';
    addBtn.disabled = hasFund(d.code);
  };
  const lookupCode = async value => {
    const ticket = ++seq;
    reset();
    if (!/^\d{6}$/.test(value)) return;
    if (hasFund(value)) { msg.textContent = '该基金已存在'; return; }
    msg.textContent = '正在识别基金档案及行情…';
    try {
      const d = await api.getFundLookup(value);
      if (ticket !== seq || code.value.trim() !== value) return;
      if (!d.found || !d.autoProfile) { msg.textContent = '没有找到该基金档案'; return; }
      show(d);
      showDegraded(value, ticket);   // 未核验 → 给净值事实；已核验 → 后端回 fund_verified，这里不画
    } catch (e) {
      if (ticket === seq) msg.textContent = '查询失败：' + e.message;
    }
  };
  code.addEventListener('input', () => {
    clearTimeout(timer); ++seq; reset();
    const value = code.value.trim();
    msg.textContent = value.length && value.length < 6 ? '输入完整 6 位代码后自动识别' : '';
    if (/^\d{6}$/.test(value)) timer = setTimeout(() => lookupCode(value), 150);
  });
  const suggestions = el('div', { class: 'hint' });
  code.addEventListener('focus', async () => {
    const rows = await ensureFundList().catch(() => null);
    if (rows && !code.value) suggestions.textContent = '基金名单已就绪，可输入代码查询';
  });
  // 改分类后口径要跟着变，否则只读的口径栏会与实际不符。
  category.addEventListener('change', () => {
    caliber.value = category.value === 'broad' ? (market.value === 'QDII' ? '海外口径' : 'A 股口径') : '不适用';
  });
  addBtn.addEventListener('click', async () => {
    if (!lookup || lookup.code !== code.value.trim()) return;
    if (!category.value) { msg.textContent = '请选择基础类别'; return; }
    addBtn.disabled = true;
    try {
      await addFund(lookup.code, lookup.profileRevision, {
        category: category.value,
        ...(lookup.confirmations.proxy ? { proxy: proxy.checked } : {}),
      });
    } catch (e) { msg.textContent = '添加失败：' + e.message; addBtn.disabled = false; }
  });

  const p = el('div', { class: 'panel' });
  p.appendChild(el('div', { class: 'panel-head' }, [el('span', { text: '快速添加基金' }), el('span', { class: 'sub', text: '输入代码，自动识别档案' })]));
  p.appendChild(el('div', { style: 'display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));margin-top:8px' }, [
    labeled('代码', code), labeled('名称（自动）', name), labeled('类型（自动）', type),
    labeled('市场（自动）', market), labeled('基础分类', category), labeled('口径（自动）', caliber),
    labeled('官方跟踪指数', tracked), labeled('盘中估算指数', estimate),
  ]));
  p.appendChild(proxyRow); p.appendChild(suggestions); p.appendChild(msg);
  p.appendChild(degradedSlot);   // 未核验基金的「净值事实（非建议）」挂在这里
  p.appendChild(el('div', { class: 'btn-row' }, [addBtn]));

  const bulkTa = el('textarea', { class: 'input', rows: '5', placeholder: '每行一条：6位代码 [日期] [金额]' });
  const bulkMsg = el('div', { class: 'hint', style: 'white-space:pre-line' });
  const bulkPreview = el('div');
  const parseBtn = el('button', { class: 'btn', text: '解析预览' });
  const commitBtn = el('button', { class: 'btn btn-primary', text: '确认写入' });
  commitBtn.style.display = 'none';
  let rows = [];
  parseBtn.addEventListener('click', async () => {
    bulkMsg.textContent = '解析中…'; bulkPreview.innerHTML = '';
    rows = await parseBulkRows(bulkTa.value);
    renderBulkPreview(bulkPreview, rows);
    commitBtn.style.display = rows.some(x => !x.err) ? '' : 'none';
    bulkMsg.textContent = rows.length ? '请确认每一行的自动档案与需要确认的选项。' : '没有可解析的行。';
  });
  commitBtn.addEventListener('click', async () => {
    commitBtn.disabled = true; bulkMsg.textContent = '写入中…';
    try { bulkMsg.textContent = (await commitBulkRows(rows)).join('\n'); }
    finally { commitBtn.disabled = false; }
  });
  p.appendChild(el('details', { style: 'margin-top:10px' }, [
    el('summary', { style: 'cursor:pointer;font-weight:600', text: '批量添加' }),
    bulkTa, el('div', { class: 'btn-row' }, [parseBtn, commitBtn]), bulkPreview, bulkMsg,
  ]));
  return p;
}

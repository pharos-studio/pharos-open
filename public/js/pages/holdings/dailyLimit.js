/* 持仓页 · 每日限购
   职责：每日限购的展示与就地编辑（桌面单元格 / 手机整行两套实现）。
   导出：limitCell / limitRow / fundSettings
   ★ 改一处务必两处同步，否则两端表现不一致。
*/

import * as api from '../../api.js';
import { el, limitLabel } from '../../util.js';
import { refreshPage } from './state.js';
import { CATS_FALLBACK } from './constants.js';

export function fundSettings(state, code, liveFund) {
  const funds = state.holdings && Array.isArray(state.holdings.funds) ? state.holdings.funds : [];
  const fund = funds.find(f => f && f.code === code);
  if (!fund) return el('div', {});
  const box = el('div', { class: 'meta', style: 'margin-top:4px;padding:6px;border-left:2px solid var(--accent);background:rgba(154,163,192,.06)' });
  const estimate = fund.estimateIndex
    ? (fund.estimateIndexName || fund.estimateLabel || fund.estimateIndex) + ' · ' + (fund.estimateRelation === 'proxy' ? '代理' : '跟踪指数直连') + ' · ' + (fund.estimateProvider || 'sina')
    : '不估算';
  box.appendChild(el('div', { text: '自动档案（只读） · ' + [fund.fundType || '类型未知', fund.market || '市场未知',
    CATS_FALLBACK.find(c => c.key === fund.category)?.name || '分类待确认',
    fund.caliber === 'us' ? '海外口径' : fund.caliber === 'cn' ? 'A 股口径' : null].filter(Boolean).join(' · ') }));
  box.appendChild(el('div', { text: '官方跟踪：' + (fund.indexName || '无') + ' · 盘中估算：' + estimate }));
  if (fund.estimateVerifiedAt) box.appendChild(el('div', { text: '估算指数验证：' + new Date(fund.estimateVerifiedAt).toLocaleString('zh-CN') }));
  if (fund.profileUpdatedAt) box.appendChild(el('div', { text: '自动档案更新：' + new Date(fund.profileUpdatedAt).toLocaleString('zh-CN') }));
  if (fund.estimateIndex) {
    const quoteState = liveFund && liveFund.estimateQuoteState;
    box.appendChild(el('div', { text: quoteState === 'fresh' ? '本次盘中行情有效，显示近似估算' :
      quoteState === 'stale' ? '本次行情已过期，暂不估算' :
      quoteState === 'unavailable' ? '本次行情不可用，暂不估算' : '当前非盘中估算时段' }));
  }
  if (fund.profileState === 'needs_review') box.appendChild(el('div', { text: '分类待确认：暂不提供可执行建议。', style: 'color:#b78b40' }));
  const button = el('button', { class: 'btn', text: '重新识别自动档案', style: 'margin-top:5px;padding:3px 8px' });
  const detail = el('div', { class: 'hint', style: 'white-space:pre-wrap' });
  button.addEventListener('click', async () => {
    button.disabled = true; detail.textContent = '正在查询最新档案…';
    try {
      const preview = await api.reidentifyFund(code, 'preview');
      detail.innerHTML = '';
      if (!preview.canApply) detail.appendChild(el('div', { text: preview.warning || '数据源暂不可用，请稍后重试', style: 'color:#b78b40' }));
      const diffs = preview.diff || [];
      detail.appendChild(el('div', { text: diffs.length ? '变更预览：' : '档案字段无变化。' }));
      const labels = { name: '名称', fundType: '基金类型', market: '市场', category: '基础分类', caliber: '口径',
        indexCode: '官方指数代码', indexName: '官方跟踪指数', trackIndex: '估值锚', estimateIndex: '盘中估算代码',
        estimateIndexName: '盘中估算名称', estimateLabel: '估算标签', estimateProvider: '行情来源',
        estimateRelation: '估算关系', estimateVerifiedAt: '行情验证时间', profileState: '档案状态' };
      const pretty = value => value == null ? '空' : typeof value === 'number' && value > 1e12
        ? new Date(value).toLocaleString('zh-CN') : String(value);
      diffs.forEach(d => detail.appendChild(el('div', { text: (labels[d.field] || d.field) + '：' + pretty(d.before) + ' → ' + pretty(d.after) })));
      const cat = el('select', {}, [el('option', { value: '', text: '确认基础分类' }), ...CATS_FALLBACK.map(c => el('option', { value: c.key, text: c.name }))]);
      cat.value = preview.autoProfile.category || '';
      if (preview.confirmations.category) detail.appendChild(el('label', {}, [el('span', { text: '分类确认：' }), cat]));
      const proxy = el('input', { type: 'checkbox' });
      if (preview.confirmations.proxy) detail.appendChild(el('label', {}, [proxy, el('span', { text: ' 确认使用代理指数' })]));
      const confirm = el('button', { class: 'btn btn-primary', text: '确认替换自动档案' });
      confirm.disabled = !preview.canApply;
      confirm.addEventListener('click', async () => {
        if (preview.confirmations.category && !cat.value) { alert('请确认基础类别'); return; }
        confirm.disabled = true;
        try {
          await api.reidentifyFund(code, 'confirm', preview.profileRevision, {
            ...(preview.confirmations.category ? { category: cat.value } : {}),
            ...(preview.confirmations.proxy ? { proxy: proxy.checked } : {}),
          });
          await refreshPage();
        } catch (e) { detail.appendChild(el('div', { text: '保存失败：' + e.message })); confirm.disabled = false; }
      });
      detail.appendChild(confirm);
    } catch (e) { detail.textContent = '识别失败：' + e.message; }
    button.disabled = false;
  });
  box.appendChild(button); box.appendChild(detail);
  return box;
}

/* ---------- 每日限购：显示 + 可编辑（数据来自 config.dailyLimits，不抓取） ---------- */
// 桌面表格单元格：上方显示标签（暂停/不限/¥X/日），下方数字输入框（0=暂停，留空=不限）
export function limitCell(state, code) {
  const lim = limitLabel(state.config, code);
  const td = el('td', {});
  const cur = state.config.dailyLimits && state.config.dailyLimits[code] != null ? state.config.dailyLimits[code] : '';
  const input = el('input', {
    class: 'input', type: 'number', min: '0', step: '1', style: 'width:80px',
    title: '每日限购（元/日，0=暂停申购，留空=不限）', value: cur,
  });
  input.addEventListener('change', async () => {
    const raw = input.value.trim();
    if (!state.config.dailyLimits) state.config.dailyLimits = {};
    if (raw === '') delete state.config.dailyLimits[code];
    else { const n = parseFloat(raw); state.config.dailyLimits[code] = (isFinite(n) && n >= 0) ? n : 0; }
    try { await api.save({ config: state.config }); await refreshPage(); }
    catch (e) { alert('日限保存失败：' + e.message); }
  });
  td.appendChild(el('div', { class: 'hint', text: lim.text, style: lim.cls ? 'color:var(--up)' : '' }));
  td.appendChild(input);
  return td;
}

// 手机卡片中的日限编辑行
export function limitRow(state, code) {
  const lim = limitLabel(state.config, code);
  const cur = state.config.dailyLimits && state.config.dailyLimits[code] != null ? state.config.dailyLimits[code] : '';
  const input = el('input', {
    class: 'input', type: 'number', min: '0', step: '1', style: 'width:80px',
    title: '每日限购（元/日，0=暂停申购，留空=不限）', value: cur,
  });
  input.addEventListener('change', async () => {
    const raw = input.value.trim();
    if (!state.config.dailyLimits) state.config.dailyLimits = {};
    if (raw === '') delete state.config.dailyLimits[code];
    else { const n = parseFloat(raw); state.config.dailyLimits[code] = (isFinite(n) && n >= 0) ? n : 0; }
    try { await api.save({ config: state.config }); await refreshPage(); }
    catch (e) { alert('日限保存失败：' + e.message); }
  });
  return el('div', { class: 'fc-limit', style: 'margin-top:6px;display:flex;align-items:center;gap:6px' }, [
    el('span', { class: 'hint', text: '日限：' + lim.text, style: lim.cls ? 'color:var(--up)' : '' }),
    input,
  ]);
}

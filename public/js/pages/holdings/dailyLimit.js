/* 持仓页 · 每日限购
   职责：每日限购的展示与就地编辑（桌面单元格 / 手机整行两套实现）。
   导出：limitCell / limitRow / fundSettings
   ★ 改一处务必两处同步，否则两端表现不一致。
*/

import * as api from '../../api.js';
import { el, limitLabel } from '../../util.js';
import { refreshPage } from './state.js';

export function fundSettings(state, code) {
  const funds = state.holdings && Array.isArray(state.holdings.funds) ? state.holdings.funds : [];
  const fund = funds.find(f => f && f.code === code);
  if (!fund) return el('div', {});
  const cats = state.categories && Array.isArray(state.categories.categories) ? state.categories.categories : [];
  const category = el('select', { style: 'max-width:150px' }, cats.map(c => el('option', { value: c.key, text: c.name })));
  category.value = fund.category;
  const caliber = el('select', { style: 'max-width:110px' }, [el('option', { value: 'cn', text: 'A股口径' }), el('option', { value: 'us', text: '海外口径' })]);
  caliber.value = fund.caliber === 'us' ? 'us' : 'cn';
  const sync = () => { caliber.style.display = category.value === 'broad' ? '' : 'none'; }; sync();
  const save = async () => {
    fund.category = category.value;
    if (fund.category === 'broad') fund.caliber = caliber.value; else delete fund.caliber;
    category.disabled = true; caliber.disabled = true;
    try { await api.save({ holdings: state.holdings }); await refreshPage(); }
    catch (e) { alert('基金设置保存失败：' + e.message); category.disabled = false; caliber.disabled = false; }
  };
  category.addEventListener('change', () => { sync(); save(); });
  caliber.addEventListener('change', save);
  return el('div', { class: 'meta', style: 'margin-top:4px;padding:4px 6px;border-left:2px solid rgba(154,163,192,.55);background:rgba(154,163,192,.06);display:flex;gap:6px;align-items:center;flex-wrap:wrap' }, [
    el('span', { text: '用户设置' }), category, caliber,
  ]);
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

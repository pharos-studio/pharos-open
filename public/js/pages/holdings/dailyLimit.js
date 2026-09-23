/* 持仓页 · 每日限购
   职责：每日限购的展示与就地编辑（桌面单元格 / 手机整行两套实现）。
   导出：limitCell / limitRow
   ★ 改一处务必两处同步，否则两端表现不一致。
*/

import * as api from '../../api.js';
import { el, limitLabel } from '../../util.js';
import { refreshPage } from './state.js';

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

/* 持仓页 · 批量添加
   职责：粘贴多行文本 → 解析 → 预览 → 批量写入。
   导出：parseBulkRows / commitBulkRows / renderBulkPreview
   ★ 不要放在这里：单只添加面板请去 addFundPanel.js。
*/

import * as api from '../../api.js';
import * as store from '../../store.js';
import { el, tableWrap, todayStr } from '../../util.js';
import { CATS_FALLBACK, EST_OPTIONS, INDEX_HINTS } from './constants.js';
import { refreshPage } from './state.js';
import { marketOfType, suggestCategory, ensureFundList } from './fundMeta.js';
import { readFunds } from './fundStore.js';

/* ---------- 批量添加（2026-09-12）：粘贴多行「代码 [日期] [金额]」→ 解析预览 → 确认写入 ---------- */
// 行格式：6位代码 + 可选日期(YYYY-MM-DD 或 YYYY/MM/DD) + 可选金额（¥/元/逗号均可容忍），日期与金额顺序无关。
// 日期缺省 = 今天；金额缺省 = 只建档案不记买入。过去日期同样可用（backfill 引擎按该记录推 T+1/T+2 拉净值）。
// 解析链与单只添加同源：本地名单 → /api/fund-lookup 兜底 → suggestCategory + INDEX_HINTS。
export async function parseBulkRows(text) {
  const rows = await ensureFundList();
  const out = [];
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(\d{6})(?:[\s,，:：]+(.*))?$/);
    if (!m) { out.push({ raw: line, err: '格式须为「6位代码 [日期] [金额]」' }); continue; }
    const code = m[1];
    let date = null, amount = null, badToken = null, badDate = null;
    if (m[2] != null && m[2] !== '') {
      for (const rawTok of m[2].split(/[\s,，]+/)) {
        const tok = rawTok.trim();
        if (!tok) continue;
        if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(tok)) {
          const seg = tok.split(/[-/]/).map(Number);
          const dt = new Date(seg[0], seg[1] - 1, seg[2]);
          if (dt.getFullYear() !== seg[0] || dt.getMonth() + 1 !== seg[1] || dt.getDate() !== seg[2]) { badDate = tok; break; }
          date = seg[0] + '-' + String(seg[1]).padStart(2, '0') + '-' + String(seg[2]).padStart(2, '0'); continue;
        }
        const a = Number(tok.replace(/[¥￥元]/g, ''));
        if (isFinite(a) && a > 0) { amount = a; continue; }
        badToken = tok; break;
      }
    }
    if (badDate) { out.push({ code, err: '日期无效：「' + badDate + '」（用 YYYY-MM-DD，月份 1-12）' }); continue; }
    if (badToken) { out.push({ code, err: '无法识别的字段：「' + badToken + '」（日期用 YYYY-MM-DD，金额只留数字）' }); continue; }
    if (amount != null && amount <= 0) { out.push({ code, err: '金额须 > 0' }); continue; }
    const local = rows && rows.find(r => r[0] === code);
    let name = local ? local[1] : '', type = local ? local[2] : '';
    if (!local) {
      try { const d = await api.getFundLookup(code); if (d && d.ok && d.found && d.name) { name = d.name; type = d.type || ''; } } catch (e) {}
    }
    if (!name) { out.push({ code, err: '未找到该基金（检查代码）' }); continue; }
    const hint = INDEX_HINTS.find(h => h.re.test(name));
    out.push({
      code, name, market: marketOfType(type), category: suggestCategory(name), date, amount,
      trackIndex: (hint && hint.trackIndex) || null,
      est: (hint && hint.est) || null,
      exists: readFunds(store.getState()).some(f => f.code === code),
    });
  }
  return out;
}

// 确认写入：新建基金走一次 /api/save 整份回写（幂等）；带金额的行循环 /api/purchase（逐条独立，
// 单条失败在汇总里报告不回滚——本地工具，失败可修正后重试）。返回结果汇报行数组。
export async function commitBulkRows(items) {
  const state = store.getState();
  const report = [];
  const toAdd = items.filter(r => !r.err && !r.exists);
  if (toAdd.length) {
    const built = toAdd.map(r => Object.assign({
      code: r.code, name: r.name, category: r.category, market: r.market,
      caliber: (r.category === 'broad') ? (r.bulkCal || (r.market === 'QDII' ? 'us' : 'cn')) : undefined,
      feeRate: 0,
      estimateIndex: r.est || null,
      estimateLabel: r.est ? ((EST_OPTIONS.find(o => o.value === r.est) || {}).label || null) : null,
      purchases: [],
    }, r.trackIndex ? { trackIndex: r.trackIndex } : {}));
    state.holdings = Object.assign({}, state.holdings, { funds: readFunds(state).concat(built) });
    try {
      await api.save({ holdings: state.holdings, config: state.config });
      report.push('✓ 新建基金 ' + built.length + ' 只：' + built.map(f => f.code).join('、'));
    } catch (e) { return ['✗ 保存失败：' + e.message + '（未写入任何买入记录，修正 API Key 后可重试）']; }
  } else {
    report.push('（无新建基金，仅处理买入记录）');
  }
  const buyRows = items.filter(x => !x.err && x.amount > 0);
  for (const r of buyRows) {
    const d = r.date || todayStr();
    // 批量录入的时段假定：默认「15:00 前」= 下单当天净值（多数人盘中下单）。
    // 注意：批量路径与单笔路径口径一致（都是 session:'T'）；批量行如需「后」请录入后逐笔编辑。
    try { await api.addPurchase({ code: r.code, date: d, amount: r.amount, session: 'T' }); report.push('✓ 买入 ' + r.code + ' ' + d + ' ¥' + r.amount + '（默认 15:00 前，份额待净值出来后自动回填）'); }
    catch (e) { report.push('✗ 买入 ' + r.code + '：' + e.message); }
  }
  if (!buyRows.length) report.push('（无买入记录需要写入）');
  await refreshPage();
  return report;
}

// 批量预览表格：错误行标红不阻塞；类别下拉可改（broad 行带口径下拉）；「已存在」行只补买入
export function renderBulkPreview(container, items) {
  container.innerHTML = '';
  const tbl = el('table', { class: 'tbl' });
  tbl.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: '代码' }), el('th', { text: '名称' }), el('th', { text: '市场' }),
    el('th', { text: '类别' }), el('th', { text: '口径' }), el('th', { text: '买入日期' }), el('th', { text: '买入金额' }), el('th', { text: '状态' }),
  ])]));
  const tb = el('tbody', {});
  items.forEach(r => {
    const tr = el('tr', r.err ? { style: 'background:rgba(192,57,43,.14)' } : {});
    if (r.err) {
      tr.appendChild(el('td', { text: r.code || r.raw || '—' }));
      tr.appendChild(el('td', { colspan: '6', text: '✗ ' + r.err }));
      tr.appendChild(el('td', { text: '错误' }));
      tb.appendChild(tr);
      return;
    }
    const catSel = el('select', {}, CATS_FALLBACK.map(k => el('option', { value: k.key, text: k.name })));
    catSel.value = r.category;
    const calSel = el('select', {}, [el('option', { value: 'cn', text: 'cn' }), el('option', { value: 'us', text: 'us' })]);
    r.bulkCal = (r.category === 'broad' && r.market === 'QDII') ? 'us' : 'cn';
    calSel.value = r.bulkCal;
    const syncCal = () => {
      if (r.category === 'broad') { calSel.style.display = ''; r.bulkCal = calSel.value; }
      else calSel.style.display = 'none';
    };
    catSel.addEventListener('change', () => { r.category = catSel.value; syncCal(); });
    calSel.addEventListener('change', () => { r.bulkCal = calSel.value; });
    syncCal();
    tr.appendChild(el('td', { text: r.code }));
    tr.appendChild(el('td', { text: r.name }));
    tr.appendChild(el('td', { text: r.market }));
    tr.appendChild(el('td', {}, [catSel]));
    tr.appendChild(el('td', {}, [calSel]));
    tr.appendChild(el('td', { text: r.date || (todayStr() + '（默认）') }));
    tr.appendChild(el('td', { text: r.amount > 0 ? '¥' + r.amount : '—' }));
    tr.appendChild(el('td', { text: r.exists ? '已存在（只补买入）' : (r.amount > 0 ? '新建+买入' : '新建') }));
    tb.appendChild(tr);
  });
  tbl.appendChild(tb);
  container.appendChild(tableWrap(tbl));
}

/* 持仓页 · 添加基金面板
   职责：单只添加（代码联想、自动带出名称与市场与分类与口径）+ 批量入口。
   导出：labeled / addFundPanel
   ★ 内部闭包共享消息区与联想列表，改动前请通读全文件。
*/

import * as api from '../../api.js';
import * as store from '../../store.js';
import { el } from '../../util.js';
import { CATS_FALLBACK, CAT_HINTS, EST_OPTIONS, INDEX_HINTS } from './constants.js';
import { marketOfType, suggestCategory, ensureFundList } from './fundMeta.js';
import { readFunds, addFund } from './fundStore.js';
import { parseBulkRows, commitBulkRows, renderBulkPreview } from './bulkAdd.js';

let _lastAutoName = '';
export function labeled(label, input) {
  return el('div', { class: 'field' }, [el('label', { text: label }), input]);
}

// 添加基金面板：代码(联想+自动带出)/名称/类别(四引擎)/市场/盘中估算 + 防错（2026-09-08 L1+L2+L3）
// 桌面/手机两处 render 共用本函数；单一 150ms 防抖按输入长度分流：1~5 联想 / 6 查询带出
export function addFundPanel() {
  const state = store.getState();
  // 类别下拉的选项源 = categories.json 的 **categories（展示线）**，不是 engines。
  // ★ 两者含义不同：engines 是「可绑定的算法」（只有 4 条），categories 是「能挂到哪个类别」
  //   （含债券/现金这两个待建设类别）。用 engines 当选项源会让用户**选不到**债券/现金。
  const engines = ((state.categories && state.categories.categories && state.categories.categories.length)
    ? state.categories.categories
    : ((state.categories && state.categories.engines && state.categories.engines.length)
      ? state.categories.engines : CATS_FALLBACK));
  const code = el('input', { class: 'input', placeholder: '基金代码（6 位数字）', autocomplete: 'off', spellcheck: 'false' });
  const name = el('input', { class: 'input', placeholder: '基金名称（自动带出，可改）' });
  const cat = el('select', {}, [
    el('option', { value: '', text: '请选择类别' }),
    ...engines.map(c => el('option', { value: c.key, text: c.name })),
  ]);
  // 适用提示：明确告诉用户「这类基金该不该挂这条线」，避免把医药基金放进宽基、把债基放进主题线
  const catHint = el('div', { class: 'hint', style: 'margin-top:4px', text: '' });
  const market = el('select', {}, [
    el('option', { value: 'A', text: 'A股' }),
    el('option', { value: 'QDII', text: 'QDII' }),
  ]);
  // 口径（caliber）：仅「宽基」需要 —— 决定用哪把尺子量便宜（cn=A股 PE分位×中债ERP / us=滚动分位∨PE回撤×美债ERP）
  const calibers = (state.categories && state.categories.calibers && state.categories.calibers.length)
    ? state.categories.calibers : [{ key: 'cn', name: 'A股口径' }, { key: 'us', name: '海外口径' }];
  const cal = el('select', {}, calibers.map(c => el('option', { value: c.key, text: c.name })));
  cal.value = 'cn';
  const calField = labeled('口径（仅宽基）', cal);
  calField.style.display = 'none';           // 默认隐藏，类别选到「宽基」才出现
  const syncCaliberVisibility = () => {
    const isBroad = cat.value === 'broad';
    calField.style.display = isBroad ? '' : 'none';
    if (isBroad && market.value === 'QDII' && cal.value === 'cn') cal.value = 'us'; // QDII 默认海外口径（可改）
  };
  // 类别适用提示：选到哪条线，就把「这条线适用什么基金」直接显示出来。
  // 这是「用户加自己的基金」最容易出错的一步 —— 选错类别会套错算法且不会报错。
  const syncCatHint = () => {
    // 自建分类（custom:xxx）本身没有提示，要折算到它绑定的内置算法去看适用说明
    const st0 = store.getState();
    const cust = (st0.categories && Array.isArray(st0.categories.customCategories)) ? st0.categories.customCategories : [];
    const hit = cust.find(x => x && x.key === cat.value);
    const baseKey = hit ? hit.category : cat.value;
    const t = CAT_HINTS[baseKey] || '';
    catHint.textContent = (hit ? '自建分类（绑定算法：' + baseKey + '）—— ' : '') + t;
    catHint.style.color = /待建设/.test(t) ? '#8a6d3b' : '';
  };
  cat.addEventListener('change', () => { syncCaliberVisibility(); syncCatHint(); });
  syncCatHint();
  const est = el('select', {}, [
    el('option', { value: '', text: '不估算' }),
    ...EST_OPTIONS.map(o => el('option', { value: o.value, text: o.label })),
  ]);
  const estHint = el('div', { class: 'hint', style: 'margin-top:4px', text: 'A股·T+1·盘中按所选指数近似估算' });
  // 市场联动：QDII → 估算禁用并重置；A股 → 恢复可选
  market.addEventListener('change', () => {
    if (market.value === 'QDII') {
      est.value = '';
      est.disabled = true;
      estHint.textContent = 'QDII·T+2·无盘中估算（净值为准）';
    } else {
      est.disabled = false;
      estHint.textContent = 'A股·T+1·盘中按所选指数近似估算';
    }
    syncCaliberVisibility();   // 市场变化时同步口径默认值（QDII + 宽基 → us）
  });
  const msg = el('div', { class: 'hint', style: 'margin-top:6px;min-height:18px;white-space:normal;line-height:1.45' });
  const addBtn = el('button', { class: 'btn btn-primary', text: '添加基金' });

  /* —— 联想下拉：代码框外层 relative 定位，候选行 mousedown 选中（先于 blur，防点击丢失）—— */
  const codeWrap = el('div', { style: 'position:relative' }, [code]);
  const listEl = el('div', { style: 'display:none;position:absolute;top:100%;left:0;right:0;z-index:30;background:#fff;border:1px solid #ccc;border-top:none;max-height:230px;overflow:auto;box-shadow:0 4px 10px rgba(0,0,0,.15)' });
  codeWrap.appendChild(listEl);
  let _items = [], _activeIdx = -1;

  function showMsg(text, color) { msg.textContent = text; msg.style.color = color || '#888'; }
  function isDuplicate(v) { return readFunds(store.getState()).some(f => f.code === v); }
  function closeList() { listEl.style.display = 'none'; listEl.innerHTML = ''; _items = []; _activeIdx = -1; }
  function renderList(items, activeIdx) {
    _items = items; _activeIdx = activeIdx;
    listEl.innerHTML = '';
    if (!items.length) { listEl.style.display = 'none'; return; }
    items.forEach((it, i) => {
      const mk = marketOfType(it[2]);
      const row = el('div', { style: 'padding:6px 10px;cursor:pointer;display:flex;gap:8px;align-items:center;border-bottom:1px solid #f0f0f0;' + (i === activeIdx ? 'background:#eef3fb;' : '') });
      row.append(
        el('span', { style: 'font-weight:600;min-width:72px', text: it[0] }),
        el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: it[1] }),
        el('span', { style: 'font-size:12px;color:#666;white-space:nowrap', text: it[2] || '' }),
        el('span', { style: 'font-size:11px;padding:1px 6px;border-radius:3px;white-space:nowrap;' + (mk === 'QDII' ? 'background:#fdeaea;color:#c0392b;' : 'background:#e8f5e9;color:#1e7e34;'), text: mk })
      );
      row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(it); });
      row.addEventListener('mouseenter', () => renderList(_items, i));
      listEl.appendChild(row);
    });
    listEl.style.display = 'block';
  }
  function pick(it) { closeList(); code.value = it[0]; fillMeta(it[0], it[1], it[2], 'list'); updateGuard(it[0]); }

  // 防错闸：重复 → 红字 + 禁用按钮；空输入清消息
  function updateGuard(v) {
    if (isDuplicate(v)) { showMsg('⚠ 该基金已在持仓，不能重复添加', '#c0392b'); addBtn.disabled = true; return; }
    addBtn.disabled = false;
    if (!v) showMsg('');
  }

  // L1 自动带出：名称(覆盖保护)/市场(触发估算联动)/类别 + 跟踪指数
  let autoTrack = null;      // 当前解析出的 trackIndex（后端档案精确给出，或 INDEX_HINTS 兜底），提交时随 addFund 落库
  let needsHeuristicConfirm = false;
  let autoAnchorNote = '';   // 估值锚提示：跟踪了指数但我们没有估值源 → 判定会降级
  function fillMeta(c, n, t, source, meta) {
    needsHeuristicConfirm = !!(meta && meta.suggestedBy === 'name');
    if (name.value === '' || name.value === _lastAutoName) { name.value = n || ''; _lastAutoName = n || ''; }
    const mk = marketOfType(t);
    if (market.value !== mk) { market.value = mk; market.dispatchEvent(new Event('change')); }
    autoAnchorNote = '';
    // 类别：后端的建议是**确定值**（来自东财 FTYPE；红利类还会被跟踪指数身份覆盖），优先用它。
    // ★ 拿不到确定建议时**不预选、不猜** —— 旧实现一律兜成「主题·行业」，会把债基/消费基金
    //   套上"60日回撤抄底"算法算出一个看起来正常的错结论（不报错，最危险）。
    if (!cat.value) {
      const sug = (meta && meta.suggestedCategory) || suggestCategory(n || '');
      if (sug) {
        cat.value = sug;
        if (meta && meta.suggestedPending) showMsg('已识别为「' + sug + '」类 —— 该类别算法待建设，先只记市值、不出买卖信号', '#8a6d3b');
        else showMsg('已自动选好类别（可改）' + (meta && meta.suggestedBy === 'index' ? '：按跟踪指数判定' : ''), '#888');
      } else {
        showMsg('未能自动识别类别，请手动选择 —— 选错会套错算法，而且不会报错', '#c0392b');
      }
    }
    // 跟踪指数：后端档案 INDEXCODE 精确映射优先，INDEX_HINTS 仅作最后兜底
    autoTrack = (meta && meta.trackIndex) || null;
    const hint = INDEX_HINTS.find(h => h.re.test(n || ''));
    if (!autoTrack && hint) autoTrack = hint.trackIndex || null;
    if (hint && hint.est && !est.value && market.value === 'A') est.value = hint.est;
    if (meta && meta.indexName && !meta.trackIndex) {
      autoTrack = null;
      autoAnchorNote = '该基金跟踪「' + meta.indexName + '」，但我们没有它的指数估值源 → 判定会降级为价格分位（不会给加仓信号）';
      showMsg(autoAnchorNote, '#8a6d3b');
    } else if (autoTrack) {
      showMsg('已自动带入跟踪指数：' + autoTrack + '（估值锚可用）', '#888');
    }
    syncCaliberVisibility();   // 类别/预选变化后同步「口径」栏的显隐与默认值
    syncCatHint();
  }

  // 6 位精确查询：本地名单优先，miss → /api/fund-lookup（B 兜底）
  async function lookupExact(v) {
    const rows = await ensureFundList();
    if (code.value !== v) return;
    const local = rows && rows.find(r => r[0] === v);
    if (local) {
      // 本地名单只有 [code,name,type]，**没有**跟踪指数与确定类别 —— 那些要问后端档案。
      // 非阻塞补齐：失败不影响继续添加，用户仍可手选。
      fillMeta(v, local[1], local[2], 'list', null);
      api.getFundLookup(v).then(d => {
        if (code.value !== v || !d || !d.ok || !d.found) return;
        fillMeta(v, d.name || local[1], d.type || local[2], 'archive', d);
      }).catch(() => { /* 档案不可用时静默，不影响添加 */ });
      updateGuard(v); return;
    }
    let d = null;
    try { d = await api.getFundLookup(v); } catch (e) { d = null; }
    if (code.value !== v) return; // 过期响应丢弃
    if (d && d.ok && d.found && d.name) { fillMeta(v, d.name, d.type || '', (d.source || 'suggest'), d); }
    else { showMsg('未匹配到该代码，可手动填写', '#c0392b'); }
    updateGuard(v);
  }

  // 单一防抖输入流（审查修订 P0：联想与带出不再双定时器竞态）
  let timer = null;
  code.addEventListener('input', () => {
    clearTimeout(timer);
    const v = code.value.trim();
    closeList();
    updateGuard(v);
    if (v === '' || !/^\d+$/.test(v)) return;
    if (v.length < 6) {
      if (!addBtn.disabled) showMsg(''); // 清掉上一条成功提示，避免残留
      timer = setTimeout(async () => {
        if (code.value.trim() !== v) return;
        const rows = await ensureFundList();
        if (!rows || code.value.trim() !== v) return;
        const st = rows.filter(r => r[0].startsWith(v));
        const rest = st.length < 8 ? rows.filter(r => r[0].indexOf(v) !== 0 && (r[1] || '').includes(v)) : [];
        renderList(st.concat(rest).slice(0, 8), 0);
      }, 150);
    } else if (v.length === 6 && !isDuplicate(v)) {
      timer = setTimeout(() => { if (code.value.trim() === v) lookupExact(v); }, 150);
    }
  });
  code.addEventListener('keydown', (e) => {
    if (!_items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); renderList(_items, (_activeIdx + 1) % _items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); renderList(_items, (_activeIdx - 1 + _items.length) % _items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); if (_items[_activeIdx]) pick(_items[_activeIdx]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeList(); }
  });
  code.addEventListener('blur', () => setTimeout(closeList, 150)); // 兜底：mousedown 已先行选中

  const addBtnHandler = () => {
    if (!code.value.trim() || !name.value.trim()) { alert('请填写代码和名称'); return; }
    if (!cat.value) { alert('请选择类别'); return; } // 杜绝 core/空串落库
    if (isDuplicate(code.value.trim())) { alert('该基金已存在'); return; }
    if (needsHeuristicConfirm && !confirm('分类仅根据基金名称启发式推断，请确认当前分类与口径无误。继续添加？')) return;
    const opt = EST_OPTIONS.find(o => o.value === est.value) || null;
    addFund(code.value.trim(), name.value.trim(), cat.value, market.value, opt ? opt.value : null, opt ? opt.label : null,
      cat.value === 'broad' ? cal.value : null, autoTrack);
  };
  addBtn.addEventListener('click', addBtnHandler);

  const p = el('div', { class: 'panel' });
  p.appendChild(el('div', { class: 'panel-head' }, [el('span', { text: '快速添加基金' }), el('span', { class: 'sub', text: '先填代码，档案自动带出' })]));
  p.appendChild(el('div', { style: 'margin-top:8px;display:grid;gap:10px;grid-template-columns:1fr 1fr' }, [
    labeled('代码', codeWrap), labeled('名称', name),
    el('div', { class: 'field' }, [el('label', { text: '类别' }), cat, catHint]),
    labeled('市场', market), calField,
  ]));
  p.appendChild(msg);
  p.appendChild(labeled('盘中估算指数', est));
  p.appendChild(estHint);
  p.appendChild(el('div', { class: 'btn-row' }, [addBtn]));

  // —— 批量添加（2026-09-12）：粘贴多行「代码 [金额]」→ 解析预览 → 确认写入 ——
  const bulkTa = el('textarea', { class: 'input', rows: '5', placeholder: '每行一条：6位代码 [日期] [金额]（日期与金额可各自省略、顺序不限）\n例：\n016452 2026-09-01 1000\n270042\n161725 500元\n202015 1000（无日期=今天）' });
  const bulkMsg = el('div', { class: 'hint', style: 'margin-top:6px;white-space:pre-line;line-height:1.5' });
  const bulkPreview = el('div', {});
  const bulkParseBtn = el('button', { class: 'btn', text: '解析预览' });
  const bulkCommitBtn = el('button', { class: 'btn btn-primary', text: '确认写入', style: 'margin-left:6px' });
  bulkCommitBtn.style.display = 'none';
  let _bulkRows = [];
  bulkParseBtn.addEventListener('click', async () => {
    bulkMsg.textContent = '解析中…';
    bulkPreview.innerHTML = '';
    bulkCommitBtn.style.display = 'none';
    const items = await parseBulkRows(bulkTa.value);
    if (!items.length) { bulkMsg.textContent = '没有可解析的行。'; return; }
    _bulkRows = items;
    renderBulkPreview(bulkPreview, items);
    const errs = items.filter(x => x.err).length;
    bulkCommitBtn.style.display = '';
    bulkCommitBtn.disabled = errs === items.length; // 全错时禁写
    bulkMsg.textContent = errs
      ? ('⚠ ' + errs + ' 行有错（标红），修正后重新解析，或直接写入其余正确行。')
      : '解析完成，确认无误后点「确认写入」。';
  });
  bulkCommitBtn.addEventListener('click', async () => {
    bulkCommitBtn.disabled = true;
    bulkMsg.textContent = '写入中…';
    const report = await commitBulkRows(_bulkRows);
    bulkTa.value = '';
    bulkPreview.innerHTML = '';
    bulkCommitBtn.style.display = 'none';
    bulkMsg.textContent = report.join('\n');
  });
  p.appendChild(el('details', { style: 'margin-top:10px' }, [
    el('summary', { style: 'cursor:pointer;font-weight:600', text: '批量添加（粘贴多行「代码 金额」）' }),
    el('div', { style: 'margin-top:8px' }, [
      bulkTa,
      el('div', { class: 'btn-row', style: 'margin-top:6px' }, [bulkParseBtn, bulkCommitBtn]),
      bulkPreview,
      bulkMsg,
    ]),
  ]));
  return p;
}

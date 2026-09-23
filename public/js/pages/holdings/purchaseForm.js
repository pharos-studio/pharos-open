/* 持仓页 · 记一笔与编辑
   职责：新增买入表单、编辑既有买入记录（含改期后份额与净值的更新判定）。
   导出：addForm / editForm
   ★ 不要放在这里：列表渲染请去 desktop.js / mobile.js。
*/

import * as api from '../../api.js';
import { el, todayStr } from '../../util.js';
import { refreshPage } from './state.js';
import { sessionToggle, buyRowShell } from './formShell.js';
import { createPreview, pvFmtOne } from './preview.js';

/* ---------- 通用：记一笔表单（桌面/手机共用） ---------- */
export function addForm(code) {
  // pvSchedule 占位：sessionToggle 的 onChange 需要在 pv 建好之前就能引用（TDZ 规避）
  let pvSchedule = () => {};
  const sessT = sessionToggle('T', { onChange: () => pvSchedule(0) }); // 默认「15:00前」
  const dateI = el('input', { class: 'input', type: 'date', value: todayStr(), style: 'width:auto' });
  const amtI = el('input', { class: 'input', type: 'number', min: '0.01', step: '0.01', placeholder: '金额 ¥ 必填', style: 'width:110px' });
  // —— 净值/份额：完全由系统按「成交日净值」算出，不提供人工入口（真实值回填走券商核对后的数据修正） ——
  // 反馈文案：挂在「操作」列按钮下方（右对齐），与按钮同列
  const msg = el('div', { class: 'hint', style: 'margin-top:2px;text-align:right;max-width:170px;line-height:1.35' });
  // —— 实时预览节点：改日期/时段/金额后自动刷新，不必先保存才知道差别 ——
  const navMain = el('span', { class: 'pv-new tnum', text: '—' });
  const navSub = el('div', { class: 'hint pv-sub', text: '成交日自动取' });
  const shMain = el('span', { class: 'pv-new tnum', text: '—' });
  const shSub = el('div', { class: 'hint pv-sub', text: '按成交日净值自动算' });
  const bothT = el('div', { class: 'pv-both' });
  const bothP = el('div', { class: 'pv-both' });
  const btn = el('button', { class: 'btn btn-primary', text: '保存这笔', style: 'padding:3px 10px;font-size:12px' });
  btn.addEventListener('click', async () => {
    const amount = Number(amtI.value);
    if (!amtI.value.trim() || !isFinite(amount) || amount <= 0) { msg.textContent = '金额必填且 > 0'; return; }
    if (!dateI.value.trim()) { msg.textContent = '日期必填'; return; }
    const payload = { code, date: dateI.value, amount, session: sessT.getSession() };
    // 预览已算出的净值直接带上（navAuto 标志让服务端用权威 feeRate 自己重算份额）。
    // pending/error 时**什么都不带** → 落成「在途」，由 backfill 在净值公布后自动补份额。
    let autoFilled = false;
    const pvres = pv.get();
    const v = pvres && pvres.variants ? pvres.variants[sessT.getSession() || 'T'] : null;
    if (v && v.status === 'ok' && v.nav != null) {
      payload.nav = v.nav; payload.pricingDate = v.pricingDate; payload.navAuto = true;
      autoFilled = true;
    }
    btn.disabled = true;
    msg.textContent = '保存中…';
    try {
      await api.addPurchase(payload);
      pv.dispose();
      msg.textContent = '✓ 已记录' + (autoFilled ? '' : '（在途，成交日净值出来后自动补份额）');
      setTimeout(refreshPage, 500);
    } catch (e) {
      msg.textContent = '✗ ' + e.message;
      btn.disabled = false;
    }
  });
  const cancelBtn = el('button', { class: 'btn', text: '取消', style: 'padding:3px 10px;font-size:12px' });
  cancelBtn.addEventListener('click', () => { pv.dispose(); refreshPage(); });
  // 5 列对齐容器：日期(+时段+前/后对比) / 份额(实时) / 金额 / 净值(实时) / 操作
  const dateCell = el('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [dateI, sessT, bothT, bothP]);
  const sharesCell = el('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [shMain, shSub]);
  const amountCell = amtI;
  const navCell = el('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [navMain, navSub]);
  // 操作列：与表头「操作」及普通数据行的 编辑/删除 同口径——贴右对齐（此前 flex 默认靠左，视觉上"跑偏"）
  const opsCell = el('div', { style: 'display:flex;flex-direction:column;align-items:flex-end;gap:4px' }, [
    el('div', { style: 'display:flex;gap:4px;align-items:center;flex-wrap:wrap;justify-content:flex-end' }, [btn, cancelBtn]),
    msg,
  ]);

  const pv = createPreview({
    code,
    getDate: () => dateI.value,
    getSession: () => sessT.getSession(),
    getAmount: () => amtI.value,
    paint: (r, err) => {
      const sel = sessT.getSession() || 'T';
      if (r === 'loading') { navMain.textContent = '…'; shMain.textContent = '…'; return; }
      if (!r || !r.variants) {
        navMain.textContent = '—'; shMain.textContent = '—';
        navSub.textContent = err ? ('净值查询失败：' + err.message) : '成交日自动取';
        bothT.textContent = ''; bothP.textContent = '';
        return;
      }
      const v = r.variants[sel];
      const pd = v.pricingDate;
      navMain.textContent = v.nav != null ? v.nav.toFixed(4) : '—';
      shMain.textContent = v.shares != null ? v.shares.toFixed(4) : (v.status === 'pending' ? '待确认' : '—');
      // 顺延时把「名义日 → 真实成交日」说出来：否则用户只会看到一个陌生日期，以为系统算错了。
      // 再补上「份额哪天确认到账」—— 这正是「当天买按当天净值成交、份额隔天才登记到账」的业务节奏。
      navSub.textContent = v.status === 'ok'
        ? ('成交净值 ' + pd.slice(5) + (v.shifted ? '（' + v.nominalDate.slice(5) + ' 非交易日，顺延 ' + v.rollDays + ' 天）' : '')
           + (v.settleDate ? ' · 份额 ' + v.settleDate.slice(5) + (v.settleEstimated ? ' 预计到账' : ' 确认') : ''))
        : v.message;
      // 前/后两档同时列出 —— 用户不必来回点按钮才知道有没有区别
      if (r.converged) {
        // 两档收敛 ⇒ 下单日不是交易日（那天根本没有 15:00 这个分界），前后必然同结果。
        // 开关**保留**（不隐藏不置灰），只把两行合并成一句主动说明 —— 把「看不出区别」讲清楚。
        bothT.textContent = '非交易日下单，15:00 前后无差别：' + r.variants.T.pricingDate.slice(5) + ' 的净值';
        bothT.className = 'pv-both on';
        bothP.textContent = '';
        bothP.className = 'pv-both';
      } else {
        bothT.textContent = '前 ' + pvFmtOne(r.variants.T);
        bothP.textContent = '后 ' + pvFmtOne(r.variants['T+1']);
        bothT.className = 'pv-both ' + (sel === 'T' ? 'on' : 'off');
        bothP.className = 'pv-both ' + (sel === 'T+1' ? 'on' : 'off');
      }
    },
  });
  pvSchedule = (d) => pv.schedule(d);
  dateI.addEventListener('change', () => pv.schedule(0));   // 日期是离散选择 → 立刻算，不用等防抖
  amtI.addEventListener('input', () => pv.schedule(450));   // 键盘连续输入 → 防抖，避免一个字一次请求
  pv.schedule(0); // 打开表单即给一版预览

  return buyRowShell({ date: dateCell, shares: sharesCell, amount: amountCell, nav: navCell, ops: opsCell });
}

/* ---------- 通用：编辑表单（预填原值，提交带 editKey 覆盖已存在记录） ---------- */
// 2026-09-16 重写要点：
//   ① 老记录（无 session）时段第三态显「未知」→ 直接保存不会静默把成交日提前一天；
//   ② 净值/份额从「一发即死的静态文本」改为「原 / 新」两行实时对比（2026-09-18 由 inline 箭头改为方案 B）。
// 2026-09-18 重写要点：
//   ① ★ 重算不再依赖勾选框 —— 定价日只由「日期 + 时段」决定，二者任一变更即自动重算（pricingKeyChanged）；
//   ② ★ 删除「手动校正净值/份额」入口（避免误覆盖券商真实值）与「在途补填」；真实值修正走数据层；
//   ③ ★ 净值/份额两列统一为「原 / 新」两行带标签（CSS .pv-kv），左边缘严格对齐。
export function editForm(code, p) {
  let pvSchedule = () => {};
  const noSession = (p.session !== 'T' && p.session !== 'T+1'); // 2026-09 之前的老记录
  const sessT = sessionToggle(p.session, { allowUnknown: noSession, onChange: () => pvSchedule(0) });
  const dateI = el('input', { class: 'input', type: 'date', value: p.date || '', style: 'width:auto' });
  const amtI = el('input', { class: 'input', type: 'number', min: '0.01', step: '0.01', value: p.amount != null ? String(p.amount) : '', placeholder: '金额 ¥ 必填', style: 'width:110px' });
  const msg = el('div', { class: 'hint', style: 'margin-top:2px;text-align:right;max-width:170px;line-height:1.35' });
  // —— 只读展示 + 实时对比：「原 / 新」两行带标签（方案 B），两列结构一致、左边缘对齐 ——
  const shOld = el('span', { class: 'pv-old tnum', text: p.shares != null ? Number(p.shares).toFixed(4) : '—' });
  const shNew = el('span', { class: 'pv-new tnum', text: '—' });
  const navOld = el('span', { class: 'pv-old tnum', text: p.nav != null ? Number(p.nav).toFixed(4) : '—' });
  const navNew = el('span', { class: 'pv-new tnum', text: '—' });
  const navSub = el('div', { class: 'hint pv-sub', text: '成交日自动取' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '保存修改', style: 'padding:3px 10px;font-size:12px' });
  const cancelBtn = el('button', { class: 'btn', text: '取消', style: 'padding:3px 10px;font-size:12px' });
  // 改了日期/时段 → 保存即按新定价日重算；未改 → 不提示（避免噪音）
  const movedKey = () => (dateI.value !== p.date || sessT.getSession() !== (noSession ? null : p.session));
  const refreshWarn = () => {
    if (msg.textContent === '保存中…' || msg.textContent.startsWith('✓') || msg.textContent.startsWith('✗')) return;
    msg.textContent = movedKey() ? '将按新成交日重算净值/份额' : '';
  };
  const doSave = async () => {
    const amount = Number(amtI.value);
    if (!amtI.value.trim() || !isFinite(amount) || amount <= 0) { msg.textContent = '金额必填且 > 0'; return; }
    if (!dateI.value.trim()) { msg.textContent = '日期必填'; return; }
    const payload = { code, date: dateI.value, amount, session: sessT.getSession(), editKey: { date: p.date, amount: p.amount } };
    // 重算：定价日只由「日期 + 时段」决定 —— 二者任一变更即自动重算，无需任何勾选。
    // 只信预览结果；服务端会用权威 feeRate 自己重算份额（客户端份额不被信任）。
    if (movedKey()) {
      const pvres = pv.get();
      const v = pvres && pvres.variants ? pvres.variants[sessT.getSession() || 'T'] : null;
      if (!v || v.status === 'error') {
        // 预览拿不到净值 → 拒绝重算。绝不在信息不足时清空真实的净值/份额（那才是真正的数据事故）
        msg.textContent = '净值查询未成功，已取消重算（请稍后重试）';
        return;
      }
      if (v.status === 'pending') {
        // 新成交日的净值确实还没公布（或顺延超限）—— 这是合法意图，但要用户明确知道后果
        const why = (v.rollDays != null)
          ? ('名义成交日 ' + v.nominalDate + ' 之后顺延 ' + v.rollDays + ' 天都没有新净值（超过 ' + '上限）。')
          : ('名义成交日 ' + v.nominalDate + ' 之后的净值尚未公布。');
        if (!confirm(why + '\n保存后这笔会变成「待确认」，原净值/份额会被清空，等系统在净值公布后自动补填。\n\n继续？')) return;
      } else {
        payload.nav = v.nav; payload.pricingDate = v.pricingDate;
      }
      payload.recalc = true;
      payload.navAuto = true;
    }
    saveBtn.disabled = true;
    msg.textContent = '保存中…';
    try {
      const r = await api.updatePurchase(payload);
      pv.dispose();
      msg.textContent = '✓ 已更新' + (r && r.warn ? '（' + r.warn + '）' : '');
      setTimeout(refreshPage, 500);
    } catch (e) {
      msg.textContent = '✗ ' + e.message;
      saveBtn.disabled = false;
    }
  };
  saveBtn.addEventListener('click', doSave);
  cancelBtn.addEventListener('click', () => { pv.dispose(); refreshPage(); });
  // 5 列对齐容器：日期(+时段) / 份额(原·新) / 金额 / 净值(原·新 + 成交日说明) / 操作
  const dateCell = el('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [dateI, sessT]);
  const sharesCell = el('div', { class: 'pv-kv' }, [
    el('span', { class: 'k', text: '原' }), shOld,
    el('span', { class: 'k', text: '新' }), shNew,
  ]);
  const amountCell = amtI;
  const navCell = el('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [
    el('div', { class: 'pv-kv' }, [
      el('span', { class: 'k', text: '原' }), navOld,
      el('span', { class: 'k', text: '新' }), navNew,
    ]),
    navSub,
  ]);
  // 操作列：贴右对齐 + 反馈文案挂按钮下方（同 记一笔）
  const opsCell = el('div', { style: 'display:flex;flex-direction:column;align-items:flex-end;gap:4px' }, [
    el('div', { style: 'display:flex;gap:4px;align-items:center;flex-wrap:wrap;justify-content:flex-end' }, [saveBtn, cancelBtn]),
    msg,
  ]);

  const pv = createPreview({
    code,
    getDate: () => dateI.value,
    getSession: () => sessT.getSession(),
    getAmount: () => amtI.value,
    paint: (r, err) => {
      const sel = sessT.getSession() || 'T';
      const dash = (e) => { e.textContent = '—'; e.className = 'hint'; };
      const hold = (e) => { e.textContent = '待确认'; e.className = 'hint'; };
      if (r === 'loading') {
        navNew.textContent = '…'; navNew.className = 'pv-new tnum';
        shNew.textContent = '…'; shNew.className = 'pv-new tnum';
        return;
      }
      if (!r || !r.variants) {
        // 拿不到预览 → 两列「新」行都退回占位，「新」位保留以维持两列左边缘对齐
        dash(navNew); dash(shNew);
        navSub.textContent = err ? ('净值查询失败：' + err.message) : '成交日自动取';
        refreshWarn();
        return;
      }
      const v = r.variants[sel];
      const pd = v.pricingDate;
      // 净值「新」行
      if (v.status === 'ok') {
        navNew.textContent = v.nav.toFixed(4);
        navNew.className = 'pv-new tnum';
        navSub.textContent = '成交净值 ' + pd.slice(5)
          + (v.shifted ? '（' + v.nominalDate.slice(5) + ' 非交易日，顺延 ' + v.rollDays + ' 天）' : '')
          + (v.settleDate ? ' · 份额 ' + v.settleDate.slice(5) + (v.settleEstimated ? ' 预计到账' : ' 确认') : '');
      } else {
        if (v.status === 'pending') hold(navNew); else dash(navNew);
        navSub.textContent = v.message;
      }
      // 份额「新」行（与原值一致时不制造噪音，但仍占「新」位保持两列左边缘对齐）
      if (v.status !== 'ok' || v.shares == null) {
        if (v.status === 'pending') hold(shNew); else dash(shNew);
      } else if (p.shares != null && Math.abs(v.shares - Number(p.shares)) < 1e-9) {
        shNew.textContent = '与原值一致';
        shNew.className = 'hint pv-sub';
      } else {
        const d = (p.shares != null) ? (v.shares - Number(p.shares)) : null;
        shNew.textContent = v.shares.toFixed(4) + (d != null ? '（' + (d > 0 ? '+' : '') + d.toFixed(4) + '）' : '');
        shNew.className = 'pv-new tnum';
      }
      refreshWarn();
    },
  });
  pvSchedule = (d) => pv.schedule(d);
  dateI.addEventListener('change', () => { refreshWarn(); pv.schedule(0); });
  amtI.addEventListener('input', () => pv.schedule(450));
  pv.schedule(0); // 打开表单即算一版：用户一眼看到「改不改有区别」

  return buyRowShell({ date: dateCell, shares: sharesCell, amount: amountCell, nav: navCell, ops: opsCell });
}

// 复盘页：每日 / 每月 两 Tab（2026-09-12 移除「总体」Tab；每月内容停用，仅保留标签）
// 手机端（≤760px）改卡片式竖排，纯纵向滚、无横滑/无缩放（方案 A）
import * as store from '../store.js';
import { signPct, cls, el, tableWrap, loadingHTML } from '../util.js';

let activeTab = 'daily';

export async function render(root) {
  const mobile = window.matchMedia('(max-width: 760px)').matches;
  root.innerHTML = '';
  const live = store.getLive();
  const state = store.getState();

  const tabs = el('div', { class: 'btn-row', style: 'margin-bottom:14px' }, [
    tabBtn('daily', '每日'),
    tabBtn('monthly', '每月'),
  ]);
  root.appendChild(tabs);

  const body = el('div', { id: 'reviewBody' });
  root.appendChild(body);
  await renderTab(body, activeTab, live, state, mobile);
}

function tabBtn(key, label) {
  const b = el('button', { class: 'btn' + (key === activeTab ? ' btn-primary' : ''), text: label });
  b.addEventListener('click', async () => {
    activeTab = key;
    b.parentElement.querySelectorAll('.btn').forEach(x => x.classList.remove('btn-primary'));
    b.classList.add('btn-primary');
    const body = document.getElementById('reviewBody');
    await renderTab(body, key, store.getLive(), store.getState(), window.matchMedia('(max-width: 760px)').matches);
  });
  return b;
}

async function renderTab(body, key, live, state, mobile) {
  body.innerHTML = loadingHTML('正在准备你的看板…', true);
  if (key === 'daily') return renderDaily(body, live, state, mobile);
  if (key === 'monthly') return renderMonthly(body, live, mobile);
}

// 结论状态 → 文案
function verdictLabel(v) { return v === 'add' ? '加仓' : '不动'; }
// factors status 三态 → 状态点 class（cheap=绿 / expensive=红 / neutral=灰）
function factorStatusClass(s) { return s === 'cheap' ? 'st-cheap' : s === 'expensive' ? 'st-expensive' : 'st-neutral'; }

async function renderDaily(body, live, state, mobile) {
  // ⚠️ 这里刻意不再 body.innerHTML=''：占位（renderTab 写入的细线）必须活到面板真正就绪。
  // 原实现在 await 之前就清空 → 首帧只剩一排 tab、下方全空 → 内容一次性蹦出（大幅跳动）。
  // 现改为只在面板挂载的那一刻替换占位（下方 mount()）。
  const panel = el('div', { class: 'panel' });
  const mount = (node) => { body.innerHTML = ''; body.appendChild(node); };
  panel.appendChild(el('div', { class: 'panel-head' }, [
    el('span', { text: '每日决策链路' }),
    el('span', { class: 'sub', text: '本次刷新 · 与上周对比' }),
  ]));

  // 取最新 advice：daily tab 需要结构化 signals + weekAgo；统一走 am 可执行模式
  // 2026-09-08 L2/L3 整合：单源渲染 advice.funds（每基金一条：判定/综合分/结论/净值全同源），
  // 类别外基金不在 funds[] → 由 live.funds 兜底渲染原始数据行（R4 护栏）。
  let advice = {};
  try { advice = await store.reloadAdvice('am'); } catch (e) { advice = {}; }
  const weekAgo = advice.weekAgo || {};
  const allFunds = advice.funds || [];
  const fundsByCode = new Map(allFunds.map(x => [x.code, x]));

  // 复盘「每日决策链路」按决策信号口径展示，与决策页一致：
  // 持仓有市值的基金（live.funds，含类别外基金净值兜底）∪ 决策引擎已覆盖但暂未建仓的基金
  // （funds[] 中 currentValue===0 者，如沪深300 宽基模块）。
  const heldFunds = (live.funds || []).filter(f => (f.currentValue || 0) > 0);
  const heldCodes = new Set(heldFunds.map(f => f.code));
  const plannedFunds = allFunds
    .filter(x => !heldCodes.has(x.code))
    .map(x => Object.assign({}, x, { _planned: true })); // 引擎覆盖未持仓记录（full record）
  const funds = [...heldFunds, ...plannedFunds];

  if (!funds.length) {
    panel.appendChild(el('div', { class: 'hint', text: '暂无持仓基金。' }));
    mount(panel);
    return;
  }

  funds.forEach(f => {
    // 引擎统一信号记录（每基金一条：verdict/score/conclusion/factors/净值全同源）；
    // 类别外基金不在 funds[] → fc=null，仅渲染原始数据行（净值由 live.funds 兜底，R4）
    const fc = fundsByCode.get(f.code) || null;
    const wa = weekAgo[f.code] || {};
    const nav = fc ? fc.latestNav : (f.latestNav != null ? f.latestNav : null);
    const chg = fc ? fc.dayChange : (f.dayChange != null ? f.dayChange : null);
    const navDate = fc ? fc.latestDate : (f.latestDate != null ? f.latestDate : null);
    const verdict = fc ? fc.verdict : null; // 机器值 'add'|'hold'
    // 暂停申购：funds 记录 suspended 判定（dailyLimit===0 同源兜底，见 allocation scoreMap）
    const suspended = !!(fc && fc.suspended) || !!(fc && fc.dailyLimit === 0);
    const score = fc ? fc.score : null; // 综合分（与决策页同一记录，物理同源）
    const posCls = (!suspended && verdict === 'add') ? 'badge-add' : 'badge-hold';
    const vBadgeTxt = suspended ? '暂停申购' : (verdict ? verdictLabel(verdict) : '');
    const vBadgeCls = suspended ? 'badge-hold' : (verdict === 'add' ? 'badge-add' : 'badge-hold');

    const summary = el('summary', { class: 'dec-sum' }, [
      el('span', { class: 'dec-name' }, [
        document.createTextNode(f.name + ' '),
        el('span', { class: 'dec-code', text: f.code }),
        f._planned ? el('span', { class: 'tag-planned', text: '未持仓' }) : null,
      ]),
      el('span', { class: 'dec-meta' }, [
        chg != null ? el('span', { class: 'dec-chg ' + cls(chg), text: signPct(chg) }) : el('span', { class: 'dec-chg', text: '—' }),
        score != null ? el('span', { class: 'badge ' + posCls, text: `综合分 ${score}` }) : null,
        (verdict || suspended) ? el('span', { class: 'badge ' + vBadgeCls, text: vBadgeTxt }) : el('span', {}),
      ]),
    ]);
    const det = el('details', { class: 'dec-card' }, [summary]);
    const bodyWrap = el('div', { class: 'dec-body' });

    // ① 信号理由（决策信号 title 类别 + detail 长文；结论两维派生在 ④，positionLabel"L2…"文案已弃用不渲染）
    if (fc) {
      const cat = (fc.title || '').replace(/决策[:：].*$/, '').trim();
      const sec = el('div', { class: 'dec-sec' }, [el('div', { class: 'dec-sec-h', text: '信号理由' })]);
      if (cat) sec.appendChild(el('div', { style: 'font-weight:600;font-size:14px;margin-bottom:2px', text: cat }));
      if (fc.detail) sec.appendChild(el('div', { class: 'dec-raw', style: 'line-height:1.7', text: fc.detail }));
      bodyWrap.appendChild(sec);
    }

    // ② 原始数据
    bodyWrap.appendChild(el('div', { class: 'dec-sec' }, [
      el('div', { class: 'dec-sec-h', text: '原始数据' }),
      el('div', { class: 'dec-raw', text: [
        '净值 ' + (nav != null ? nav : '—'),
        '当日 ' + (chg != null ? signPct(chg) : '—'),
        '净值日 ' + (navDate || '—'),
      ].join(' · ') }),
    ]));

    // ③ 估值信号层（结构化分项 + 上周对比）
    if (fc && fc.factors && fc.factors.length) {
      const table = el('table', { class: 'tbl dec-factors' });
      table.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', { text: '维度' }), el('th', { text: '值' }),
        el('th', { text: '状态' }), el('th', { text: '上周' }),
      ])]));
      const tb = el('tbody', {});
      fc.factors.forEach(fac => {
        const prev = (wa.factors || []).find(x => x.dim === fac.dim);
        tb.appendChild(el('tr', {}, [
          el('td', { text: fac.dim }),
          el('td', { class: 'tnum', text: fac.value != null ? String(fac.value) : '—' }),
          el('td', {}, [el('span', { class: 'st-dot ' + factorStatusClass(fac.status), title: fac.status })]),
          el('td', { class: 'dec-wk', text: prev && prev.value != null ? ('↔ 上周 ' + prev.value) : '—' }),
        ]));
      });
      table.appendChild(tb);
      bodyWrap.appendChild(el('div', { class: 'dec-sec' }, [
        el('div', { class: 'dec-sec-h', text: '估值信号' }),
        tableWrap(table),
      ]));
    }

    // ④ 结论（两维派生 conclusion 承接原 action 句职责）+ 上周对比
    if (fc) {
      const verdictChanged = wa.verdict && wa.verdict !== fc.verdict;
      const wkNode = wa.verdict
        ? el('div', { class: 'dec-wk' + (verdictChanged ? ' dec-changed' : '') }, [
            document.createTextNode('↔ 上周 ' + verdictLabel(wa.verdict)),
            verdictChanged ? el('span', { class: 'tag-change', text: ' 变化' }) : null,
          ])
        : el('div', { class: 'dec-wk', text: '—' });
      bodyWrap.appendChild(el('div', { class: 'dec-sec' }, [
        el('div', { class: 'dec-sec-h', text: '结论' }),
        el('div', { class: 'dec-verdict', text: fc.conclusion || fc.title }),
        wkNode,
      ]));
    }

    det.appendChild(bodyWrap);
    panel.appendChild(det);
  });

  mount(panel);
}

async function renderMonthly(body) {
  body.innerHTML = '';
  // 2026-09-12 每月复盘内容停用（原买入时机复盘面板移除；后端 timing 采样继续独立运行，
  // 数据仍写入 data/state/timing_samples.json，需要时经 GET /api/timing 查看）。
  body.appendChild(el('div', { class: 'hint', style: 'margin-top:8px', text: '每月复盘内容已停用。' }));
}

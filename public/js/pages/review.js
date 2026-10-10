// 复盘页：每日 / 每月 两 Tab（2026-09-12 移除「总体」Tab；每月内容停用，仅保留标签）
// 手机端（≤760px）改卡片式竖排，纯纵向滚、无横滑/无缩放（方案 A）
import * as store from '../store.js';
import { signPct, cls, el, tableWrap, loadingHTML } from '../util.js';
import { attachLazyDegraded } from '../degraded-view.js';
import { decisionDetailSections } from './decision-card.js';

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
  if(allFunds.some(f=>['nasdaq-dual-v1','active-equity-buy-v1','gold-dual-v1','dividend-monthly-dca-v1'].includes(f.strategyVersion))){
    panel.style.minWidth='0';panel.style.maxWidth='100%';panel.style.boxSizing='border-box';
    body.style.minWidth='0';body.style.maxWidth='100%';
  }
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
    panel.appendChild(el('div', { class: 'hint', text: '暂无持仓基金。先去「持仓」页添加第一只。' }));
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
    const monthlyPlan = fc?.strategyVersion === 'dividend-monthly-dca-v1' && fc.marketState === 'monthly_dca';
    const vBadgeTxt = suspended ? '暂停申购' : monthlyPlan ? '每月定投，手动执行' : ['active-equity-buy-v1','gold-dual-v1'].includes(fc?.strategyVersion)?(fc.marketStateLabel||'无法判定'):(verdict ? verdictLabel(verdict) : '');
    const vBadgeCls = suspended ? 'badge-hold' : (verdict === 'add' ? 'badge-add' : 'badge-hold');

    const nasdaq=['nasdaq-dual-v1','active-equity-buy-v1','gold-dual-v1'].includes(fc?.strategyVersion);
    const summary = el('summary', { class: 'dec-sum',...(nasdaq?{style:'display:flex;flex-direction:column;align-items:stretch;min-width:0;gap:8px'}:{}) }, [
      el('span', { class: 'dec-name',...(nasdaq?{style:'min-width:0;max-width:100%;white-space:normal;overflow-wrap:anywhere'}:{}) }, [
        document.createTextNode(f.name + ' '),
        el('span', { class: 'dec-code', text: f.code }),
        f._planned ? el('span', { class: 'tag-planned', text: '未持仓' }) : null,
      ]),
      el('span', { class: 'dec-meta',...(nasdaq?{style:'display:flex;flex-wrap:wrap;min-width:0;gap:6px;justify-content:flex-start'}:{}) }, [
        fc && ['dividend-monthly-dca-v1','dividend-trend-v1','hs300-dual-v1','nasdaq-dual-v1','active-equity-buy-v1','gold-dual-v1'].includes(fc.strategyVersion) && fc.blockedReason ? el('span',{class:'badge badge-hold',text:
          ({release_pending:'待启用',purchase_suspended:'暂停申购',purchase_status_unverified:'申购状态待核验',user_limit_zero:'用户限额为零',policy_blocked:'资金政策限制',future_order_recheck:'未来申请日需复核',official_purchase_suspended:'官方暂停申购',official_resumption_unverified:'官方恢复申购待核',official_constraint_unverified:'官方申购约束待核'})[fc.blockedReason]||'当前不可执行'}) : null,
        fc?.strategyVersion==='gold-dual-v1'&&fc.releaseEnabled!==true&&fc.blockedReason!=='release_pending'?el('span',{class:'badge badge-hold',text:'待启用'}):null,
        chg != null ? el('span', { class: 'dec-chg ' + cls(chg), text: signPct(chg) }) : el('span', { class: 'dec-chg', text: '—' }),
        score != null ? el('span', { class: 'badge ' + posCls, text: `综合分 ${score}` }) : null,
        fc && fc.marketStateLabel ? el('span', { class: 'badge ' + (monthlyPlan ? 'badge-add' : fc.marketState === 'candidate' ? 'badge-add' : 'badge-hold'), text: monthlyPlan ? '计划：每月定投' : fc.marketStateLabel }) : null,
        fc && fc.unsupportedReason === 'rule_disabled' ? el('span', { class: 'badge badge-hold', text: '规则调整中' }) : null,
        (verdict || suspended) && (fc?.strategyVersion!=='gold-dual-v1'||suspended&&!['purchase_suspended','official_purchase_suspended'].includes(fc.blockedReason)) ? el('span', { class: 'badge ' + vBadgeCls, text: vBadgeTxt }) : el('span', {}),
      ]),
    ]);
    const det = el('details', { class: 'dec-card',...(nasdaq?{style:'min-width:0;max-width:100%;width:100%;box-sizing:border-box;overflow-wrap:anywhere'}:{}) }, [summary]);
    const bodyWrap = el('div', { class: 'dec-body',...(nasdaq?{style:'min-width:0;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;word-break:break-word'}:{}) });

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
      const secTitle = fc.strategyVersion==='gold-dual-v1'?'黄金A/B双路径；仅买入判断':fc.strategyVersion==='active-equity-buy-v1'?'主动权益A/B双通道；仅买入判断':fc.strategyVersion==='nasdaq-dual-v1'?'纳指双通道条件；PE仅回撤门槛':fc.strategyVersion==='hs300-dual-v1'?'共同PE入口、双通道条件与参考':fc.strategyVersion==='dividend-trend-v1'?'趋势回踩条件与参考':'估值信号';
      const table = el('table', { class: 'tbl dec-factors',...(nasdaq?{style:'table-layout:fixed;width:100%;min-width:0;overflow-wrap:anywhere'}:{}) });
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
      // ★ 一行都取不到**实测值**时，这张表不给判断也不给数字，只是把同一句「无法判定」重复 N 遍，
      //   还会让标题里的「仅买入判断」读成"正在判"。此时折叠成一行，把版面让给净值事实。
      //   实测踩过：三只 QDII 13 行全「无法判定」、红利低波 9 行全「—」。
      //   ⚠️ 判空要按「是不是实测值」判，不能只判 null/空串：
      //     · 各策略占位写法不统一 —— 红利线写「—」，主动权益/纳指写「无法判定」；
      //     · 通道行会带原因后缀：「无法判定；daily_sampling_unverified」，等值比较会漏掉。
      //   但「待启用」「尚未核验项目：…」这类**带信息的文案不算空**，它们要照常显示。
      const NO_VALUE = v => v == null || v === '' || v === '—' || /^无法判定/.test(String(v));
      const hasValue = fc.factors.some(x => !NO_VALUE(x.value));
      const tableNode = nasdaq ? el('div',{style:'min-width:0;max-width:100%;width:100%;overflow-wrap:anywhere'},[table]) : tableWrap(table);
      bodyWrap.appendChild(el('div', { class: 'dec-sec' }, [
        el('div', { class: 'dec-sec-h' }, [
          document.createTextNode(secTitle),
          hasValue ? null : el('span', { class: 'badge badge-hold', style: 'margin-left:8px',
            text: fc.factors.length + ' 项本次未取值' }),
        ]),
        hasValue ? tableNode : el('details', {}, [
          el('summary', { style: 'cursor:pointer', text: '查看条件清单（本次均未取值）' }),
          tableNode,
        ]),
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

    // ⑤ 决策详情段（判断说明/条件与指标/数据核验/数据日期/交易限制）——由决策页折叠区搬迁而来，
    //    承接原决策卡的证据明细；类别外基金 fc 为 null，无引擎记录可展示，跳过。
    if (fc) bodyWrap.appendChild(decisionDetailSections(fc, {}));

    det.appendChild(bodyWrap);
    // 没有 verdict = 上方徽标位渲染成空 <span> 的那种空屏 → 挂上降级视图（展开才拉取）。
    // ★ 判据只看「有没有 verdict」，**不能加 !suspended**：暂停申购（如 QDII 外汇额度限售、
    //   配置里 dailyLimit=0）与「未通过证据闸门」是两件正交的事。只看 suspended 会让
    //   「既暂停又未核验」的基金退回空屏 —— 这正是本视图要消灭的那种空白。
    //   实测踩过：012920 因 dailyLimit=0 被判 suspended，降级视图被跳过。
    if (!verdict && !monthlyPlan) attachLazyDegraded(det, f.code, 300);
    panel.appendChild(det);
  });

  mount(panel);
}

async function renderMonthly(body, live) {
  body.innerHTML = '';
  const panel = el('div', { class: 'panel monthly-purchases' });
  panel.appendChild(el('div', { class: 'panel-head' }, [
    el('span', { text: '红利基金每月购买记录' }),
    el('span', { class: 'sub', text: '按手动录入流水汇总' }),
  ]));
  panel.appendChild(el('div', { class: 'hint monthly-note', text: '每月定投，手动执行。以下金额来自手动录入的购买记录，不代表系统自动申购、计划金额或定投完成率。旧版趋势回踩历史记录仍按原口径保留。' }));
  const groups = new Map();
  (live?.funds || []).filter(f => f.category === 'dividend').forEach(f => {
    (Array.isArray(f.purchases) ? f.purchases : []).forEach((p, index) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '') || p.amount == null || !Number.isFinite(Number(p.amount))) return;
      const month = p.date.slice(0, 7), state = p.shares == null ? '待确认' : '已确认';
      const key = `${month}|${f.code}|${state}`;
      if (!groups.has(key)) groups.set(key, {month, code:f.code, name:f.name, state, dates:[], pricingDates:[], count:0, amount:0});
      const row = groups.get(key); row.count++; row.amount += Number(p.amount); row.dates.push(p.date);
      const pricingDate = p.pricingDate || p.navDate || p.confirmDate;
      if (pricingDate && !row.pricingDates.includes(pricingDate)) row.pricingDates.push(pricingDate);
    });
  });
  const rows = [...groups.values()].sort((a,b)=>b.month.localeCompare(a.month)||a.name.localeCompare(b.name)||a.state.localeCompare(b.state));
  if (!rows.length) {
    panel.appendChild(el('div', { class: 'monthly-empty', text: '暂无红利基金购买记录。录入购买流水后，这里会按交易日期汇总；不会补造缺失交易。' }));
  } else {
    const table = el('table', { class: 'tbl monthly-table' });
    table.appendChild(el('thead', {}, [el('tr', {}, ['月份','基金','份额状态','笔数','录入金额','交易日期','定价日'].map(x=>el('th',{text:x})))]));
    const tb = el('tbody', {});
    rows.forEach(r=>tb.appendChild(el('tr', {}, [
      el('td',{text:r.month}),el('td',{text:`${r.name} ${r.code}`}),
      el('td',{},[el('span',{class:'badge '+(r.state==='已确认'?'badge-add':'badge-hold'),text:r.state})),
      el('td',{class:'tnum',text:String(r.count)}),el('td',{class:'tnum',text:'¥'+r.amount.toFixed(2)}),
      el('td',{text:[...new Set(r.dates)].sort().join('、')}),el('td',{text:r.pricingDates.sort().join('、')||'—'})
    ])));
    table.appendChild(tb);
    panel.appendChild(tableWrap(table));
    const cards = el('div', { class: 'monthly-cards' });
    rows.forEach(r=>cards.appendChild(el('article',{class:'monthly-record'},[
      el('div',{class:'monthly-record-head'},[el('strong',{text:r.month}),el('span',{class:'badge '+(r.state==='已确认'?'badge-add':'badge-hold'),text:r.state})]),
      el('div',{class:'monthly-record-name',text:`${r.name} · ${r.code}`}),
      el('div',{class:'monthly-record-grid'},[
        el('span',{text:'笔数'}),el('strong',{text:String(r.count)}),
        el('span',{text:'录入金额'}),el('strong',{text:'¥'+r.amount.toFixed(2)}),
        el('span',{text:'交易日期'}),el('span',{text:[...new Set(r.dates)].sort().join('、')}),
        el('span',{text:'定价日'}),el('span',{text:r.pricingDates.sort().join('、')||'—'})
      ])
    ])));
    panel.appendChild(cards);
  }
  body.appendChild(panel);
}

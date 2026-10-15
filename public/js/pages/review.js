// 复盘页：每日状态与详情 / 每月红利手动购买记录。
// 手机端（≤760px）改卡片式竖排，纯纵向滚、无横滑/无缩放（方案 A）
import * as store from '../store.js';
import { signPct, cls, el, tableWrap, loadingHTML } from '../util.js';
import { attachLazyDegraded } from '../degraded-view.js';
import { cardState, decisionDetailSections } from './decision-card.js';
import { macroPolicySection } from './macro-policy.js';
import { buildDecisionExplanation, displayFactorName } from './decision-explanation.js';

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
  const generation = body._reviewGeneration = (body._reviewGeneration || 0) + 1;
  body.innerHTML = loadingHTML('正在准备你的看板…', true);
  if (key === 'daily') return renderDaily(body, live, state, mobile, generation);
  if (key === 'monthly') return renderMonthly(body, live, mobile);
}

// 结论状态 → 文案
function verdictLabel(v) { return v === 'add' ? '加仓' : '不动'; }
// factors status 三态 → 状态点 class（cheap=绿 / expensive=红 / neutral=灰）
function factorStatusClass(s) { return s === 'cheap' ? 'st-cheap' : s === 'expensive' ? 'st-expensive' : 'st-neutral'; }

async function renderDaily(body, live, state, mobile, generation) {
  const panel = el('div', {class:'panel'});
  panel.appendChild(el('div', {class:'panel-head',text:'每日决策与原因'}));
  let advice={};
  try { advice=await store.reloadAdvice('am'); } catch (_) {}
  if(body._reviewGeneration!==generation)return;
  const byCode=new Map((advice.funds||[]).map(f=>[f.code,f]));
  const held=(live.funds||[]).filter(f=>(f.currentValue||0)>0), codes=new Set(held.map(f=>f.code));
  const funds=[...held,...(advice.funds||[]).filter(f=>!codes.has(f.code)).map(f=>({...f,_planned:true}))];
  if(!funds.length)panel.appendChild(el('div',{class:'hint',text:'暂无持仓基金。先去「持仓」页添加第一只。'}));
  funds.forEach(f=>{
    const fc=byCode.get(f.code)||(f.strategyScope==='record_only'||f.marketState==='record_only'?f:null), chg=fc?fc.dayChange:f.dayChange;
    const plan=fc?.displayKind==='plan'&&fc.marketState==='monthly_dca'&&!fc.unsupported;
    const state=fc?cardState(fc):{market:'暂无策略判断',action:null,constraint:null};
    const constraints=fc?[...new Set([...(fc.constraints||[]).map(reason=>cardState({...fc,blockedReason:reason}).constraint||reason),state.constraint].filter(Boolean))]:[];
    const summary=el('summary',{class:'dec-sum'},[
      el('span',{class:'dec-name'},[document.createTextNode(f.name+' '),el('span',{class:'dec-code',text:f.code}),f._planned?el('span',{class:'tag-planned',text:'未持仓'}):null]),
      el('span',{class:'dec-meta'},[
        el('span',{class:'badge '+(state.action==='add'?'badge-add':'badge-hold'),text:plan?'每月定投，手动执行':state.market}),
        ...constraints.map(text=>el('span',{class:'badge badge-hold',text})),
        chg!=null?el('span',{class:'dec-chg '+cls(chg),text:signPct(chg)}):el('span',{class:'dec-chg',text:'—'})
      ])
    ]);
    const det=el('details',{class:'dec-card','data-code':f.code,'data-strategy-version':fc?.strategyVersion||'legacy'},[summary]);
    const wrap=el('div',{class:'dec-body'});
    if(fc?.marketState==='record_only') {
      wrap.appendChild(el('div',{class:'dec-raw',text:'仅记录持仓与收益，不生成新的策略信号。旧历史仍按原版本保留，不代表当前建议。'}));
      wrap.appendChild(el('div',{class:'dec-raw',text:'净值 '+((fc.latestNav??f.latestNav)??'—')+' · 净值日 '+((fc.latestDate||f.latestDate)||'—')}));
    } else if(fc?.strategyVersion==='gold-monthly-dca-v1') {
      wrap.appendChild(macroPolicySection({trigger:det}));
      wrap.appendChild(decisionDetailSections(fc,{simpleGold:true}));
    } else {
      const explanation=buildDecisionExplanation(fc||{});
      const overview=el('section',{class:'dec-overview'});
      [['当前情况',explanation.current],['判断原因',explanation.reason],['还缺什么',explanation.missing]].forEach(([label,text])=>overview.appendChild(el('div',{class:'dec-sec'},[el('div',{class:'dec-sec-h',text:label}),el('div',{class:'dec-raw',text})])));
      explanation.paths.forEach(p=>overview.appendChild(el('div',{class:'sub',text:p.name+'：'+p.purpose})));
      wrap.appendChild(overview);
      const evidence=el('details',{class:'decision-evidence'},[el('summary',{text:'查看详细依据'})]);
      explanation.paths.forEach(p=>evidence.appendChild(el('section',{class:'decision-path'},[
        el('h3',{text:p.name+' · '+(p.state===true?p.missing.length?'原记录成立，分项不一致':!p.hasPathEvidence||p.unknown.length||!p.ready.length?'原记录成立，分项尚待核实':'分项条件成立':p.state===false?'尚未满足':'尚无法核实')}),
        ...[p.ready.length?'已有：'+p.ready.join('、'):'',p.missing.length?'尚缺：'+p.missing.join('、'):'',p.unknown.length?'待核：'+p.unknown.join('、'):''].filter(Boolean).map(text=>el('div',{text}))
      ])));
      evidence.appendChild(el('div',{class:'dec-raw',text:'净值 '+((fc?fc.latestNav:f.latestNav)??'—')+' · 净值日 '+((fc?fc.latestDate:f.latestDate)||'—')}));
      if(fc?.score!=null)evidence.appendChild(el('div',{class:'dec-raw',text:'原综合分（仅保留依据）：'+fc.score}));
      if(fc?.factors?.length){
        const table=el('table',{class:'tbl dec-factors'});
        table.appendChild(el('thead',{},[el('tr',{},['维度','值','状态','上周'].map(text=>el('th',{text})))]));
        const tb=el('tbody',{});
        fc.factors.forEach(fac=>{
          const prev=(advice.weekAgo?.[f.code]?.factors||[]).find(x=>x.dim===fac.dim);
          tb.appendChild(el('tr',{},[el('td',{text:displayFactorName(fc.strategyVersion,fac.dim)}),el('td',{text:fac.value??'—'}),el('td',{text:({cheap:'有利',expensive:'受限',neutral:'参考'})[fac.status]||'待核'}),el('td',{text:prev?.value??'—'})]));
        });
        table.appendChild(tb);evidence.appendChild(table);
      }
      // Keep original material in the optional evidence area; dual path wording comes from structured conditions.
      if(fc?.detail&&!explanation.paths.length)evidence.appendChild(el('div',{class:'dec-raw',text:fc.detail}));
      if(fc?.conclusion&&!explanation.paths.length)evidence.appendChild(el('div',{class:'dec-raw',text:fc.conclusion}));
      if(fc)evidence.appendChild(decisionDetailSections(fc));
      wrap.appendChild(evidence);
    }
    det.appendChild(wrap);
    if(fc?.verdict==null&&!plan&&fc?.marketState!=='record_only'&&fc?.strategyVersion!=='gold-monthly-dca-v1')attachLazyDegraded(det,f.code,300);
    panel.appendChild(det);
  });
  if(body._reviewGeneration===generation){body.innerHTML='';body.appendChild(panel);}
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
      el('td',{},[el('span',{class:'badge '+(r.state==='已确认'?'badge-add':'badge-hold'),text:r.state})]),
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

import { el } from '../util.js';
import { getGoldMacroPolicy } from '../api.js';
const REGIONS={US:'美国',CN:'中国',EA:'欧元区',JP:'日本',UK:'英国'};
const TYPES={policy_decision:'政策决定',implementation_measure:'实施措施',proposal_consultation:'提案／咨询',meeting_minutes:'会议纪要／意见摘要',speech_statement:'讲话／声明',economic_data:'经济数据',reserve_data:'储备数据',unknown:'类型待核'};
const HOSTS=new Set(['www.federalreserve.gov','www.pbc.gov.cn','www.ecb.europa.eu','www.boj.or.jp','www.bankofengland.co.uk','home.treasury.gov','www.federalregister.gov','www.mof.gov.cn','www.gov.cn','www.customs.gov.cn','www.chinatax.gov.cn','www.mof.go.jp','www.gov.uk','ec.europa.eu','eur-lex.europa.eu','ofac.treasury.gov','www.sge.com.cn','www.safe.gov.cn']);
function officialLink(url,label){try{const u=new URL(url);if(u.protocol!=='https:'||!HOSTS.has(u.hostname)||u.username||u.password||u.port)return el('span',{text:'官方链接待核'});return el('a',{href:u.href,target:'_blank',rel:'noopener noreferrer',text:label});}catch(_){return el('span',{text:'官方链接待核'});}}
function mechanismLink(r){try{const u=new URL(r.url);if(u.protocol==='https:'&&['www.chicagofed.org','china.gold.org'].includes(u.hostname)&&!u.username&&!u.password&&!u.port)return el('a',{href:u.href,target:'_blank',rel:'noopener noreferrer',text:r.title});}catch(_){}return el('span',{text:'机制参考链接待核'});}
function select(label,values){const s=el('select',{'aria-label':label});values.forEach(([value,name])=>s.appendChild(el('option',{value,text:name})));return s;}
// Native append stringifies null/undefined; optional UI nodes must be omitted.
export function appendPresent(parent,...children){parent.append(...children.filter(child=>child!=null));}
let sectionSerial=0;
export function macroPolicySection({trigger}={}){
  const details=el(trigger?'section':'details',{class:trigger?'macro-policy macro-policy-embedded':'panel macro-policy',id:'goldMacroPolicy-'+(++sectionSerial)}),body=el('div',{class:'macro-policy-body'});
  details.appendChild(el(trigger?'h3':'summary',{class:trigger?'dec-sec-h':'panel-head',text:'近期宏观政策 · 阅读后由你决定是否执行'}));details.appendChild(body);
  const days=select('政策窗口',[['90','最近90天'],['30','最近30天'],['180','最近180天']]),region=select('地区',[['','全部五经济体'],...Object.entries(REGIONS)]),type=select('政策类型',[['','政策决定与实施'],...Object.entries(TYPES)]);
  const controls=el('details',{class:'macro-filters'},[el('summary',{text:'更多筛选'}),el('div',{class:'macro-controls'},[days,region,type])]),status=el('div',{class:'hint macro-status'}),list=el('div',{class:'macro-list'}),coverage=el('details',{class:'macro-coverage'},[el('summary',{text:'查看登记来源、覆盖边界与同步状态'})]);
  const more=el('button',{class:'btn',text:'加载下一页'}),retry=el('button',{class:'btn',text:'重新从第一页核查'});body.append(controls,status,list,coverage,retry,more);
  let loaded=false,busy=false,cursor=null,generation=0;
  function itemNode(item){
    const reading=item.interpretation, article=el('article',{class:'macro-item'});
    appendPresent(article,
      el('div',{class:'macro-item-meta',text:(item.authorityZh||item.authority||'机构待核')+' · '+(item.publishedDate||'公布日期待核')+' · '+(REGIONS[item.region]||item.region||'地区待核')}),
      el('h3',{text:item.title}),
      el('div',{class:'macro-reading-label',text:reading?.status==='supported'?'已取原文事实':'资料状态'}),
      el('div',{class:'macro-summary',text:reading?.fact||'现有资料不足以可靠说明具体政策动作；请阅读官方原文。'}),
      el('div',{class:'macro-reading-label',text:'可能怎样影响黄金（本项目解读）'}),
      el('div',{class:'macro-interpretation',text:reading?.mechanism||'尚无法可靠解读；不会据此改变基金状态。'}),
      reading?.counterfactors?el('div',{class:'macro-counterfactors',text:reading.counterfactors}):null,
      officialLink(item.sourceUrl,'官方原文'));
    if(!reading&&['proposal_consultation','speech_statement','meeting_minutes','economic_data','reserve_data','unknown'].includes(item.documentType))article.appendChild(el('div',{class:'hint',text:({proposal_consultation:'提案／咨询尚未视为执行决定。',speech_statement:'讲话／声明不是新的执行决定。',meeting_minutes:'会议记录不是新的执行决定。',economic_data:'经济数据不是政策决定。',reserve_data:'储备数据不能当作新购金政策。',unknown:'材料类型尚待核验。'})[item.documentType]}));
    const evidence=el('details',{class:'macro-item-evidence'},[el('summary',{text:'查看依据'}),
      el('div',{class:'macro-dates',text:'材料：'+(TYPES[item.documentType]||'类型待核')+'；公布日期 '+(item.publishedDate||'待核')+'（机构日期；'+(item.originalTimezone||'时区待核')+'）'}),
      item.precision==='instant'?el('div',{class:'macro-dates',text:'北京时间 '+item.publishedAtBeijing+'；原文 '+item.originalPublishedAt}):null,
      el('div',{class:'dec-raw',text:item.summaryZh||'中文结构化摘录暂缺；请阅读官方原文。'}),
      item.summaryAnchor?el('div',{class:'dec-raw',text:'原文锚：'+item.summaryAnchor}):null,
      el('div',{class:'macro-dates',text:(item.effectiveDateScope==='interest_rate_section'?'利率摘录段生效：':'实际生效：')+(item.effectiveDate||'待核')+' · 法律状态：'+(item.legalStatus==='proposal'?'提案，未视为已生效':'待核')}),
      el('div',{class:'sub',text:'最后增量核查：'+(item.fetchedAt||'待核')+' · 首次发现：'+(item.firstSeenAt||'待核')+(item.revision>1?' · 修订版本 '+item.revision:'')}),
      item.bodyFetchedAt?el('div',{class:'sub',text:(item.bodyRetained?'保留上次正文核查：':'正文核查：')+item.bodyFetchedAt}):null,
      el('div',{class:'sub',text:'摘录方法：'+(item.summaryMethod||'未取得')+'；解读方法：'+(reading?.methodVersion||'未取得')}),
      ...(reading?.references||[]).map(r=>mechanismLink(r))
    ].filter(Boolean));
    if(item.documents?.length>1){const materials=el('details',{},[el('summary',{text:'关联材料（各自公布日期）'})]);item.documents.forEach(d=>materials.appendChild(el('div',{class:'macro-material'},[el('span',{text:d.publishedDate+' · '+(TYPES[d.documentType]||'待核')+' · '}),officialLink(d.sourceUrl,d.title)])));evidence.appendChild(materials);}
    article.appendChild(evidence);return article;
  }
  async function load(append=false){if(busy)return;busy=true;const token=++generation;more.disabled=true;retry.disabled=true;status.textContent='正在核查登记的官方来源…';if(!append){list.replaceChildren();coverage.replaceChildren(el('summary',{text:'查看登记来源、覆盖边界与同步状态'}));}
    try{const data=await getGoldMacroPolicy({windowDays:days.value,...(region.value?{region:region.value}:{}),...(type.value?{type:type.value}:{}),...(append&&cursor?{cursor}: {})});if(token!==generation)return;
      if(!append)list.replaceChildren();(data.items||[]).forEach(i=>list.appendChild(itemNode(i)));cursor=data.nextCursor;loaded=true;
      status.textContent=`${data.status==='stale'?'信息过期；保留上次成功资料':data.status==='source_unavailable'?'部分来源未同步':'来源已核查；收录范围仍有缺项'}。窗口 ${data.window.from}～${data.window.to}。`;
      if(!data.items.length&&!append)list.appendChild(el('div',{class:'monthly-empty',text:data.emptyReason==='not_synchronized'?'尚未同步或抓取失败，不能判断近期有无政策。':'本窗口已取得资料中没有匹配条目；覆盖不全，不能据此认定没有新公布。'}));
      coverage.replaceChildren(el('summary',{text:'查看登记来源、覆盖边界与同步状态'}));(data.coverage||[]).forEach(c=>coverage.appendChild(el('article',{class:'macro-source'},[el('strong',{text:`${c.authority} · ${c.unavailable?'尚未同步／不可用':'部分同步'}${c.stale?' · 过期':''}`}),el('div',{text:c.scope}),el('div',{text:`请求范围 ${c.requestedFrom}～${c.requestedTo}；已观察 ${c.observedFrom||'未知'}～${c.observedTo||'未知'}；最后成功 ${c.lastSuccessfulAt||'无'}`}),c.retainedPrevious?el('div',{text:`本次保留先前取得的 ${c.retainedItemCount} 条历史资料，原核查 ${c.retainedCheckedFrom}～${c.retainedLastSuccessfulAt}；增量成功不代表历史重新核查完整。`}):null,el('div',{text:[...(c.limitations||[]),...(c.errors||[])].join('；')}),officialLink(c.officialUrl,'官方栏目')] )));
      coverage.appendChild(el('div',{class:'hint',text:'来源成功数不等于政策完整率；未覆盖的财政、贸易、制裁、黄金直接规则与部门均在来源清单说明。宏观信息不参与月计划或申购判断。'}));
    }catch(e){if(token!==generation)return;cursor=null;status.textContent=/cursor|snapshot/.test(e.message)?'分页快照已失效或条件已变化，请重新从第一页加载。':'政策核查失败：'+e.message+'。基金状态保持不变。';}
    finally{if(token===generation){busy=false;more.disabled=false;retry.disabled=false;more.hidden=!cursor;}}
  }
  more.hidden=true;more.addEventListener('click',()=>load(true));retry.addEventListener('click',()=>{cursor=null;load();});
  [days,region,type].forEach(s=>s.addEventListener('change',()=>{cursor=null;loaded=false;if(!busy)load();else{generation++;busy=false;load();}}));
  const lazyTrigger=trigger||details;
  lazyTrigger.addEventListener('toggle',()=>{if(lazyTrigger.open&&!loaded&&!busy)load();});return details;
}

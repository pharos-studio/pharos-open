'use strict';
// Run the actual daily/monthly and policy renderers. Layout and keyboard QA are separate browser checks.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
class Node {
  constructor(tag) { this.tag=tag; this.children=[]; this.attrs={}; this.style={}; this.listeners={}; this.className=''; this._text=''; this.open=false; this.hidden=false; }
  appendChild(child) { child.parentElement=this; this.children.push(child); return child; }
  append(...children) { children.forEach(c=>this.appendChild(c instanceof Node?c:Object.assign(new Node('#text'),{textContent:String(c)}))); }
  replaceChildren(...children) { this.children.forEach(c=>c.parentElement=null); this.children=[]; this._text=''; this.append(...children); }
  set textContent(v) { this.replaceChildren(); this._text=String(v); }
  get textContent() { return this._text+this.children.map(c=>c.textContent).join(''); }
  set innerHTML(v) { this.replaceChildren(); this._text=String(v); }
  setAttribute(k,v) { this.attrs[k]=String(v); if(k==='id')this.id=String(v); if(k==='value')this.value=String(v); }
  addEventListener(k,fn) { (this.listeners[k]??=[]).push(fn); }
  async fire(k) { for(const fn of this.listeners[k]||[])await fn({target:this}); await tick(); }
  get value() { return this._value??this.children[0]?.value??''; }
  set value(v) { this._value=String(v); }
  get classList() { const n=this; return {add(c){n.className=[...new Set(n.className.split(' ').filter(Boolean).concat(c))].join(' ');},remove(c){n.className=n.className.split(' ').filter(x=>x!==c).join(' ');},toggle(c,on){if(on)this.add(c);else this.remove(c);}}; }
  querySelectorAll(selector) { return walk(this).slice(1).filter(n=>selector.startsWith('.')?n.className.split(' ').includes(selector.slice(1)):selector.startsWith('#')?n.id===selector.slice(1):n.tag===selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]||null; }
}
function walk(n) { return [n,...n.children.flatMap(walk)]; }
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function source(file) { return fs.readFileSync(path.join(__dirname,'../../public/js',file),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export /g,''); }
function fixture() {
  const gold={code:'000216',name:'合成黄金A',strategyVersion:'gold-monthly-dca-v1',displayKind:'plan',marketState:'monthly_dca',marketStateLabel:'每月定投',marketVerdict:null,verdict:null,score:null,dayChange:1,detail:'旧理由不应渲染',conclusion:'旧结论不应渲染',factors:[{dim:'旧量化指标',value:'达标'}],constraints:[],purchaseStatus:{state:'open',maxBuy:1000},dailyLimit:100};
  const nonGold=[
    {code:'999101',name:'合成红利',category:'dividend',strategyVersion:'dividend-monthly-dca-v1',displayKind:'plan',marketState:'monthly_dca',marketStateLabel:'每月定投',verdict:null,score:null},
    {code:'999102',name:'合成沪深300',strategyVersion:'hs300-dual-v1',marketStateLabel:'等待机会',verdict:'hold',detail:'共同PE入口',score:null},
    {code:'999103',name:'合成普通宽基',category:'broad',verdict:'add',score:75,detail:'原宽基理由',conclusion:'原宽基结论',factors:[{dim:'PE',value:20,status:'cheap'}]},
    {code:'999104',name:'合成纳指',strategyVersion:'nasdaq-dual-v1',marketStateLabel:'无法判定',verdict:null,score:null},
    {code:'999105',name:'合成主动权益',strategyVersion:'active-equity-buy-v1',marketStateLabel:'需要处理',verdict:null,score:null},
    {code:'999106',name:'合成白银',category:'cycle',verdict:'hold',score:30},
  ];
  return [gold,{...gold,code:'000217',name:'合成黄金C',suspended:true,blockedReason:'purchase_suspended',constraints:['purchase_suspended','purchase_suspended'],purchaseStatus:{state:'suspended'}},...nonGold];
}
function policy(status='partial') { return {status,window:{from:'2026-07-15',to:'2026-10-12'},lastSuccessfulAt:'2026-10-12T00:00:00Z',nextCursor:'page2',items:[{region:'US',authorityZh:'美联储',documentType:'policy_decision',title:'合成政策 <img onerror=evil()>',publishedDate:'2026-10-01',originalTimezone:'America/New_York',summaryZh:'可靠中文事实要点；<script>只显示文本</script>',sourceUrl:'https://www.federalreserve.gov/newsevents/test.htm',fetchedAt:'2026-10-12',firstSeenAt:'2026-10-01'}],coverage:[{authority:'合成官方来源',scope:'有限登记栏目',unavailable:true,limitations:['财政缺项'],officialUrl:'https://www.federalreserve.gov/'}]}; }
function harness(funds=fixture()) {
  const root=new Node('main'), calls=[], pending=[], advicePending=[]; let fail=false, defer=false, deferAdvice=false, response=policy();
  const live={funds:funds.map(f=>({...f,currentValue:100,purchases:f.category==='dividend'?[{date:'2026-10-01',amount:10,shares:1},{date:'2026-10-02',amount:20,shares:2}]:[{date:'2026-10-03',amount:99,shares:1}]}))};
  const context=vm.createContext({URL,console,document:{createElement:t=>new Node(t),createTextNode:t=>Object.assign(new Node('#text'),{textContent:t}),getElementById:id=>walk(root).find(n=>n.id===id)},window:{matchMedia:()=>({matches:false})},store:{getLive:()=>live,getState:()=>({}),reloadAdvice:async()=>deferAdvice?new Promise(resolve=>advicePending.push(()=>resolve({funds,weekAgo:{}}))):({funds,weekAgo:{}})},attachLazyDegraded:n=>{n.attrs.degraded='true';},getGoldMacroPolicy:async params=>{calls.push({...params});if(defer)return new Promise((resolve,reject)=>pending.push({resolve,reject}));if(fail)throw new Error('合成离线失败');return response;}});
  ['util.js','pages/decision-explanation.js','pages/decision-card.js','pages/macro-policy.js','pages/review.js'].forEach(p=>vm.runInContext(source(p),context,{filename:p}));
  return {root,context,calls,pending,advicePending,live,setFail:v=>{fail=v;},setDefer:v=>{defer=v;},setDeferAdvice:v=>{deferAdvice=v;},setResponse:v=>{response=v;},async render(){await context.render(root);},gold(){return root.querySelectorAll('details').filter(n=>n.attrs['data-strategy-version']==='gold-monthly-dca-v1');}};
}
async function open(n) { n.open=true; await n.fire('toggle'); }
function tree(n) { return {tag:n.tag,attrs:n.attrs,className:n.className,text:n._text,children:n.children.map(tree)}; }
async function run() {
  const h=harness();await h.render(); const [a,b]=h.gold();
  assert.equal(h.gold().length,2);assert.equal(h.calls.length,0);assert.equal(a.open,false);assert.equal(b.open,false);
  const ids=walk(h.root).map(n=>n.id).filter(Boolean);assert.equal(new Set(ids).size,ids.length);
  for(const g of h.gold()) {
    assert.match(g.children[0].textContent,/每月定投，手动执行/);
    assert(!/信号理由|原始数据|旧理由|旧结论|旧量化指标|计划说明/.test(g.textContent));
    assert.equal(g.querySelector('.macro-policy-embedded').tag,'section');
    assert(!walk(g).some(n=>n.tag==='details'&&n.className.split(' ').includes('macro-policy')));
    assert(!g.attrs.degraded);
  }
  assert.equal((b.children[0].textContent.match(/暂停申购/g)||[]).length,1);
  const constraintsBefore=b.children[0].textContent;
  await open(a);assert.equal(h.calls.length,1);assert.equal(h.calls[0].windowDays,'90');
  assert.match(a.textContent,/美联储/);assert.match(a.textContent,/2026-10-01/);assert.match(a.textContent,/可靠中文事实要点/);assert.match(a.textContent,/尚无法可靠解读/);assert.match(a.textContent,/可能怎样影响黄金（本项目解读）/);assert.equal(a.querySelector('.macro-filters').open,false);assert.match(a.textContent,/官方原文/);assert.match(a.textContent,/收录范围仍有缺项/);
  assert.equal(a.querySelector('.macro-item').querySelector('.macro-item-evidence').querySelector('.dec-raw').textContent,'可靠中文事实要点；<script>只显示文本</script>');
  assert(!walk(a).some(n=>n.tag==='script'||n.tag==='img'));assert.equal(b.querySelectorAll('.macro-item').length,0);
  a.open=false;await a.fire('toggle');await open(a);assert.equal(h.calls.length,1);
  h.setFail(true);await open(b);assert.match(b.textContent,/政策核查失败/);assert.equal(b.children[0].textContent,constraintsBefore);
  assert.match(b.textContent,/基金状态保持不变/);h.setFail(false);h.setResponse(policy('stale'));await b.querySelectorAll('button')[0].fire('click');assert.match(b.textContent,/信息过期/);
  // Snapshot pagination and filters use the actual control listeners.
  h.setResponse({...policy(),nextCursor:null});await a.querySelectorAll('button')[1].fire('click');assert.equal(h.calls.at(-1).cursor,'page2');
  const [days,region,type]=a.querySelectorAll('select');days.value='30';await days.fire('change');assert.equal(h.calls.at(-1).windowDays,'30');assert(!h.calls.at(-1).cursor);
  region.value='JP';await region.fire('change');assert.equal(h.calls.at(-1).region,'JP');type.value='speech_statement';await type.fire('change');assert.equal(h.calls.at(-1).type,'speech_statement');
  // Empty and bad-link references do not become an absence-of-policy assertion or an active link.
  h.setResponse({...policy('source_unavailable'),items:[],emptyReason:'not_synchronized'});await a.querySelectorAll('button')[0].fire('click');assert.match(a.textContent,/不能判断近期有无政策/);
  h.setResponse({...policy(),items:[{...policy().items[0],sourceUrl:'javascript:alert(1)',summaryZh:null}]});await a.querySelectorAll('button')[0].fire('click');assert.match(a.textContent,/中文结构化摘录暂缺/);assert.match(a.textContent,/官方链接待核/);assert(!a.querySelectorAll('a').some(n=>n.attrs.href?.startsWith('javascript:')));
  // Detached async completion must not overwrite a newly selected page.
  h.setDefer(true);days.value='180';await days.fire('change');assert.equal(h.pending.length,1);await h.root.querySelectorAll('button')[1].fire('click');const monthly=h.root.textContent;
  assert.match(monthly,/红利基金每月购买记录/);assert.match(monthly,/¥30\.00/);assert.match(monthly,/2026-10-01、2026-10-02/);assert(!/合成黄金|近期宏观政策|99\.00/.test(monthly));
  h.pending[0].resolve(policy());await tick();assert.equal(h.root.textContent,monthly);
  // A filter change supersedes the older response within the same gold card.
  await h.root.querySelectorAll('button')[0].fire('click');const fresh=h.gold()[0];await open(fresh);const selects=fresh.querySelectorAll('select');selects[0].value='30';await selects[0].fire('change');assert.equal(h.pending.length,3);
  h.pending[2].resolve({...policy(),items:[{...policy().items[0],title:'最新窗口'}]});await tick();h.pending[1].resolve({...policy(),items:[{...policy().items[0],title:'旧窗口不应出现'}]});await tick();assert.match(fresh.textContent,/最新窗口/);assert(!fresh.textContent.includes('旧窗口不应出现'));
  // The same non-gold records produce identical actual subtrees with or without gold records.
  const clean=harness(fixture().slice(2));await clean.render();const mixed=harness();await mixed.render();
  assert.deepEqual(mixed.root.querySelectorAll('.dec-card').slice(2).map(tree),clean.root.querySelectorAll('.dec-card').map(tree));
  const slow=harness();slow.setDeferAdvice(true);const rendering=slow.render();await tick();await slow.root.querySelectorAll('button')[1].fire('click');const selected=slow.root.textContent;slow.advicePending[0]();await rendering;assert.equal(slow.root.textContent,selected);
  for(const reason of ['scope_unsupported','profile_unverified']) {
    const bad=harness([{...fixture()[0],marketState:'unsupported',displayKind:'unsupported',unsupported:true,unsupportedReason:reason,marketStateLabel:'资料不足'}]);await bad.render();assert(!bad.gold()[0].children[0].textContent.includes('每月定投，手动执行'));assert.match(bad.gold()[0].children[0].textContent,/暂不支持|需要处理/);
  }
  const C=h.context, card=C.decisionStatusCard(fixture()[1]);assert.match(card.textContent,/每月定投，手动执行/);assert.equal((card.textContent.match(/暂停申购/g)||[]).length,1);assert(!/市场：|不动|加仓/.test(card.textContent));
  console.log('gold simple UI: actual mixed daily/monthly DOM, lazy direct policy, unique IDs, null plan, constraints, filters/pages, stale/errors/XSS, detached/superseded responses and non-gold subtrees passed');
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});module.exports={run,harness,fixture,walk,tree,Node};

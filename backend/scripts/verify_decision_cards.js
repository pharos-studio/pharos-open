'use strict';
// Exercise the real card renderer with a tiny DOM; browser layout/keyboard are checked separately.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Node {constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.className='';this._text='';}appendChild(child){this.children.push(child);return child;}setAttribute(k,v){this.attrs[k]=String(v);}addEventListener(){}set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}}
function load(){const context=vm.createContext({document:{createElement:t=>new Node(t),createTextNode:text=>{const n=new Node('#text');n.textContent=text;return n;}}});
  const util=fs.readFileSync(path.join(__dirname,'../../public/js/util.js'),'utf8').replace(/export /g,'');vm.runInContext(util,context);
  // ★ 剥 import 行时行尾要容忍 CRLF：Windows 导出/检出后是 `;\r\n`，
  //   只写 `;\n` 会匹配不上（import 留在源码里 → 报 Cannot use import statement outside a module），
  //   而 Linux CI 是 LF 所以照绿 —— 属于只在 Windows 本地复现的假红。
  const src=fs.readFileSync(path.join(__dirname,'../../public/js/pages/decision-card.js'),'utf8').replace(/^import .*;\r?\n/m,'').replace(/export /g,'');vm.runInContext(src,context);return context;
}
function run(){const C=load(),signal={code:'999001',name:'合成基金',marketVerdict:'add',verdict:'hold',executable:false,suspended:true,blockedReason:'purchase_suspended',marketStateLabel:'可加仓',score:90,valueScore:80,momentumScore:95,detail:'回撤恢复达标。综合分 90。估值分 80；动量分 95；申请日需复核。',factors:[{dim:'回撤',value:'达标'},{dim:'综合分',value:'90'}],signalNavDate:'2026-09-18',orderDate:'2026-09-24',matrix:{evidenceChecks:{identity:true,sampling:false,continuity:false,calendar:false}}};
  const card=C.decisionCard(signal);assert.equal(card.tag,'details');assert(!Object.hasOwn(card.attrs,'open'));assert.equal(card.children[0].tag,'summary');assert.match(card.children[0].textContent,/市场：可加仓/);assert.match(card.children[0].textContent,/暂停申购/);assert(!card.children[0].textContent.includes('回撤恢复'));
  const text=card.textContent;assert(!/综合分|估值分|动量分|估80|动95/.test(text));assert.match(text,/回撤恢复达标/);assert.match(text,/2026-09-18/);assert.match(text,/日频采样完整性待核验/);
  const unknown=C.cardState({marketVerdict:null,verdict:'hold',executable:false});assert.equal(unknown.market,'无法判定');assert(!C.decisionCard({name:'未知',marketVerdict:null,verdict:null,matrix:{dataErrorLabel:'数据日期缺失'}}).textContent.includes('等待机会'));
  const old=C.decisionCard({name:'旧规则',marketVerdict:'add',verdict:'hold',suspended:true,detail:'双均线成立。',factors:[{dim:'PE分位',value:'低位'}]});assert.match(old.textContent,/市场：加仓/);assert.match(old.textContent,/暂停申购/);assert(!old.textContent.includes('通道'));
  const alert=C.decisionCard({name:'合成提醒',title:'可减仓观察',action:'持有成本提醒',statementOnly:true},{alert:true,fund:signal});assert.match(alert.textContent,/提醒：减仓/);assert.match(alert.textContent,/持有成本提醒/);assert(!alert.textContent.includes('市场：可加仓'));
  assert.equal(C.cardState({unsupported:true,unsupportedReason:'scope_unsupported'}).market,'暂不支持');assert.equal(C.cardState({marketVerdict:'hold',verdict:'hold'}).constraint,null);
  const hostile=C.decisionCard({name:'<script>alert(1)</script>',detail:'<img onerror=alert(1)>'});assert.equal(hostile.children[0].children[0].children[0].tag,'span');assert.match(hostile.textContent,/<script>/);
  console.log('决策卡片：默认折叠、市场/执行分列、展开证据与日期、无分数、空判断、旧策略及提醒语义通过');
}
if(require.main===module)run();module.exports={run};

'use strict';
// Exercise the real renderer with a tiny DOM: status row (no <details>) vs detail sections; browser layout/keyboard are checked separately.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Node {constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.className='';this._text='';}appendChild(child){this.children.push(child);return child;}setAttribute(k,v){this.attrs[k]=String(v);}addEventListener(){}set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}}
function load(){const context=vm.createContext({document:{createElement:t=>new Node(t),createTextNode:text=>{const n=new Node('#text');n.textContent=text;return n;}}});
  const util=fs.readFileSync(path.join(__dirname,'../../public/js/util.js'),'utf8').replace(/export /g,'');vm.runInContext(util,context);
  // ★ 剥 import 行时行尾要容忍 CRLF：Windows 导出/检出后是 `;\r\n`，
  //   只写 `;\n` 会匹配不上（import 留在源码里 → 报 Cannot use import statement outside a module），
  //   而 Linux CI 是 LF 所以照绿 —— 属于只在 Windows 本地复现的假红。
  const src=fs.readFileSync(path.join(__dirname,'../../public/js/pages/decision-card.js'),'utf8').replace(/^import .*;\r?\n/m,'').replace(/export /g,'');vm.runInContext(src,context);return context;
}
function run(){
  const C=load();
  const signal={code:'999001',name:'合成基金',dayChange:1.23,marketVerdict:'add',verdict:'hold',executable:false,suspended:true,blockedReason:'purchase_suspended',marketStateLabel:'可加仓',score:90,valueScore:80,momentumScore:95,detail:'回撤恢复达标。综合分 90。估值分 80；动量分 95；申请日需复核。',factors:[{dim:'回撤',value:'达标'},{dim:'综合分',value:'90'}],signalNavDate:'2026-09-18',orderDate:'2026-09-24',matrix:{evidenceChecks:{identity:true,sampling:false,continuity:false,calendar:false}}};

  // ① 状态行：div（非 details）、名称/代码/涨跌/市场徽标/约束徽标齐全
  const card=C.decisionStatusCard(signal);
  assert.equal(card.tag,'div');assert(!/details/.test(card.tag));
  assert.equal(card.children[0].tag,'div');assert.equal(card.children[0].className,'dec-status-row');
  const rowText=card.textContent;
  assert.match(rowText,/合成基金/);assert.match(rowText,/999001/);assert.match(rowText,/市场：可加仓/);assert.match(rowText,/暂停申购/);assert.match(rowText,/\+1\.23%/);
  // 负向：详情不得残留在状态行（判断说明/数据日期/数据核验都不在）
  assert(!rowText.includes('回撤恢复达标'));assert(!rowText.includes('2026-09-18'));assert(!rowText.includes('日频采样完整性'));
  // dayChange 缺失降级为「—」
  assert.equal(C.decisionStatusCard({name:'缺涨跌',marketVerdict:'hold',verdict:'hold'}).textContent.includes('—'),true);

  // ② 详情段：只承接复盘页没渲染过的三段（数据核验 / 数据日期 / 交易限制）
  const detail=C.decisionDetailSections(signal);
  const dText=detail.textContent;
  assert.match(dText,/2026-09-18/);assert.match(dText,/日频采样完整性待核验/);assert.match(dText,/暂停申购/);
  // ★ 负向：复盘页已渲染过的「信号理由」与「因子表」不在这里重复，否则同一段文字会出现两次
  assert(!dText.includes('回撤恢复达标'));assert(!dText.includes('条件与指标'));
  assert(!/综合分|估值分|动量分|估80|动95/.test(dText));

  // ③ cardState 语义（无法判定 / 暂不支持 / constraint 为 null）
  const unknown=C.cardState({marketVerdict:null,verdict:'hold',executable:false});assert.equal(unknown.market,'无法判定');
  // 无 dataErrorLabel、无降级提示时「判断说明」段整段不出现（理由已交复盘页，这里不再重复）；有则照常出现
  assert(!C.decisionDetailSections({name:'未知',marketVerdict:null,verdict:null}).textContent.includes('判断说明'));
  assert.match(C.decisionDetailSections({name:'未知',marketVerdict:null,verdict:null,matrix:{dataErrorLabel:'数据日期缺失'}}).textContent,/数据日期缺失/);
  assert.equal(C.cardState({unsupported:true,unsupportedReason:'scope_unsupported'}).market,'暂不支持');
  assert.equal(C.cardState({marketVerdict:'hold',verdict:'hold'}).constraint,null);

  // 旧策略：状态行给市场/约束；详情段**不再**承接理由与因子（那两块归复盘页，避免重复渲染）
  const old=C.decisionStatusCard({name:'旧规则',marketVerdict:'add',verdict:'hold',suspended:true});
  assert.match(old.textContent,/市场：加仓/);assert.match(old.textContent,/暂停申购/);assert(!old.textContent.includes('通道'));
  const oldDetail=C.decisionDetailSections({name:'旧规则',marketVerdict:'add',verdict:'hold',suspended:true,detail:'双均线成立。',factors:[{dim:'PE分位',value:'低位'}]});
  assert(!oldDetail.textContent.includes('双均线成立'));assert(!oldDetail.textContent.includes('PE分位'));

  // ④ alert 路径：出「提醒：」而非「市场：」；详情段标题为「持有提醒」并收敛 action 文案
  const alert=C.decisionStatusCard({name:'合成提醒',title:'可减仓观察',action:'持有成本提醒',statementOnly:true},{alert:true,fund:signal});
  assert.match(alert.textContent,/提醒：减仓/);assert(!alert.textContent.includes('市场：可加仓'));
  // ★ alert 记录自身没有 dayChange，涨跌必须从 options.fund 取；用错来源会恒显示「—」。
  assert.match(alert.textContent,/\+1\.23%/);
  const alertDetail=C.decisionDetailSections({name:'合成提醒',title:'可减仓观察',action:'持有成本提醒',statementOnly:true},{alert:true,fund:signal});
  assert.match(alertDetail.textContent,/持有提醒/);assert.match(alertDetail.textContent,/持有成本提醒/);

  // ⑤ hostile 输入：标签串必须当文本
  const hostile=C.decisionStatusCard({name:'<script>alert(1)</script>',dayChange:null});
  assert.equal(hostile.children[0].children[0].children[0].tag,'span');assert.match(hostile.textContent,/<script>/);
  const hostileDetail=C.decisionDetailSections({name:'x',matrix:{dataErrorLabel:'<img onerror=alert(1)>'}});
  assert.match(hostileDetail.textContent,/<img onerror=alert\(1\)>/);

  console.log('决策状态行：div 非 details、名称/代码/涨跌/徽标齐备、详情已移至复盘段、无分数、alert 语义与 XSS 文本化通过');
}
if(require.main===module)run();module.exports={run};

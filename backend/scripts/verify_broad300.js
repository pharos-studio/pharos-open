'use strict';
const assert=require('node:assert/strict');
const S=require('../lib/hs300Signal'),C=require('../lib/hs300Calendar');
const {buildBroad300Decision,evaluate}=require('../engines/strategies/broad300');
const {resolveRegistry}=require('../engines/registry');
const {runDecisionPipeline}=require('../engines/decisionPipeline');
const F=require('./fixtures/hs300Inputs');
let checks=0;
function test(name,fn){fn();checks++;console.log('✓ '+name);}
test('共同25%、两通道并联去重及 ERP 无影响',()=>{
  const p=F.price(),pe={available:true,percentile:25};
  const r=S.evaluate(p,pe);assert.equal(r.route,'both');assert.equal(r.triggered,true);
  assert.equal(S.evaluate(p,{...pe,percentile:25+Number.EPSILON*100}).triggered,false);
  const f=F.fund();assert.equal(buildBroad300Decision(f,{}, {treasury10y:2}).action,'add');
  assert.equal(buildBroad300Decision(f,{}, {treasury10y:99}).action,'add');
  assert.equal(S.evaluate({...p,biases:{...p.biases,120:0}},pe).route,'trend');
  assert.equal(S.evaluate({...p,dip60:0},pe).route,'deep');
});
test('阈值使用原始精度，RSI持平不触发',()=>{
  const p=F.price({dip60:0}),pe={available:true,percentile:25};
  assert.equal(S.evaluate({...p,biases:{...p.biases,120:-3.0084}},pe).triggered,true);
  assert.equal(S.evaluate({...p,biases:{...p.biases,120:-3.008399}},pe).triggered,false);
  assert.equal(S.evaluate({...p,repairs:{...p.repairs,120:.999999}},pe).triggered,false);
  assert.equal(S.evaluate(F.price({rsis:{weekly:{14:{current:55,previous:55,count:60,valid:true}}}}),pe).triggered,false);
  for(const bound of [2,6]) assert.equal(S.evaluate(F.price({dip60:bound}),pe).trend.triggered,true);
  for(const bound of [45,65]) assert.equal(S.evaluate(F.price({rsis:{weekly:{14:{current:bound,previous:bound-1,count:60,valid:true}}}}),pe).trend.triggered,true);
});
test('月度PE严格比较、当前月排除、缺月不扩窗',()=>{
  const rows=Array.from({length:61},(_,i)=>({date:S.monthKey('2026-09-30',i-60)+'-15',pe:i<15?10:20}));
  rows.at(-1).pe=15;
  const last=S.preparePe(rows).at(-1);assert.equal(last.percentile,25);assert.equal(last.historyMonths,60);
  const changed=rows.map(r=>({...r,pe:15}));assert.equal(S.preparePe(changed).at(-1).percentile,0);
  assert.equal(S.preparePe(rows.filter((_,i)=>i!==30)).at(-1).percentile,null);
  assert.throws(()=>S.preparePe([...rows,rows[0]]),/duplicate/);
  const prepared=S.preparePe(rows);
  assert.equal(S.peAt(prepared,'2026-10-08',C.INDEX,'2026-10-01').date,'2026-09-15');
  assert.equal(S.peAt(prepared,'2026-12-01',C.INDEX).reason,'stale_pe');
});
test('核验日历、特殊休市、15点及查看时点',()=>{
  assert.equal(C.isOpen('2015-09-03'),false);assert.equal(C.isOpen('2020-01-31'),false);
  assert.equal(C.isOpen('2027-01-04'),null);
  assert.equal(C.isOpen('2026-99-99'),null);
  assert.equal(C.orderContext(Date.parse('2026-09-24T06:59:00Z')).orderDate,'2026-09-24');
  assert.equal(C.orderContext(Date.parse('2026-09-24T07:00:00Z')).orderDate,'2026-09-28');
  assert.equal(C.orderContext(Date.parse('2026-10-03T04:00:00Z')).knownThrough,'2026-10-03');
  const pe=[{date:'2026-09-30',pe:12,percentile:25}];
  assert.equal(S.peAt(pe,'2026-10-08',C.INDEX,'2026-10-03').available,false);
});
test('最新周公告等待可用上一周，不可压缩缺失周',()=>{
  const dates=C.DATA.openDates.filter(d=>d>='2025-01-01'&&d<='2026-09-24');
  const rows=dates.map((date,i)=>({date,close:100+i/100+Math.sin(i/10)}));
  const known=rows.filter(r=>C.INDEX.available(r.date)<='2026-09-24');
  const p=S.preparePrice(known,'2026-09-28',C.INDEX);
  assert.equal(p.available,true);assert.equal(p.weeklyDate,'2026-09-18');
  assert.equal(p.rsis.weekly[14].valid,true);
  assert.equal(S.preparePrice(known.filter(r=>r.date!=='2026-09-18'),'2026-09-28',C.INDEX).rsis.weekly[14].valid,false);
  assert.equal(S.preparePrice(known.slice(-259),'2026-09-28',C.INDEX).reason,'price_warmup');
});
test('旧入口、旧参数、人工分位不能恢复单通道',()=>{
  const f=F.fund();delete f._hs300Data;
  f.adjustedHistory=Array.from({length:300},(_,i)=>({date:'2026-01-01',close:100+i}));
  assert.equal(buildBroad300Decision(f,{[f.code]:{pePercentile:0}},{signals:{broad300:{biasPct:100}}}).action,null);
  assert.equal(evaluate({rows:f.adjustedHistory,pePercentile:0}).action,null);
  assert.equal(buildBroad300Decision(F.fund({profileState:'needs_review'})).matrix.marketStateLabel,'档案待确认');
  assert.equal(buildBroad300Decision(F.fund({_hs300Data:{error:'scope_unsupported'}})).matrix.marketStateLabel,'暂不支持');
  assert.equal(resolveRegistry(F.fund()).key,'broad:hs300');
  assert.equal(resolveRegistry(F.fund({indexCode:'000905',trackIndex:'SH000905'})).key,'broad');
  assert.equal(resolveRegistry(F.fund({indexCode:null,trackIndex:null,name:'疑似沪深300增强'})).key,'broad:hs300');
});
test('无判断保留null；暂停/过期/用户零/政策限制保留市场结果',()=>{
  const run=f=>runDecisionPipeline({allocation:[],policy:{core:'buy'},funds:[f],valuationMap:{},now:Date.UTC(2026,8,24,1),dailyLimits:{}}).scoreMap[f.code];
  const missing=run(F.fund({_hs300Data:{error:'price_warmup'}}));
  assert.equal(missing.marketVerdict,null);assert.equal(missing.verdict,null);assert.equal(missing.eligible,false);
  const suspended=run(F.fund({purchaseStatus:{state:'suspended',updatedAt:Date.UTC(2026,8,24,1)}}));
  assert.equal(suspended.marketVerdict,'add');assert.equal(suspended.verdict,'hold');assert.equal(suspended.executable,false);
  const stale=run(F.fund({purchaseStatus:{state:'open',updatedAt:0}}));
  assert.equal(stale.marketVerdict,'add');assert.equal(stale.blockedReason,'purchase_status_unverified');
  for(const policy of [{core:'buy'},{core:'frozen'}]){
    const f=F.fund(),m=runDecisionPipeline({allocation:[],policy,funds:[f],now:Date.UTC(2026,8,24,1),dailyLimits:policy.core==='buy'?{[f.code]:0}:{}}).scoreMap[f.code];
    assert.equal(m.marketVerdict,'add');assert.equal(m.executable,false);assert.equal(m.marketScore,null);
  }
});
console.log('沪深300双通道正式计算：'+checks+'组通过');

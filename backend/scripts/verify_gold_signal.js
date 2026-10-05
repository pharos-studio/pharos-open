'use strict';
const assert=require('node:assert/strict'),S=require('../lib/goldSignal'),F=require('../fixtures/goldInputs');
function run(){let checks=0;const equal=(a,b)=>{assert.deepEqual(a,b);checks++;};equal(S.and3([null,false]),false);equal(S.or3([null,true]),true);equal(S.or3([null,false]),null);equal(S.and3([true,null]),null);
  for(const [kind,n,expected] of [['flat',50,50],['up',50,100],['down',50,0]]){const s=S.state();for(let i=0;i<n;i++)S.push(s,kind==='flat'?100:kind==='up'?100+i:100-i);equal(s.rsi,expected);equal(s.previousRsi,expected);}
  const s=S.state();for(let i=0;i<129;i++){S.push(s,100+i%7);if(i===118)equal(S.indicators(s).bias120,null);if(i===127)equal(S.indicators(s).bias120Min10,null);}assert(S.finite(S.indicators(s).bias120Min10));checks++;
  const m={close:110,ma60:105,ma120:120,ma250:100,bias60:2,bias120:-5,bias120Min10:-6,rsi14:50,previousRsi14:49,drawdown60:3,recovery10:1.5};equal(S.rules(m).values,{A:true,B:true,OR:true});for(const [key,value,path] of [['rsi14',55,'A'],['rsi14',65,'B'],['rsi14',45,'B'],['drawdown60',10,'B']])equal(S.rules({...m,previousRsi14:44,[key]:value}).values[path],true);
  equal(S.rules({...m,rsi14:49}).values.OR,false);equal(S.rules({...m,bias120Min10:null,bias120:0}).values.A,false);equal(S.rules({...m,ma250:null}).values.OR,true);equal(S.rules({...m,bias120:null,bias120Min10:null,ma250:null}).values.OR,null);
  const before=S.analyze(F.rows());equal(before.values.A,true);const future=F.rows().concat([{date:'2026-09-24',close:1000}]);equal(S.analyze(future.slice(0,-1)),before);equal(S.analyze(F.rows('insufficient')).values.OR,null);const flat=S.state();for(let i=0;i<250;i++)S.push(flat,100);equal(S.indicators(flat).position250,0);assert.throws(()=>S.push(S.state(),NaN));assert.throws(()=>S.analyze([{date:'2026-02-30',close:1}]));checks+=2;
  console.log('黄金纯计算：'+checks+'边界、原精度、Wilder、129独立预热及三值检查通过');return checks;}
if(require.main===module)run();module.exports={run};

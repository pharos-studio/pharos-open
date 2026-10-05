'use strict';
// Frozen gold-dual-v1 arithmetic. Percentages are percentage points, not ratios.
// No network, clock, storage, or research dependency; preserve Wilder's full seed.
const VERSION='gold-dual-v1', INPUT_VERSION='gold-live-input-v1';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const and3=xs=>xs.includes(false)?false:xs.includes(null)?null:true;
const or3=xs=>xs.includes(true)?true:xs.includes(null)?null:false;
const compare=(xs,fn)=>xs.every(finite)?fn(...xs):null;
const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
function validDate(d){return typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;}
function state(){return {closes:[],biases:[],gain:null,loss:null,rsi:null,previousRsi:null};}
function rsi(g,l){return g===0&&l===0?50:l===0?100:g===0?0:100-100/(1+g/l);}
function push(s,close){if(!finite(close)||close<=0)throw Error('invalid_gold_close');const old=s.closes.at(-1);s.previousRsi=s.rsi;s.closes.push(close);const n=s.closes.length;
  if(n===15){const differences=s.closes.slice(1).map((x,i)=>x-s.closes[i]);s.gain=mean(differences.map(x=>Math.max(0,x)));s.loss=mean(differences.map(x=>Math.max(0,-x)));s.rsi=rsi(s.gain,s.loss);}
  else if(n>15){s.gain=(s.gain*13+Math.max(0,close-old))/14;s.loss=(s.loss*13+Math.max(0,old-close))/14;s.rsi=rsi(s.gain,s.loss);}
  if(n>=120)s.biases.push(100*(close/mean(s.closes.slice(-120))-1));return s;}
function indicators(s){const p=s.closes.at(-1)??null,n=s.closes.length,ma=N=>n>=N?mean(s.closes.slice(-N)):null,ma60=ma(60),ma120=ma(120),ma250=ma(250);
  return {segmentLength:n,close:p,ma60,ma120,ma250,bias60:compare([p,ma60],(a,b)=>100*(a/b-1)),bias120:compare([p,ma120],(a,b)=>100*(a/b-1)),bias120Min10:s.biases.length>=10?Math.min(...s.biases.slice(-10)):null,rsi14:s.rsi,previousRsi14:s.previousRsi,drawdown60:n>=60?100*(1-p/Math.max(...s.closes.slice(-60))):null,recovery10:n>=10?100*(p/Math.min(...s.closes.slice(-10))-1):null,position250:n>=250?100*s.closes.slice(-250).filter(x=>x<p).length/250:null};}
function rules(m){const rising=compare([m.rsi14,m.previousRsi14],(r,pr)=>r>pr);
  const A={negativeBias:compare([m.bias120],b=>b<=-5),biasRepair:compare([m.bias120,m.bias120Min10],(b,min)=>b-min>=1),rsiRising:rising,rsiCeiling:compare([m.rsi14],r=>r<=55)};
  const B={aboveLongMA:compare([m.close,m.ma250],(p,ma)=>p>ma),trendMA:compare([m.ma60,m.ma250],(s,l)=>s>l),drawdownRange:compare([m.drawdown60],d=>d>=3&&d<=10),recovery:compare([m.recovery10],r=>r>=1.5),biasCeiling:compare([m.bias60],b=>b<=2),rsiRange:compare([m.rsi14],r=>r>=45&&r<=65),rsiRising:rising};
  const a=and3(Object.values(A)),b=and3(Object.values(B)),missing={A:Object.entries(A).filter(([,v])=>v===null).map(([k])=>k),B:Object.entries(B).filter(([,v])=>v===null).map(([k])=>k)};
  return {conditions:{A,B},values:{A:a,B:b,OR:or3([a,b])},missingConditions:missing,allNecessaryIndicatorsFinite:missing.A.length===0&&missing.B.length===0,paths:[...(a===true?['A']:[]),...(b===true?['B']:[])]};}
function analyze(rows){const s=state();let previous='';for(const row of rows){if(!validDate(row.date)||row.date<=previous)throw Error('invalid_gold_dates');push(s,row.close);previous=row.date;}const m=indicators(s);return {date:rows.at(-1)?.date??null,metrics:m,...rules(m)};}
module.exports={VERSION,INPUT_VERSION,finite,and3,or3,compare,mean,validDate,state,push,indicators,rules,analyze};

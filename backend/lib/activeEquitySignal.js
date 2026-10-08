'use strict';
// Frozen BASE arithmetic. Every comparison uses unrounded prices and Wilder values.
const VERSION='active-equity-buy-v1',INPUT_VERSION='active-equity-live-input-v1';
const BASE=Object.freeze({id:'BASE',A:Object.freeze({ddWindow:120,ddMin:.15,biasWindow:120,biasMax:-.08,recoveryMin:.02,rsiPeriod:14,rsiMax:55}),B:Object.freeze({ddWindow:60,ddMin:.05,ddMax:.15,biasWindow:60,biasMax:0,recoveryMin:.02,rsiPeriod:14,rsiMin:40,rsiMax:60,maShort:60,maLong:250,slopeLag:20})});
function validDate(d){return typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(Date.parse(d+'T00:00:00Z')).toISOString().slice(0,10)===d;}
function instant(d){if(typeof d!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(d)||!Number.isFinite(Date.parse(d)))throw Error('EXPLICIT_TIMEZONE_REQUIRED');return Date.parse(d);}
function validateRows(rows){let previous='';for(const r of rows){if(!validDate(r.date))throw Error('INVALID_DATE');if(r.date<=previous)throw Error('ROWS_NOT_STRICTLY_SORTED');if(!Number.isFinite(r.P)||r.P<=0)throw Error('INVALID_PRICE');previous=r.date;}return rows;}
function wilder(prices,n){if(!Number.isInteger(n)||n<1)throw Error('INVALID_PERIOD');if(prices.some(p=>!Number.isFinite(p)||p<=0))throw Error('INVALID_PRICE');const values=Array(prices.length).fill(null);let gain=0,loss=0;for(let i=1;i<prices.length;i++){const d=prices[i]-prices[i-1];if(i<=n){gain+=Math.max(d,0);loss+=Math.max(-d,0);if(i<n)continue;gain/=n;loss/=n;}else{gain=(gain*(n-1)+Math.max(d,0))/n;loss=(loss*(n-1)+Math.max(-d,0))/n;}values[i]=gain===0&&loss===0?50:loss===0?100:gain===0?0:100-100/(1+gain/loss);}return values;}
function prepareSeries(rows){validateRows(rows);const prices=rows.map(r=>r.P),invalidDaily=[0],missingKnown=[0],latestKnown=[-Infinity];for(const r of rows){invalidDaily.push(invalidDaily.at(-1)+(r.dailyValid===true?0:1));missingKnown.push(missingKnown.at(-1)+(r.availableAt?0:1));latestKnown.push(Math.max(latestKnown.at(-1),r.availableAt?instant(r.availableAt):-Infinity));}return {rows,prices,invalidDaily,missingKnown,latestKnown,rsi:{14:wilder(prices,14)}};}
function windowMetrics(prepared,index,n){if(index+1<n)return null;const vals=prepared.prices.slice(index+1-n,index+1);let sum=0;for(const v of vals)sum+=v;const mean=sum/n;return {mean,drawdown:1-prepared.prices[index]/Math.max(...vals),bias:prepared.prices[index]/mean-1};}
function triOr(a,b){return a===true||b===true?true:a===false&&b===false?false:null;}
function pathAt(prepared,index,cfg,path,context){const rows=prepared.rows,row=rows[index],missing=[],need=path==='A'?120:270;
  if(index+1<need)missing.push('WARMUP_'+need);
  if(context.strategyStart&&rows[0]?.date!==context.strategyStart)missing.push('STRATEGY_SEED_NOT_AT_FIRST_ELIGIBLE_NAV');
  if(prepared.invalidDaily[index+1]>0)missing.push('DAILY_SAMPLING_UNVERIFIED');
  if(context.decisionAt&&(prepared.missingKnown[index+1]>0||prepared.latestKnown[index+1]>instant(context.decisionAt)))missing.push('DAILY_OBSERVATION_NOT_KNOWN_AT_DECISION');
  const dd=windowMetrics(prepared,index,cfg.ddWindow),bias=windowMetrics(prepared,index,cfg.biasWindow),r10=windowMetrics(prepared,index,10),rsi=prepared.rsi[14][index],previousRsi=prepared.rsi[14][index-1]??null;
  if(rsi===null||previousRsi===null)missing.push('RSI_CURRENT_PREVIOUS_MISSING');
  const long=path==='B'?windowMetrics(prepared,index,250):null,short=path==='B'?windowMetrics(prepared,index,60):null,lag=path==='B'?windowMetrics(prepared,index-20,250):null;
  const metrics={P:row.P,D:dd?.drawdown??null,BIAS:bias?.bias??null,R10:r10?row.P/Math.min(...prepared.prices.slice(index-9,index+1))-1:null,rsi,previousRsi,MA60:short?.mean??null,MA250:long?.mean??null,priorMA250:lag?.mean??null,position250:null};
  if(index>=249){const window=prepared.prices.slice(index-249,index+1);metrics.position250=window.filter(p=>p<=row.P).length/250;}
  if(missing.length)return {eligible:false,trigger:null,missing:[...new Set(missing)],warmup:need,metrics};
  const checks={drawdown:metrics.D>=cfg.ddMin&&(path==='A'||metrics.D<=cfg.ddMax),bias:metrics.BIAS<=cfg.biasMax,recovery:metrics.R10>=cfg.recoveryMin,rsi:rsi>previousRsi&&rsi<=cfg.rsiMax&&(path==='A'||rsi>=cfg.rsiMin)};
  if(path==='B'){checks.priceTrend=row.P>long.mean;checks.shortTrend=short.mean>long.mean;checks.longDirection=long.mean>lag.mean;}
  return {eligible:true,trigger:Object.values(checks).every(Boolean),missing:[],warmup:need,checks,metrics};
}
function analyzeAt(rows,index,config='BASE',context={}){if(!Number.isInteger(index)||index<0||index>=rows.length)throw Error('INVALID_INDEX');if(config!=='BASE'&&config?.id!=='BASE')throw Error('ONLY_FROZEN_BASE_SUPPORTED');const prepared=context.prepared??prepareSeries(rows);if(prepared.rows!==rows)throw Error('PREPARED_ROWS_MISMATCH');const A=pathAt(prepared,index,BASE.A,'A',context),B=pathAt(prepared,index,BASE.B,'B',context),trigger=triOr(A.trigger,B.trigger);return {configId:'BASE',date:rows[index].date,A,B,trigger,paths:['A','B'].filter(p=>({A,B})[p].trigger===true),eligible:trigger!==null,bothPathsEvaluable:A.eligible&&B.eligible};}
module.exports={VERSION,INPUT_VERSION,BASE,validDate,validateRows,wilder,prepareSeries,windowMetrics,triOr,analyzeAt};

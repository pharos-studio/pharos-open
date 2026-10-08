'use strict';
const DAY = 86400000;
function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const n = Date.parse(date + 'T00:00:00Z');
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === date;
}
function time(date) { if (!validDate(date)) throw new Error('invalid_date:' + date); return Date.parse(date + 'T00:00:00Z'); }
function distance(a, b) { return (time(b) - time(a)) / DAY; }
function addMonths(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  time(date);
  if (!Number.isInteger(months)) throw new Error('invalid_months');
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}
module.exports = { DAY, validDate, time, distance, addMonths };

const VERSION='nasdaq-dual-v1';
const BASE = Object.freeze({ peYears:3, peCap:25, drawBiasPeriod:120, drawBiasMax:-5,
  drawRepair:1, drawRsiFrequency:'week', drawRsiPeriod:14, drawRsiMax:55,
  trendPullbackMin:2, trendPullbackMax:8, trendRecovery:1.5, trendBiasMax:10,
  trendRsiFrequency:'week', trendRsiPeriod:14, trendRsiMin:45, trendRsiMax:65,
  trendMaSlopeLag:0, trendStack:false });
const positive = x => Number.isFinite(x) && x > 0;
function validateRows(rows) {
  if (!Array.isArray(rows)) throw new Error('invalid_rows');
  rows.forEach((r,i) => {
    if (!validDate(r.date) || !positive(r.close) || (i && r.date <= rows[i-1].date)) throw new Error('invalid_price_row:' + i);
  });
}
// Wilder seed uses the first N changes, not N closes. No seed is restarted.
function rsiSeries(rows, period) {
  const out = Array(rows.length).fill(null); let gain = 0, loss = 0;
  for (let i=1;i<rows.length;i++) {
    const delta = rows[i].close - rows[i-1].close, g = Math.max(0,delta), l = Math.max(0,-delta);
    if (i <= period) { gain += g / period; loss += l / period; }
    else { gain = (gain*(period-1)+g)/period; loss = (loss*(period-1)+l)/period; }
    if (i >= period) out[i] = gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100/(1+gain/loss);
  }
  return out;
}
function preparePrices(rows) {
  validateRows(rows);
  rows.forEach((r,i)=>{if(!positive(r.rawNav))throw new Error('invalid_raw_nav:'+i);});
  const periods=[60,120,250], rsis=Object.fromEntries([9,14,21].map(n=>[n,rsiSeries(rows,n)]));
  const sums={60:0,120:0,250:0}, out=[];
  for (let i=0;i<rows.length;i++) {
    const r=rows[i], ma={}, bias={}, biasRepair={}, rsi={}, rsiPrev={};
    for (const n of periods) {
      sums[n]+=r.close; if(i>=n)sums[n]-=rows[i-n].close;
      ma[n]=i+1>=n?sums[n]/n:null;
      bias[n]=ma[n]===null?null:100*(r.close/ma[n]-1);
      const previous=out.slice(Math.max(0,i-9),i).map(v=>v.bias[n]);
      biasRepair[n]=previous.length===9 && previous.every(Number.isFinite) && bias[n]!==null ? bias[n]-Math.min(bias[n],...previous):null;
    }
    for(const n of [9,14,21]) { rsi[n]=rsis[n][i]; rsiPrev[n]=i>0?rsis[n][i-1]:null; }
    const max60=i>=59?Math.max(...rows.slice(i-59,i+1).map(v=>v.close)):null;
    const min10=i>=9?Math.min(...rows.slice(i-9,i+1).map(v=>v.close)):null;
    const pricePercentile250=i>=249 ? 100*rows.slice(i-249,i+1).filter(v=>v.close<r.close).length/250:null;
    out.push({...r,count:i+1,ma,bias,biasRepair,pullback:max60===null?null:100*(max60-r.close)/max60,
      recovery:min10===null?null:100*(r.close/min10-1),max60,min10,pricePercentile250,
      pricePercentile250Definition:'strict_lower_including_current_250',ma250Lag20:i>=20?out[i-20].ma[250]:null,rsi,rsiPrev});
  }
  return out;
}
function prepareWeeks(rows) {
  validateRows(rows);
  const series=Object.fromEntries([9,14,21].map(n=>[n,rsiSeries(rows,n)]));
  return rows.map((r,i)=>({...r,count:i+1,rsi:Object.fromEntries([9,14,21].map(n=>[n,series[n][i]])),
    rsiPrev:Object.fromEntries([9,14,21].map(n=>[n,i>0?series[n][i-1]:null]))}));
}
function pePercentile(rows,idx,years) {
  const current=rows?.[idx], result={state:'unknown',percentile:null,n:0,reason:null,observationDate:current?.date??null,windowStart:null};
  const fail=reason=>({...result,reason});
  if(![3,5].includes(years)||!Number.isInteger(idx)||idx<0||!current||!validDate(current.date))return fail('invalid_pe_input');
  result.windowStart=addMonths(current.date,-12*years);
  const prefix=rows.slice(0,idx+1), seen=new Map(), unique=[];
  for(const r of prefix) {
    if(!validDate(r.date))return fail('invalid_pe_date');
    if(r.date>current.date)return fail('unordered_pe');
    if(unique.length && r.date<unique.at(-1).date)return fail('unordered_pe');
    if(seen.has(r.date)) {
      if(seen.get(r.date)!==r.pe && r.date>=addMonths(result.windowStart,-1))return fail('conflicting_pe_duplicate');
      continue;
    }
    seen.set(r.date,r.pe); unique.push(r);
  }
  const anchor=unique.filter(r=>r.date<=result.windowStart).at(-1);
  if(!anchor || distance(anchor.date,result.windowStart)>21)return fail('missing_window_boundary');
  const relevant=unique.filter(r=>r.date>=anchor.date && r.date<=current.date);
  if(relevant.some(r=>!positive(r.pe)))return fail('invalid_pe_value');
  if(relevant.some((r,i)=>i>0 && distance(relevant[i-1].date,r.date)>21))return fail('pe_gap_over_21d');
  const history=unique.filter(r=>r.date>=result.windowStart && r.date<current.date);
  result.n=history.length;
  if(result.n<(years===3?141:234))return fail('insufficient_pe_observations');
  const intervals=relevant.slice(1).map((r,i)=>distance(relevant[i].date,r.date));
  return {...result,state:'ready',percentile:100*history.filter(r=>r.pe<current.pe).length/history.length,reason:null,
    boundaryDate:anchor.date,minIntervalDays:Math.min(...intervals),maxIntervalDays:Math.max(...intervals),
    duplicateCount:prefix.length-unique.length};
}
function evaluate({price,week,pe,quality={}},params=BASE) {
  const p={...BASE,...params};
  function path(kind) {
    const conditions={}, needed=[];
    function condition(name,value,test) { conditions[name]={value,pass:Number.isFinite(value)?!!test(value):null}; if(!Number.isFinite(value))needed.push(name); }
    if(!price || quality.prices!==true || price.count<260)return {state:'unknown',conditions,reason:quality.reason||'price_quality_or_warmup'};
    const freq=p[kind+'RsiFrequency'], n=p[kind+'RsiPeriod'], source=freq==='week'?week:price;
    if(freq==='week' && (quality.weeks!==true || !source || source.count<n+2))needed.push('weekly_quality_or_warmup');
    const rsi=source?.rsi?.[n], prev=source?.rsiPrev?.[n];
    if(kind==='draw') {
      if(pe?.state!=='ready')needed.push('pe_quality');
      condition('pePercentile',pe?.state==='ready'?pe.percentile:null,v=>v<=p.peCap);
      condition('bias',price.bias?.[p.drawBiasPeriod],v=>v<=p.drawBiasMax);
      condition('biasRepair',price.biasRepair?.[p.drawBiasPeriod],v=>v>=p.drawRepair);
      condition('rsiCeiling',rsi,v=>v<=p.drawRsiMax);
    } else {
      condition('priceAboveMa250',price.close,v=>Number.isFinite(price.ma?.[250]) && v>price.ma[250]);
      condition('ma60AboveMa250',price.ma?.[60],v=>Number.isFinite(price.ma?.[250]) && v>price.ma[250]);
      if(!Number.isFinite(price.ma?.[250]))needed.push('ma250');
      condition('pullback',price.pullback,v=>v>=p.trendPullbackMin && v<=p.trendPullbackMax);
      condition('recovery',price.recovery,v=>v>=p.trendRecovery);
      condition('bias',price.bias?.[250],v=>v<=p.trendBiasMax);
      condition('rsiRange',rsi,v=>v>=p.trendRsiMin && v<=p.trendRsiMax);
      if(p.trendMaSlopeLag) {
        if(p.trendMaSlopeLag!==20)throw new Error('unsupported_ma_slope_lag');
        condition('ma250Lag20',price.ma250Lag20,v=>price.ma[250]>v);
        if(price.count<270)needed.push('ma_slope_warmup');
      }
      if(p.trendStack)condition('maStack120',price.ma?.[120],v=>price.ma[60]>v && v>price.ma[250]);
    }
    condition('rsiRising',rsi,v=>Number.isFinite(prev) && v>prev);
    if(!Number.isFinite(prev))needed.push('previous_rsi');
    if(needed.length)return {state:'unknown',conditions,reason:[...new Set(needed)].join(',')};
    return {state:Object.values(conditions).every(c=>c.pass)?'buy':'hold',conditions,reason:null};
  }
  const draw=path('draw'),trend=path('trend'),paths=[];
  if(draw.state==='buy')paths.push('draw'); if(trend.state==='buy')paths.push('trend');
  const state=paths.length?'buy':draw.state==='hold'&&trend.state==='hold'?'hold':'unknown';
  return {state,draw,trend,paths,indicators:{price:price??null,week:week??null,pe:pe??null}};
}
module.exports={VERSION,validDate,time,distance,addMonths,BASE,preparePrices,prepareWeeks,pePercentile,evaluate,rsiSeries};

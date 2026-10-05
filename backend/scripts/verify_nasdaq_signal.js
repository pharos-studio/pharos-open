'use strict';
const assert=require('node:assert/strict'),S=require('../lib/nasdaqSignal'),F=require('../fixtures/nasdaqInputs');
function evaluate(kind){const i=F.input('999001',kind);return S.evaluate(i);}
assert.equal(evaluate('both').state,'buy');assert.deepEqual(evaluate('both').paths,['draw','trend']);
assert.equal(evaluate('waiting').state,'hold');assert.equal(evaluate('unknown').state,'unknown');
assert.equal(evaluate('missingPe').state,'buy');assert.equal(evaluate('missingPe').draw.state,'unknown');
const edge=F.input();edge.week.rsi[14]=50;edge.week.rsiPrev[14]=50;assert.equal(S.evaluate(edge).state,'hold');
edge.week.rsi[14]=50+1e-14;assert.equal(S.evaluate(edge).trend.state,'buy');
edge.price.pullback=8;edge.price.recovery=1.5;edge.price.bias[250]=10;edge.week.rsi[14]=65;edge.week.rsiPrev[14]=64;
assert.equal(S.evaluate(edge).trend.state,'buy');edge.price.pullback=8+1e-12;assert.equal(S.evaluate(edge).trend.state,'hold');
assert.equal(S.addMonths('2024-02-29',-36),'2021-02-28');
const rows=Array.from({length:180},(_,i)=>({date:new Date(Date.parse('2026-09-18T00:00:00Z')-(179-i)*7*86400000).toISOString().slice(0,10),pe:10+i}));
const result=S.pePercentile(rows,rows.length-1,3);assert.equal(result.state,'ready');assert.equal(result.percentile,100);
assert.equal(result.n,rows.filter(r=>r.date>=result.windowStart&&r.date<rows.at(-1).date).length);
const duplicate=rows.slice();duplicate.splice(175,0,{...rows[175],pe:0});assert.equal(S.pePercentile(duplicate,duplicate.length-1,3).state,'unknown');
const series=Array.from({length:400},(_,i)=>({date:new Date(Date.UTC(2024,0,1)+i*86400000).toISOString().slice(0,10),close:100+i%17,rawNav:100+i%17}));
const prepared=S.preparePrices(series);assert.equal(prepared[258].biasRepair[250],prepared[258].bias[250]-Math.min(...prepared.slice(249,259).map(r=>r.bias[250])));
assert.deepEqual(S.rsiSeries([{close:100},{close:110},{close:100},{close:110}],2),[null,null,50,75]);
console.log('纳指数学：三态OR、包含边界、严格RSI微幅回升、三自然年PE及Wilder种子通过');

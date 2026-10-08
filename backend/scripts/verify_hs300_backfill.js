'use strict';
const assert=require('node:assert/strict'),T=require('../engines/timing'),C=require('../lib/hs300Calendar');
const service=require('../services/hs300Data'),VERSION=require('../lib/hs300Signal').VERSION;
async function run() {
  let today='2026-10-15';
  const old={type:'advice-open',code:'999001',eventDate:'2026-09-01',campaign:{id:'legacy'},backfill:'done',navRef:{T:{nav:99}}};
  const input=[structuredClone(old),{type:'advice-open',code:'999001',strategyVersion:VERSION,eventDate:'2026-09-25',
    orderDate:'2026-09-28',backfill:'pending',campaign:{id:'999001#'+VERSION+'#2026-09-25'}}];
  const db={'timing_samples.json':input};
  const rows=C.DATA.openDates.filter(d=>d>='2026-09-24'&&d<='2026-12-01').map((date,i)=>({date,nav:100+i,dayChange:null}));
  const original=service.fetchFull;
  service.fetchFull=async()=>({history:rows,actions:{dividends:[],splits:[]}});
  T._forTest({today:()=>today,read:k=>db[k],write:(k,v)=>{db[k]=v;return true;}});
  try {
    await T.runBackfill({});assert.equal(db['timing_samples.json'][1].backfill,'partial');
    assert.equal(db['timing_samples.json'][1].navRef.T.date,'2026-09-28');
    today='2026-12-01';await T.runBackfill({});
    assert.equal(db['timing_samples.json'][1].backfill,'done');
    assert.match(db['timing_samples.json'][1].returnBasis,/fees excluded/);
    assert.deepEqual(db['timing_samples.json'][0],old);
    const before=structuredClone(db['timing_samples.json'][1]);
    db['timing_samples.json'][1]={...before,orderDate:'2026-09-25',backfill:'pending',navRef:null}; // market holiday, no NAV
    await T.runBackfill({});assert.equal(db['timing_samples.json'][1].backfill,'pending');
    assert.equal(db['timing_samples.json'][1].navRef,null);
    console.log('沪深300T+30：申请日严格匹配、未来净值排除、partial继续成熟、旧样本不改');
  }finally{service.fetchFull=original;T._forTest();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});

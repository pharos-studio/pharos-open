'use strict';
const assert=require('node:assert/strict'),T=require('../engines/timing'),C=require('../lib/nasdaqCalendar'),F=require('../fixtures/nasdaqInputs');
const service=require('../services/nasdaqData'),identity=require('../services/nasdaqIdentity'),VERSION=require('../lib/nasdaqSignal').VERSION;
async function run(){
  let today='2026-10-15',missing=false;
  const old={type:'buy',code:'999001',eventDate:'2026-09-01',backfill:'done',navRef:{T:{nav:99}}};
  const samples=[structuredClone(old),{type:'advice-open',code:'999001',strategyVersion:VERSION,eventDate:'2026-09-24',orderDate:'2026-09-28',backfill:'pending'},
    {type:'buy',code:'999001',strategyVersion:VERSION,eventDate:'2026-09-28',orderDate:'2026-09-28',pricingDate:'2026-09-29',purchaseConfirmed:true,backfill:'pending'},
    {type:'buy',code:'999001',strategyVersion:VERSION,eventDate:'2026-09-28',pricingDate:null,purchaseConfirmed:false,backfill:'pending'}];
  const db={'timing_samples.json':samples},rows=C.DATES.joint.filter(d=>d>='2026-09-24'&&d<='2026-12-01').map((date,i)=>({date,nav:100+i,dayChange:null}));
  const saved=service.fetchFull,savedIdentity=identity.resolve;
  service.fetchFull=async()=>({history:missing?rows.filter(r=>r.date!=='2026-10-09'):rows,actions:{identityVerified:true,dividends:[],splits:[]}});
  identity.resolve=async()=>({evidence:F.evidence()});
  T._forTest({today:()=>today,read:k=>db[k],write:(k,v)=>{db[k]=v;return true;}});
  try{
    await T.runBackfill({});assert.equal(samples[1].backfill,'partial');assert.equal(samples[1].navRef.T.date,'2026-09-28');
    assert.equal(samples[2].navRef.T.date,'2026-09-29');assert.equal(samples[3].backfill,'pending');
    today='2026-12-01';missing=true;await T.runBackfill({});assert.equal(samples[1].backfill,'partial','missing expected NAV must not compress T30');
    missing=false;await T.runBackfill({});assert.equal(samples[1].backfill,'done');assert.equal(samples[2].backfill,'done');
    assert.equal(samples[3].backfill,'pending');assert.deepEqual(samples[0],old);
    assert.match(samples[2].returnBasis,/fees excluded/);
    const beyond=C.DATES.joint.filter(d=>d>='2026-12-01').concat(Array.from({length:60},(_,i)=>new Date(Date.parse('2027-01-04T00:00:00Z')+i*86400000).toISOString().slice(0,10)));
    const futureSample={type:'buy',code:'999001',strategyVersion:VERSION,eventDate:'2026-12-01',pricingDate:'2026-12-01',purchaseConfirmed:true,backfill:'pending'};
    db['timing_samples.json']=[structuredClone(old),futureSample];today='2027-03-31';
    service.fetchFull=async()=>({history:beyond.map((date,i)=>({date,nav:100+i,dayChange:null})),actions:{identityVerified:true,dividends:[],splits:[]}});
    await T.runBackfill({});assert.equal(futureSample.backfill,'pending');assert.equal(futureSample.navRef,undefined);
    console.log('纳指T+30：真实定价日、未来数据排除、缺日不压缩、partial成熟及旧样本不改通过');
  }finally{service.fetchFull=saved;identity.resolve=savedIdentity;T._forTest();}
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={run};

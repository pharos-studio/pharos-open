'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const F=require('../fixtures/nasdaqInputs'),C=require('../lib/nasdaqCalendar'),S=require('../lib/nasdaqSignal'),N=require('../lib/nasdaqNav');
const D=require('../services/nasdaqData'),P=require('../services/nasdaqPe'),I=require('../services/nasdaqIdentity');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const actions={dividends:[],splits:[],identityVerified:true,sourceUrl:'https://example.invalid/actions'};
const history=C.DATES.joint.filter(d=>d>='2024-01-02'&&d<='2026-09-22').map((date,i)=>({date,nav:100+i/100,dayChange:null,navType:'1'}));
const peRows=Array.from({length:180},(_,i)=>({date:new Date(Date.parse('2026-09-18T00:00:00Z')-(179-i)*7*86400000).toISOString().slice(0,10),pe:20+i/100}));
async function run(){let checks=0;const test=async(fn)=>{await fn();checks++;};
  await test(()=>{assert(!C.DATES.cn.includes('2018-12-31'));assert(C.DATES.us.includes('2018-12-31'));
    assert(!C.DATES.us.includes('2025-01-09'));assert(C.DATES.joint.includes('2026-10-08'));assert(!C.DATES.cn.includes('2026-10-10'));});
  await test(()=>{const e=F.evidence(),context=C.orderContext(F.NOW,e),data={history,actions,fetchedAt:F.NOW-1,source:'synthetic'},pe={rows:peRows,fetchedAt:F.NOW-1};
    const input=D.prepareInput(data,pe,e,context);assert.equal(input.price.date,'2026-09-22');assert.equal(input.week.date,'2026-09-18');
    assert(input.waitingForPublication.includes('2026-09-23'));assert.equal(input.quality.prices,true);
    const holiday=C.orderContext(Date.parse('2026-10-04T05:00:00Z'),e);assert.equal(holiday.orderDate,'2026-10-08');assert.equal(holiday.futureOrder,true);
    const missing=D.prepareInput({...data,history:history.filter(r=>r.date!=='2025-07-10')},pe,e,context);assert.equal(missing.quality.prices,false);assert.match(missing.quality.reason,/expected_nav_gap/);
    assert.equal(D.prepareInput({...data,fetchedAt:F.NOW-3600000},pe,e,context).error,'nav_snapshot_not_current');
    assert.equal(D.prepareInput(data,pe,{...e,initializationFrom:'2010-01-04'},context).error,'initialization_history_missing');
    assert.equal(P.atSnapshot({...pe,rows:[null]},context).state,'unknown');
    assert.equal(P.atSnapshot({...pe,rows:[...peRows,{date:'2026-09-25',pe:20}]},context).reason,'future_pe_observation');});
  await test(()=>{assert.equal(N.adjust(history,{...actions,identityVerified:false},'999001').error,'corporate_action_identity_unverified');
    assert.equal(N.adjust(history.map((r,i)=>i===100?{...r,dayChange:20}:r),actions,'999001').error,'reported_return_mismatch');
    const extra=[{date:'2026-09-24',nav:100,dayChange:null},{date:'2026-09-25',nav:99,dayChange:-1},{date:'2026-09-28',nav:100,dayChange:null}];
    assert.equal(N.adjust(extra,actions,'999001').rows.length,3);});
  await test(async()=>{let clock=1000,calls=0,writes=0,active=0,max=0;
    const rows=C.DATES.joint.filter(d=>d<='2026-09-22').slice(-2801).map((date,i)=>({date,nav:100+i/100})).reverse();
    const svc=D.createService({read:()=>null,write:()=>writes++,now:()=>clock,fetchActions:async()=>actions,fetchText:async url=>{
      calls++;active++;max=Math.max(active,max);await new Promise(r=>setImmediate(r));active--;
      const page=Number(new URL(url).searchParams.get('pageIndex'));return JSON.stringify({TotalCount:rows.length,Data:{LSJZList:rows.slice((page-1)*20,page*20).map(r=>({FSRQ:r.date,DWJZ:r.nav,JZZZL:'',NAVTYPE:'1'}))}});}});
    const [a,b]=await Promise.all([svc.fetchFull('999001'),svc.fetchFull('999001')]);assert.strictEqual(a,b);assert.equal(a.history.length,2801);assert.equal(calls,141);assert.equal(writes,1);assert(max<=4);
    clock+=3599000;await svc.fetchFull('999001');assert.equal(calls,141);
    clock+=2000;await svc.fetchFull('999001');assert(calls<150); // complete overlap allows incremental, same action hash
    clock+=86400001;const before=calls;await svc.fetchFull('999001');assert.equal(calls-before,141);
  });
  await test(async()=>{let clock=1000,calls=0,writes=0;const svc=D.createService({read:()=>null,write:()=>writes++,now:()=>clock,fetchActions:async()=>actions,
    fetchText:async()=>{calls++;return JSON.stringify({TotalCount:21,Data:{LSJZList:[{FSRQ:'2026-09-22',DWJZ:100,JZZZL:'',NAVTYPE:'1'}]}});}});
    await assert.rejects(svc.fetchFull('999001'),/coverage/);assert.equal(writes,0);const before=calls;
    await assert.rejects(svc.fetchFull('999001'));assert.equal(calls,before);clock+=300001;await assert.rejects(svc.fetchFull('999001'));assert(calls>before);});
  await test(async()=>{let calls=0;const bad=[null],svc=P.createService({now:()=>F.NOW,write:()=>{},read:()=>({version:1,rows:bad,checksum:hash(bad),fetchedAt:F.NOW,source:P.SOURCE}),fetchRows:async()=>{calls++;return peRows;}});
    const result=await svc.fetchFull();assert.equal(calls,1);assert.equal(result.rows.length,180);
    const fail=P.createService({read:()=>null,write:()=>{throw Error('must not write');},fetchRows:async()=>[null]});await assert.rejects(fail.fetchFull(),/invalid_pe/);});
  await test(async()=>{let clock=Date.parse('2026-09-24T06:59:00Z');const e=F.evidence(),svc=D.createService({read:()=>null,write:()=>{},now:()=>clock,identity:{resolve:async()=>({evidence:e})},
    fetchActions:async()=>actions,peService:{fetchFull:async()=>{clock=Date.parse('2026-09-24T07:01:00Z');throw Error('PE unavailable');}},
    fetchText:async url=>{const page=Number(new URL(url).searchParams.get('pageIndex')),rows=history.slice().reverse();return JSON.stringify({TotalCount:rows.length,
      Data:{LSJZList:rows.slice((page-1)*20,page*20).map(r=>({FSRQ:r.date,DWJZ:r.nav,JZZZL:'',NAVTYPE:'1'}))}});}});
    const input=await svc.forFund({code:'999001'});assert.equal(input.context.orderDate,'2026-09-28');assert.equal(input.context.futureOrder,true);
    assert.equal(input.quality.prices,true);assert.equal(input.pe.state,'unknown');
    const final=D.revalidateInput(input,clock+1000);assert.equal(final.context.knownAt,clock+1000);
    assert.equal(D.revalidateInput(input,clock-1).error,'historical_asof_not_supported');});
  await test(async()=>{const service=I.createService({resolveOfficial:async code=>({...F.evidence(code),currency:'USD'})});assert.equal((await service.resolve('999001')).error,'scope_unsupported');
    assert.equal((await I.createService({resolveOfficial:async()=>null}).resolve('999001')).error,'profile_unverified');
    for(const code of ['270042','160213','161130','015299','015300','016452','018966']){
      const real=await I.resolve(code);assert.equal(real.error,undefined);assert.equal(real.evidence.identityVerified,true);
      assert.equal(C.validContract(real.evidence),true);
    }
    for(const code of ['040046','000834']){const real=await I.resolve(code);assert.equal(real.error,undefined);
      assert.equal(C.orderContext(F.NOW,real.evidence).error,'fund_calendar_unverified');}
    assert.equal((await I.resolve('008971')).error,'index_continuity_unverified');
  });
  await test(async()=>{let clock=F.NOW,rows=history.slice().reverse();const e={...F.evidence(),initializationFrom:null,seedEstablishedOn:null,
      initializationPolicy:'first-ten-joint',identityNotBefore:'2024-01-02'};
    assert.deepEqual(C.findInitialSeed(history,e.identityNotBefore),{seedDate:'2024-01-02',seedEstablishedOn:'2024-01-17'});
    const service=D.createService({now:()=>clock,read:()=>null,write:()=>{},identity:{resolve:async()=>({evidence:e})},fetchActions:async()=>actions,
      fetchText:async url=>{const p=Number(new URL(url).searchParams.get('pageIndex'));return JSON.stringify({TotalCount:rows.length,
        Data:{LSJZList:rows.slice((p-1)*20,p*20).map(r=>({FSRQ:r.date,DWJZ:r.nav,JZZZL:'',NAVTYPE:'1'}))}});}});
    const first=await service.fetchFull('999001');assert.equal(first.initialization.seedDate,'2024-01-02');
    rows.push({date:'2023-12-29',nav:100,dayChange:null});clock+=86400001;const next=await service.fetchFull('999001');
    assert.deepEqual(next.initialization,first.initialization,'new earlier rows must not re-seed established share class');
    const input=D.prepareInput(first,{rows:peRows,fetchedAt:F.NOW},e,C.orderContext(F.NOW,e));assert.equal(input.initializationFrom,'2024-01-02');
    assert(!JSON.stringify(input).includes('originHistory'),'runtime origin history must not enter public analysis input');
    const earlier=D.prepareInput(next,{rows:peRows,fetchedAt:clock},e,C.orderContext(clock,e));assert.equal(earlier.error,'pre_identity_nav_observation');
    const ledger=require('../data/nasdaqIdentity.json');assert.equal(ledger.funds.find(f=>f.code==='016452').rulesVerified,true);
    assert.equal(ledger.funds.find(f=>f.code==='018966').rulesVerified,true);
    assert.equal(ledger.funds.find(f=>f.code==='040046').rulesVerified,false);
  });
  await test(async()=>{const e={...F.evidence(),initializationFrom:null,seedEstablishedOn:null,initializationPolicy:'first-ten-joint',identityNotBefore:'2024-01-02'};
    const raw=history.map(r=>({...r,rawFields:{FSRQ:r.date,DWJZ:r.nav,JZZZL:'',NAVTYPE:'1'}})).reverse();
    const init={...C.findInitialSeed(raw,e.identityNotBefore),code:e.code,source:'https://fundf10.eastmoney.com/jjjz_999001.html',
      establishedAt:F.NOW-1,establishedFromChecksum:hash(raw),originHistory:raw};
    const base={version:1,code:e.code,source:init.source,history:raw,total:raw.length,checksum:hash(raw),
      actions:{...actions,code:e.code,sourceUrl:'https://fundf10.eastmoney.com/fhsp_999001.html'},fetchedAt:F.NOW-1,fullCheckedAt:F.NOW-1,
      initialization:init,initializationChecksum:hash(init)};base.actionsHash=hash(base.actions);
    const service=cache=>D.createService({now:()=>F.NOW,read:()=>cache,write:()=>{throw Error('unexpected write');},
      fetchText:()=>{throw Error('unexpected request');},identity:{resolve:async()=>({evidence:e})}});
    assert.strictEqual(await service(base).fetchFull(e.code),base,'valid persisted origin proof may use success cache');
    const mutations=[c=>{c.initialization.establishedAt=F.NOW+1;},c=>{c.initialization.establishedFromChecksum='wrong';},
      c=>{c.initialization.seedDate='2025-06-03';c.initialization.seedEstablishedOn='2025-06-18';},
      c=>{c.initialization.establishedAt=Date.parse('2024-01-16T04:00:00Z');},c=>{delete c.initialization;}];
    for(const mutate of mutations){const bad=structuredClone(base);mutate(bad);if(bad.initialization)bad.initializationChecksum=hash(bad.initialization);
      await assert.rejects(service(bad).fetchFull(e.code),/initialization_/);}
    const changed=structuredClone(base);changed.initialization.originHistory=structuredClone(base.initialization.originHistory);
    const r=changed.history.find(r=>r.date===init.seedDate);r.nav+=1;r.rawFields.DWJZ=r.nav;
    changed.checksum=hash(changed.history); // current source changed, origin proof must not silently become a different seed
    assert.equal(D.initializationError(changed,e,F.NOW),'initialization_source_revision_conflict');
  });
  await test(()=>{assert.equal(D.coverageGap([],F.evidence(),'2027-01-04','2027-02-10'),'calendar_coverage_short');
    assert.equal(D.coverageGap([],F.evidence(),'2026-12-01','2027-01-04'),'calendar_coverage_short');
    assert.equal(D.coverageGap([],F.evidence(),'2026-02-30','2026-03-01'),'invalid_coverage_interval');
    const e={...F.evidence(),statutoryDates:['12-31']},dates=[...new Set(C.DATES.joint.filter(d=>d>='2022-01-03'&&d<='2023-12-29').concat(['2022-12-31']))].sort();
    const rows=dates.map((date,i)=>({date,close:100+i/100,rawNav:100+i/100}));
    const saturday=C.selectKnown(rows,e,C.orderContext(Date.parse('2023-12-30T04:00:00Z'),e));
    assert.equal(saturday.week.date,'2023-12-22');assert.equal(saturday.quality.prices,true,'future statutory day is not a current price gap');
    const waiting=C.selectKnown(rows,e,C.orderContext(Date.parse('2024-01-01T04:00:00Z'),e));assert.equal(waiting.week.date,'2023-12-22');
    const complete=C.selectKnown(rows.concat({date:'2023-12-31',close:110,rawNav:110}),e,C.orderContext(Date.parse('2024-01-01T04:00:00Z'),e));
    assert.equal(complete.week.date,'2023-12-31');assert.equal(complete.week.completedOn,'2023-12-31');
    const sat2022=C.selectKnown(rows.filter(r=>r.date<='2022-12-31'),e,C.orderContext(Date.parse('2023-01-01T04:00:00Z'),e));
    assert.equal(sat2022.week.date,'2022-12-31');assert.equal(sat2022.week.completedOn,'2022-12-31');
  });
  await test(async()=>{let clock=F.NOW,rows=history.filter(r=>r.date>='2024-01-04').slice().reverse();
    const e={...F.evidence(),initializationFrom:null,seedEstablishedOn:null,initializationPolicy:'first-ten-joint',identityNotBefore:'2024-01-02'},
      request=async url=>{const p=Number(new URL(url).searchParams.get('pageIndex'));return JSON.stringify({TotalCount:rows.length,
        Data:{LSJZList:rows.slice((p-1)*20,p*20).map(r=>({FSRQ:r.date,DWJZ:r.nav,JZZZL:'',NAVTYPE:'1'}))}});};
    const options={now:()=>clock,write:()=>{},identity:{resolve:async()=>({evidence:e})},fetchText:request,
      fetchActions:async()=>({...actions,code:e.code,sourceUrl:'https://fundf10.eastmoney.com/fhsp_999001.html'})};
    const first=await D.createService({...options,read:()=>null}).fetchFull(e.code);assert.equal(first.initialization.seedDate,'2024-01-04');
    rows=history.slice().reverse();clock+=86400001;
    const damagedPayload={...first,checksum:'corrupt-current-payload-but-origin-intact'};
    const repaired=await D.createService({...options,read:()=>damagedPayload}).fetchFull(e.code);
    assert.equal(C.findInitialSeed(rows,e.identityNotBefore).seedDate,'2024-01-02');
    assert.deepEqual(repaired.initialization,first.initialization,'valid origin persists even if current payload needs complete refresh');
    assert.equal(D.prepareInput(repaired,{rows:peRows,fetchedAt:clock},e,C.orderContext(clock,e)).initializationFrom,'2024-01-04');
  });
  console.log('纳指完整数据/实时知悉：'+checks+'组通过（分页有界、缓存失败、固定种子、完成周、缺PE独立、跨15点）');
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});module.exports={run};

'use strict';
const assert=require('node:assert/strict');
const C=require('../lib/hs300Calendar'),S=require('../lib/hs300Signal');
const F=require('./fixtures/hs300Inputs');
const {createService,prepareInput}=require('../services/hs300Data');
const {createService:createPe}=require('../services/hs300Pe');
const {createService:createIdentity,parseOfficial}=require('../services/hs300Identity');
async function run() {
  let count=0;
  const test=async(name,fn)=>{await fn();count++;console.log('✓ '+name);};
  const dates=C.DATA.openDates.filter(d=>d>='2025-01-01'&&d<='2026-09-24');
  const rows=dates.map((date,i)=>({date,nav:100+i/100,acc:null,dayChange:null})).reverse();
  const actions={dividends:[],splits:[],sourceUrl:'https://fundf10.eastmoney.com/'};
  const ev={...F.evidence('999001'),effectiveDate:dates[0]};
  const monthly=Array.from({length:70},(_,i)=>({date:S.monthKey('2026-08-31',i-69)+'-28',pe:20-i/100}));
  const peData={rows:monthly,source:'synthetic'};
  const context=C.orderContext(Date.parse('2026-09-24T03:00:00Z'));
  await test('完整分页超过2600行、并发单飞、完整校验后才写缓存',async()=>{
    const large=C.DATA.openDates.filter(d=>d<='2026-09-24').slice(-2801).map((date,i)=>({date,nav:100+i/100,acc:null,dayChange:null})).reverse();
    let calls=0,writes=0;
    const svc=createService({read:()=>null,write:()=>writes++,now:()=>100000,
      fetchActions:async()=>actions,fetchText:async url=>{calls++;const n=Number(new URL(url).searchParams.get('pageIndex'));
        return JSON.stringify({TotalCount:large.length,Data:{LSJZList:large.slice((n-1)*20,n*20).map(r=>({FSRQ:r.date,DWJZ:r.nav,LJJZ:'',JZZZL:''}))}});}});
    const [a,b]=await Promise.all([svc.fetchFull('999001'),svc.fetchFull('999001')]);
    assert.strictEqual(a,b);assert.equal(a.history.length,2801);assert.equal(calls,141);assert.equal(writes,1);
    await svc.fetchFull('999001');assert.equal(calls,141);
  });
  await test('缺页、重复日期与复权失败零发布，失败只缓存5分钟',async()=>{
    let clock=0,calls=0,writes=0;
    const svc=createService({read:()=>null,write:()=>writes++,now:()=>clock,fetchActions:async()=>actions,
      fetchText:async()=>{calls++;return JSON.stringify({TotalCount:21,Data:{LSJZList:[{FSRQ:'2026-09-24',DWJZ:100,LJJZ:'',JZZZL:''}]}});}});
    await assert.rejects(svc.fetchFull('999001'),/coverage/);assert.equal(writes,0);
    const first=calls;await assert.rejects(svc.fetchFull('999001'));assert.equal(calls,first);
    clock=300001;await assert.rejects(svc.fetchFull('999001'));assert(calls>first);
    const bad=createService({read:()=>null,write:()=>writes++,fetchActions:async()=>({error:'unverified_split'}),
      fetchText:async()=>JSON.stringify({TotalCount:1,Data:{LSJZList:[{FSRQ:'2026-09-24',DWJZ:100}]}})});
    await assert.rejects(bad.fetchFull('999001'),/unverified_split/);assert.equal(writes,0);
  });
  await test('PE24小时缓存、单飞和修订风险披露',async()=>{
    let clock=0,calls=0;
    const svc=createPe({now:()=>clock,read:()=>null,write:()=>{},fetchRows:async()=>{calls++;return monthly;}});
    await Promise.all([svc.fetchFull(),svc.fetchFull()]);assert.equal(calls,1);
    assert.match((await svc.fetchFull()).caveat,/修订/);clock=86400001;await svc.fetchFull();assert.equal(calls,2);
  });
  await test('申请日与实际查看时点分开、公告等待使用已知周',()=>{
    const value=prepareInput({history:rows,actions},peData,ev,context);
    assert.equal(value.p.available,true);assert.equal(value.p.navDate,'2026-09-22');assert.equal(value.p.weeklyDate,'2026-09-18');
    const after=C.orderContext(Date.parse('2026-09-24T08:00:00Z'));
    const later=prepareInput({history:rows,actions},peData,ev,after);
    assert.equal(later.context.orderDate,'2026-09-28');assert.equal(later.p.navDate,'2026-09-22');
    assert.equal(later.p.weeklyDate,'2026-09-18');assert.equal(later.p.rsis.weekly[14].valid,true);
    const missing=prepareInput({history:rows.filter(r=>r.date!=='2026-09-18'),actions},peData,ev,context);
    assert.equal(missing.error,'nav_calendar_coverage_gap');
    const unadjusted=prepareInput({history:rows,actions:{...actions,dividends:[{date:dates[1],amount:1}]}},peData,ev,context);
    assert.equal(unadjusted.error,'action_return_unverified');
    const future=rows.map(r=>r.date>'2026-09-22'?{...r,nav:r.nav*2}:r);
    // Unverified future corrections fail adjustment; never change an earlier published signal silently.
    assert.equal(prepareInput({history:future,actions},peData,ev,context).p.navDate,value.p.navDate);
    assert.deepEqual(prepareInput({history:future,actions},peData,ev,context).p,value.p);
  });
  await test('FOF法律分类与C类自身身份可通过；增强、代理、未知生效日不能通过',async()=>{
    const svc=createIdentity({fetchArchive:async()=>({indexCode:'000300',ftype:'基金中基金',name:'合成测试'}),
      resolveOfficial:async code=>({...F.evidence(code),shareClass:'C',legalClassification:'FOF'}),fetchText:async()=>{throw Error('offline');}});
    assert.equal((await svc.resolve('999002')).error,undefined);
    const enhanced=createIdentity({fetchArchive:async()=>({indexCode:'000300',ftype:'指数型-增强'}),fetchText:async()=>{throw Error('offline');}});
    assert.equal((await enhanced.resolve('999003')).error,'scope_unsupported');
    const unknown=createIdentity({fetchArchive:async()=>({indexCode:'000300',ftype:'指数型'}),resolveOfficial:async()=>null});
    assert.equal((await unknown.resolve('999004')).error,'profile_unverified');
    assert.equal(parseOfficial('基金代码：999005 业绩比较基准：沪深300指数 普通开放式 成立日期：2014-01-01','999005','https://www.jsfund.cn/'),null);
  });
  console.log('沪深300完整数据与官方身份：'+count+'组通过');
}
run().catch(e=>{console.error(e);process.exitCode=1;});

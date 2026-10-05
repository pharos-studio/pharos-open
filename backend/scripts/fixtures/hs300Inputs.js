'use strict';
// Small synthetic inputs, never frozen research snapshots or real investor data.
const signal=require('../../lib/hs300Signal');
const evidence=code=>({verified:true,code,market:'A',otc:true,indexCode:'000300',kind:'link',historyVerified:true,
  effectiveDate:'2013-05-16',source:'https://www.nffund.com/',individuallyBacktested:false});
function price(overrides={}) {
  return {available:true,navDays:320,navDate:'2026-09-21',weeklyDate:'2026-09-18',price:102,
    mas:{60:101,120:100,250:100},biases:{60:1,120:-4,250:2},repairs:{60:1,120:1,250:1},
    dip60:3,recovery10:2,position250:60,missingWeeks:[],
    rsis:{weekly:{14:{current:55,previous:52,count:60,valid:true}}},...overrides};
}
function input(code='999001',overrides={}) {
  return {p:price(),pe:{available:true,percentile:25,pe:12,date:'2026-08-31',availableDate:'2026-09-02'},
    evidence:evidence(code),context:{orderDate:'2026-09-24',knownThrough:'2026-09-24'},peSource:'synthetic',...overrides};
}
function fund(overrides={}) {
  const code=overrides.code||'999001';
  return {code,name:'合成测试份额',category:'broad',market:'A',caliber:'cn',indexCode:'000300',trackIndex:'SH000300',
    profileState:'ready',purchaseStatus:{state:'open',updatedAt:Date.UTC(2026,8,24,1)},_hs300Data:input(code),...overrides};
}
function history(calendar,n=320) {
  return calendar.openDates.slice(0,n).map((date,i)=>({date,nav:100+i/100,dayChange:null}));
}
module.exports={evidence,price,input,fund,history,VERSION:signal.VERSION};

'use strict';
// Public synthetic data only. Numbers deliberately do not represent an actual fund NAV.
const NOW=Date.parse('2026-09-24T04:00:00Z');
function evidence(code='999001'){return {code,verified:true,identityVerified:true,continuityVerified:true,currency:'CNY',otc:true,indexCode:'NDX',kind:'link',
  source:'https://example.invalid/synthetic-identity',rulesVerified:true,contractSource:'https://example.invalid/synthetic-contract',
  workCalendar:'cn',openCalendar:'joint',valuationCalendar:'joint',navLagWorkDays:2,statutoryDates:[],initializationFrom:'2024-01-02',seedEstablishedOn:'2024-01-16'};}
function input(code='999001',kind='trend'){
  const draw=kind==='draw'||kind==='both',price={date:'2026-09-22',close:100,count:500,rawNav:100,
    ma:{60:101,120:draw?107:99,250:95},bias:{60:-1,120:draw?-6:1,250:6},biasRepair:{120:1.5},pullback:5,recovery:2,pricePercentile250:70};
  const week={date:'2026-09-18',count:80,rsi:{14:50},rsiPrev:{14:48}},pe={state:'ready',percentile:20,pe:30,observationDate:'2026-09-18',n:156};
  if(kind==='draw')price.close=90;
  if(kind==='waiting'){price.recovery=0;price.bias[120]=0;}
  if(kind==='unknown'){week.rsi={};pe.state='unknown';pe.reason='synthetic_missing_pe';}
  if(kind==='missingPe'){pe.state='unknown';pe.reason='synthetic_missing_pe';pe.percentile=null;}
  const result={price,week,pe,quality:{prices:true,weeks:true},evidence:evidence(code),
    context:{orderDate:'2026-09-24',asOfDate:'2026-09-24',knownAt:NOW,computedAt:new Date(NOW).toISOString(),futureOrder:false,calendarVersion:'synthetic'},
    source:'https://example.invalid/synthetic-nav',sourceFetchedAt:NOW-1000,sourceHash:'synthetic-nav-version',actionHash:'synthetic-actions-version',
    peSource:'https://example.invalid/synthetic-pe',peFetchedAt:NOW-1000,peHash:'synthetic-pe-version',initializationFrom:'2024-01-02',adjustment:'synthetic-dividend-reinvested'};
  if(kind==='outside'){result.error='scope_unsupported';result.evidence.currency='USD';}
  if(kind==='future'){result.context.futureOrder=true;result.context.orderDate='2026-09-28';}
  return result;
}
function fund(code='999001',kind='trend'){return {code,name:'合成纳斯达克100 '+kind,category:'broad',caliber:'us',market:'QDII',indexCode:'NDX',trackIndex:'NDX',
  profileState:'ready',purchases:[],history:[{date:'2026-09-22',nav:100,dayChange:1}],purchaseStatus:{state:kind==='suspended'?'suspended':'open',updatedAt:NOW-1000},
  _nasdaqData:input(code,kind)};}
module.exports={NOW,evidence,input,fund};

'use strict';
const S=require('../../lib/nasdaqSignal'),{eligibility}=require('../../lib/nasdaqIdentity');
const LABELS={candidate:'市场可加仓',waiting:'等待机会',insufficient:'无法判定',profile_unverified:'档案待确认',scope_unsupported:'暂不支持'};
function buildNasdaqDecision(fund,valuationMap,config){
  const input=fund._nasdaqData||{},error=fund.profileState==='needs_review'||fund.category!=='broad'?'profile_unverified':input.error||eligibility(input.evidence);
  const result=error?{state:'unknown',draw:{state:'unknown',reason:error,conditions:{}},trend:{state:'unknown',reason:error,conditions:{}},paths:[]}:
    S.evaluate({price:input.price,week:input.week,pe:input.pe,quality:input.quality});
  const reason=error||(result.state==='unknown'?[result.draw.reason,result.trend.reason].filter(Boolean).join(';'):null);
  const unsupported=['profile_unverified','scope_unsupported'].includes(reason),state=result.state==='buy'?'candidate':result.state==='hold'?'waiting':unsupported?reason:'insufficient';
  const p=input.price||{},w=input.week||{},pe=input.pe||{},action=result.state==='buy'?'add':result.state==='hold'?'hold':null;
  const bond=valuationMap?.[fund.code]?.usTreasury10y??fund.valuation?.usTreasury10y??config?.usTreasury10y;
  const erp=Number.isFinite(pe.pe)&&pe.pe>0&&Number.isFinite(bond)?(1/pe.pe-bond)*100:null;
  const metrics={navDate:p.date||null,weeklyDate:w.date||null,price:p.close??null,navDays:p.count??null,
    ma60:p.ma?.[60]??null,ma120:p.ma?.[120]??null,ma250:p.ma?.[250]??null,bias120:p.bias?.[120]??null,bias250:p.bias?.[250]??null,
    biasRepair120:p.biasRepair?.[120]??null,dip60:p.pullback??null,recovery10:p.recovery??null,weeklyRsi:w.rsi?.[14]??null,
    previousWeeklyRsi:w.rsiPrev?.[14]??null,position250:p.pricePercentile250??null,pe:pe.pe??null,pePercentile:pe.percentile??null};
  return {action,marketVerdict:action,verdict:action,executable:false,positionScore:null,strategyVersion:S.VERSION,unsupported,unsupportedReason:unsupported?reason:null,
    reasons:[action==='add'?'纳指'+result.paths.map(p=>p==='draw'?'回撤修复':'趋势回踩').join('、')+'条件成立':action==='hold'?'两个通道均未全部成立':LABELS[state]+'：'+reason],
    matrix:{_type:'nasdaq',strategyVersion:S.VERSION,inputVersion:'nasdaq-live-input-v1',marketState:state,marketStateLabel:LABELS[state],dataError:reason,
      route:result.paths.length===2?'both':result.paths[0]||null,paths:result.paths,pathStates:{draw:result.draw.state,trend:result.trend.state},
      pathReasons:{draw:result.draw.reason,trend:result.trend.reason},conditions:{draw:result.draw.conditions||{},trend:result.trend.conditions||{}},metrics,
      orderDate:input.context?.orderDate||null,futureOrder:input.context?.futureOrder===true,computedAt:input.context?.computedAt||null,
      source:input.source||null,sourceFetchedAt:input.sourceFetchedAt??null,sourceHash:input.sourceHash||null,actionHash:input.actionHash||null,
      peDate:pe.observationDate||null,peSource:input.peSource||null,peFetchedAt:input.peFetchedAt??null,peHash:input.peHash||null,
      peCaveat:pe.caveat||'历史PE可能修订；本次快照不证明历史当时已知',dataCaveat:input.dataCaveat||null,
      initializationFrom:input.initializationFrom||null,seedEstablishedOn:input.seedEstablishedOn||null,adjustment:input.adjustment||null,identity:input.evidence||null,
      officialPurchaseConstraint:input.evidence?.purchaseConstraint||null,
      observedPurchaseLimit:input.evidence?.observedPurchaseLimit||null,
      calendarVersion:input.context?.calendarVersion||null,contractSource:input.context?.contractSource||null,
      waitingForPublication:input.waitingForPublication||[],missingDates:input.missingDates||[],erpReference:erp,erpReferenceOnly:true,rawDecisionPrecision:true}};
}
module.exports=buildNasdaqDecision;

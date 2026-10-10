'use strict';
const signal=require('../../lib/hs300Signal');
const {eligibility}=require('../../lib/hs300Identity');
const LABELS={profile_unverified:'需要处理',scope_unsupported:'暂不支持',insufficient:'无法判定',candidate:'可加仓',waiting:'等待机会'};
const REASONS={profile_unverified:'官方身份或策略生效日尚未核验',scope_unsupported:'不是国内场外普通沪深300指数或联接份额',
  hs300_data_unavailable:'尚未取得新版本完整数据',calendar_unverified:'交易日历缺少核验覆盖',price_warmup:'净值预热不足260日',
  rsi_incomplete_or_warmup:'已完成且可知周数据不足或缺失',pe_not_yet_available:'月度PE尚不可知',pe_missing_prior_months:'此前60个自然月PE不完整',
  stale_pe:'PE观察超过50日',stale_price:'信号净值超过14日',nav_calendar_coverage_gap:'应已可知的净值缺失'};
const round=value=>typeof value==='number'&&Number.isFinite(value)?+value.toFixed(3):value;
function buildBroad300Decision(fund,valuationMap,config) {
  // Old config, adjustedHistory, manually entered percentiles and legacy parameters cannot bypass this input.
  const input=fund._hs300Data;
  const error=fund.profileState==='needs_review'?'profile_unverified':input?.error||(!input?.p||!input?.pe?'hs300_data_unavailable':eligibility(input.evidence));
  const result=error?{available:false,reason:error}:signal.evaluate(input.p,input.pe);
  const reason=result.reason||(!result.available?(result.deep?.reason||result.trend?.reason):null);
  const unsupported=['profile_unverified','scope_unsupported'].includes(reason);
  const state=result.available?result.triggered?'candidate':'waiting':unsupported?reason:'insufficient';
  const p=input?.p||{},pe=input?.pe||{},rsi=p.rsis?.weekly?.[14]||{};
  const metrics={navDate:p.navDate||null,weeklyDate:p.weeklyDate||null,price:p.price??null,navDays:p.navDays??null,
    ma60:p.mas?.[60]??null,ma120:p.mas?.[120]??null,ma250:p.mas?.[250]??null,
    bias120:p.biases?.[120]??null,bias250:p.biases?.[250]??null,biasRepair120:p.repairs?.[120]??null,
    dip60:p.dip60??null,recovery10:p.recovery10??null,weeklyRsi:rsi.current??null,previousWeeklyRsi:rsi.previous??null,
    position250:p.position250??null,pe:pe.pe??null,pePercentile:pe.percentile??null};
  const bond=valuationMap?.[fund.code]?.treasury10y??fund.valuation?.treasury10y??config?.treasury10y;
  const erp=Number.isFinite(pe.pe)&&pe.pe>0&&Number.isFinite(bond)?(1/pe.pe-bond)*100:null;
  const action=result.available?result.triggered?'add':'hold':null;
  return {action,marketVerdict:action,verdict:action,executable:false,positionScore:null,strategyVersion:signal.VERSION,
    unsupported,unsupportedReason:unsupported?reason:null,
    reasons:[result.available?result.triggered?'共同PE入口与'+(result.route==='both'?'两个通道':result.route==='deep'?'回撤修复通道':'趋势回踩通道')+'成立':'共同PE入口或通道条件尚未全部成立':LABELS[state]+'：'+(REASONS[reason]||reason)],
    matrix:{_type:'broad300',strategyVersion:signal.VERSION,marketState:state,marketStateLabel:LABELS[state],dataError:reason,
      route:result.route||null,conditions:{peGate:pe.available?pe.percentile<=25:null,
        deep:result.deep?.conditions||{},trend:result.trend?.conditions||{}},
      metrics:Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k,round(v)])),
      orderDate:input?.context?.orderDate||null,viewedAt:input?.context?.viewedAt||null,
      peDate:pe.date||null,peAvailableDate:pe.availableDate||null,peSource:input?.peSource||null,peCaveat:input?.peCaveat||null,
      dataSource:input?.source||null,calendarSource:input?.context?.source||null,initializationFrom:input?.initializationFrom||null,
      adjustment:input?.adjustment||null,identity:input?.evidence||null,
      individuallyBacktested:input?.evidence?.individuallyBacktested===true,
      erpReference:round(erp),erpReferenceOnly:true,rawDecisionPrecision:true}};
}
// Compatibility always uses the versioned formal builder; incomplete old inputs fail closed.
function evaluate(input={}) {return buildBroad300Decision({_hs300Data:input.input,profileState:input.profileState||'ready'},null,null);}
module.exports={buildBroad300Decision,evaluate,VERSION:signal.VERSION};

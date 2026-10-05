'use strict';
const trend = require('../../lib/dividendTrend');
const LABELS = { profile_unverified:'档案待确认',scope_unsupported:'暂不支持',insufficient:'数据不足' };
function buildDividendDecision(fund) {
  const error = trend.eligibility(fund) || fund._dividendData?.error || (!fund._dividendData ? 'dividend_data_unavailable' : null);
  const data = fund._dividendData;
  const result = error ? {available:false,reason:error} : trend.evaluate(data.known,data.context.orderDate,{weekEndDates:data.weekEndDates});
  const unsupported = ['profile_unverified','scope_unsupported'].includes(result.reason);
  const state = result.available ? result.trend ? 'candidate':'waiting' : unsupported ? result.reason:'insufficient';
  const label = LABELS[state] || (state==='candidate'?'可加仓':'等待机会');
  const metrics = Object.fromEntries(Object.entries(result.metrics||{}).map(([k,v])=>[k,typeof v==='number'?+v.toFixed(3):v]));
  return {action:result.available?result.trend?'add':'hold':null,
    reasons:[result.available ? result.trend?'趋势回踩全部条件成立':'趋势回踩条件尚未全部成立':label+'：'+result.reason],
    strategyVersion:trend.VERSION,unsupported,unsupportedReason:unsupported?result.reason:null,
    matrix:{_type:'dividendTrend',strategyVersion:trend.VERSION,marketState:state,marketStateLabel:label,
      dataError:result.reason||null,metrics,conditions:result.conditions||{},
      orderDate:data?.context?.orderDate||null,calendarSource:data?.context?.source||null,
      dataSource:data?.source||null,adjustment:data?.adjustment||null,
      yieldReference:fund.dividendYieldReference||null,referenceOnly:true},
    positionScore:null,marketVerdict:result.available?result.trend?'add':'hold':null,
    verdict:result.available?result.trend?'add':'hold':null,executable:false};
}
module.exports = buildDividendDecision;

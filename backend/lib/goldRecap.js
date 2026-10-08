'use strict';
// NAV signal review, not account P&L: dividends reinvested, fees excluded.
// Exact own-share reference date; a closed buy window is never a sell order.
const S=require('./goldSignal');
function evaluate(rows,sample,{holdDays=30,previewDays=[5,10]}={}){if(sample?.strategyVersion!==S.VERSION)return {error:'wrong_strategy_version'};if(!Number.isInteger(holdDays)||holdDays<1||!Array.isArray(previewDays)||previewDays.some(n=>!Number.isInteger(n)||n<1))return {error:'invalid_recap_period'};
  if(!Array.isArray(rows))return {error:'invalid_recap_series'};
  let previous='';for(const r of rows){if(!S.validDate(r.date)||r.date<=previous||!S.finite(r.close)||r.close<=0)return {error:'invalid_recap_series'};previous=r.date;}
  if(sample.type==='buy'&&sample.purchaseConfirmed!==true)return {error:'purchase_pricing_unconfirmed'};
  const date=sample.type==='buy'?sample.pricingDate:sample.orderDate;if(!S.validDate(date))return {error:'reference_date_missing'};const index=rows.findIndex(r=>r.date===date);if(index<0)return {error:'reference_nav_missing'};
  const reference=rows[index],basis='dividend-reinvested; fees excluded; '+holdDays+' verified daily NAV observations; buy-only signal review',end=rows[index+holdDays],preview={};for(const n of previewDays)preview['d'+n]=rows[index+n]?rows[index+n].close>reference.close:null;
  if(!end)return Object.values(preview).some(v=>v!==null)?{update:{...preview,navRef:{T:{date:reference.date,nav:reference.close},T30:null},positive30:null,returnPct:null,backfill:'partial',returnBasis:basis}}:{error:'recap_unmatured'};
  const returnPct=100*(end.close/reference.close-1);return {update:{...preview,navRef:{T:{date:reference.date,nav:reference.close},T30:{date:end.date,nav:end.close}},positive30:returnPct>0,returnPct,backfill:'done',returnBasis:basis,buyOnly:true}};}
module.exports={evaluate};

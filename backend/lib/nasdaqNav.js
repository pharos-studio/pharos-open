'use strict';
const S=require('./nasdaqSignal'),refs=require('../data/nasdaqNavReferences.json');
function adjust(history,actions,code){
  if(!Array.isArray(history)||history.length<2)return {error:'insufficient_nav_history'};
  if(!actions||actions.error||actions.identityVerified!==true||!Array.isArray(actions.dividends)||!Array.isArray(actions.splits))return {error:actions?.error||'corporate_action_identity_unverified'};
  const rows=history.slice().sort((a,b)=>a.date.localeCompare(b.date)),byDate=new Map(),div=new Map(),split=new Map();
  for(const r of rows){if(!S.validDate(r.date)||!Number.isFinite(r.nav)||r.nav<=0||byDate.has(r.date)||
    (r.dayChange!=null&&!Number.isFinite(r.dayChange)))return {error:'invalid_nav_history'};byDate.set(r.date,r);}
  const from=rows[0].date,to=rows.at(-1).date;
  for(const a of actions.dividends){if(!S.validDate(a.date)||!Number.isFinite(a.amount)||a.amount<=0)return {error:'invalid_dividend'};
    if(a.date>=from&&a.date<=to){if(!byDate.has(a.date)||div.has(a.date))return {error:'dividend_date_not_in_nav'};div.set(a.date,a.amount);}}
  for(const a of actions.splits){if(!S.validDate(a.date)||!Number.isFinite(a.factor)||a.factor<=0)return {error:'invalid_split'};
    if(a.date>=from&&a.date<=to){if(!byDate.has(a.date)||split.has(a.date)||div.has(a.date))return {error:'split_date_unverified'};split.set(a.date,a.factor);}}
  const output=[{date:from,close:1,rawNav:rows[0].nav}],repairs=[];
  for(let i=1;i<rows.length;i++){
    const r=rows[i],prev=rows[i-1],growth=(r.nav*(split.get(r.date)||1)+(div.get(r.date)||0))/prev.nav;
    if(!Number.isFinite(growth)||growth<=0)return {error:'invalid_adjusted_return'};
    if((div.has(r.date)||split.has(r.date))&&!Number.isFinite(r.dayChange))return {error:'action_return_unverified',date:r.date};
    if(Number.isFinite(r.dayChange)&&Math.abs((growth-1)*100-r.dayChange)>0.2){
      const w=refs.windows.find(w=>w.code===code&&w.diagnostic.currentDate===r.date);
      if(!w)return {error:'reported_return_mismatch',date:r.date};
      const d=w.diagnostic,current=byDate.get(d.currentDate),ref=byDate.get(d.referenceDate),between=rows.filter(x=>x.date>d.referenceDate&&x.date<d.currentDate);
      const matches=o=>{const x=byDate.get(o.FSRQ);return x&&x.nav===Number(o.DWJZ)&&(x.dayChange??null)===(o.JZZZL===''?null:Number(o.JZZZL))&&x.navType===o.NAVTYPE;};
      if(!current||!ref||current.navType!=='1'||ref.navType!=='1'||current.nav!==d.currentNav||ref.nav!==d.referenceNav||current.dayChange!==d.currentDayChange||
        between.length!==d.intermediateDates.length||!w.observations.every(matches)||
        between.some((x,j)=>x.date!==d.intermediateDates[j].date||x.nav!==d.intermediateDates[j].nav||x.navType!=='0'||x.dayChange!=null)||
        [...div.keys(),...split.keys()].some(date=>date>d.referenceDate&&date<=d.currentDate)||
        Number(((current.nav/ref.nav-1)*100).toFixed(2))!==current.dayChange)return {error:'provider_reference_evidence_changed',date:r.date};
      repairs.push({date:r.date,referenceDate:ref.date,evidenceSha256:refs.evidenceSha256,source:w.url,sourceSha256:w.sourceSha256,priceSequenceChanged:false});
    }
    output.push({date:r.date,close:output.at(-1).close*growth,rawNav:r.nav});
  }
  return {rows:output,repairs,reportPointRowsDeleted:0,adjustment:'dividend-reinvested; adjacent economic NAV; provider field references separately verified'};
}
module.exports={adjust};

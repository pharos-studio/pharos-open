'use strict';
// A manager's unresolved suspension cannot be silently overridden by a vendor's open flag.
// Static observed evidence is not an automatic official-announcement refresh service.
function overlay(ps,constraint,instant){
  if(!constraint||!['suspended','unknown'].includes(constraint.status))return ps;
  const checked=Date.parse(constraint.checkedAt);
  if(!Number.isFinite(Number(instant)))return {...ps,fresh:false,suspended:false,unavailable:true,
    officialConstraint:constraint,officialConstraintReason:'official_resumption_unverified'};
  const day=new Date(Number(instant)+8*3600000).toISOString().slice(0,10);
  const requestBoundary=Date.parse(constraint.requestsAfter);
  if(constraint.start&&day<constraint.start&&!(Number.isFinite(requestBoundary)&&instant>requestBoundary))return ps;
  if(constraint.status==='unknown')return {...ps,fresh:false,suspended:false,unavailable:true,
    officialConstraint:constraint,officialConstraintReason:'official_constraint_unverified'};
  const fresh=Number.isFinite(checked)&&checked<=instant&&instant-checked<86400000;
  return {...ps,fresh:fresh&&ps.fresh,suspended:fresh,unavailable:!fresh,
    officialConstraint:constraint,officialConstraintReason:fresh?'official_purchase_suspended':'official_resumption_unverified'};
}
module.exports={overlay};

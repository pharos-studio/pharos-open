'use strict';
const CODES=new Set(['270042','040046','160213','161130','000834','015299','008971','015300','016452','018966']);
function isNasdaqRoute(f){return !!f&&(CODES.has(f.code)||
  /^(NDX|NDX100|NASDAQ100)$/i.test(String(f.indexCode||f.trackIndex||''))||
  /纳斯达克\s*100|NASDAQ[\s-]*100/i.test((f.name||'')+' '+(f.indexName||'')));}
function eligibility(e){
  if(e?.identityVerified!==true||!e.source||!/^\d{6}$/.test(e.code||''))return 'profile_unverified';
  if(e.currency!=='CNY'||e.otc!==true||e.indexCode!=='NDX'||!['index','link'].includes(e.kind)||e.enhanced===true)return 'scope_unsupported';
  if(e.continuityVerified!==true)return 'index_continuity_unverified';
  return null;
}
module.exports={CODES,isNasdaqRoute,eligibility};

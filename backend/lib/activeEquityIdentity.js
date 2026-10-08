'use strict';
const LEDGER=require('../data/activeEquityIdentity.json');
function isActiveEquityRoute(f){if(!f)return false;const e=LEDGER.funds.find(x=>x.code===f.code);if(e?.route===true)return true;if(f._activeEquityData)return true;
  // Suspicion selects a fail-closed route; it never certifies admission. Known index funds retain their existing strategy.
  const type=String(f.fundType||''),name=String(f.name||'');
  // Preserve verified dedicated identity even when an old record has no type/name.
  if(require('./nasdaqIdentity').CODES.has(f.code)||require('./hs300Identity').REVIEWED[f.code]||require('../data/goldIdentity.json').funds.some(x=>x.code===f.code))return false;
  // Preserve the existing dedicated dividend scope guard when its index context contradicts a mixed-fund type.
  if(f.category==='dividend'&&/指数|ETF|联接/.test(String(f.indexName||'')))return false;
  if(/指数|ETF|联接|债券|货币/.test(type)||/指数|指数增强|ETF|联接|债券|货币/.test(name))return false;
  if(/混合|股票|主动|active-equity|equity|hybrid|mixed/i.test(type)||f.managementType==='active'||/混合|股票|主动/.test(name))return true;
  // Legacy overseas growth records may only carry QDII + category. Route them to
  // identity review; unknown management style must never fall back to old scores.
  const overseas=f.market==='QDII'||f.caliber==='us'||/QDII|海外/i.test(type+' '+name);
  if(overseas&&f.category==='growth'&&!require('./nasdaqIdentity').isNasdaqRoute(f))return true;
  return false;
}
function eligibility(e){if(e?.identityVerified!==true||!e.source||!/^\d{6}$/.test(e.code||''))return 'profile_unverified';
  const supportedMarket=e.qdii===true?e.investmentScope==='global-active-equity':e.domestic===true;
  if(!supportedMarket||e.otc!==true||e.currency!=='CNY'||!['stock','mixed-equity'].includes(e.kind)||e.active!==true||e.enhanced===true)return 'scope_unsupported';
  if(e.samplingVerified!==true||e.sampling!=='all-economic-nav')return 'daily_sampling_unverified';
  if(e.continuityVerified!==true||!require('./activeEquitySignal').validDate(e.initializationFrom))return 'initialization_unverified';return null;}
function isOverseasActiveEquityRoute(f){return !!f&&(f.market==='QDII'||f.caliber==='us'||/QDII|海外/i.test(String(f.fundType||'')+' '+String(f.name||'')))&&isActiveEquityRoute(f);}
module.exports={LEDGER,isActiveEquityRoute,isOverseasActiveEquityRoute,eligibility};

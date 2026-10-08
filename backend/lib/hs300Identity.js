'use strict';
// Reviewed official evidence, not a name/proxy/benchmark whitelist.
const REVIEWED = Object.freeze({
  '202015': {effectiveDate:'2013-05-16',shareClass:'A',targetEtf:'159925',source:'https://www.nffund.com/main/files/2023/10/24/549178805721.pdf'},
  '000051': {effectiveDate:'2012-12-25',shareClass:'A',targetEtf:'510330',source:'https://www.chinaamc.com.cn/fund/000051/index.shtml',historySource:'https://ewealth.abchina.com/fund/Information/fundnews/202105/t20210531_2003923.htm'},
  '160706': {effectiveDate:'2012-08-21',shareClass:'A',targetEtf:'159919',source:'https://www.jsfund.cn/cms/Services/AttachDownLoad.jsp?id=427896'},
  '110020': {effectiveDate:'2013-09-17',shareClass:'A',targetEtf:'510310',source:'https://cdn.efunds.com.cn/owch/data/bulletin/20260131/%E6%98%93%E6%96%B9%E8%BE%BE%E6%B2%AA%E6%B7%B1300%E4%BA%A4%E6%98%93%E5%9E%8B%E5%BC%80%E6%94%BE%E5%BC%8F%E6%8C%87%E6%95%B0%E5%8F%91%E8%B5%B7%E5%BC%8F%E8%AF%81%E5%88%B8%E6%8A%95%E8%B5%84%E5%9F%BA%E9%87%91%E8%81%94%E6%8E%A5%E5%9F%BA%E9%87%91%E6%9B%B4%E6%96%B0%E7%9A%84%E6%8B%9B%E5%8B%9F%E8%AF%B4%E6%98%8E%E4%B9%A6.pdf?from=person',sourceSha256:'b3fbbedf9b61bb034129a2f7d9b2c229fa504d9f3cef4f57a5b6c65dd869a825',reviewedPage:2}
});
const normalizeIndex = s => String(s||'').replace(/^(?:SH|SZ|CSI)/i,'').replace(/\.(SH|SZ)$/i,'');
function isHs300Route(f) {
  return f?.category==='broad' && (normalizeIndex(f.indexCode)==='000300' || f.trackIndex==='SH000300' ||
    /沪深\s*300|CSI\s*300/i.test((f.name||'')+' '+(f.indexName||'')));
}
function eligibility(evidence) {
  if(!evidence?.verified || !evidence.source || !/^\d{6}$/.test(evidence.code||'')) return 'profile_unverified';
  if(evidence.market!=='A' || evidence.otc!==true || evidence.indexCode!=='000300' ||
    !['index','link'].includes(evidence.kind) || evidence.enhanced===true) return 'scope_unsupported';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(evidence.effectiveDate||'') || evidence.historyVerified!==true) return 'profile_unverified';
  return null;
}
module.exports={REVIEWED,normalizeIndex,isHs300Route,eligibility};

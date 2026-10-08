'use strict';
const {REVIEWED,normalizeIndex,eligibility}=require('../lib/hs300Identity');
const http=require('../lib/http');
const fetchers=require('../fetchers');
// URLs are selected server-side; user-supplied URLs and automatic fields are never evidence.
const OFFICIAL_URLS = [
  code=>`https://www.chinaamc.com.cn/fund/${code}/index.shtml`,
  code=>`https://www.jsfund.cn/main/fund/${code}/fundRecord.shtml`,
  code=>`https://api.efunds.com.cn/owch/oURL/website/weixin/wx_fundinfo.shtml?fundcode=${code}`
];
function parseOfficial(html,code,source) {
  const text=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ');
  if(!new RegExp('基金代码\\s*[:：]?\\s*'+code).test(text)) return null;
  if(/增强|主动管理|QDII/.test(text)) return {verified:true,code,source,kind:'outside',market:/QDII/.test(text)?'QDII':'A'};
  // A benchmark mentioning CSI300 is insufficient: require investment/target wording.
  const direct=/(?:标的指数|跟踪指数)\s*[:：为是]?\s*(?:中证)?沪深\s*300/.test(text);
  const link=/(?:投资范围|本基金主要通过投资|目标ETF)[^。]{0,120}沪深\s*300[^。]{0,80}ETF/.test(text);
  if(!direct&&!link) return null;
  // Founding date alone cannot establish current strategy after a transformation.
  const effective=text.match(/(?:现行(?:投资)?策略|转型|变更为[^。]{0,50})(?:生效)?(?:日期|日)\s*[:：]?\s*(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/);
  if(!effective || !/普通开放式|开放式|场外申购/.test(text)) return null;
  const effectiveDate=effective[1]+'-'+effective[2].padStart(2,'0')+'-'+effective[3].padStart(2,'0');
  return {verified:true,code,source,effectiveDate,historyVerified:true,market:'A',otc:true,indexCode:'000300',kind:link?'link':'index',
    legalClassification:/基金中基金|FOF/.test(text)?'FOF':null,individuallyBacktested:false};
}
function createService(deps={}) {
  const archiveOf=deps.fetchArchive||fetchers.fetchFundArchive, request=deps.fetchText||http.fetchText,now=deps.now||Date.now;
  const memory=new Map(),inflight=new Map();
  async function load(code) {
    const archive=await archiveOf(code);
    if(!archive) return {error:'profile_unverified'};
    const index=normalizeIndex(archive.indexCode), type=archive.ftype||'';
    if(index && index!=='000300' || /增强|QDII/.test(type) || /增强/.test(archive.name||'')) return {error:'scope_unsupported'};
    if(index!=='000300') return {error:'profile_unverified'};
    let evidence;
    if(REVIEWED[code]) evidence={...REVIEWED[code],verified:true,code,market:'A',otc:true,indexCode:'000300',kind:'link',
      historyVerified:true,individuallyBacktested:true,evidenceNote:'官方转型/当前跟踪关系已核验；此后的历史公告并非逐条核验'};
    else {
      if(deps.resolveOfficial) evidence=await deps.resolveOfficial(code,archive);
      else for(const urlOf of OFFICIAL_URLS) {
        const source=urlOf(code);
        try {evidence=parseOfficial(await request(source,{},12000),code,source);if(evidence)break;} catch(_) {}
      }
    }
    if(evidence?.code!==code) return {error:'profile_unverified'};
    const error=eligibility(evidence);
    return error?{error,evidence}:{evidence};
  }
  function resolve(code) {
    if(!/^\d{6}$/.test(code||'')) return Promise.resolve({error:'profile_unverified'});
    const hit=memory.get(code);if(hit&&hit.until>now())return Promise.resolve(hit.value);
    if(!inflight.has(code)) inflight.set(code,load(code).catch(()=>({error:'profile_unverified'})).then(value=>{
      memory.set(code,{value,until:now()+(value.error?300000:86400000)});return value;
    }).finally(()=>inflight.delete(code)));
    return inflight.get(code);
  }
  return {resolve};
}
module.exports={...createService(),createService,parseOfficial};

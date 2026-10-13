'use strict';
const crypto = require('node:crypto');
const REGIONS=['US','CN','EA','JP','UK'];
const TYPES=['policy_decision','implementation_measure','proposal_consultation','meeting_minutes','speech_statement','economic_data','reserve_data','schedule','unknown'];
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function validDate(v){return /^\d{4}-\d{2}-\d{2}$/.test(v||'')&&Number.isFinite(Date.parse(v))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;}
function day(at,zone='Asia/Shanghai'){return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));}
function windowOf(days,now){const to=day(now),d=new Date(to+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-days+1);return {days,from:d.toISOString().slice(0,10),to};}
function queryOf(q={}){
  if(Object.keys(q).some(k=>!['windowDays','region','type','cursor'].includes(k)))throw Object.assign(Error('invalid_query'),{statusCode:400});
  const days=Number(q.windowDays??90),region=q.region||'',type=q.type||'';
  if(![30,90,180].includes(days)||region&&!REGIONS.includes(region)||type&&!TYPES.includes(type)||typeof q.cursor!=='undefined'&&(typeof q.cursor!=='string'||q.cursor.length>1200))throw Object.assign(Error('invalid_query'),{statusCode:400});
  return {windowDays:days,region,type,cursor:q.cursor||''};
}
function officialUrl(value,hosts){try{const u=new URL(value);u.pathname=u.pathname.replace(/\/{2,}/g,'/');return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&hosts.includes(u.hostname)?u.href:null;}catch(_){return null;}}
function text(value){return String(value||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&nbsp;|&#160;/g,' ').replace(/&ndash;/g,'–').replace(/&mdash;/g,'—').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(Number(n),0x10ffff))).replace(/\s+/g,' ').trim();}
function classify(title){
  if(/schedule|calendar|to be published|会议日程/i.test(title))return 'schedule';
  if(/minutes|accounts|summary of opinions|议事|会议纪要/i.test(title))return 'meeting_minutes';
  if(/consultation|proposal|proposed|draft|征求意见|草案/i.test(title))return 'proposal_consultation';
  if(/speech|remarks|interview|讲|致辞|会见/i.test(title))return 'speech_statement';
  if(/reserve assets|黄金储备/i.test(title))return 'reserve_data';
  if(/statistics|survey|inflation|employment|balance of payments|统计|数据/i.test(title))return 'economic_data';
  if(/implementation|operations|purchases|liquidity|准备金|公开市场|实施|操作|再贷款|调整完善.*货币政策工具/i.test(title))return 'implementation_measure';
  if(/monetary policy decisions|monetary policy statement|monetary policy summary|statement on monetary policy|federal reserve issues fomc statement|决定.*(?:利率|降息|货币政策)|(?:利率|降息).*决定/i.test(title))return 'policy_decision';
  return 'unknown';
}
function exactTime(raw){if(!raw||!/(?:GMT|UTC|[+-]\d{2}:?\d{2}|Z)\s*$/i.test(raw))return null;const t=Date.parse(raw);return Number.isFinite(t)?new Date(t).toISOString():null;}
function ecbMeetingKey(title){const meeting=text(title).match(/^Meeting of (\d{1,2})(?:[-–](\d{1,2}))? ([A-Za-z]+) (\d{4})$/i);if(!meeting)return null;const end=Number(meeting[2]||meeting[1]),t=Date.parse(`${meeting[3]} ${end}, ${meeting[4]} UTC`);if(!Number.isFinite(t)||new Date(t).getUTCDate()!==end)return null;return 'ecb-'+new Date(t).toISOString().slice(0,10);}
function normalize(raw,source,now){
  const url=officialUrl(raw.sourceUrl,source.hosts);if(!url||!raw.title)return {error:'invalid_item'};
  const publishedAt=exactTime(raw.publishedAt),publishedDate=publishedAt?day(Date.parse(publishedAt)):raw.publishedDate;
  if(!validDate(publishedDate))return {error:'publication_unknown',pending:raw};
  if(publishedAt?Date.parse(publishedAt)>now:publishedDate>day(now,source.timezone))return {error:'future_publication',pending:raw};
  const kind=raw.documentType||(source.id==='ecb'&&/\/press\/accounts\//.test(url)?'meeting_minutes':source.id==='boj'&&/^Quarterly Schedule of Outright Purchases of Japanese Government Bonds\b/i.test(text(raw.title))?'implementation_measure':classify(raw.title)),canonical=new URL(url);canonical.hash='';const id=hash([source.authority,canonical.href]);
  let eventKey=raw.eventKey||null,eventKeyBasis=raw.eventKey?'official_archive_meeting_context':null;
  if(!eventKey&&source.id==='ecb'&&kind==='meeting_minutes'&&/\/press\/accounts\//.test(url)){eventKey=ecbMeetingKey(raw.title);if(eventKey)eventKeyBasis='official_title_meeting_date';}
  if(!eventKey&&source.id==='fed'){
    const meeting=kind==='meeting_minutes'&&String(raw.title).match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:[-–](\d{1,2}))?,?\s+(\d{4})/i);
    const t=meeting&&Date.parse(`${meeting[1]} ${meeting[3]||meeting[2]}, ${meeting[4]} UTC`);
    if(Number.isFinite(t)&&t!==false)eventKey='fed-'+new Date(t).toISOString().slice(0,10).replaceAll('-','');
    else if(/(?:monetary|fomcminutes)(\d{8})/.test(url))eventKey='fed-'+url.match(/(?:monetary|fomcminutes)(\d{8})/)[1];
  }
  return {item:{id,sourceId:source.id,region:source.region,authority:source.authority,authorityZh:source.authorityZh,
    title:text(raw.title),documentType:kind,secondaryDocumentTypes:raw.secondaryDocumentTypes||[],policyType:kind,sourceGuid:raw.guid||null,classificationBasis:raw.classificationBasis||'官方栏目标题保守分类；法律效力另待核',
    sourceUrl:url,language:source.language||'en',publishedDate,publishedAt,precision:publishedAt?'instant':'date',
    originalPublishedAt:publishedAt?raw.publishedAt:null,originalTimezone:source.timezone,
    publishedAtBeijing:publishedAt?new Date(Date.parse(publishedAt)+8*3600000).toISOString().replace('Z','+08:00'):null,
    effectiveDate:validDate(raw.effectiveDate)?raw.effectiveDate:null,effectiveDateScope:validDate(raw.effectiveDate)?raw.effectiveDateScope||null:null,effectiveDateAnchor:validDate(raw.effectiveDate)?raw.effectiveDateAnchor||null:null,
    legalStatus:kind==='proposal_consultation'?'proposal':'unknown',revisedAt:exactTime(raw.updatedAt),
    fetchedAt:new Date(now).toISOString(),firstSeenAt:new Date(now).toISOString(),summaryZh:raw.summaryZh||null,
    summaryMethod:raw.summaryZh?'verified-source-template-v1':null,summaryAnchor:raw.summaryAnchor||null,
    summaryStatus:raw.summaryZh?'structured_extract':raw.summaryAttempted?'extraction_unavailable':'not_extracted',eventKey,eventKeyBasis,
    hasBody:!!raw.bodyText,bodyFetchedAt:raw.bodyText?new Date(now).toISOString():null,bodyRetained:false,
    contentHash:hash([raw.title,raw.bodyText||'',raw.effectiveDate||null]),revision:1,revisionHistory:[]}};
}
function parseFeed(xml,source){const blocks=xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi)||[];
  const field=(b,n)=>text((b.match(new RegExp('<'+n+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+n+'>','i'))||[])[1]);
  return blocks.map(b=>({title:field(b,'title'),sourceUrl:(b.match(/<link[^>]*href=["']([^"']+)/i)||[])[1]||field(b,'link'),guid:field(b,'guid')||field(b,'id'),publishedAt:field(b,'pubDate')||field(b,'published'),updatedAt:field(b,'updated')}));
}
function reconcile(rows,previous=[]){const old=new Map(previous.map(i=>[i.id,i])),out=new Map();for(const row of rows){const existing=out.get(row.id);if(!existing){out.set(row.id,{...row});continue;}const timed=existing.precision==='instant'?existing:row.precision==='instant'?row:existing,content=row.hasBody?row:existing.hasBody?existing:timed;
    out.set(row.id,{...content,publishedAt:timed.publishedAt,publishedDate:timed.publishedDate,precision:timed.precision,originalPublishedAt:timed.originalPublishedAt,publishedAtBeijing:timed.publishedAtBeijing,sourceGuid:existing.sourceGuid||row.sourceGuid,eventKey:content.eventKey||existing.eventKey||row.eventKey,eventKeyBasis:content.eventKeyBasis||existing.eventKeyBasis||row.eventKeyBasis});}
  for(const row of out.values()){const prior=old.get(row.id);if(!prior)continue;row.firstSeenAt=prior.firstSeenAt;row.revision=prior.revision;row.revisionHistory=prior.revisionHistory||[];
    if(!row.eventKey&&row.title===prior.title&&prior.eventKey&&['official_archive_meeting_context','official_title_meeting_date'].includes(prior.eventKeyBasis)){row.eventKey=prior.eventKey;row.eventKeyBasis=prior.eventKeyBasis;}
    if(!row.hasBody&&prior.hasBody&&row.title===prior.title){row.contentHash=prior.contentHash;row.hasBody=prior.hasBody;row.summaryZh=prior.summaryZh;row.summaryAnchor=prior.summaryAnchor;row.summaryMethod=prior.summaryMethod;row.summaryStatus=prior.summaryStatus;
      row.effectiveDate=prior.effectiveDate;row.effectiveDateScope=prior.effectiveDateScope;row.effectiveDateAnchor=prior.effectiveDateAnchor;
      row.bodyFetchedAt=prior.bodyFetchedAt||prior.fetchedAt;row.bodyRetained=true;
    }
    if(row.contentHash!==prior.contentHash){row.revision=(prior.revision||1)+1;row.revisionHistory=[...row.revisionHistory,{contentHash:prior.contentHash,title:prior.title,publishedDate:prior.publishedDate,sourceUrl:prior.sourceUrl,lastSeenAt:prior.fetchedAt}];}}
  return [...out.values()];
}
function publicationOrder(a,b){const date=b.publishedDate.localeCompare(a.publishedDate);if(date)return date;const at=Date.parse(a.publishedAt),bt=Date.parse(b.publishedAt),ae=Number.isFinite(at),be=Number.isFinite(bt);
  if(ae&&be&&at!==bt)return bt-at;if(ae!==be)return ae?-1:1;return a.id.localeCompare(b.id);
}
function eventsOf(rows,w,q){const selected=rows.filter(i=>i.publishedDate>=w.from&&i.publishedDate<=w.to&&(!q.region||i.region===q.region)&&i.documentType!=='schedule');
  const groups=new Map();for(const item of selected){const key=item.eventKey||item.id;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
  return [...groups.values()].filter(docs=>docs.some(i=>q.type?i.documentType===q.type:['policy_decision','implementation_measure'].includes(i.documentType))).map(docs=>{docs.sort(publicationOrder);const primary=docs.find(i=>q.type?i.documentType===q.type:i.documentType==='policy_decision')||docs[0];return {...primary,eventId:hash(docs[0].eventKey||primary.id),sortDate:docs[0].publishedDate,sortPublishedAt:docs[0].publishedAt,documents:docs};}).sort((a,b)=>publicationOrder({publishedDate:a.sortDate,publishedAt:a.sortPublishedAt,id:a.eventId},{publishedDate:b.sortDate,publishedAt:b.sortPublishedAt,id:b.eventId}));
}
module.exports={REGIONS,TYPES,hash,validDate,day,windowOf,queryOf,officialUrl,text,classify,exactTime,normalize,parseFeed,reconcile,eventsOf,publicationOrder,ecbMeetingKey};

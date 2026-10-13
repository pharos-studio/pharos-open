'use strict';
// Public official information only. Never used by a fund decision or purchase service.
const fs=require('node:fs'),path=require('node:path'),P=require('../lib/macroPolicy');
const REGISTRY=require('../data/macroPolicySources.json');
const {explainGoldPolicy,METHOD_VERSION:interpretationMethodVersion}=require('../lib/goldPolicyExplanation');
const TTL=6*3600000,STALE=24*3600000,PAGE_SIZE=20,MAX_PAGES=16,MAX_BODY=1500000;
function links(html,base){return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(m=>{const href=(m[1].match(/href\s*=\s*["']([^"']+)["']/i)||[])[1];try{return {sourceUrl:new URL(P.text(href),base).href,title:P.text((m[1].match(/title\s*=\s*["']([^"']*)/i)||[])[1]||m[2])};}catch(_){return null;}}).filter(Boolean);}
function dateEnglish(raw){const value=P.text(raw).replace(/Sept\./g,'Sep.').replace(/([a-z])(\d)/gi,'$1 $2').replace(/(\d)([a-z])/gi,'$1 $2');const t=value?Date.parse(value+' UTC'):NaN;return Number.isFinite(t)?new Date(t).toISOString().slice(0,10):null;}
function parseArchive(html,source,url){
  if(source.adapter==='pboc')return [...html.matchAll(/<font\b[^>]*class=["']newslist_style["'][^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]{0,500}?<span\b[^>]*class=["']hui12["'][^>]*>(\d{4}-\d{2}-\d{2})<\/span>/gi)].map(m=>({sourceUrl:new URL(m[1],url).href,title:P.text((m[0].match(/title=["']([^"']+)/i)||[])[1]||m[2]),publishedDate:m[3]}));
  if(source.adapter==='ecb'){
    const accounts=/\/accounts\//.test(url),out=[];for(const m of html.matchAll(/<dt\b[^>]*isoDate=["'](\d{4}-\d{2}-\d{2})["'][^>]*>[\s\S]*?<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)){const title=(m[2].match(/<div\b[^>]*class=["']title["'][^>]*>([\s\S]*?)<\/div>/i)||[])[1]||m[2].split(/Related/i)[0];const l=links(title,url).find(l=>/\.en\.html(?:$|\?)/.test(l.sourceUrl)&&(accounts?/\/press\/accounts\//.test(l.sourceUrl):/\/press\/pr\/date\/.*ecb\.mp/.test(l.sourceUrl)));if(l){const meeting=accounts&&l.title.match(/^Meeting of (\d{1,2})(?:[-–](\d{1,2}))? ([A-Za-z]+) (\d{4})$/i),meetingDate=meeting?dateEnglish(`${meeting[2]||meeting[1]} ${meeting[3]} ${meeting[4]}`):null;out.push({...l,publishedDate:m[1],documentType:accounts?'meeting_minutes':'policy_decision',eventKey:accounts?(meetingDate?'ecb-'+meetingDate:null):'ecb-'+m[1]});}}return out;
  }
  if(source.adapter==='boj'){
    const out=[];for(const m of html.matchAll(/<tr\b[^>]*>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi)){const d=dateEnglish(m[1]);if(d)for(const l of links(m[2],url))out.push({...l,publishedDate:d,eventKey:/statement on monetary policy|reference|purchases of japanese government bonds/i.test(l.title)?'boj-'+d:null});}return out;
  }
  if(source.adapter==='fed')return links(html,url).filter(l=>/monetary\d{8}a(?:1)?\.htm|fomcminutes\d{8}\.htm/.test(l.sourceUrl)).map(l=>({...l,eventKey:'fed-'+(l.sourceUrl.match(/(?:monetary|fomcminutes)(\d{8})/)||[])[1],documentType:/minutes/.test(l.sourceUrl)?'meeting_minutes':/a1\.htm/.test(l.sourceUrl)?'implementation_measure':'policy_decision',needsBody:true}));
  if(source.adapter==='boe')return links(html,url).filter(l=>/^https:\/\/www\.bankofengland\.co\.uk\/monetary-policy-summary-and-minutes\/\d{4}\//.test(l.sourceUrl)&&!l.sourceUrl.endsWith('.pdf')).map(l=>({...l,needsBody:true,documentType:'policy_decision',secondaryDocumentTypes:['meeting_minutes']}));
  return [];
}
function publicationFromBody(html,adapter){
  if(adapter==='boe'){const container=(html.match(/<div\b[^>]*class=["'][^"']*published-date[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)||[])[1];const value=P.text(container).replace(/^Published on\s*/i,'');const d=dateEnglish(value);return d?{publishedDate:d}:{};}
  if(adapter==='fed'){const container=(html.match(/<[^>]+class=["'][^"']*article__time[^"']*["'][^>]*>([\s\S]*?)<\//i)||[])[1],d=dateEnglish(container);if(!d)return {};const release=P.text((html.match(/<[^>]+class=["'][^"']*releaseTime[^"']*["'][^>]*>([\s\S]*?)<\//i)||[])[1]),m=release.match(/(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\s*(EDT|EST)/i);if(!m)return {publishedDate:d};const h=Number(m[1])%12+(m[3].toLowerCase()==='p'?12:0);return {publishedAt:`${d}T${String(h).padStart(2,'0')}:${m[2]}:00${m[4].toUpperCase()==='EDT'?'-04:00':'-05:00'}`};}
  const plain=P.text(html);const iso=(html.match(/(?:datePublished|article:published_time)["']?\s*(?:content=|:\s*)["']([^"']+)/i)||[])[1];if(iso&&P.exactTime(iso))return {publishedAt:iso};
  const visible=(plain.match(/(?:Published on|For release at[^.]*?\.|Release Date:|Released on)\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})/i)||[])[1];
  const fed=(plain.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/)||[])[0];
  const d=dateEnglish(visible||fed);return d?{publishedDate:d}:{};
}
function summaryFromBody(html,adapter){const text=P.text(html);
  const fed=text.match(/The Committee decided to (maintain|raise|lower) the target range for the federal funds rate (?:by \d+(?:\/\d)? percentage points? )?(?:at|to) (\d+(?:-\d\/\d)?(?:\.\d+)?) to (\d+(?:-\d\/\d)?(?:\.\d+)?) percent/i);
  if(adapter==='fed'&&fed)return {summaryZh:`结构化摘录：委员会决定${({maintain:'维持',raise:'提高',lower:'降低'})[fed[1].toLowerCase()]}联邦基金利率目标区间至 ${fed[2]}%～${fed[3]}%。`,summaryAnchor:fed[0],summaryAttempted:true};
  const ecb=text.match(/the interest rates on the deposit facility, the main refinancing operations and the marginal lending facility will (?:be (?:increased|decreased|reduced) to|remain unchanged at) (\d+(?:\.\d+)?)%, (\d+(?:\.\d+)?)% and (\d+(?:\.\d+)?)% respectively(?:, with effect from (\d{1,2} [A-Za-z]+ \d{4}))?/i);
  if(adapter==='ecb'&&ecb)return {summaryZh:`结构化摘录：存款便利、主要再融资操作、边际贷款便利利率分别为 ${ecb[1]}%、${ecb[2]}%、${ecb[3]}%。${ecb[4]?'该利率段自 '+dateEnglish(ecb[4])+' 生效。':''}`,summaryAnchor:ecb[0],summaryAttempted:true,effectiveDate:ecb[4]?dateEnglish(ecb[4]):null,effectiveDateScope:ecb[4]?'interest_rate_section':null,effectiveDateAnchor:ecb[4]?ecb[0]:null};
  const pbc=text.match(/一年期抵押补充贷款利率从(\d+(?:\.\d+)?)%降至(\d+(?:\.\d+)?)%/);
  if(adapter==='pboc'&&pbc)return {summaryZh:`结构化摘录：一年期抵押补充贷款利率由 ${pbc[1]}% 降至 ${pbc[2]}%；其他措施请阅读原文。`,summaryAnchor:pbc[0],summaryAttempted:true};
  const boe=text.match(/(?:Monetary Policy Committee|MPC)[^.]{0,150}voted[^.]{0,120}to (maintain|reduce|increase) Bank Rate (?:at|to) (\d+(?:\.\d+)?)%/i);
  if(adapter==='boe'&&boe)return {summaryZh:`结构化摘录：货币政策委员会投票${({maintain:'维持',reduce:'降低',increase:'提高'})[boe[1].toLowerCase()]}银行利率至 ${boe[2]}%。`,summaryAnchor:boe[0],summaryAttempted:true};
  return {summaryZh:null,summaryAnchor:null,summaryAttempted:true};
}
function createService(deps={}){
  const registry=deps.registry||REGISTRY,now=deps.now||Date.now,fetcher=deps.fetch||global.fetch;
  const cacheDir=deps.cacheDir===null?null:deps.cacheDir||path.join(require('../lib/store').DATA_DIR,'cache');
  const latest=new Map(),snapshots=new Map(),inflight=new Map();
  async function getText(url,source,deadline=Infinity){if(!P.officialUrl(url,source.hosts))throw Error('official_url_rejected');if(Date.now()>=deadline)throw Error('refresh_time_limit');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(8000,deadline-Date.now()));
    try{const res=await fetcher(url,{signal:controller.signal,redirect:'manual',headers:{accept:'application/xml,text/xml,text/html;q=0.9','user-agent':'Pharos official policy reader'}});if(!res.ok)throw Error('HTTP_'+res.status);if(Number(res.headers?.get('content-length'))>MAX_BODY)throw Error('response_too_large');
      if(!res.body?.getReader){const body=await res.text();if(Buffer.byteLength(body)>MAX_BODY)throw Error('response_too_large');return body;}
      const reader=res.body.getReader();let size=0;const chunks=[];while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>MAX_BODY){await reader.cancel();throw Error('response_too_large');}chunks.push(Buffer.from(r.value));}return Buffer.concat(chunks).toString('utf8');
    }finally{clearTimeout(timer);}
  }
  async function sourceFetch(source,w,deadline=Date.now()+45000){const raw=[],errors=[],pages=[],at=now();let archiveReached=false;
    const read=url=>getText(url,source,deadline);
    if(source.feed)try{const xml=await read(source.feed);const items=P.parseFeed(xml,source);if(!items.length)throw Error('feed_parse_empty');raw.push(...items);pages.push({url:source.feed,count:items.length});}catch(e){errors.push('feed:'+e.message);}
    if(source.adapter)try{
      if(source.adapter==='pboc'){
        for(let page=1;page<=MAX_PAGES;page++){const url=page===1?source.archive:new URL('11040-'+page+'.html',source.archive).href,html=await read(url),rows=parseArchive(html,source,url);if(!rows.length)throw Error('archive_parse_empty');raw.push(...rows);pages.push({url,count:rows.length});
          const dates=rows.map(i=>i.publishedDate);if(dates.every(P.validDate)&&dates.every((d,i)=>!i||dates[i-1]>=d)&&dates.at(-1)<w.from){archiveReached=true;break;}
        }
      }else if(['ecb','boj'].includes(source.adapter)){
        const years=[...new Set([Number(w.to.slice(0,4)),Number(w.from.slice(0,4))])];
        for(const y of years){const urls=source.adapter==='ecb'?[`https://www.ecb.europa.eu/press/govcdec/mopo/${y}/html/index_include.en.html`,`https://www.ecb.europa.eu/press/accounts/${y}/html/index_include.en.html`]:[`https://www.boj.or.jp/en/mopo/mpmdeci/mpr_${y}/index.htm`];for(const url of urls){const rows=parseArchive(await read(url),source,url);if(!rows.length)throw Error('archive_parse_empty');raw.push(...rows);pages.push({url,count:rows.length});}}archiveReached=true;
      }else{
        const html=await read(source.archive),rows=parseArchive(html,source,source.archive);if(!rows.length)throw Error('archive_parse_empty');
        // Resolve publication from the official body, never from a meeting-date URL.
        const relevant=rows.filter(r=>{const year=(r.sourceUrl.match(/(?:monetary|fomcminutes)(\d{4})|\/(\d{4})\//)||[]).slice(1).find(Boolean);return !year||Number(year)>=Number(w.from.slice(0,4));});
        const unique=[...new Map(relevant.map(r=>[r.sourceUrl,r])).values()].sort((a,b)=>(b.eventKey||b.sourceUrl).localeCompare(a.eventKey||a.sourceUrl));
        for(const r of unique.slice(0,MAX_PAGES)){try{const body=await read(r.sourceUrl),date=publicationFromBody(body,source.adapter),title=P.text((body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)||[])[1])||r.title;raw.push({...r,...date,...summaryFromBody(body,source.adapter),title,bodyText:P.text(body),documentType:r.documentType||P.classify(title)});}catch(e){errors.push('body:'+e.message);}}
        pages.push({url:source.archive,count:rows.length,bodies:Math.min(unique.length,MAX_PAGES)});archiveReached=unique.length<=MAX_PAGES;
        if(!archiveReached)errors.push('body_page_limit');
      }
      if(['pboc','ecb'].includes(source.adapter)){
        const candidates=[...new Map(raw.filter(r=>r.publishedDate>=w.from&&r.publishedDate<=w.to&&['policy_decision','implementation_measure'].includes(r.documentType||P.classify(r.title))).map(r=>[r.sourceUrl,r])).values()].sort((a,b)=>b.publishedDate.localeCompare(a.publishedDate));
        for(const r of candidates.slice(0,8))try{const body=await read(r.sourceUrl);Object.assign(r,summaryFromBody(body,source.adapter),{bodyText:P.text(body)});}catch(e){errors.push('body:'+e.message);}
        if(candidates.length>8)errors.push('body_page_limit');
      }
    }catch(e){errors.push('archive:'+e.message);}
    const items=[],pending=[];for(const r of raw){const n=P.normalize(r,source,at);if(n.item)items.push(n.item);else pending.push({reason:n.error,title:P.text(r.title),sourceUrl:P.officialUrl(r.sourceUrl,source.hosts)});}
    const checked=items.length||pages.length,dates=items.map(i=>i.publishedDate).sort();
    return {items,pending,coverage:{sourceId:source.id,region:source.region,authority:source.authorityZh,scope:source.scope,officialUrl:source.archive,
      status:checked?'source_partial':'source_unavailable',partial:true,unavailable:!checked,archiveReachedWindow:archiveReached,
      requestedFrom:w.from,requestedTo:w.to,observedFrom:dates[0]||null,observedTo:dates.at(-1)||null,
      lastAttemptAt:new Date(at).toISOString(),lastSuccessfulAt:checked?new Date(at).toISOString():null,
      pages,errors,limitations:[!source.adapter?'历史适配未实现，RSS仅有限增量':'栏目范围有限，正文、附件及法律效力未逐条完整核验',...(archiveReached?[]:['历史列表尚未遍历至窗口下界'])]}};
  }
  const keyOf=days=>P.hash([registry.version,'macro-policy-v1',days]);
  function diskRead(key){if(!cacheDir)return null;try{const envelope=JSON.parse(fs.readFileSync(path.join(cacheDir,'macro_policy_'+key+'.json'),'utf8')),s=envelope.snapshot;if(envelope.hash!==P.hash(s)||s.sourceRegistryVersion!==registry.version||s.methodVersion!=='macro-policy-v1'||!Number.isFinite(Date.parse(s.fetchedAt))||Date.parse(s.fetchedAt)>now())return null;return s;}catch(_){return null;}}
  function retain(s){snapshots.set(s.dataVersion,s);for(const [key,v]of snapshots)if(now()-Date.parse(v.fetchedAt)>STALE)snapshots.delete(key);}
  async function refresh(days,prior){const at=now(),w=P.windowOf(days,at),results=[],deadline=Date.now()+45000;
    for(let index=0;index<registry.sources.length;index+=2)results.push(...await Promise.all(registry.sources.slice(index,index+2).map(s=>sourceFetch(s,w,deadline))));
    const items=[],coverage=[],pending=[];for(let i=0;i<results.length;i++){const r=results[i],old=prior?.coverage.find(c=>c.sourceId===r.coverage.sourceId),freshIds=new Set(r.items.map(item=>item.id));
      // A successful incremental feed cannot erase previously fetched archive records.
      // Retained records keep their own original fetchedAt and firstSeenAt.
      const retained=(prior?.rows||[]).filter(item=>item.sourceId===r.coverage.sourceId&&!freshIds.has(item.id));items.push(...retained,...r.items);
      if(retained.length){const checked=retained.map(item=>item.fetchedAt).filter(Boolean).sort();r.coverage.retainedPrevious=true;r.coverage.retainedItemCount=retained.length;r.coverage.retainedSnapshotAt=prior.asOf;r.coverage.retainedCheckedFrom=checked[0]||null;r.coverage.retainedLastSuccessfulAt=checked.at(-1)||null;}
      if(r.coverage.unavailable&&old?.lastSuccessfulAt)r.coverage.lastSuccessfulAt=old.lastSuccessfulAt;
      coverage.push(r.coverage);pending.push(...r.pending);}
    const rows=P.reconcile(items,prior?.rows),lastSuccessfulAt=coverage.map(c=>c.lastSuccessfulAt).filter(Boolean).sort().at(-1)||prior?.lastSuccessfulAt||null;
    const snapshot={schemaVersion:1,methodVersion:'macro-policy-v1',sourceRegistryVersion:registry.version,window:w,asOf:new Date(at).toISOString(),fetchedAt:new Date(at).toISOString(),lastSuccessfulAt,rows,coverage,pending};snapshot.dataVersion=P.hash(snapshot);latest.set(keyOf(days),snapshot);retain(snapshot);
    if(cacheDir)try{fs.mkdirSync(cacheDir,{recursive:true});const file=path.join(cacheDir,'macro_policy_'+keyOf(days)+'.json'),tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify({hash:P.hash(snapshot),snapshot}));fs.renameSync(tmp,file);}catch(_){/* memory remains usable; no fund error */}
    return snapshot;
  }
  function page(s,q,offset=0){const at=now(),rows=P.eventsOf(s.rows,s.window,q),filter=P.hash([q.windowDays,q.region,q.type]),next=offset+PAGE_SIZE<rows.length?Buffer.from(JSON.stringify({v:s.dataVersion,f:filter,o:offset+PAGE_SIZE})).toString('base64url'):null;
    const coverage=s.coverage.filter(c=>!q.region||c.region===q.region).map(c=>({...c,stale:!!c.lastSuccessfulAt&&at-Date.parse(c.lastSuccessfulAt)>STALE}));
    return {schemaVersion:s.schemaVersion,methodVersion:s.methodVersion,sourceRegistryVersion:s.sourceRegistryVersion,dataVersion:s.dataVersion,asOf:s.asOf,window:s.window,fetchedAt:s.fetchedAt,lastSuccessfulAt:s.lastSuccessfulAt,
      status:coverage.some(c=>c.stale)?'stale':coverage.some(c=>c.unavailable)?'source_unavailable':'source_partial',coverage,pending:s.pending,
      items:rows.slice(offset,offset+PAGE_SIZE).map(item=>({...item,interpretation:explainGoldPolicy(item)})),interpretationMethodVersion,nextCursor:next,total:rows.length,emptyReason:rows.length?null:!coverage.some(c=>c.lastSuccessfulAt)?'not_synchronized':'coverage_incomplete',
      caveats:['来源运行成功不等于政策完整率；未登记部门及成员国不覆盖。','仅对可靠原文摘录提供条件性的黄金机制解读，不参与基金决策；提取失败时请阅读官方原文。','日期精度条目按机构日期筛选，不能证明精确北京公布时刻。']};
  }
  async function get(query={}){const q=P.queryOf(query),key=keyOf(q.windowDays);let s=latest.get(key)||diskRead(key);if(s){latest.set(key,s);retain(s);}
    if(q.cursor){let c;try{c=JSON.parse(Buffer.from(q.cursor,'base64url').toString('utf8'));}catch(_){throw Object.assign(Error('cursor_invalid_reload'),{statusCode:409});}
      const bound=snapshots.get(c.v);if(!bound||now()-Date.parse(bound.fetchedAt)>STALE)throw Object.assign(Error('snapshot_expired_reload'),{statusCode:409});if(c.f!==P.hash([q.windowDays,q.region,q.type])||!Number.isInteger(c.o)||c.o<0||c.o%PAGE_SIZE)throw Object.assign(Error('cursor_filter_mismatch_reload'),{statusCode:409});return page(bound,q,c.o);
    }
    if(!s||now()-Date.parse(s.fetchedAt)>=TTL||s.window.to!==P.day(now())){if(!inflight.has(key))inflight.set(key,refresh(q.windowDays,s).finally(()=>inflight.delete(key)));s=await inflight.get(key);}return page(s,q);
  }
  return {get,refresh:days=>refresh(days,latest.get(keyOf(days))),sourceFetch};
}
module.exports={...createService(),createService,parseArchive,publicationFromBody,summaryFromBody,links,TTL,STALE};

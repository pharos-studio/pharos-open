'use strict';
// Mechanism reading only: never used to choose a fund signal, amount or execution.
const METHOD_VERSION='gold-policy-reading-v1';
const references=[{title:'Chicago Fed：What Drives Gold Prices?',url:'https://www.chicagofed.org/publications/chicago-fed-letter/2021/464'},{title:'世界黄金协会：利率与黄金',url:'https://china.gold.org/goldhub/research/publication/2026/06/04/19659'}];
function rateNumber(raw){const mixed=String(raw).match(/^(\d+)-(\d+)\/(\d+)$/);if(mixed){const den=Number(mixed[3]),num=Number(mixed[2]);return den>0&&num<den?Number(mixed[1])+num/den:null;}const value=Number(raw);return Number.isFinite(value)&&value>=0?value:null;}
function explainGoldPolicy(item={}) {
  const base={methodVersion:METHOD_VERSION,references};
  const type=item.documentType;
  const statusText=({proposal_consultation:'这是提案或征求意见，尚不能视为执行决定。',speech_statement:'这是讲话或声明，尚不能视为新的执行决定。',meeting_minutes:'这是会议记录，不能当作新的执行决定。',economic_data:'这是经济数据，不是新的政策执行决定。',reserve_data:'这是储备数据，不是新的购金政策决定。'})[type];
  const unknown=message=>({...base,status:'unavailable',fact:message||'现有资料不足以可靠说明具体政策动作。',mechanism:'尚无法可靠解读对黄金的传导，请阅读官方原文；不会据此改变基金状态。',counterfactors:null,anchor:null});
  if(statusText)return unknown(statusText);
  if(!['policy_decision','implementation_measure'].includes(type)||item.summaryMethod!=='verified-source-template-v1'||item.summaryStatus!=='structured_extract'||item.hasBody!==true||!item.summaryAnchor||!item.summaryZh)return unknown();
  const a=String(item.summaryAnchor), source=item.sourceId;
  let action=null,fact=null;
  if(source==='fed'&&item.region==='US'&&type==='policy_decision') {
    const m=a.match(/^The Committee decided to (maintain|raise|lower) the target range for the federal funds rate (?:by \d+(?:\/\d)? percentage points? )?(?:at|to) (\d+(?:-\d\/\d)?(?:\.\d+)?) to (\d+(?:-\d\/\d)?(?:\.\d+)?) percent\.?$/i);
    if(m){const low=rateNumber(m[2]),high=rateNumber(m[3]);if(low!=null&&high!=null&&low<=high){action=({maintain:'hold',raise:'up',lower:'down'})[m[1].toLowerCase()];fact='美联储决定'+({hold:'维持',up:'提高',down:'降低'})[action]+'联邦基金利率目标区间至 '+low+'%～'+high+'%。';}}
  } else if(source==='ecb'&&item.region==='EA'&&type==='policy_decision') {
    const m=a.match(/^the interest rates on the deposit facility, the main refinancing operations and the marginal lending facility will (be (increased|decreased|reduced) to|remain unchanged at) (\d+(?:\.\d+)?)%, (\d+(?:\.\d+)?)% and (\d+(?:\.\d+)?)% respectively(?:, with effect from \d{1,2} [A-Za-z]+ \d{4})\.?$/i) || a.match(/^the interest rates on the deposit facility, the main refinancing operations and the marginal lending facility will (be (increased|decreased|reduced) to|remain unchanged at) (\d+(?:\.\d+)?)%, (\d+(?:\.\d+)?)% and (\d+(?:\.\d+)?)% respectively\.?$/i);
    if(m){action=m[2]?m[2].toLowerCase()==='increased'?'up':'down':'hold';fact='欧洲央行决定'+({hold:'维持',up:'提高',down:'降低'})[action]+'三项政策利率，分别为 '+m[3]+'%、'+m[4]+'%、'+m[5]+'%。';}
  } else if(source==='boe'&&item.region==='UK'&&type==='policy_decision') {
    const m=a.match(/^(?:Monetary Policy Committee|MPC)[^.]{0,150}voted[^.]{0,120}to (maintain|reduce|increase) Bank Rate (?:at|to) (\d+(?:\.\d+)?)%\.?$/i);
    if(m){action=({maintain:'hold',reduce:'down',increase:'up'})[m[1].toLowerCase()];fact='英国央行货币政策委员会投票'+({hold:'维持',up:'提高',down:'降低'})[action]+'银行利率至 '+m[2]+'%。';}
  } else if(source==='pboc'&&item.region==='CN'&&type==='implementation_measure') {
    const m=a.match(/^一年期抵押补充贷款利率从(\d+(?:\.\d+)?)%降至(\d+(?:\.\d+)?)%$/);
    if(m&&Number(m[1])>Number(m[2])){action='targeted_down';fact='人民银行降低一年期抵押补充贷款这一特定工具的利率，由 '+m[1]+'%降至 '+m[2]+'%；不能把它当成通用降息。';}
  }
  if(!action)return unknown();
  let mechanism;
  if(item.region==='US')mechanism=action==='down'?'如果后续实际利率（扣除通胀影响后的利率）或美元随之走低，黄金持有成本可能下降，形成支持；政策降息本身不能证明这两个变化已经发生。':action==='up'?'如果后续实际利率（扣除通胀影响后的利率）或美元随之走高，黄金可能面临压力；政策加息本身不能证明这两个变化已经发生。':'维持政策利率仍可能改变市场预期；只有结合后续实际利率（扣除通胀影响后的利率）和美元变化，才能判断黄金可能受到的影响。';
  else if(item.region==='CN')mechanism='这项措施主要影响特定融资渠道，不能直接推出国际金价方向；人民币黄金还会受汇率和国内溢价影响。';
  else mechanism='这是'+(item.region==='EA'?'欧元区':'英国')+'的本地利率动作，可能通过当地持有成本、经济预期和汇率间接影响黄金，不能直接套用美国实际利率或美元已经变化的结论。';
  return {...base,status:'supported',action,fact,mechanism,counterfactors:'通胀预期、风险需求及其他需求因素可能抵消上述传导，金价反应并不固定。',anchor:a};
}
module.exports={METHOD_VERSION,explainGoldPolicy};

'use strict';
const assert=require('node:assert/strict'),{explainGoldPolicy,METHOD_VERSION}=require('../lib/goldPolicyExplanation');
function run(){
  const base={sourceId:'fed',region:'US',documentType:'policy_decision',hasBody:true,summaryMethod:'verified-source-template-v1',summaryStatus:'structured_extract',summaryZh:'结构化摘录',summaryAnchor:'The Committee decided to lower the target range for the federal funds rate by 1/4 percentage point to 3-1/2 to 3-3/4 percent'};
  const low=explainGoldPolicy(base);assert.equal(low.status,'supported');assert.equal(low.action,'down');assert.match(low.mechanism,/如果/);assert.match(low.mechanism,/不能证明/);assert.equal(low.methodVersion,METHOD_VERSION);
  assert.match(low.fact,/3.5%～3.75%/);
  assert.match(low.mechanism,/实际利率（扣除通胀影响后的利率）/);
  for(const raw of ['3-3/0 to 4','3-5/4 to 4','4 to 3'])assert.equal(explainGoldPolicy({...base,summaryAnchor:base.summaryAnchor.replace('3-1/2 to 3-3/4',raw)}).status,'unavailable');
  for(const action of ['raise','maintain']){const r=explainGoldPolicy({...base,summaryAnchor:base.summaryAnchor.replace('lower',action)});assert.equal(r.status,'supported');assert(!/无影响|必涨|必跌/.test(r.mechanism));}
  for(const [type,word]of [['proposal_consultation','提案'],['speech_statement','讲话'],['meeting_minutes','会议记录'],['economic_data','经济数据'],['reserve_data','储备数据']]){const r=explainGoldPolicy({...base,documentType:type});assert.equal(r.status,'unavailable');assert.match(r.fact,new RegExp(word));}
  for(const change of [{summaryMethod:null},{summaryAnchor:null},{hasBody:false},{summaryStatus:'not_extracted'},{sourceId:'treasury'},{region:'EA'},{documentType:'unknown'},{summaryAnchor:'The target rate is at 3 percent'},{summaryAnchor:'The Committee decided to purchase gold'}])assert.equal(explainGoldPolicy({...base,...change}).status,'unavailable');
  const ecb={...base,sourceId:'ecb',region:'EA',summaryAnchor:'the interest rates on the deposit facility, the main refinancing operations and the marginal lending facility will be increased to 2.50%, 2.65% and 2.90% respectively, with effect from 16 September 2026'};
  assert.equal(explainGoldPolicy(ecb).action,'up');assert.match(explainGoldPolicy(ecb).mechanism,/不能直接套用美国/);
  const unchanged={...ecb,summaryAnchor:ecb.summaryAnchor.replace('be increased to','remain unchanged at')};assert.equal(explainGoldPolicy(unchanged).action,'hold');
  const boe={...base,sourceId:'boe',region:'UK',summaryAnchor:'MPC voted by a majority of 7–2 to maintain Bank Rate at 4%'};assert.equal(explainGoldPolicy(boe).action,'hold');assert.match(explainGoldPolicy(boe).mechanism,/英国/);
  const cn={...base,sourceId:'pboc',region:'CN',documentType:'implementation_measure',summaryAnchor:'一年期抵押补充贷款利率从1.75%降至1.5%'};assert.equal(explainGoldPolicy(cn).action,'targeted_down');assert.match(explainGoldPolicy(cn).fact,/特定工具/);assert.match(explainGoldPolicy(cn).mechanism,/不能直接推出/);
  assert.equal(explainGoldPolicy({...cn,summaryAnchor:'一年期抵押补充贷款利率从1.5%降至1.75%'}).status,'unavailable');
  const frozen=JSON.stringify(base);explainGoldPolicy(base);assert.equal(JSON.stringify(base),frozen);assert.equal(explainGoldPolicy({title:'决定降息支持黄金',summaryZh:'可靠字样'}).status,'unavailable');
  assert.equal(explainGoldPolicy({...base,summaryAnchor:base.summaryAnchor.toUpperCase()}).status,'supported');
  console.log('gold policy explanation: supported anchored US/EA/UK/CN actions, conditional channels, maintained rates, unsupported titles/body/method/type/region and immutable input passed');
}
if(require.main===module)run();module.exports={run};

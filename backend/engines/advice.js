'use strict';
/*
 * 每日建议引擎（规则引擎）：L1 组合状态 / per-fund 统一信号（决策判定 + 综合分 + 两维结论文案）。
 * 决策信号（红利/科技/黄金/宽基）经 registry.REGISTRY 遍历分发；统一引擎 computeAllocation 在
 * buildAnalysis 阶段已对每只持仓算好 dec（_dec/_marketScore 挂在 a.funds[i] 上），本文件组装 funds[] 时
 * **直接复用**（不再第二次调 builder，见 plans/tranquil-ember-galileo-Kx8Qm3Rv §七 已查证同引用无漂移）。
 * 响应结构：funds[] 每基金一条（verdict/score/scoreLabel/conclusion/净值全同源）；alerts[] 收非常规
 * 信号（trim/statementOnly）；l2/l3/fundSnap/navDates 已删除（信息全部并入 funds[]，2026-09-08 整合）。
 * session='pm' 只复盘不动作、不消耗冷却；session='am' 可执行、写 signals.json 冷却与决策历史。
 */
const analysis = require('./analysis');
const allocation = require('./alloc/allocation');
const { REGISTRY, resolveRegistry, isPendingCategory } = require('./registry');
const store = require('../lib/store');
const util = require('../lib/util');
const config = require('../lib/config');
const timing = require('./timing'); // 买入时机复盘：战役状态机采集（am-only，不进校准统计的用户买入 = buyScan 处理）

// factors 状态三态 helper：cheap=绿(偏便宜/有利买入) / expensive=红(偏贵/不利买入) / neutral=灰(信息项不判好坏)
function maStatus(z) { return z === 'below' ? 'cheap' : z === 'above' ? 'expensive' : 'neutral'; }
function gateStatus(g) { return g === 'block' ? 'expensive' : 'cheap'; }
function erpStatus(z) { return z === 'high' ? 'cheap' : z === 'low' ? 'expensive' : 'neutral'; }

// ---------- 结论文案两维派生（方案甲，2026-09-08 用户拍板：贴天然锚点分档，措辞与数字永远同源）----------
// score（0~100，marketScore）→ 便宜度形容词：[75,100] 深便宜 / [40,75) 中便宜 / [25,40) 中性 / [0,25) 偏贵；null → 无数据。
// 天然锚点：0=贵区/PE总闸拦截，25=中性(0.5²×100，无数据兜底同值)，100=满格便宜。25 分是"没信号"的数学锚。
function scoreLabelOf(score) {
  if (score == null) return null;
  if (score >= 75) return '深便宜';
  if (score >= 40) return '中便宜';
  if (score >= 25) return '中性';
  return '偏贵';
}
// 两维拼句：action（add/hold 机器值）给动作词，score 给便宜度词。措辞表见计划 §六。
// suspended（暂停申购）与 dailyLimit（每日限购 >0）作为尾注追加——保持原 action 句里的限购/暂停提示能力。
function conclusionOf(action, score, suspended, dailyLimit, compositeLabel) {
  const sl = scoreLabelOf(score);
  // ★硬约束一票否决（gate=block / 暂停申购）把综合分直接归零，与"贵不贵"无关。
  //   此时不能说"偏贵区"（否则出现「综合分 0，偏贵区」的误导文案），须改为说明归零原因。
  const blocked = score === 0 && (compositeLabel === '暂停申购' || compositeLabel === 'PE总闸拦截');
  let base;
  if (blocked) {
    base = action === 'add'
      ? `综合分 0（${compositeLabel} → 硬约束一票否决归零，不代表估值贵），已过确认门槛但当前不可买入`
      : `综合分 0（${compositeLabel} → 硬约束一票否决归零），维持不动：按你自己原来的节奏`;
  } else if (score == null) {
    base = action === 'add'
      ? '数据不足但已过确认门槛，可小步加仓（金额与节奏由你自己定）'
      : '数据不足，维持不动：按你自己原来的节奏';
  } else if (action === 'add') {
    if (sl === '中性') base = `综合分 ${score}，中性区但已过确认门槛，可小步加仓（金额与节奏由你自己定）`;
    else if (sl === '偏贵') base = `综合分 ${score}，偏贵区，本次靠趋势/纪律确认，加仓请谨慎（金额自行决定）`;
    else base = `综合分 ${score}，${sl}区，可加仓（金额与节奏由你自己定，系统不强制）`;
  } else {
    base = sl === '深便宜'
      ? `综合分 ${score}，已深便宜但未过确认门槛（如未止跌），维持不动，等确认`
      : `综合分 ${score}（${sl}），维持不动：按你自己原来的节奏`;
  }
  const tail = blocked
    ? '' // 归零原因已在 base 里说明，不再追加暂停/限购尾注（避免重复与误导）
    : (suspended
      ? '；当前暂停申购，仅作信号观察'
      : (dailyLimit != null && dailyLimit > 0 ? `；注意每日限购 ¥${dailyLimit}` : ''));
  return base + tail;
}

// 周对比：取 7 天前那天的决策快照（精确日期 → 否则 7 天窗口内最近一条 ≤ target → 都没有则 {}）
function pickWeekAgo(history) {
  if (!Array.isArray(history) || !history.length) return {};
  // ★ 「7 天前」要按**上海时区**的今天算，不能用 `new Date()` + 本机 getter：
  //   进程不在东八区时「本机今天」会与「上海今天」差一天，从而取错快照（且不报错）。
  //   这里与 lib/tradeDate.js 同一条铁律：UTC 锚点 + UTC getter 做纯日历减法。
  const d = new Date(util.todayStr() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 7);
  const target = d.toISOString().slice(0, 10);
  const exact = history.find(e => e.date === target);
  if (exact) return exact.funds || {};
  const before = history.filter(e => e.date <= target).sort((a, b) => a.date < b.date ? 1 : -1);
  return before.length ? (before[0].funds || {}) : {};
}

// 决策卡组装：按 dec.matrix._type 还原 title/detail/factors（展示层原样保留，含真实因子长文）。
// ⚠ 不再生成写死 action 中文句（R1：原 L2 条目 .action 是中文展示句，.verdict 才是机器值）——
// 结论文案由 conclusionOf(dec.action, score, ...) 两维派生（funds 组装处调用），verdict 字段保留机器值供历史/周对比。
function buildCard(f, dec, dailyLimits, cfg) {
  const actLabel = dec.action === 'add' ? '加仓' : '不动';
  if(dec.strategyVersion==='gold-dual-v1'){
    const m=dec.matrix,x=m.metrics,fmt=v=>v==null?'—':Number(v).toFixed(3),names={negativeBias:'BIAS120 ≤−5%',biasRepair:'近10日BIAS修复 ≥1个百分点',rsiRising:'日RSI14严格回升',rsiCeiling:'日RSI14 ≤55',aboveLongMA:'复权净值 > MA250',trendMA:'MA60 > MA250',drawdownRange:'60日回撤 3%～10%',recovery:'10日恢复 ≥1.5%',biasCeiling:'BIAS60 ≤2%',rsiRange:'日RSI14 45～65'};
    const factors=['A','B'].flatMap(p=>Object.entries(m.conditions[p]||{}).map(([k,v])=>({dim:(p==='A'?'A 回撤修复':'B 趋势回踩')+' · '+names[k],value:v===true?'达标':v===false?'未达标':'无法判定',status:v===true?'cheap':'neutral'})));
    factors.push({dim:'250日位置（仅参考）',value:fmt(x.position250)+'%',status:'neutral'},{dim:'版本启用',value:m.releaseLabel,status:'neutral'});
    const evidenceNames={profile_unverified:'当前官方身份',daily_sampling_unverified:'日频采样',initialization_unverified:'策略起点／连续性',official_actions_history_unverified:'完整官方分红拆分史',fund_calendar_unverified:'基金日期与开放规则'};
    if(m.evidenceBlockers.length)factors.push({dim:'尚未核验项目',value:m.evidenceBlockers.map(k=>evidenceNames[k]||k).join('、'),status:'neutral'});
    const detail=`A：BIAS120≤−5%、近10日最低乖离修复≥1个百分点、日RSI14严格回升且≤55。B：复权净值及MA60均>MA250、60日回撤3%～10%、近10日恢复≥1.5%、BIAS60≤2%、日RSI14为45～65且严格回升。路径内全部且，两路或；重合只形成一个候选。BIAS120 ${fmt(x.bias120)}%、BIAS60 ${fmt(x.bias60)}%、回撤 ${fmt(x.drawdown60)}%、恢复 ${fmt(x.recovery10)}%、RSI ${fmt(x.rsi14)}（前日 ${fmt(x.previousRsi14)}）。信号净值日 ${x.navDate||'—'}；申请日 ${m.orderDate||'—'}；计算 ${m.computedAt||'—'}。${dec.action==null?dec.reasons.join('；')+'。':''}${m.releasePending?'待独立终审与确认启用；当前不可执行。':''}${m.futureOrder?'未来申请日须届时复核。':''}仅判断买入，无卖出或补仓；250日位置只参考。趋势回踩可能位于长期相对高位，历史结果不保证盈利；${m.dataCaveat}。`;
    return {title:'国内黄金：'+m.marketStateLabel,detail,verdict:dec.action,factors};
  }
  if(dec.strategyVersion==='active-equity-buy-v1'){
    const m=dec.matrix,fmt=v=>v==null?'—':Number(v).toFixed(3),pct=v=>v==null?'—':fmt(v*100)+'%',names={drawdown:'窗口回撤',bias:'BIAS',recovery:'近10日恢复 ≥2%',rsi:'日RSI14严格回升且在范围内',priceTrend:'净值 > MA250',shortTrend:'MA60 > MA250',longDirection:'MA250 > 20个有效净值日前'};
    const factors=['A','B'].flatMap(path=>Object.entries(m.conditions[path]||{}).map(([key,pass])=>({dim:(path==='A'?'A 回撤修复':'B 趋势回踩')+' · '+names[key],value:pass===true?'达标':pass===false?'未达标':'无法判定',status:pass===true?'cheap':'neutral'})));
    for(const path of ['A','B']){const x=m.metrics[path];if(x)factors.push({dim:path+' 指标（原精度判断）',value:`回撤 ${pct(x.D)}；BIAS ${pct(x.BIAS)}；恢复 ${pct(x.R10)}；日RSI ${fmt(x.rsi)} / 前日 ${fmt(x.previousRsi)}`,status:'neutral'});else factors.push({dim:path+' 通道',value:'无法判定；'+(m.pathReasons[path]||[]).join('；'),status:'neutral'});}
    const detail=`仅买入判断。A：120日回撤≥15%、BIAS120≤−8%、近10日恢复≥2%、日RSI14严格回升且≤55。B：净值及MA60均>MA250、MA250高于20个有效净值日前、60日回撤5%～15%、恢复≥2%、BIAS60≤0%、日RSI14为40～60且严格回升。任一路成立为候选，两路均有效不成立为等待，其余无法判定。信号净值日 ${m.metrics.navDate||'—'}；申请日 ${m.orderDate||'—'}；计算 ${m.computedAt||'—'}。${m.futureOrder?'未来申请日需届时复核。':''}${dec.action==null?dec.reasons.join('；')+'。':''}身份、日频采样、数据可知性和申购状态分别核验；${m.dataCaveat||''}。没有PE或综合分门槛；不含卖出、补仓节奏或金额建议，历史结果不保证盈利。`;
    return {title:'主动权益：'+m.marketStateLabel,detail,verdict:dec.action,factors};
  }
  if(dec.strategyVersion==='nasdaq-dual-v1'){
    const m=dec.matrix,x=m.metrics,fmt=v=>v==null?'—':Number(v).toFixed(3),pct=v=>fmt(v)+'%';
    const names={pePercentile:'PE三年分位 ≤25%',bias:'BIAS',biasRepair:'10日BIAS修复 ≥1个百分点',
      rsiCeiling:'周RSI14 ≤55',rsiRising:'周RSI14严格回升',priceAboveMa250:'净值 > MA250',ma60AboveMa250:'MA60 > MA250',
      pullback:'60日回落 2%～8%',recovery:'10日恢复 ≥1.5%',rsiRange:'周RSI14 45～65'};
    const labels={draw:'回撤修复',trend:'趋势回踩'},states={buy:'触发',hold:'未触发',unknown:'无法判定'};
    const factors=['draw','trend'].flatMap(path=>Object.entries(m.conditions[path]||{}).map(([key,c])=>({
      dim:labels[path]+' · '+(key==='bias'?(path==='draw'?'BIAS120 ≤−5%':'BIAS250 ≤10%'):names[key]||key),
      value:fmt(c.value)+'；'+(c.pass==null?'无法判定':c.pass?'达标':'未达标'),status:c.pass===true?'cheap':'neutral'})));
    const detail=`PE仅为回撤通道门槛，PE在趋势通道仅参考。回撤 ${states[m.pathStates.draw]}；趋势 ${states[m.pathStates.trend]}。`+
      `BIAS120 ${pct(x.bias120)}、修复 ${fmt(x.biasRepair120)} 个百分点；BIAS250 ${pct(x.bias250)}；60日回落 ${pct(x.dip60)}、10日恢复 ${pct(x.recovery10)}。`+
      `已完成且本次可知周RSI14 ${fmt(x.weeklyRsi)}（前周 ${fmt(x.previousWeeklyRsi)}；周末 ${x.weeklyDate||'—'}）。`+
      `信号净值日 ${x.navDate||'—'}；目标申请日 ${m.orderDate||'—'}；本次计算 ${m.computedAt||'—'}。`+
      `PE三年分位 ${pct(x.pePercentile)}（当前观察不计，严格较低）；PE日 ${m.peDate||'—'}；ERP ${pct(m.erpReference)}仅参考。`+
      `${dec.action==null?dec.reasons.join('；')+'。':''}${m.futureOrder?'未来申请日需届时复核。':''}`+
      `${m.officialPurchaseConstraint?(m.officialPurchaseConstraint.status==='unknown'?'官方申购约束正文或恢复待核；':'官方暂停自 '+m.officialPurchaseConstraint.start+'；')+'最近核验 '+m.officialPurchaseConstraint.checkedAt+'，证据超过24小时执行待复核。':''}`+
      `${m.observedPurchaseLimit?'官方已观察正限额 ¥'+m.observedPurchaseLimit.amountCny+'（账户每日合计；核验 '+m.observedPurchaseLimit.checkedAt+'；具体渠道仍需复核）。':''}`+
      `本次取得快照不证明历史当时可知；历史可能修订。RSI按原始精度严格比较，极小浮点回升也可能达标；历史结果不保证盈利。`;
    factors.push({dim:'ERP（仅参考）',value:pct(m.erpReference),status:'neutral'},{dim:'250日净值分位（仅参考）',value:pct(x.position250),status:'neutral'});
    return {title:'纳斯达克100 决策：'+m.marketStateLabel,detail,verdict:dec.action,factors};
  }
  if(dec.strategyVersion==='hs300-dual-v1') {
    const m=dec.matrix,x=m.metrics,pct=v=>v==null?'—':v+'%';
    const names={negativeBias:'回撤修复 · BIAS120 ≤−3.0084%',repair:'回撤修复 · 10日乖离修复 ≥1百分点',
      rsiRising:'周 RSI14 严格回升',priceAbove:'趋势回踩 · 复权净值 > MA250',maAbove:'趋势回踩 · MA60 > MA250',
      dip:'趋势回踩 · 60日回落 2%～6%',recovery:'趋势回踩 · 10日恢复 ≥1.5%',bias:'趋势回踩 · BIAS250 ≤8%',rsiRange:'趋势回踩 · 周 RSI14 45～65'};
    const factor=(dim,value)=>({dim,value:value==null?'无法判断':value?'达标':'未达标',status:value===true?'cheap':'neutral'});
    const paths={deep:'回撤修复',trend:'趋势回踩',both:'双通道同时触发'};
    const detail=`共同入口 PE分位 ${pct(x.pePercentile)}（≤25%；此前60个连续自然月，当前月不计入）｜BIAS120 ${pct(x.bias120)}、修复 ${x.biasRepair120??'—'} 个百分点｜BIAS250 ${pct(x.bias250)}｜60日回落 ${pct(x.dip60)}、10日恢复 ${pct(x.recovery10)}｜已完成且可知周 RSI14 ${x.weeklyRsi??'—'}（前周 ${x.previousWeeklyRsi??'—'}；周末 ${x.weeklyDate||'—'}）。信号净值日 ${x.navDate||'—'}；申请日 ${m.orderDate||'—'}；PE日 ${m.peDate||'—'}（${m.peSource||'—'}）。触发路径：${paths[m.route]||'无'}。${dec.action==null?dec.reasons.join('；')+'。':''}ERP ${pct(m.erpReference)}仅参考。${m.individuallyBacktested?'已观察四只同指数样本，不是四份独立市场证据':'此份额未经逐只回测'}；历史PE可能修订，历史结果不保证未来盈利。`;
    return {title:`沪深300 决策：${m.marketStateLabel}`,detail,verdict:dec.action,
      factors:[factor('共同PE入口 ≤25%',m.conditions.peGate),
        ...['deep','trend'].flatMap(path=>Object.entries(m.conditions[path]).filter(([key])=>!['peGate','rsiCap'].includes(key)).map(([key,value])=>factor((key==='rsiRising'?(path==='deep'?'回撤修复 · ':'趋势回踩 · '):'')+names[key],value))),
        {dim:'ERP（仅参考）',value:pct(m.erpReference),status:'neutral'},
        {dim:'250日净值分位（仅参考）',value:pct(x.position250),status:'neutral'}]};
  }
  if (dec.strategyVersion === 'dividend-trend-v1') {
    const m=dec.matrix,x=m.metrics,pct=v=>v==null?'—':v+'%';
    const conditions=m.conditions, names={navAboveMa250:'复权净值 > MA250',ma60AboveMa250:'MA60 > MA250',
      dip60InRange:'60日回落 2%～6%',recovery10Ready:'10日恢复 ≥1.5%',bias250Allowed:'BIAS250 ≤8%',
      weeklyRsiInRange:'周 RSI14 45～65',weeklyRsiRising:'周 RSI 严格回升'};
    const yr=m.yieldReference;
    const errorText=({profile_unverified:'自动档案或官方指数身份未核验',scope_unsupported:'仅支持国内红利指数、联接和指数增强基金',
      incomplete_week_close:'最新完整周收盘净值尚不可知',calendar_unverified:'交易日历尚未核验',nav_calendar_coverage_gap:'近期开放日净值存在缺口',
      stale_nav_history:'净值已过期',insufficient_adjusted_nav:'至少需要260个合格净值日',
      insufficient_completed_weeks:'至少需要16个合格周',reported_return_mismatch:'净值收益与分红拆分记录不一致',
      dividend_data_unavailable:'完整复权净值尚未取得'})[m.dataError]|| (m.dataError?'完整净值或复权资料核验未通过':'');
    const detail=`信号净值日 ${x.navDate||'—'}；目标申请日 ${m.orderDate||'—'}。BIAS250 ${pct(x.bias250)}｜60日回落 ${pct(x.dip60)}｜10日恢复 ${pct(x.recovery10)}｜已完成周 RSI14 ${x.weeklyRsi14??'—'}（前周 ${x.previousWeeklyRsi14??'—'}）。${m.dataError?'暂不判定：'+errorText+'。':''}股息率 ${yr?.value!=null?pct(+(yr.value*100).toFixed(2)):'未取得'}（${yr?.indexName||'对应指数未核验'}；${yr?.asOf||'发布时间未核验'}），仅参考，不参与判断。`;
    return {title:`红利·低波 决策：${m.marketStateLabel}`,detail,verdict:dec.action,
      factors:[...Object.entries(names).map(([key,dim])=>({dim,value:Object.hasOwn(conditions,key)?conditions[key]?'达标':'未达标':'—',
        status:conditions[key]===true?'cheap':'neutral'})),
        {dim:'250日净值分位（参考）',value:pct(x.percentile250),status:'neutral'},
        {dim:'对应指数股息率（参考）',value:yr?.value!=null?pct(+(yr.value*100).toFixed(2)):'—',status:'neutral'}]};
  }
  if (dec.matrix._type === 'tech') {
    const m = dec.matrix;
    const dipTxt = m.drawdown != null ? `${m.drawdown.toFixed(1)}%` : '—';
    const maTxt = m.goldenState === true ? '金叉(MA20>MA60)' : m.goldenState === false ? '死叉(MA20<MA60)' : '—';
    const gateTxt = m.gate === 'block' ? '拦截' : '放行';
    const tCfg = (cfg && cfg.signals && cfg.signals.tech) || {};
    const limit = dailyLimits[f.code];
    const limitTxt = limit === 0 ? '（暂停申购）' : (limit != null ? `（每日限购 ¥${limit}）` : '（无上限）');
    const detail = `回撤 ${dipTxt}（阈值≤-${tCfg.dipPct || 15}%）｜止跌 ${m.stopFall ? '是' : '否'}｜双均线 ${maTxt}｜PE闸 ${gateTxt}${limitTxt}。${dec.reasons.length ? dec.reasons.join('；') : ''}`;
    return {
      level: 'L2', type: 'tech', code: f.code, name: f.name,
      title: `主题·行业（高波动） 决策：${f.name} → ${actLabel}`,
      detail,
      factors: [
        { dim: '回撤', value: dipTxt, status: m.drawdown != null && m.drawdown <= -(tCfg.dipPct || 15) ? 'cheap' : 'neutral' },
        { dim: '止跌', value: m.stopFall ? '是' : '否', status: m.stopFall ? 'cheap' : 'neutral' },
        { dim: '双均线', value: maTxt, status: 'neutral' },
        { dim: 'PE闸', value: gateTxt, status: gateStatus(m.gate) },
      ],
      verdict: dec.action === 'add' ? 'add' : 'hold',
    };
  } else if (dec.matrix._type === 'broad') {
    const m = dec.matrix;
    const isUS = m._caliber === 'us';   // 宽基·海外（纳指100）：两通道并联口径
    const peTxt = m.peZone === 'cheap' ? '便宜' : m.peZone === 'expensive' ? '贵' : (m.peZone === 'neutral' ? '中性' : '数据缺失');
    const trendTxt = m.trendWeak === true ? '跌破半年线' : m.trendWeak === false ? '站上半年线' : '—';
    const gateTxt = m.gate === 'block' ? '拦截' : '放行';
    if (isUS) {
      // 海外口径：主锚 = 自算滚动分位；副锚 ERP 对美债；通道② = PE 回撤
      const erpTxt = m.erpZone === 'high' ? '偏高(相对美债)' : m.erpZone === 'low' ? '偏低(相对美债)' : (m.erpZone === 'neutral' ? '中性' : '—');
      const dipTxt = m.peDipLevel != null ? `${m.peDipLevel}%` : '—';
      const pctTxt = m.peRollingPct != null ? `${m.peRollingPct}%` : '—';
      const winW = m.peWindowWeeks || 156;
      const dipW = m.peDipWindowWeeks || 52;
      const dipTh = m.peDipPct != null ? m.peDipPct : 12;   // 与 config.peDipPct 对齐（2026-09-13 由 15 改 12）
      const detail = `PE滚动${winW}周分位 ${pctTxt}（${peTxt}）｜PE回撤(近${dipW}周) ${dipTxt}（阈值≤-${dipTh}%）｜ERP(对美债) ${erpTxt}｜趋势 ${trendTxt}（${m.trendGrade || '—'}）｜PE闸 ${gateTxt}。${dec.reasons.length ? dec.reasons.join('；') : ''}`;
      return {
        level: 'L2', type: 'broad', code: f.code, name: f.name,
        title: `宽基·海外 决策：${f.name} → ${actLabel}`,
        detail,
        factors: [
          { dim: `PE滚动${winW}周分位`, value: `${pctTxt}（${peTxt}）`, status: m.peZone },
          { dim: 'PE回撤', value: dipTxt, status: m.cheapByDip ? 'cheap' : 'neutral' },
          { dim: 'ERP', value: erpTxt, status: erpStatus(m.erpZone) },
          { dim: '趋势', value: trendTxt, status: m.trendWeak ? 'cheap' : 'neutral' },
          { dim: 'PE闸', value: gateTxt, status: gateStatus(m.gate) },
        ],
        verdict: dec.action === 'add' ? 'add' : 'hold',
      };
    }
    // A 股口径：保持原样（文案逐字不变，作为回归基线）
    const erpTxt = m.erpZone === 'high' ? '偏高(股票划算)' : m.erpZone === 'low' ? '偏低(债券划算)' : (m.erpZone === 'neutral' ? '中性' : '—');
    const detail = `PE分位 ${peTxt}｜ERP(股债利差) ${erpTxt}｜趋势 ${trendTxt}（${m.trendGrade || '—'}）｜PE闸 ${gateTxt}。${dec.reasons.length ? dec.reasons.join('；') : ''}`;
    return {
      level: 'L2', type: 'broad', code: f.code, name: f.name,
      title: `宽基(双锚) 决策：${f.name} → ${actLabel}`,
      detail,
      factors: [
        { dim: 'PE分位', value: peTxt, status: m.peZone },
        { dim: 'ERP', value: erpTxt, status: erpStatus(m.erpZone) },
        { dim: '趋势', value: trendTxt, status: m.trendWeak ? 'cheap' : 'neutral' },
        { dim: 'PE闸', value: gateTxt, status: gateStatus(m.gate) },
      ],
      verdict: dec.action === 'add' ? 'add' : 'hold',
    };
  } else { // cycle
    const m = dec.matrix;
    const pctTxt = m.pctZone === 'cheap' ? '便宜' : m.pctZone === 'expensive' ? '贵' : (m.pctZone === 'neutral' ? '中性' : '—');
    const trendTxt = m.trendWeak === true ? '跌破半年线' : m.trendWeak === false ? '站上半年线' : '—';
    const stopTxt = m.stopFall ? '已止跌' : '未止跌';
    const surgeTxt = m.surge ? '急涨强拦' : '急涨放行';
    const detail = `250日分位 ${pctTxt}｜趋势 ${trendTxt}（${m.trendGrade || '—'}）｜止跌 ${stopTxt}｜急涨闸 ${surgeTxt}。${dec.reasons.length ? dec.reasons.join('；') : ''}`;
    return {
      level: 'L2', type: 'cycle', code: f.code, name: f.name,
      title: `商品·对冲 决策：${f.name} → ${actLabel}`,
      detail,
      factors: [
        { dim: '250日分位', value: pctTxt, status: m.pctZone },
        { dim: '趋势', value: trendTxt, status: m.trendWeak ? 'cheap' : 'neutral' },
        { dim: '止跌', value: stopTxt, status: m.stopFall ? 'cheap' : 'neutral' },
        { dim: '急涨闸', value: surgeTxt, status: m.surge ? 'expensive' : 'cheap' },
      ],
      verdict: dec.action === 'add' ? 'add' : 'hold',
    };
  }
}

async function buildAdvice(session = 'am') {
  const isPM = session === 'pm';
  const a = await analysis.buildAnalysis();
  const cfg = config.getConfig();
  const sig = cfg.signals || {};
  const policy = cfg.categoryPolicy || {};
  const dailyLimits = cfg.dailyLimits || {}; // 每日限购（0=暂停申购，null=无上限）
  const thresholds = sig.fundThresholds || {};
  const cooldownDays = sig.cooldownDays == null ? 7 : sig.cooldownDays;
  const today = util.todayStr();
  // 统一引擎结果（buildAnalysis 已算好挂在 a.plan 且 _dec/_marketScore 已挂在 a.funds[i]，见计划 §七 同引用查证）
  // 兜底分支同样组装 valuationMap（pePercentile/pricePercentile），保证「便宜度」维度不缺失
  const _fallbackVMap = {};
  (a.funds || []).forEach(f => { _fallbackVMap[f.code] = f.valuation || {}; });
  const plan = a.plan || allocation.computeAllocation(a.allocation, policy, a.funds, a.totals.totalValue, 0, _fallbackVMap, dailyLimits); // 预算已移除：只产出综合分信号

  let sigState = {};
  try { sigState = store.readJSON('signals.json'); } catch (e) { sigState = {}; }

  // ---------- L1：组合状态（常驻播报，不含操作指令）----------
  let dayGain = 0, dayBase = 0;
  a.funds.forEach(f => {
    if (f.dayChange != null && f.currentValue) {
      const prev = f.currentValue / (1 + f.dayChange / 100);
      dayGain += f.currentValue - prev;
      dayBase += prev;
    }
  });
  const allocationRows = a.allocation.map(c => ({
    key: c.key, name: c.name, pct: c.pct,
    value: c.value,
    policy: policy[c.key] || 'buy'
  }));

  const l1notes = [];
  // H1: 净值缺失/兜底提示（避免"市值缩水/假盈亏"被静默吞掉）
  const navMissing = a.funds.filter(f => f.currentValue == null);
  const navFallback = a.funds.filter(f => f.navFallback);
  if (navMissing.length) {
    l1notes.push(`⚠️ 净值缺失：${navMissing.map(f => `${f.code}(${f.name.slice(0, 8)})`).join('、')} 本次未取到最新净值，已从汇总中剔除（避免计入假市值）。`);
  }
  if (navFallback.length) {
    l1notes.push(`净值未更新：${navFallback.map(f => `${f.code} 已用 ${f.navFallbackDate} 快照兜底`).join('、')}，本次市值按快照估算。`);
  }
  // 冻结类别的深度回撤 → 只做纪律提醒，禁止任何买入措辞
  const frozenDeep = a.funds
    .filter(f => (policy[util.engineCategoryToBucket(f.category)] || 'buy') === 'frozen' && f.currentValue > 0)
    .map(f => ({ f, dd: util.drawdownFromHigh(f.history.slice(0, 60)) }))
    .filter(x => x.dd != null && thresholds[x.f.code] != null && x.dd <= thresholds[x.f.code]);
  if (frozenDeep.length) {
    l1notes.push('纪律提醒：' + frozenDeep.map(x => `${x.f.code} 回撤 ${x.dd.toFixed(2)}%`).join('、') +
      ' 处于深度回撤区。该类别按既定策略冻结，**不加仓、不动作**，等待占比自然稀释。');
  }

  const l1 = {
    totalPrincipal: a.totals.totalPrincipal,           // 实付（含申购费）
    totalNetInvested: a.totals.totalNetInvested,       // 净投入（扣申购费）= 下面的收益基准
    totalFee: a.totals.totalFee,                       // 累计申购费 = 实付 − 净投入
    totalValue: a.totals.totalValue,
    totalProfit: a.totals.totalProfit,                 // ★ 净口径（2026-09-18 起，基准 = totalNetInvested）
    totalProfitPct: a.totals.totalProfitPct,
    dayChangeValue: dayBase ? dayGain : null,
    dayChangePct: dayBase ? dayGain / dayBase * 100 : null,
    allocation: allocationRows,
    notes: l1notes
  };

  // ---------- per-fund 统一信号（整合主体，替代原 l2+l3+fundSnap 三源，2026-09-08）----------
  // funds[]：只收 resolveRegistry 命中的基金（= 原 l2 决策卡集合 ∪ scoreMap 全集）；判定/综合分/文案全同源。
  // alerts[]：非常规信号（原 l2 中无 factors 的条目：trim / statementOnly / 冷却期重复提示）。
  const scoreMap = (plan.scoreMap) || {};
  const funds = [];
  const alerts = [];
  const decMap = {}; // 买入时机复盘：am 会话收集全量基金当日判定（code → action/matrix/name/category），matrix 需带 _type

  for (const f of a.funds) {
    const resolved=resolveRegistry(f);
    const hit = f.profileState === 'needs_review' && !['broad300','nasdaq','activeEquity','goldDual'].includes(resolved?.reg.type) ? null : resolved;
    if (!hit || hit.reg.enabled === false) {
      // ★ 类别没有对应算法 → **不再静默丢弃**。
      //   旧实现这里是 `continue`，该基金在决策页整只消失，用户只会觉得"少了一只"、看不出原因
      //   （净值行虽有复盘页 live.funds 兜底，决策页没有任何兜底）。
      //   现在改为产出显式卡片：待建设的类别说明「暂不判定」，未归类的类别提示去改类别。
      const pending = isPendingCategory(f.category);
      const needsReview = f.profileState === 'needs_review';
      const disabled = !!(hit && hit.reg.enabled === false);
      funds.push({
        code: f.code, name: f.name, category: f.category,
        caliber: util.caliberOf(f) || null,
        categoryName: disabled ? '红利·低波' : needsReview ? '待确认' : pending ? '待建设' : '未归类',
        unsupported: true,
        unsupportedReason: disabled ? 'rule_disabled' : needsReview ? 'needs_review' : pending ? 'pending' : 'unknown',
        verdict: null,
        title: (disabled ? '红利规则调整中：' : needsReview ? '待确认：' : pending ? '暂不支持：' : '未归类：') + f.name,
        detail: disabled ? '红利规则调整中，暂不判定。旧股息率买入规则已停用，新双路径尚未上线；持仓与购买记录照常保留。' : needsReview ? '自动档案分类待确认；市值照常显示，暂不提供可执行建议。' : pending
          ? '该类别的决策算法尚未开放（待建设），不参与买卖判定；市值仍计入总资产与配置占比。'
          : '该类别没有对应算法，请到「配置」页把它改到已有类别上；市值仍计入总资产与配置占比。',
        factors: [], matrix: null,
        score: null, scoreLabel: null,
        valueScore: null, momentumScore: null,
        compositeLabel: disabled ? '红利规则调整中，暂不判定' : pending ? '待建设' : '未归类',
        weights: null, degraded: [],
        conclusion: disabled ? '红利规则调整中，暂不判定' : needsReview ? '分类待确认 · 暂不判定' : pending ? '待建设 · 暂不判定' : '未归类 · 暂不判定',
        suspended: false, dailyLimit: null,
        currentValue: f.currentValue != null ? f.currentValue : 0,
        latestNav: f.latestNav,
        dayChange: f.dayChange != null ? +f.dayChange.toFixed(2) : null,
        latestDate: f.latestDate,
        profitPct: f.profitPct != null ? +f.profitPct.toFixed(2) : null,
        eligible: false,
        ...(disabled || f.category==='dividend' ? { marketVerdict: null, executable: false } : {}),
        ...(f.category==='dividend' ? {strategyVersion:'dividend-trend-v1',marketState:'profile_unverified',
          marketStateLabel:'档案待确认',blockedReason:'profile_unverified'} : {}),
        valuationAnchor: f.valuationAnchor || null
      });
      continue;
    }

    const reg = hit.reg;

    // 决策判定：直接复用 computeAllocation 已挂在 a.funds[i] 上的 _dec（同一数组引用，同参等价无漂移，见计划 §七）；
    // 仅当异常路径（buildAnalysis 内打分半路中断）未挂载时补算一次兜底。
    let dec = f._dec;
    if (!dec) { dec = reg.builder(f, _fallbackVMap, cfg); f._dec = dec; }
    // computeAllocation 路径不设 matrix._type（strategies builder 均不写），决策卡格式化/timing 采集依赖它 → 这里补
    // （对 a.funds 上对象赋值会在 /api/refresh 响应多出 _type 字段，无害；decMap 引用的 matrix 因此带 _type）
    if (dec && dec.matrix) {
      dec.matrix._type = dec.strategyVersion === 'dividend-trend-v1' ? 'dividendTrend' : reg.type;
      dec.matrix._caliber = reg.caliber || null;  // 口径（broad 下 cn/us）：决策卡文案与 timing 分组用
    }

    const card = buildCard(f, dec, dailyLimits, cfg); // title/detail/factors/verdict（展示层原样保留）
    const dailyLimit = dailyLimits[f.code] != null ? dailyLimits[f.code] : null;
    const hs300Fallback = ['broad300','nasdaq','activeEquity','goldDual'].includes(reg.type) && !scoreMap[f.code] ? (() => {
      let ps = allocation.purchaseStatusMeta(f,['nasdaq','activeEquity','goldDual'].includes(reg.type)?Date.parse(dec.matrix.computedAt):undefined);
      if(['activeEquity','goldDual'].includes(reg.type)){
        const instant=Date.parse(dec.matrix.computedAt),stamp=Number(f.purchaseStatus?.updatedAt);
        if(!Number.isFinite(stamp)||stamp>instant){ps.fresh=false;ps.unavailable=true;ps.suspended=false;}
      }
      if(reg.type==='nasdaq'){
        const instant=Date.parse(dec.matrix.computedAt),stamp=Number(f.purchaseStatus?.updatedAt);
        if(!Number.isFinite(stamp)||stamp>instant){ps.fresh=false;ps.unavailable=true;ps.suspended=false;}
        ps=require('../lib/nasdaqExecution').overlay(ps,dec.matrix.officialPurchaseConstraint,instant);
      }
      const marketVerdict = dec.action;
      const decision = marketVerdict==null?{verdict:null,executable:false}:allocation.purchaseDecision(marketVerdict, ps, dailyLimit);
      const policyAllowed = !dec.matrix.futureOrder&&(reg.type!=='goldDual'||dec.matrix.releaseEnabled)&&(policy[util.engineCategoryToBucket(f.category)] || 'buy') === 'buy';
      return { marketState: dec.matrix.marketState, marketStateLabel: dec.matrix.marketStateLabel,
        marketVerdict, verdict:marketVerdict==null?null:policyAllowed ? decision.verdict : 'hold',
        executable: policyAllowed && decision.executable, eligible:marketVerdict!=null&&policyAllowed && !ps.unavailable && !ps.suspended && dailyLimit!==0,
        blockedReason:marketVerdict==null?dec.matrix.dataError:ps.officialConstraintReason||(ps.suspended?'purchase_suspended':ps.unavailable?'purchase_status_unverified':dailyLimit===0?'user_limit_zero':dec.matrix.futureOrder?'future_order_recheck':reg.type==='goldDual'&&!dec.matrix.releaseEnabled?'release_pending':!policyAllowed?'policy_blocked':null),
        suspended: ps.suspended || dailyLimit === 0, statusFresh: ps.fresh };
    })() : null;
    const sm = scoreMap[f.code] || hs300Fallback || {};
    const score = sm.marketScore != null ? sm.marketScore : null; // 真实市场分（0~100, toFixed(1)）；与决策页旧 scoreMap 同源
    const suspended = !!(sm && sm.suspended);
    // ★ 估值锚降级提示（2026-09-19）：缺跟踪指数（或抓取失败）时判定会退化成「价格分位弱信号」，
    //   外在表现就是恒定建议持仓不动 —— 必须显式说出来，否则用户会以为它在正常工作。
    const anchorWarn = (f.valuationAnchor && f.valuationAnchor.degraded)
      ? '⚠ 缺估值锚（跟踪指数），当前按价格分位降级判定，不会给加仓信号。'
      : '';
    funds.push({
      code: f.code, name: f.name, category: f.category,
      caliber: reg.caliber || null,  // 口径（仅 broad 下有值：cn/us），供前端展示「宽基 · 海外口径」
      categoryName: reg.label, // = REGISTRY.label（引擎类别中文名：宽基/宽基·海外/红利·低波/主题·行业(高波动)/商品·对冲）；⚠ 非分配桶名
      unsupported: ['dividend','broad300','nasdaq','activeEquity','goldDual'].includes(reg.type) ? !!dec.unsupported : false,
      ...(reg.type === 'dividend' ? {unsupportedReason:dec.unsupportedReason,strategyVersion:dec.strategyVersion,
        metrics:dec.matrix.metrics,conditions:dec.matrix.conditions,signalNavDate:dec.matrix.metrics.navDate||null,
        orderDate:dec.matrix.orderDate,blockedReason:sm.blockedReason||null,yieldReference:dec.matrix.yieldReference} : {}),
      ...(reg.type==='broad300'?{unsupportedReason:dec.unsupportedReason,strategyVersion:dec.strategyVersion,
        metrics:dec.matrix.metrics,conditions:dec.matrix.conditions,route:dec.matrix.route,
        signalNavDate:dec.matrix.metrics.navDate,orderDate:dec.matrix.orderDate,peDate:dec.matrix.peDate,
        peSource:dec.matrix.peSource,blockedReason:sm.blockedReason||null}:{}),
      ...(reg.type==='nasdaq'?{unsupportedReason:dec.unsupportedReason,strategyVersion:dec.strategyVersion,inputVersion:dec.matrix.inputVersion,
        metrics:dec.matrix.metrics,conditions:dec.matrix.conditions,route:dec.matrix.route,paths:dec.matrix.paths,pathStates:dec.matrix.pathStates,
        signalNavDate:dec.matrix.metrics.navDate,orderDate:dec.matrix.orderDate,computedAt:dec.matrix.computedAt,
        peDate:dec.matrix.peDate,peSource:dec.matrix.peSource,blockedReason:sm.blockedReason||null}:{}),
      ...(reg.type==='activeEquity'?{unsupportedReason:dec.unsupportedReason,strategyVersion:dec.strategyVersion,inputVersion:dec.matrix.inputVersion,
        metrics:dec.matrix.metrics,conditions:dec.matrix.conditions,route:dec.matrix.route,paths:dec.matrix.paths,pathStates:dec.matrix.pathStates,
        signalNavDate:dec.matrix.metrics.navDate,orderDate:dec.matrix.orderDate,computedAt:dec.matrix.computedAt,
        source:dec.matrix.source,sourceHash:dec.matrix.sourceHash,sourceFetchedAt:dec.matrix.sourceFetchedAt,
        futureOrder:dec.matrix.futureOrder,buyOnly:true,blockedReason:sm.blockedReason||null}:{}),
      ...(reg.type==='goldDual'?{unsupportedReason:dec.unsupportedReason,strategyVersion:dec.strategyVersion,inputVersion:dec.matrix.inputVersion,
        metrics:dec.matrix.metrics,conditions:dec.matrix.conditions,route:dec.matrix.route,paths:dec.matrix.paths,pathStates:dec.matrix.pathStates,
        signalNavDate:dec.matrix.metrics.navDate,orderDate:dec.matrix.orderDate,computedAt:dec.matrix.computedAt,
        source:dec.matrix.source,sourceHash:dec.matrix.sourceHash,sourceFetchedAt:dec.matrix.sourceFetchedAt,
        releaseEnabled:dec.matrix.releaseEnabled,releaseLabel:dec.matrix.releaseLabel,
        futureOrder:dec.matrix.futureOrder,buyOnly:true,blockedReason:sm.blockedReason||null}:{}),
      valuationAnchor: f.valuationAnchor || null,
      marketState: sm.marketState || null,
      marketStateLabel: sm.marketStateLabel || null,
      marketVerdict: ['dividend','broad300','nasdaq','activeEquity','goldDual'].includes(reg.type) ? (Object.hasOwn(sm,'marketVerdict')?sm.marketVerdict:dec.action) : sm.marketVerdict || card.verdict,
      verdict: ['dividend','broad300','nasdaq','activeEquity','goldDual'].includes(reg.type) ? (Object.hasOwn(sm,'verdict')?sm.verdict:null) : sm.verdict || card.verdict,
      title: card.title, detail: card.detail, factors: card.factors,
      matrix: (dec && dec.matrix) || null,
      score,                                   // ← 语义变更：位置分 → **综合分**（= wV×V + wM×M）
      scoreLabel: scoreLabelOf(score),
      // 2026-09-14 综合分构成（两派拆开，便于看懂分数来源；任一缺失为 null）
      valueScore: sm.valueScore != null ? sm.valueScore : null,           // V 估值分（均值回归派）
      momentumScore: sm.momentumScore != null ? sm.momentumScore : null,  // M 动量分（动量派，二值→连续）
      compositeLabel: sm.compositeLabel || null,                          // 拦截/降级说明
      weights: sm.weights || null,                                        // { wV, wM }
      degraded: sm.degraded || [],                                        // ['V'] / ['M'] / ['V','M']
      conclusion: reg.type==='goldDual'
        ? `${dec.matrix.marketStateLabel}；${dec.action==null?'身份、基金日期或数据尚未通过核验':dec.action==='add'?'双路径之一条件成立':'两个通道均有条件未达标'}。${dec.matrix.releasePending?'待启用，当前不可执行。':sm.executable?'当前约束允许执行。':'当前执行受限，申请日需复核。'}仅买入判断；趋势回踩不等于长期低位，历史结果不保证盈利。`
        : reg.type==='activeEquity'
        ? `${dec.matrix.marketStateLabel}；${dec.action==null?'必要身份、采样或数据尚未通过核验':dec.action==='add'?(sm.executable?'市场条件成立，当前约束允许执行':'市场条件成立，当前执行受限；申请日需复核'):'两个通道均未全部成立'}。仅买入判断，金额与节奏由你决定；不含退出规则，历史结果不保证盈利。`
        : reg.type==='nasdaq'
        ? `${dec.matrix.marketStateLabel}；${dec.action==null?'必要身份或数据未通过核验':dec.action==='add'?(sm.executable?'市场条件成立，当前约束允许执行':'市场条件成立，当前执行受限；目标申请日需复核'):'两个通道均未全部成立'}。PE只限制回撤通道，趋势不设PE门槛；金额和节奏由你决定。`
        : reg.type === 'dividend'
        ? `${dec.matrix.marketStateLabel}；${dec.action==null?'必要档案或数据尚未核验，暂不判定':dec.action==='add'?(sm.executable?'市场条件成立，当前约束允许执行':'市场条件成立，但当前申购或资金政策不允许执行'):'趋势回踩条件尚未全部成立'}。趋势回踩可能在长期相对高位，历史结果不保证未来盈利；股息率仅供参考。`
        : reg.type === 'broad300'
        ? `${sm.marketStateLabel || dec.matrix.marketStateLabel}；${dec.action==null?'必要档案或数据未通过核验，暂不判定':dec.action==='add'?(sm.executable?'市场条件成立，当前约束允许执行':'市场条件成立，但当前申购或资金政策不允许执行'):'共同PE入口或双通道条件尚未全部成立'}。共同25%入口可能漏买，趋势回踩可能处于相对高位；历史PE可能修订，历史结果不保证未来盈利。`
        : anchorWarn + conclusionOf(dec.action, score, suspended, dailyLimit, sm.compositeLabel), // 其他策略仍沿用综合分文案
      suspended, dailyLimit,
      purchaseStatus: sm.purchaseStatus || f.purchaseStatus || null,
      statusFresh: sm.statusFresh === true,
      executable: sm.executable === true,
      currentValue: f.currentValue != null ? f.currentValue : 0, // 未建仓为 0；净值缺失为 0（live.funds 兜底见 A6）
      latestNav: f.latestNav,
      dayChange: f.dayChange != null ? +f.dayChange.toFixed(2) : null,
      latestDate: f.latestDate,
      profitPct: f.profitPct != null ? +f.profitPct.toFixed(2) : null,
      eligible: !!(sm && sm.eligible) // = 原 scoreMap.eligible（policy=buy ∧ 未暂停申购）
    });
    if (!isPM) {
      // ⚠ 副作用②（D1 保留）：timing 采集输入（复盘「每月」tab 战役状态机），仅 am 收集——随 funds 组装保留
      decMap[f.code] = { action: dec.action, matrix: (dec && dec.matrix) || null, name: f.name, category: f.category, caliber: reg.caliber || null,
        ...(['dividend','broad300','nasdaq','activeEquity','goldDual'].includes(reg.type)?{strategyVersion:dec.strategyVersion,unsupported:dec.unsupported,executable:sm.executable,blockedReason:sm.blockedReason}: {}) };
    }
  }

  // 信号 2：C 类份额涨到位清理（仅 frozen 类别；当前全 buy 故静默，未来恢复冻结自动重新生效）
  // 无 factors/verdict → 进 alerts[]（不进 funds[]，前端 decision 页按 verdictOf(title) 文字推断 stop）
  // ★ 判据口径（2026-09-18 变更）：f.profitPct 现为**净口径**（= 市值 − 净投入，扣申购费，见 analysis.js）。
  //   本规则当前**处于休眠**：categoryPolicy 全为 buy，下面第一道 continue 即跳过全部基金
  //   （实测 data/state/decision_history.json 15 条记录中 trim 命中 0 次）。
  //   将来恢复 frozen 时按净口径浮盈判断 —— 那更准确（收益本就该扣费）。仅 feeRate > 0 的基金两口径才有差异。
  const trimPct = sig.trimProfitPct == null ? 12 : sig.trimProfitPct;
  for (const f of a.funds) {
    // This route is buy-only, including unknown admission states and frozen C shares.
    if (require('../lib/activeEquityIdentity').isActiveEquityRoute(f)||require('../lib/goldIdentity').isGoldRoute(f)) continue;
    if ((policy[util.engineCategoryToBucket(f.category)] || 'buy') !== 'frozen') continue;
    if (!f.currentValue || !f.principal) continue;
    if (!/C$/.test((f.name || '').trim())) continue; // 仅 C 类：按日计提销售服务费，长期持有更贵
    consider(`trim:${f.code}`, f.profitPct >= trimPct, {
      level: 'L2', type: 'trim', code: f.code, name: f.name,
      title: `${f.name} 达到减仓条件`,
      detail: `当前浮盈 ${f.profitPct.toFixed(2)}%，达到 +${trimPct}% 条件（净值日 ${f.latestDate}）。该动作实质是清理 C 类持有成本，而非择时。`,
      action: `可减仓该 C 类份额，回收资金转投核心/对冲类。`
    });
  }

  // consider 冷却状态机：满足条件才进 alerts；pm 只陈述（不写冷却/不给 action）
  function consider(id, cond, payload) {
    if (!cond) {
      if (sigState[id]) sigState[id].active = false;
      return;
    }
    const rec = sigState[id];
    if (isPM) {
      // 晚间只陈述状态：不写冷却、不给动作
      const p = Object.assign({}, payload);
      delete p.action;
      alerts.push(Object.assign({ id, firedAt: (rec && rec.lastFired) || today, statementOnly: true }, p));
      return;
    }
    const isNew = !rec || !rec.active;
    const expired = rec && rec.active && rec.lastFired && util.daysBetween(rec.lastFired, today) >= cooldownDays;
    if (isNew || expired) {
      sigState[id] = { active: true, lastFired: today };
      alerts.push(Object.assign({ id, firedAt: today }, payload));
    } else {
      sigState[id] = { active: true, lastFired: rec.lastFired }; // 冷却期内静默
      // M5: 冷却期内不重复触发，但若今天刚播报过，追加一条只陈述提示（避免"无信号"误导）
      if (rec.lastFired === today) {
        alerts.push({
          id, level: 'L2', type: payload.type || 'dip', code: payload.code, name: payload.name,
          title: `${payload.name || ''} 回撤信号今日已播报`,
          detail: '该信号今天已触发过，7 天冷却期内不重复催（详见早间/晚间播报）。',
          statementOnly: true
        });
      }
    }
  }

  if (!isPM) {
    store.writeJSONSafe('signals.json', sigState);
    // ⚠ 副作用③（R3）：写决策快照（供复盘「每日」tab 周对比）——来源由原 l2.filter 改为遍历 funds[]，
    // 只保留有 factors/verdict 的决策卡（alerts 无 factors 不进，避免污染前端按 code 取数）；conclusion 顺带存备用。
    const decSnap = {};
    funds.forEach(s => {
      if (s.factors && s.verdict) decSnap[s.code] = { factors: s.factors, verdict: s.verdict, conclusion: s.conclusion,
        ...(s.strategyVersion?{strategyVersion:s.strategyVersion,marketState:s.marketState,marketVerdict:s.marketVerdict,
          executable:s.executable,metrics:s.metrics,signalNavDate:s.signalNavDate}: {}) };
    });
    store.writeDecisionHistory({ date: today, funds: decSnap });
    // 买入时机复盘：战役状态机采集（am-only，pm 只陈述不改状态；采集失败不致命，不阻塞决策主流程）
    try {
      timing.onDecide(decMap, cfg);
    } catch (e) {
      console.warn('[timing] onDecide 失败:', e && e.message || e);
    }
  }

  return {
    asOf: a.asOf, date: today, session: isPM ? 'pm' : 'am',
    l1, funds, alerts,
    thresholds, categoryPolicy: policy,
    cooldownDays, calibratedAt: sig.calibratedAt,
    // 周对比快照：取 7 天前决策快照的 {code:{factors,verdict}}，前端只渲染不自己算 diff。
    // 早期无历史时返回 {}（前端不显示对比列）。
    weekAgo: Object.fromEntries(Object.entries(pickWeekAgo(store.readDecisionHistory())).filter(([code,s])=>{
      const current=funds.find(f=>f.code===code);return !current?.strategyVersion || current.strategyVersion===s.strategyVersion;
    }))
    // 已删除：l2、l3、fundSnap、navDates（信息全部并入 funds[]；latestDate 即原净值日，见计划 §三 字段去向表）
  };
}

module.exports = { buildAdvice };

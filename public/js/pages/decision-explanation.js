// Read existing evidence only. No thresholds, scores or trading decisions are computed here.
const DUAL = {
  'nasdaq-dual-v1': ['draw', 'trend'], 'hs300-dual-v1': ['deep', 'trend'],
  'active-equity-buy-v1': ['A', 'B'], 'gold-dual-v1': ['A', 'B'],
};
// Evidence field names from the four frozen production schemas. Presence only;
// this does not evaluate indicator values, thresholds or market decisions.
const PATH_EVIDENCE = {
  'nasdaq-dual-v1': {draw:['pePercentile','bias','biasRepair','rsiCeiling','rsiRising'],trend:['priceAboveMa250','ma60AboveMa250','pullback','recovery','bias','rsiRange','rsiRising']},
  'hs300-dual-v1': {deep:['negativeBias','repair','rsiRising','rsiCap','peGate'],trend:['priceAbove','maAbove','dip','recovery','bias','rsiRange','rsiRising','peGate']},
  'active-equity-buy-v1': {A:['drawdown','bias','recovery','rsi'],B:['drawdown','bias','recovery','rsi','priceTrend','shortTrend','longDirection']},
  'gold-dual-v1': {A:['negativeBias','biasRepair','rsiRising','rsiCeiling'],B:['aboveLongMA','trendMA','drawdownRange','recovery','biasCeiling','rsiRange','rsiRising']},
};
const WORDS = {
  pePercentile: '估值处在规则要求的较低区间', peGate: '共同估值入口',
  negativeBias: '价格回落到规则要求的位置', bias: '价格与该通道参考均线的距离', drawdown: '回落幅度',
  biasRepair: '从近期低位回升', repair: '从近期低位回升', recovery: '从近期低点恢复',
  rsiRising: '近期走势开始回稳', rsiCeiling: '回升幅度尚未过热', rsiCap: '原始指标配置检查（未另设回升上限）',
  rsiRange: '回升力度处在规则范围内', rsi: '回升力度和回稳情况',
  priceAboveMa250: '价格站在长期均线上方', priceAbove: '价格站在长期均线上方', aboveLongMA: '价格站在长期均线上方', priceTrend: '价格站在长期均线上方',
  ma60AboveMa250: '中期均线高于长期均线', maAbove: '中期均线高于长期均线', trendMA: '中期均线高于长期均线', shortTrend: '中期均线高于长期均线',
  longDirection: '长期均线仍向上', pullback: '上涨后的回调幅度', dip: '上涨后的回调幅度', drawdownRange: '上涨后的回调幅度', biasCeiling: '价格尚未过度偏离中期均线',
  navAboveMa250: '价格站在长期均线上方', dip60InRange: '上涨后的回调幅度', recovery10Ready: '从近期低点恢复', bias250Allowed: '价格与长期均线的距离', weeklyRsiInRange: '回升力度处在规则范围内', weeklyRsiRising: '近期走势开始回稳',
};
const passOf = value => value && typeof value === 'object' ? !Number.isFinite(value.value) ? null : value.pass === true ? true : value.pass === false ? false : null : value === true ? true : value === false ? false : null;
function conjunction(values) { return values.includes(false) ? false : values.length && values.every(x => x === true) ? true : null; }
export function pathDisplayName(version, path) {
  const keys = DUAL[version];
  return keys?.includes(path) ? path === keys[0] ? '下跌后回稳' : '上涨中回调' : path;
}
export function displayFactorName(version, value) {
  if (!DUAL[version]) return value;
  return String(value).replace(/^(?:A 回撤修复|回撤修复)(?= ·|$)/, '下跌后回稳').replace(/^(?:B 趋势回踩|趋势回踩)(?= ·|$)/, '上涨中回调')
    .replace(/^A (?=指标|通道)/, '下跌后回稳 ').replace(/^B (?=指标|通道)/, '上涨中回调 ');
}
function ordinaryFacts(factors) {
  const facts = [], missing = [];
  for (const f of factors || []) {
    const v = f.value, dim = f.dim;
    if (dim === '止跌' && ['是','已止跌','否','未止跌'].includes(v)) (['是','已止跌'].includes(v) ? facts : missing).push(['是','已止跌'].includes(v) ? '近期已有止跌迹象' : '近期还没有确认止跌');
    else if (dim === '趋势' && ['跌破半年线','站上半年线'].includes(v)) facts.push(v === '跌破半年线' ? '价格在半年均线下方' : '价格在半年均线上方');
    else if (dim === '双均线' && ['金叉(MA20>MA60)','死叉(MA20<MA60)'].includes(v)) facts.push(v.startsWith('金叉') ? '短期均线高于中期均线' : '短期均线低于中期均线');
    else if (dim === 'PE闸' && ['拦截','放行'].includes(v)) (v === '拦截' ? missing : facts).push(v === '拦截' ? '估值入口仍在拦截' : '估值入口没有拦截');
    else if (dim === '急涨闸' && ['急涨强拦','急涨放行'].includes(v)) (v === '急涨强拦' ? missing : facts).push(v === '急涨强拦' ? '近期急涨限制仍在拦截' : '近期急涨限制没有拦截');
    else if (dim === '250日分位' && ['便宜','贵','中性'].includes(v)) facts.push('价格在近期观察区间处于' + ({便宜:'较低位置',贵:'较高位置',中性:'中间位置'})[v] + '（不是基本面估值）');
    else if ((dim === 'PE分位' || /^PE滚动\d+周分位$/.test(dim)) && ['cheap','expensive','neutral'].includes(f.status) && v != null) facts.push('估值相对历史处于' + ({cheap:'较低区间',expensive:'较高区间',neutral:'中间区间'})[f.status]);
    else if (dim === 'PE回撤' && f.status === 'cheap' && v != null && v !== '—') facts.push('估值从近期高点的回落已达到原规则要求');
    else if (dim === '回撤' && f.status === 'cheap' && v != null && v !== '—') facts.push('价格回落幅度已达到原规则要求');
  }
  return {facts, missing};
}
export function buildDecisionExplanation(sig = {}) {
  const m = sig.matrix || {}, version = sig.strategyVersion || m.strategyVersion;
  const action = ['insufficient','profile_unverified','scope_unsupported'].includes(sig.marketState) ? null : Object.hasOwn(sig, 'marketVerdict') ? sig.marketVerdict : sig.verdict;
  const errorWords={profile_unverified:'当前基金身份尚未核验',scope_unsupported:'基金不在本策略支持范围',daily_sampling_unverified:'日频采样尚未核验',initialization_unverified:'序列起点或连续性尚未核验',fund_calendar_unverified:'基金日期和开放规则尚未核验',insufficient_adjusted_nav:'合格净值历史不足',insufficient_completed_weeks:'完整周数据不足',stale_nav_history:'净值历史已过期',calendar_unverified:'交易日历尚未核验',nav_calendar_coverage_gap:'开放日净值有缺口',release_pending:'规则尚待确认启用'};
  Object.assign(errorWords,{hs300_data_unavailable:'尚未取得本版本完整资料',price_warmup:'合格净值历史不足，指标还在积累',rsi_incomplete_or_warmup:'已完成且可知的周数据不足或缺失',pe_not_yet_available:'月度估值资料尚不可知',pe_missing_prior_months:'此前估值月份资料不完整',stale_pe:'估值观察已过期',stale_price:'信号净值已过期',nav_calendar_coverage_gap:'应已可知的净值存在缺口'});
  const rawError=sig.dataError||m.dataError|| (Object.hasOwn(errorWords,sig.blockedReason)?sig.blockedReason:null);
  const error=sig.dataErrorLabel||m.dataErrorLabel||errorWords[rawError]|| (rawError?/WARMUP/.test(rawError)?'合格历史还不足以完成指标预热。':/pe_quality|pePercentile/.test(rawError)?'估值历史或可知性尚未通过核验。':'数据核验未通过；具体缺项请查看依据。':'');
  if (sig.unsupported || ['unsupported','profile_unverified','scope_unsupported'].includes(sig.marketState)) return {summary:'基金身份或适用范围尚未通过核验，暂时不能提供此策略的判断。', current:'身份或适用范围待处理', reason:m.dataErrorLabel || '需要先核对基金档案及策略范围。', missing:'补齐身份或适用范围核验后再查看。', paths:[]};
  if (sig.displayKind === 'plan' && sig.marketState === 'monthly_dca') return {summary:'按月定投，由你手动决定是否执行；本策略不判断每日买点。', current:'每月定投，手动执行', reason:'采用固定月度节奏，不因当天涨跌或政策阅读改变计划。', missing:'执行前单独核对申购状态、限额和资金安排。', paths:[]};
  const conditions = sig.conditions || m.conditions || {}, keys = DUAL[version];
  if (keys) {
    const states = sig.pathStates || m.pathStates || {};
    const paths = keys.map(key => {
      const own = conditions[key] || {}, entries = Object.entries(own), required = PATH_EVIDENCE[version][key];
      const absent = required.filter(name=>!Object.hasOwn(own,name));
      const checks = entries.map(([name,value]) => ({name:WORDS[name] || '该项规则条件', pass:passOf(value)}));
      absent.forEach(name=>checks.push({name:(WORDS[name]||'该项规则条件')+'（未附依据）',pass:null}));
      if (version === 'hs300-dual-v1') checks.unshift({name:WORDS.peGate, pass:passOf(conditions.peGate)});
      const state = Object.hasOwn(states,key) ? states[key] === 'buy' ? true : states[key] === 'hold' ? false : null : entries.length ? conjunction(checks.map(c => c.pass)) : null;
      return {key, name:pathDisplayName(version,key), state, hasPathEvidence:entries.some(([name])=>name!=='peGate'), hasCompletePathEvidence:absent.length===0, purpose:key === keys[0] ? '观察明显下跌后有没有开始恢复。' : '观察上涨趋势中的回调有没有恢复。', ready:checks.filter(c=>c.pass===true).map(c=>c.name), missing:checks.filter(c=>c.pass===false).map(c=>c.name), unknown:checks.filter(c=>c.pass===null).map(c=>c.name)};
    });
    const buys=paths.filter(p=>p.state===true), unknown=paths.filter(p=>p.state===null), contradiction=buys.some(p=>p.missing.length);
    const incomplete=buys.some(p=>!p.hasCompletePathEvidence || p.unknown.length || !p.ready.length);
    const reason = action == null ? (error || '必要资料或整体判断尚未完成核验。')+'目前不能确认买入或等待；分项记录不能代替完整结果。' : contradiction || action==='hold' && buys.length ? '分项与整体状态不一致，需核查完整依据；不能据此补推完整买入条件。' : incomplete ? '原规则仍记录买入候选，但分项依据尚未完整核实，不能补推所有条件成立。'+(buys.length===2?'两种情况的记录仍只是一条候选，不增加信号强度或投入。':'') : buys.length ? buys.map(p=>p.name).join('、')+'的完整条件已成立。'+(unknown.length?'另一种情况尚有条件未核实，不能评价。':buys.length===2?'重合只形成一条候选，不增加信号强度或投入。':'') : paths.map(p=>p.name+'：'+(p.missing.length?'尚缺'+p.missing.slice(0,2).join('、')+(p.missing.length>2?'等条件':''): '条件尚无法核实')+(p.unknown.length?'；还有未核条件':'')).join('。')+'。';
    return {summary:reason, current:action === 'add' ? '原规则已有买入候选，执行条件需另核对' : action === 'hold' ? '目前等待条件满足' : '目前无法完整判定', reason, missing:action==null?'先补齐尚未核验的数据与资料；已有分项不代表整体可用。':buys.length?'候选不等于可执行申购，请另看交易限制。':unknown.length?'补齐未核条件；已知未满足项也仍需等待。':'等待上面尚缺的条件满足，再由原规则重新判断。', paths};
  }
  const checks=Object.entries(conditions).filter(([key,value])=>WORDS[key] && (value == null || typeof value !== 'object' || Object.hasOwn(value,'pass'))).map(([key,value])=>({name:WORDS[key], pass:passOf(value)}));
  const facts=ordinaryFacts(sig.factors), ready=checks.filter(c=>c.pass===true).map(c=>c.name), absent=checks.filter(c=>c.pass===false).map(c=>c.name), unknown=checks.filter(c=>c.pass===null);
  const sentences=[ready.length?'已满足：'+ready.join('、')+'。':'', absent.length?'尚未满足：'+absent.join('、')+'。':'', ...facts.facts.map(f=>f+'。'), ...facts.missing.map(f=>f+'。')].filter(Boolean);
  const reason=action==null?(error||'必要资料或整体判断尚未完成核验。')+'目前无法完整判定。':sentences.length?sentences.slice(0,3).join('')+(checks.length?'':'这些是分项事实，完整组合依据尚未提供。'):'本次结果未附足够细分依据，无法确认具体由哪条条件决定。';
  return {summary:reason, current:action === 'add' ? '原规则已有买入候选' : action === 'hold' ? '原规则目前等待' : '目前无法完整判定', reason, missing:unknown.length?'有条件未核实，需要补齐资料。':absent.length||facts.missing.length?'留意上述尚未满足或拦截项；其他条件仍由原规则判断。':'执行前核对交易限制；缺少的细分依据不能自行补推。', paths:[]};
}

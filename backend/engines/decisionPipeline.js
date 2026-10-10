'use strict';
// Orchestration only; all data/configuration/time are supplied by callers.
const util = require('../lib/util');
const { resolveRegistry, isPendingCategory } = require('./registry');
const { synthesizeCompositeScore, compositeLabelOf, synthesizePositionLabel } = require('./scoring');
const { purchaseStatusMeta, purchaseDecision, policyEligible, policyDecision } = require('./tradeConstraints');
function runDecisionPipeline({ allocation, policy, funds, valuationMap, dailyLimits, scoreConfig: AC, strategyConfig, now, today }) {
  allocation = Array.isArray(allocation) ? allocation : [];
  funds = Array.isArray(funds) ? funds : [];
  dailyLimits = dailyLimits || null;


  // 1) 真实市场分 + 决策副作用（给 funds 挂 _dec / _marketScore，advice.js 决策卡复用，同源零漂移）
  funds.forEach(f => {
    const resolved=resolveRegistry(f);
    const hit = f.profileState === 'needs_review' && !['broad300','nasdaq','activeEquity','goldDual'].includes(resolved?.reg.type) ? null : resolved;
    if (!hit || hit.reg.enabled === false) {
      // ★ 无算法的类别（待建设 / 未归类）：不能只是"清空分数"就完事。
      //   旧实现在下方 scoreMap 循环里遇到 `_marketScore == null` 就 return，
      //   于是这类基金**连 scoreMap 条目都没有** —— 前端连"待建设"都显示不出来，
      //   表现就是"这只基金在看板上凭空少了一截"（决策页整只消失、配置页丢市值）。
      //   现在打个显式标记，由下方 scoreMap 产出一条 unsupported 记录。
      const pending = isPendingCategory(f.category);
      f._marketScore = null; f._dec = null;
      const disabled = !!(hit && hit.reg.enabled === false);
      if (disabled || f.category==='dividend') { f._composite = null; f._purchaseStatusMeta = null; }
      f._unsupported = { pending, reason: disabled ? 'rule_disabled' : f.profileState === 'needs_review' ? 'needs_review' : pending ? 'pending' : 'unknown' };
      return;
    }
    f._unsupported = null;
    const dec = hit.reg.builder(f, valuationMap, strategyConfig, { today });
    f._dec = dec;
    const lim0 = (dailyLimits && dailyLimits[f.code] != null) ? dailyLimits[f.code] : null;
    let ps = purchaseStatusMeta(f, ['nasdaq-dual-v1','active-equity-buy-v1','gold-dual-v1'].includes(dec.strategyVersion)?(Date.parse(dec.matrix.computedAt)||Number(now??Date.now())):now);
    if(['active-equity-buy-v1','gold-dual-v1'].includes(dec.strategyVersion)){
      const observed=Date.parse(dec.matrix.computedAt)||Number(now??Date.now()),stamp=Number(f.purchaseStatus?.updatedAt);
      if(!Number.isFinite(stamp)||stamp>observed){ps.fresh=false;ps.unavailable=true;ps.suspended=false;}
    }
    if(dec.strategyVersion==='nasdaq-dual-v1'){
      const observed=Date.parse(dec.matrix.computedAt)||Number(now??Date.now()),stamp=Number(f.purchaseStatus?.updatedAt);
      if(!Number.isFinite(stamp)||stamp>observed){ps.fresh=false;ps.unavailable=true;ps.suspended=false;}
      ps=require('../lib/nasdaqExecution').overlay(ps,dec.matrix.officialPurchaseConstraint,observed);
    }
    f._purchaseStatusMeta = ps;
    if (hit.reg.type === 'dividend') {
      f._composite = null; f._marketScore = null;
      return;
    }
    if (['broad300','nasdaq','activeEquity','goldDual'].includes(hit.reg.type)) {
      f._composite = null;
      f._marketScore = null;
      return;
    }
    f._composite = synthesizeCompositeScore(dec, AC, hit.reg.type, hit.reg.caliber, { suspended: ps.suspended || (lim0 != null && lim0 <= 0) });
    f._marketScore = f._composite.composite; // 语义变更：位置分 → 综合分（0~100）
  });

  // 2) eligible：policy=buy 且未暂停申购（仅 scoreMap.eligible 标注用，与分配无关）
  const eligible = funds.filter(f => {
    if (f.category === 'dividend' && (!f._dec || f._dec.action == null)) return false;
    if (f._dec?.strategyVersion === 'hs300-dual-v1' && f._dec.action == null) return false;
    if(f._dec?.strategyVersion==='nasdaq-dual-v1'&&(f._dec.action==null||f._dec.matrix.futureOrder))return false;
    if(f._dec?.strategyVersion==='active-equity-buy-v1'&&(f._dec.action==null||f._dec.matrix.futureOrder))return false;
    if(f._dec?.strategyVersion==='gold-dual-v1'&&(f._dec.action==null||f._dec.matrix.futureOrder||!f._dec.matrix.releaseEnabled))return false;
    if (f._unsupported && f._unsupported.reason === 'rule_disabled') return false;
    const ps = f._purchaseStatusMeta || purchaseStatusMeta(f, now);
    const lim = dailyLimits && dailyLimits[f.code] != null ? dailyLimits[f.code] : null;
    return policyEligible(f, policy, ps, lim, util.engineCategoryToBucket);
  });

  // 3) 综合分信号（前端决策页/复盘页兜底，唯一活输出）
  const scoreMap = {};
  funds.forEach(f => {
    if (f._dec && ['dividend-monthly-dca-v1','dividend-trend-v1','hs300-dual-v1','nasdaq-dual-v1','active-equity-buy-v1','gold-dual-v1'].includes(f._dec.strategyVersion)) {
      const dec=f._dec,m=dec.matrix,lim=dailyLimits&&dailyLimits[f.code]!=null?dailyLimits[f.code]:null;
      const ps=f._purchaseStatusMeta||purchaseStatusMeta(f,now),allowed=eligible.includes(f);
      const judged=dec.action!=null;
      const result=judged?policyDecision(purchaseDecision(dec.action,ps,lim),allowed,true):{verdict:null,executable:false};
      const blockedReason=dec.strategyVersion==='dividend-monthly-dca-v1'
        ? (ps.officialConstraintReason || (ps.suspended?'purchase_suspended':ps.unavailable?'purchase_status_unverified':lim!=null&&lim<=0?'user_limit_zero':!allowed?'policy_blocked':null))
        : !judged?m.dataError:ps.officialConstraintReason|| (ps.suspended?'purchase_suspended':ps.unavailable?'purchase_status_unverified':
        lim!=null&&lim<=0?'user_limit_zero':m.futureOrder?'future_order_recheck':dec.strategyVersion==='gold-dual-v1'&&!m.releaseEnabled?'release_pending':!allowed?'policy_blocked':null);
      scoreMap[f.code]={code:f.code,name:f.name,marketScore:null,valueScore:null,momentumScore:null,
        compositeLabel:m.marketStateLabel,weights:null,degraded:[],positionLabel:null,
        strategyVersion:dec.strategyVersion,marketState:m.marketState,marketStateLabel:m.marketStateLabel,
        ...(dec.strategyVersion==='dividend-monthly-dca-v1'?{displayKind:m.displayKind,frequency:m.frequency}:{}),
        ... (dec.strategyVersion==='dividend-monthly-dca-v1'?{}:{metrics:m.metrics,conditions:m.conditions,signalNavDate:m.metrics.navDate||null,orderDate:m.orderDate}),
        ...(dec.strategyVersion==='hs300-dual-v1'?{route:m.route,peDate:m.peDate,peSource:m.peSource,
          peCaveat:m.peCaveat,erpReference:m.erpReference,erpReferenceOnly:true,individuallyBacktested:m.individuallyBacktested}:{}),
        ...(dec.strategyVersion==='nasdaq-dual-v1'?{route:m.route,paths:m.paths,pathStates:m.pathStates,pathReasons:m.pathReasons,
          inputVersion:m.inputVersion,computedAt:m.computedAt,futureOrder:m.futureOrder,sourceHash:m.sourceHash,sourceFetchedAt:m.sourceFetchedAt,
          peDate:m.peDate,peSource:m.peSource,peCaveat:m.peCaveat,erpReference:m.erpReference,erpReferenceOnly:true}:{}),
        ...(dec.strategyVersion==='active-equity-buy-v1'?{route:m.route,paths:m.paths,pathStates:m.pathStates,pathReasons:m.pathReasons,
          inputVersion:m.inputVersion,computedAt:m.computedAt,futureOrder:m.futureOrder,source:m.source,sourceHash:m.sourceHash,
          sourceFetchedAt:m.sourceFetchedAt,actionHash:m.actionHash,initializationFrom:m.initializationFrom,buyOnly:true}:{}),
        ...(dec.strategyVersion==='gold-dual-v1'?{route:m.route,paths:m.paths,pathStates:m.pathStates,pathReasons:m.pathReasons,
          inputVersion:m.inputVersion,computedAt:m.computedAt,futureOrder:m.futureOrder,source:m.source,sourceHash:m.sourceHash,
          sourceFetchedAt:m.sourceFetchedAt,actionHash:m.actionHash,initializationFrom:m.initializationFrom,segmentFrom:m.segmentFrom,
          releaseEnabled:m.releaseEnabled,releaseLabel:m.releaseLabel,buyOnly:true}:{}),
        unsupported:dec.unsupported,unsupportedReason:dec.unsupportedReason,
        eligible:dec.strategyVersion==='dividend-monthly-dca-v1'?false:judged&&allowed,suspended:ps.suspended||lim!=null&&lim<=0,purchaseStatus:f.purchaseStatus||null,
        statusFresh:ps.fresh,marketVerdict:dec.action,verdict:result.verdict,executable:result.executable,blockedReason};
      return;
    }
    if (f._dec && f._dec.matrix && f._dec.matrix.marketState) {
      const lim = (dailyLimits && dailyLimits[f.code] != null) ? dailyLimits[f.code] : null;
      const ps = f._purchaseStatusMeta || purchaseStatusMeta(f, now);
      const marketVerdict = f._dec.action === 'add' ? 'add' : 'hold';
      const policyAllowed = eligible.includes(f);
      const decision = policyDecision(purchaseDecision(marketVerdict, ps, lim), policyAllowed, true);
      scoreMap[f.code] = {
        code: f.code, name: f.name, marketScore: null, valueScore: null, momentumScore: null,
        compositeLabel: f._dec.matrix.marketStateLabel, weights: null, degraded: [], positionLabel: null,
        marketState: f._dec.matrix.marketState, marketStateLabel: f._dec.matrix.marketStateLabel,
        eligible: policyAllowed, suspended: ps.suspended || (lim != null && lim <= 0),
        purchaseStatus: f.purchaseStatus || null, statusFresh: ps.fresh,
        marketVerdict, verdict: decision.verdict,
        executable: decision.executable
      };
      return;
    }
    if (f._marketScore == null || !f._dec) {
      // 待建设 / 未归类：仍产出一条记录，让前端能显示状态而不是"什么都没有"
      if (f._unsupported) {
        scoreMap[f.code] = {
          code: f.code, name: f.name,
          marketScore: null, valueScore: null, momentumScore: null,
          compositeLabel: f._unsupported.reason === 'rule_disabled' ? '红利规则调整中，暂不判定' : f._unsupported.reason === 'needs_review' ? '需要处理' : f._unsupported.pending ? '待建设' : '未归类',
          weights: null, degraded: [],
          positionLabel: null,
          eligible: false, suspended: false,
          unsupported: true, unsupportedReason: f._unsupported.reason,
          ...(f._unsupported.reason === 'rule_disabled' || f.category==='dividend' ? { marketVerdict: null, verdict: null, executable: false } : {}),
          ...(f.category==='dividend' ? {strategyVersion:'dividend-monthly-dca-v1',marketState:'profile_unverified',
            marketStateLabel:'需要处理',blockedReason:'profile_unverified'} : {})
        };
      }
      return;
    }
    const lim = (dailyLimits && dailyLimits[f.code] != null) ? dailyLimits[f.code] : null;
    const c = f._composite || {};
    const ps = f._purchaseStatusMeta || purchaseStatusMeta(f, now);
    const marketVerdict = f._dec.action === 'add' ? 'add' : 'hold';
    const decision = purchaseDecision(marketVerdict, ps, lim);
    scoreMap[f.code] = {
      code: f.code, name: f.name,
      marketScore: +f._marketScore.toFixed(1),                                   // = 综合分
      valueScore: c.valueScore == null ? null : +c.valueScore.toFixed(1),       // V 估值分
      momentumScore: c.momentumScore == null ? null : +c.momentumScore.toFixed(1), // M 动量分
      compositeLabel: compositeLabelOf(c),
      weights: c.weights || null,                                               // { wV, wM }
      degraded: c.degraded || [],                                               // ['V'] / ['M'] / ['V','M']
      positionLabel: synthesizePositionLabel(f._dec),
      eligible: eligible.includes(f),
      suspended: ps.suspended || (lim != null && lim <= 0),
      purchaseStatus: f.purchaseStatus || null,
      statusFresh: ps.fresh,
      marketVerdict,
      verdict: decision.verdict,
      executable: decision.executable
    };
  });
  return { scoreMap };
}


module.exports = { runDecisionPipeline };

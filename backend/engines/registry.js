'use strict';
/*
 * 决策信号注册表：category（引擎类型）+ caliber（口径）→ 信号线构造器。
 * 仅此文件登记信号线：新增信号只需在此加一条，buildAdvice 通过 REGISTRY 遍历，无需改循环。
 *
 * key 规则（2026-09-12 起支持两层）：
 *   一级 category 取值 = 引擎类型：broad(宽基) / dividend(红利) / growth(科技成长) / cycle(黄金对冲)
 *   二级 caliber 取值 = 口径变体：宽基下分 cn(A股，peErp) / us(海外，滚动分位∨PE回撤)
 *   ★category 仍只 4 值 → 组合环形图仍 4 块、配置桶映射不变、科技穿透范围不变。
 *     caliber 只决定「用哪把尺子量便宜」，不参与任何分组展示。
 *   地域由 holdings.json 的 market 字段承载（A/QDII），额度由 config.dailyLimits 承载，与本表无关。
 *
 * 宽基大类按口径分流；确认跟踪 SH000300 的 A 股基金再进入基金复权净值专线。
 */
// Runtime routing points directly to strategies, never to compatibility facades.
const strategies = {
  buildCoreDecision: require('./strategies/core'),
  buildBroad300Decision: require('./strategies/broad300').buildBroad300Decision,
  buildBroadGlobalDecision: require('./strategies/broadGlobal'),
  buildNasdaqDecision: require('./strategies/nasdaq'),
  buildDividendDecision: require('./strategies/dividend'),
  buildTechDecision: require('./strategies/tech'),
  buildActiveEquityDecision: require('./strategies/activeEquity'),
  buildGoldDualDecision: require('./strategies/goldDual'),
  buildGoldDecision: require('./strategies/gold')
};
const util = require('../lib/util');
const { isHs300Route } = require('../lib/hs300Identity');
const { isNasdaqRoute } = require('../lib/nasdaqIdentity');
const { isActiveEquityRoute } = require('../lib/activeEquityIdentity');
const { isGoldRoute } = require('../lib/goldIdentity');

const REGISTRY = {
  goldDual: {builder:strategies.buildGoldDualDecision,type:'goldDual',label:'国内黄金 · 双路径',scope:'verified-own-share'},
  activeEquity: { builder: strategies.buildActiveEquityDecision, type: 'activeEquity', label: '主动权益 · 买入判断', scope: 'verified-own-share' },
  broad:      { builder: strategies.buildCoreDecision,        type: 'broad',    label: '宽基',            caliber: 'cn', scope: 'category' },
  'broad:hs300': { builder: strategies.buildBroad300Decision, type: 'broad300', label: '沪深300', caliber: 'cn', scope: 'trackIndex' },
  'broad:us': { builder: strategies.buildBroadGlobalDecision, type: 'broad',    label: '宽基·海外',       caliber: 'us', scope: 'category:caliber' },
  'broad:nasdaq': {builder:strategies.buildNasdaqDecision,type:'nasdaq',label:'纳斯达克100',caliber:'us',scope:'verified:NDX'},
  dividend:   { builder: strategies.buildDividendDecision, type: 'dividend', label: '红利·低波', scope: 'category' },
  growth:     { builder: strategies.buildTechDecision,        type: 'tech',     label: '主题·行业（高波动）', scope: 'category' },
  cycle:      { builder: strategies.buildGoldDecision,        type: 'cycle',    label: '商品·对冲',       scope: 'category' }
};

// 还没有决策算法的类别（占位"待建设"）。
// 这些类别**允许被选、允许加基金、市值照算**，但看板必须显示「待建设」而不是给结论，
// 并且**绝不能静默丢弃** —— 旧实现遇到无算法的类别会直接 continue，用户只会觉得"少了一只"。
// 扩展点：将来给债券/现金写真算法时，往 REGISTRY 加条目并从这里移除即可。
const PENDING_CATEGORIES = new Set(['bond', 'cash']);
function isPendingCategory(cat) { return PENDING_CATEGORIES.has(cat); }

// 旧自定义分类由启动迁移折算；运行时只接收系统基础类别。
function baseCategoryOf(cat) { return cat; }

// 给定基金，反查命中哪条注册项（三段降级，保证旧数据零改动兼容）
//   ① 按基金 code 精确命中（保留能力，当前表未用）
//   ② 按 'category:caliber' 复合键命中（如 broad:us）
//   ③ 按 category 命中（旧数据无 caliber → caliberOf 默认 broad='cn' → 命中 broad，行为与改动前逐位一致）
function resolveRegistry(fund) {
  if (!fund) return null;
  const byCode = REGISTRY[fund.code];
  if (byCode) return { key: fund.code, reg: byCode };
  // 仅系统基础类别可以命中；悬空旧分类会明确进入未归类状态。
  const baseCat = baseCategoryOf(fund.category);
  const view = (baseCat === fund.category) ? fund : Object.assign({}, fund, { category: baseCat });
  const cal = util.caliberOf(view);
  if(isGoldRoute(fund))return {key:'goldDual',reg:REGISTRY.goldDual};
  if(isActiveEquityRoute(fund))return {key:'activeEquity',reg:REGISTRY.activeEquity};
  if(isNasdaqRoute(fund))return {key:'broad:nasdaq',reg:REGISTRY['broad:nasdaq']};
  if (isHs300Route(fund))
    return { key: 'broad:hs300', reg: REGISTRY['broad:hs300'] };
  if (cal) {
    const compound = REGISTRY[baseCat + ':' + cal];
    if (compound) return { key: baseCat + ':' + cal, reg: compound };
  }
  const byCat = REGISTRY[baseCat];
  if (byCat) return { key: baseCat, reg: byCat };
  return null;
}

module.exports = { REGISTRY, resolveRegistry, PENDING_CATEGORIES, isPendingCategory, baseCategoryOf };

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
 * 「宽基」不是泛指大盘宽基，而是**一套算法**：A股口径 = 乐咕PE分位 × 中债ERP；海外口径 = 蛋卷PE滚动分位 ∨ PE回撤。
 * 同一大类、两套口径，故用 'category:caliber' 复合键登记。
 */
const decisions = require('./decisions');
const util = require('../lib/util');

const REGISTRY = {
  broad:      { builder: decisions.buildCoreDecision,        type: 'broad',    label: '宽基',      caliber: 'cn', scope: 'category' },
  'broad:us': { builder: decisions.buildBroadGlobalDecision, type: 'broad',    label: '宽基·海外', caliber: 'us', scope: 'category:caliber' },
  dividend:   { builder: decisions.buildDividendDecision,    type: 'dividend', label: '红利低波',  scope: 'category' },
  growth:     { builder: decisions.buildTechDecision,        type: 'tech',     label: '科技成长',  scope: 'category' },
  cycle:      { builder: decisions.buildGoldDecision,        type: 'cycle',    label: '黄金(对冲)', scope: 'category' }
};

// 给定基金，反查命中哪条注册项（三段降级，保证旧数据零改动兼容）
//   ① 按基金 code 精确命中（保留能力，当前表未用）
//   ② 按 'category:caliber' 复合键命中（如 broad:us）
//   ③ 按 category 命中（旧数据无 caliber → caliberOf 默认 broad='cn' → 命中 broad，行为与改动前逐位一致）
function resolveRegistry(fund) {
  if (!fund) return null;
  const byCode = REGISTRY[fund.code];
  if (byCode) return { key: fund.code, reg: byCode };
  const cal = util.caliberOf(fund);
  if (cal) {
    const compound = REGISTRY[fund.category + ':' + cal];
    if (compound) return { key: fund.category + ':' + cal, reg: compound };
  }
  const byCat = REGISTRY[fund.category];
  if (byCat) return { key: fund.category, reg: byCat };
  return null;
}

module.exports = { REGISTRY, resolveRegistry };

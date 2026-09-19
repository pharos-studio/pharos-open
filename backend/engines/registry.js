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
const store = require('../lib/store');

const REGISTRY = {
  broad:      { builder: decisions.buildCoreDecision,        type: 'broad',    label: '宽基',            caliber: 'cn', scope: 'category' },
  'broad:us': { builder: decisions.buildBroadGlobalDecision, type: 'broad',    label: '宽基·海外',       caliber: 'us', scope: 'category:caliber' },
  dividend:   { builder: decisions.buildDividendDecision,    type: 'dividend', label: '红利·低波',       scope: 'category' },
  growth:     { builder: decisions.buildTechDecision,        type: 'tech',     label: '主题·行业（高波动）', scope: 'category' },
  cycle:      { builder: decisions.buildGoldDecision,        type: 'cycle',    label: '商品·对冲',       scope: 'category' }
};

// 还没有决策算法的类别（占位"待建设"）。
// 这些类别**允许被选、允许加基金、市值照算**，但看板必须显示「待建设」而不是给结论，
// 并且**绝不能静默丢弃** —— 旧实现遇到无算法的类别会直接 continue，用户只会觉得"少了一只"。
// 扩展点：将来给债券/现金写真算法时，往 REGISTRY 加条目并从这里移除即可。
const PENDING_CATEGORIES = new Set(['bond', 'cash']);
// 注意：先折算自定义别名 —— 用户可能自建一个「我的现金」绑定到 cash，
// 那它同样是"待建设"，不能因为 key 不是 'cash' 就漏判。
function isPendingCategory(cat) { return PENDING_CATEGORIES.has(baseCategoryOf(cat)); }

// ── 自建分类（custom:xxx）→ 它绑定的内置算法 ──
// 自建分类**不是新算法**，只是用户给某条内置线起的别名（例如把「主题·行业」叫成「我的医药」）。
// 映射来自 data/config/categories.json 的 customCategories 段，用户可在「配置」页增删。
// 为什么放在本文件：resolveRegistry 是「这只基金该用哪套算法」的唯一入口，别名必须在这里折掉。
let _customMap = null, _customMapAt = 0;
function customCategoryMap() {
  if (_customMap && (Date.now() - _customMapAt) < 5000) return _customMap;
  const m = {};
  try {
    const c = store.readJSON('categories.json');
    const arr = (c && Array.isArray(c.customCategories)) ? c.customCategories : [];
    for (const e of arr) {
      if (e && typeof e.key === 'string' && typeof e.category === 'string') m[e.key] = e.category;
    }
  } catch (e) { /* 读不到就视为没有自建分类 */ }
  _customMap = m; _customMapAt = Date.now();
  return m;
}
// 把任意 category（可能是 custom:xxx）折算成内置算法 key；非自建分类原样返回。
function baseCategoryOf(cat) {
  return customCategoryMap()[cat] || cat;
}

// 给定基金，反查命中哪条注册项（三段降级，保证旧数据零改动兼容）
//   ① 按基金 code 精确命中（保留能力，当前表未用）
//   ② 按 'category:caliber' 复合键命中（如 broad:us）
//   ③ 按 category 命中（旧数据无 caliber → caliberOf 默认 broad='cn' → 命中 broad，行为与改动前逐位一致）
function resolveRegistry(fund) {
  if (!fund) return null;
  const byCode = REGISTRY[fund.code];
  if (byCode) return { key: fund.code, reg: byCode };
  // ★ 自建分类先折算成它绑定的内置算法，再做路由。
  //   用折算后的类别重建一个视图，因为 util.caliberOf 会按 fund.category 取缺省口径
  //   （DEFAULT_CALIBER 只认 broad），不折算就会漏掉「宽基·海外」的默认 us 口径。
  //   无自建映射时 baseCat === fund.category → view === fund，行为与改动前逐位一致。
  const baseCat = baseCategoryOf(fund.category);
  const view = (baseCat === fund.category) ? fund : Object.assign({}, fund, { category: baseCat });
  const cal = util.caliberOf(view);
  if (cal) {
    const compound = REGISTRY[baseCat + ':' + cal];
    if (compound) return { key: baseCat + ':' + cal, reg: compound };
  }
  const byCat = REGISTRY[baseCat];
  if (byCat) return { key: baseCat, reg: byCat };
  return null;
}

module.exports = { REGISTRY, resolveRegistry, PENDING_CATEGORIES, isPendingCategory, baseCategoryOf };

'use strict';
/*
 * 内置类别/算法/口径/预设的**唯一真相源**（代码侧）。
 *
 * 为什么需要这个模块（2026-09-20）：
 *   内置项原先只存在于 `data/example/categories.example.json` —— 而那个模板**只在 setup 时**被整份
 *   拷贝成 `data/config/categories.json`，且 setup 是**幂等**的（已存在即跳过）。用户升级只做
 *   `git pull` + 重启、不会重跑 setup，于是他的 categories.json 永远停在下单当时的版本：
 *   新版本新增的内置类别（如 bond/cash）与 presets 段**永远进不去**，表现为
 *   「添加基金时选不到债券/现金」「环形图里这类基金的市值落进『未归类』」——而且不报错。
 *   所以内置项必须在**代码**里有一份，由启动时的 ensureBuiltins() 把缺的补进用户文件。
 *
 * ★ 契约（改这个文件前必读）：
 *   - 这里的常量必须与 `data/example/categories.example.json` 的对应段**保持一致**——
 *     `backend/scripts/verify_caliber_routing.js` 有断言在盯着，漂移会红。
 *   - 新增内置类别/预设 = 往下面加一条即可，用户升级后会被自动补齐；**不要**只改模板。
 *   - 只增不改：ensureBuiltins() 绝不覆盖用户已有条目（他可能改过 name、删过某条），
 *     也绝不合成 customCategories（那是用户层数据，不是内置项）。
 */

// 展示线（环形图分块 + 添加基金的类别下拉；顺序 = 环形图排布序）
const BUILTIN_CATEGORIES = [
  { key: 'broad', name: '宽基' },
  { key: 'dividend', name: '红利·低波' },
  { key: 'growth', name: '主题·行业（高波动）' },
  { key: 'cycle', name: '商品·对冲' },
  { key: 'bond', name: '债券' },
  { key: 'cash', name: '现金' },
];

// 可绑定的算法线。name 必须与 backend/engines/registry.js 的 REGISTRY.label 逐字一致
// （否则「设置/类别管理」显示的名字和决策卡上的名字会对不上）。
const BUILTIN_ENGINES = [
  { key: 'broad', name: '宽基' },
  { key: 'dividend', name: '红利·低波' },
  { key: 'growth', name: '主题·行业（高波动）' },
  { key: 'cycle', name: '商品·对冲' },
];

// 口径维度：category 之下的「用哪把尺子量」。不参与环形图分块。
const BUILTIN_CALIBERS = [
  { key: 'cn', name: 'A股口径', note: '乐咕PE分位(近5年滚动) × 中债10年ERP' },
  { key: 'us', name: '海外口径', note: '滚动3年PE分位 ∨ PE回撤15% × 美债10年ERP' },
];

// 给用户看的预设清单（配置页「类别管理」只读展示 + 说明「这条线适用于哪类基金」）。
// supported=false 表示该类别的算法「待建设」：能选、能记市值，但不给买卖结论。
const BUILTIN_PRESETS = [
  {
    id: 'broad-cn', name: 'A股宽基', category: 'broad', caliber: 'cn', supported: true,
    applies: '跟踪 A 股宽基指数的基金：沪深300 / 中证500 / 中证1000 / A500 / 创业板 / 科创50',
    note: '估值锚 = 该指数自己的 PE 分位 × 中债 ERP，所以**必须填对跟踪指数**，否则判定会降级',
  },
  {
    id: 'broad-us', name: '海外宽基', category: 'broad', caliber: 'us', supported: true,
    applies: '跟踪海外宽基指数的基金：标普500 / 纳斯达克100 / 日经 / 恒生 / DAX',
    note: '锚 = 滚动156周PE分位 ∨ PE回撤，× 美债 ERP',
  },
  {
    id: 'dividend-cn', name: '红利·低波（A股）', category: 'dividend', supported: true,
    applies: '**仅适用 A 股红利/低波类基金**',
    note: '参考带是中证红利 000922 的动态股息率。海外红利没有免费估值源，挂这条线会走常量兜底带',
  },
  {
    id: 'theme', name: '主题·行业', category: 'growth', supported: true,
    applies: '任何**高波动**资产：医药 / 消费 / 新能源 / 军工 / 半导体 / 港股科技 / 主动偏股基金',
    note: '算法本质是「深度回撤抄底」，只看基金自身净值，**不需要跟踪指数、也不看行业**',
  },
  {
    id: 'commodity', name: '商品·对冲', category: 'cycle', supported: true,
    applies: '任何**商品**类基金：黄金 / 白银 / 原油 / 豆粕 / 有色 ETF',
    note: '只看自身净值的 250 日价格分位与三重均线，**不绑黄金这一种标的**',
  },
  {
    id: 'bond', name: '债券', category: 'bond', supported: false, pending: true,
    applies: '纯债 / 一级债基 / 二级债基 / 可转债基金',
    note: '★ 决策算法**待建设**：这类基金的锚应是「国债利率分位 + 信用利差」，与现有五条线完全不同。当前只记录市值与占比，不给买卖结论',
  },
  {
    id: 'cash', name: '现金', category: 'cash', supported: false, pending: true,
    applies: '货币基金 / 现金管理类',
    note: '★ 决策算法**待建设**：货币基金没有净值波动、也没有估值锚，本质上不需要买入信号，只应计入总资产与占比',
  },
];

// 供 server.js 的类别白名单使用（展示线 key）。
// ★ 只用 key、不含 name：白名单判的是 fund.category 能否落库。
const BASE_CATEGORY_KEYS = BUILTIN_CATEGORIES.map((c) => c.key);

// 四段内置项的统一描述表（ensureBuiltins 靠它遍历）。
const SEGMENTS = [
  { seg: 'categories', defs: BUILTIN_CATEGORIES, idKey: 'key' },
  { seg: 'engines', defs: BUILTIN_ENGINES, idKey: 'key' },
  { seg: 'calibers', defs: BUILTIN_CALIBERS, idKey: 'key' },
  { seg: 'presets', defs: BUILTIN_PRESETS, idKey: 'id' },
];

const SEG_CN = { categories: '展示线', engines: '可绑定算法', calibers: '口径', presets: '预设' };

// 浅拷贝一条定义并按需补 category 字段（返回值都是新对象，绝不把常量对象的引用交出去）。
function cloneDef(d) { return Object.assign({}, d); }

/*
 * 只增不改地补齐内置项。
 *
 * 纯函数：不读盘、不写盘、**不修改入参**（返回新对象）。
 * 返回 { obj, changed, added, skipped }
 *   - obj      补好的新对象（各段是新数组；已有条目按原引用带入，一个字段不动）
 *   - changed  是否有补齐（false 时调用方**不要写盘**，这样文件字节不变 = 天然幂等）
 *   - added    [{ seg, key, name }] 便于启动日志逐条打印（本项目忌讳静默改用户文件）
 *   - skipped  [{ seg, reason }] 该段存在但不是数组 → **保留用户的非法值，不覆盖**
 *
 * 逐段规则：按 key(或 presets 的 id) 判重，只把缺的**追加到末尾**；不重排、不删、不改已有条目。
 * 顺序上：旧文件是 broad/dividend/growth/cycle，追加 bond/cash 后恰好等于内置顺序（= 环形图排布序）。
 * ★ customCategories 是用户层数据（自建分类别名），不合成、不触碰。
 */
function ensureBuiltins(cats) {
  const added = [];
  const skipped = [];
  if (!cats || typeof cats !== 'object' || Array.isArray(cats)) {
    return { obj: cats, changed: false, added, skipped }; // 畸形输入：原样返回，不抛错
  }
  const obj = Object.assign({}, cats);

  for (const { seg, defs, idKey } of SEGMENTS) {
    const cur = obj[seg];

    if (cur === undefined) {
      // 老文件没这一段（如 presets）→ 整段写入
      obj[seg] = defs.map(cloneDef);
      for (const d of defs) added.push({ seg, key: d[idKey], name: d.name });
      continue;
    }
    if (!Array.isArray(cur)) {
      // 用户手改成了非数组 → 保持原样，只记一笔（宁可少补，不可覆盖用户的文件）
      skipped.push({ seg, reason: '该段不是数组，保留原值' });
      continue;
    }

    const have = new Set();
    for (const x of cur) {
      if (x && typeof x === 'object' && x[idKey] != null) have.add(x[idKey]);
    }
    const miss = defs.filter((d) => !have.has(d[idKey]));
    if (!miss.length) continue;

    obj[seg] = cur.concat(miss.map(cloneDef));
    for (const d of miss) added.push({ seg, key: d[idKey], name: d.name });
  }

  return { obj, changed: added.length > 0, added, skipped };
}

// 把 added 渲染成一行人类可读的说明（启动日志用）
function describeAdded(added) {
  return added.map((a) => SEG_CN[a.seg] + '/' + a.key + (a.name ? '（' + a.name + '）' : '')).join('、');
}

module.exports = {
  BUILTIN_CATEGORIES, BUILTIN_ENGINES, BUILTIN_CALIBERS, BUILTIN_PRESETS,
  BASE_CATEGORY_KEYS, ensureBuiltins, describeAdded,
};

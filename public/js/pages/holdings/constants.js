/* 持仓页 · 常量表
   职责：分类兜底、口径选项、跟踪指数提示等纯数据，供表单与批量添加共用。
   导出：CATS_FALLBACK / CAT_HINTS / EST_OPTIONS / INDEX_HINTS
   ★ 不要放在这里：任何函数逻辑；改渲染请去 desktop.js / mobile.js。
*/

// 展示线兜底常量：仅当 state.categories.engines 缺失时降级用
// （文案须与 data/config/categories.json 的 engines 一致，正常路径永远读下发段）
// 2026-09-19：bond/cash 是**待建设**类别——能选、能记市值，但不给买卖结论。
export const CATS_FALLBACK = [
  { key: 'broad', name: '宽基' },
  { key: 'dividend', name: '红利·低波' },
  { key: 'growth', name: '主题·行业（高波动）' },
  { key: 'cycle', name: '商品·对冲' },
  { key: 'bond', name: '债券' },
  { key: 'cash', name: '现金' },
];
// 每条展示线的「适用于哪类基金」提示（选类别时显示，避免用户把医药基金放进宽基）
export const CAT_HINTS = {
  broad: '适用：跟踪 A股/海外宽基指数的指数基金。★必须填对跟踪指数，否则估值锚缺失、判定会降级',
  dividend: '适用：**仅 A 股红利 / 低波类**。海外红利没有免费估值源，挂这条线会走常量兜底',
  growth: '适用：任何**高波动**资产 —— 医药/消费/新能源/军工/半导体/主动偏股都算，不只科技',
  cycle: '适用：任何**商品**类 —— 黄金/白银/原油/豆粕。本线只看自身净值，不绑黄金',
  bond: '★ 债券的决策算法**待建设**：现在只记录市值与占比，不给买卖结论',
  cash: '★ 现金/货币的决策算法**待建设**：现在只记录市值与占比，不给买卖结论',
};
// 盘中估算指数选项：value=指数代码（写入 estimateIndex），label 与 data/state/holdings.json 存量 estimateLabel 逐字对齐
export const EST_OPTIONS = [
  { value: 'sh000300', label: '沪深300' },
  { value: 'sh000015', label: '上证红利(近似)' },
  { value: 'sz159834', label: '南方上海金ETF(159834)' },
];
// 指数映射提示表：**仅作最后兜底**。正常路径是后端 /api/fund-lookup 用东财档案的
// INDEXCODE 精确给出 trackIndex（见 backend/lib/trackIndex.js 的 INDEX_CODE_TO_TRACK）。
// 这张表只在档案抓不到、而用户又先填了名称时有帮助；匹配不到留空，不阻塞添加。
export const INDEX_HINTS = [
  { re: /纳斯达克|纳指/, trackIndex: 'NDX' },
  { re: /沪深300/, trackIndex: 'SH000300', est: 'sh000300', estLabel: '沪深300' },
  { re: /红利低波|标普红利/, trackIndex: 'CSI930955', est: 'sh000015', estLabel: '上证红利(近似)' },
  { re: /上证红利/, est: 'sh000015', estLabel: '上证红利(近似)' },
  { re: /上海金|黄金ETF|金ETF/, est: 'sz159834', estLabel: '南方上海金ETF(159834)' },
];

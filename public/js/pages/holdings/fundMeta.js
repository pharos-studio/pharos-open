/* 持仓页 · 基金元数据
   职责：基金名单懒加载、市场推断、分类建议、按代码归集买入记录、费率只读文案。
   导出：marketOfType / suggestCategory / ensureFundList / purchasesByCode / feeNote / purchaseStatusNote
   ★ 不要放在这里：增删基金的落盘逻辑请去 fundStore.js。
*/

import * as api from '../../api.js';

/* —— 添加基金自动带出（2026-09-08 L1+L2+L3）—— */
// 模块级：名单同会话只拉一次；_lastAutoName 防自动值覆盖用户手改的名称
let _fundListPromise = null;
let _trackIdxListPromise = null;

// 跟踪指数白名单（来自后端 lib/trackIndex.js 的唯一真相源）：懒加载一次，失败静默降级为纯手填
function ensureTrackIndexList() {
  if (!_trackIdxListPromise) {
    _trackIdxListPromise = api.getTrackIndex()
      .then(d => (d && d.ok && Array.isArray(d.list)) ? d.list : null)
      .catch(() => null);
  }
  return _trackIdxListPromise;
}

// 市场判定：类型文本含 QDII/海外 → QDII（与 backend fetchers.marketOfType 同规则）
export function marketOfType(typeText) { return /QDII|海外/.test(typeText || '') ? 'QDII' : 'A'; }
// 类别预选（可改、不锁定；仅建议）。
// ★★ 2026-09-19 关键修复：兜底从 `return 'growth'` 改为 **return null（不猜）**。
//   旧实现在名称匹配不到时一律归成「主题·行业」线，于是用户加一只债基/消费基金会被
//   套上"60日回撤抄底"算法算出一个看起来正常的错结论 —— 不报错，最危险。
//   现在改为：拿不到确定的判断就不预选，由界面提示用户自己选（后端 /api/fund-lookup 会
//   用东财的 FTYPE 给出确定建议，那条路径优先）。
export function suggestCategory(nameText) {
  const s = String(nameText || '');
  if (/货币|现金宝|活期/.test(s)) return 'cash';
  if (/债券|纯债|信用债|利率债|可转债|双利|增利/.test(s)) return 'bond';
  if (/红利|低波/.test(s)) return 'dividend';
  if (/黄金|上海金|白银|原油|豆粕|商品/.test(s)) return 'cycle';
  if (/纳斯达克|纳指|标普\d*00|标普500|日经|恒生|道琼斯|德国DAX|法国CAC/.test(s)) return 'broad';
  if (/沪深300|中证500|中证800|中证A500|中证1000|上证50|创业板指|深证|中证100/.test(s)) return 'broad';
  return null; // ★ 不猜 —— 由 /api/fund-lookup 的 FTYPE 建议或用户手选
}
// 联想名单：懒加载一次，失败静默降级为纯 6 位查询流
export function ensureFundList() {
  if (!_fundListPromise) {
    _fundListPromise = api.getFundList()
      .then(d => (d && d.ok && Array.isArray(d.list)) ? d.list : null)
      .catch(() => null);
  }
  return _fundListPromise;
}

export function purchasesByCode(state) {
  const map = {};
  const raw = (state && state.holdings && state.holdings.funds) || {};
  const funds = Array.isArray(raw) ? raw : Object.values(raw); // 磁盘为数组；历史代码兼容对象形态
  funds.forEach(f => { if (f && f.code) map[f.code] = f.purchases || []; });
  return map;
}

/* —— 申购费只读文案 —— */
// 费率由后端抓取写入持仓文件，**界面刻意不提供任何输入框**：改费率会连带改变成本与份额口径，
// 开放版用户随手一改就再难自查。这里只把抓来的值排版成一行可读文案。
// 返回 { text, title }；拿不到费率时返回 null —— 宁可整行不显示，也不显示「0%」冒充已知值。
export function feeNote(f) {
  const rate = f && f.feeRate;
  if (typeof rate !== 'number' || !isFinite(rate) || rate < 0) return null;
  const d = (f && f.feeDetail) || {};
  const tips = [];
  const src = d.sub && d.sub.source;
  if (typeof src === 'number' && src > rate) tips.push('法定原价 ' + pctText(src) + '（' + foldText(src, rate) + '）');
  if (d.updated) tips.push('数据源 天天基金 · 更新 ' + d.updated);
  if (d.sgState) tips.push('申购状态 ' + d.sgState);
  return { text: '申购费 ' + pctText(rate), title: tips.join(' · ') };
}
export function purchaseStatusNote(f) {
  const s = f && f.purchaseStatus;
  if (!s) return { text: '申购状态未知', state: 'unknown' };
  const fresh = !!(s.updatedAt && Date.now() - Number(s.updatedAt) < 24 * 3600 * 1000);
  const names = { open: '开放申购', limited: '限额申购', suspended: '暂停申购', unknown: '状态未知' };
  let text = names[s.state] || '状态未知';
  if (!fresh) text += '（已过期）';
  if (s.state !== 'suspended') {
    if (s.unlimited) text += ' · 不限额';
    else if (s.maxBuy > 0) text += ' · 实际上限 ¥' + Number(s.maxBuy).toLocaleString('zh-CN');
  }
  return { text, state: fresh ? s.state : 'stale', title: s.raw || '' };
}
// 0.0012 → "0.12%"；0 → "0%"（去掉无意义的尾零）
function pctText(v) {
  return (Number(v) * 100).toFixed(2).replace(/\.?0+$/, '') + '%';
}
// 折数：折后价 ÷ 原价。国内「几折」= 原价的十分之几，故 1 折是九折优惠后的价
function foldText(source, rate) {
  return String(Math.round(rate / source * 100) / 10).replace(/\.0$/, '') + ' 折';
}

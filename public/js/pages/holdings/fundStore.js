/* 持仓页 · 基金增删落盘
   职责：读基金列表、持久化、添加与删除基金。
   导出：readFunds / persist / addFund / removeFund
   ★ 不要放在这里：表单交互请去 purchaseForm.js / addFundPanel.js。
*/

import * as api from '../../api.js';
import * as store from '../../store.js';
import { refreshPage } from './state.js';

/* ---------- 添加基金：表单 + 持久化（从设置页迁入，唯一持仓入口） ---------- */
// 读 funds（磁盘为数组；历史对象形态兼容）
export function readFunds(state) {
  const raw = (state && state.holdings && state.holdings.funds) || [];
  return Array.isArray(raw) ? raw : Object.values(raw);
}

// 持久化：只回写 holdings + config（不再含 watchlist），成功刷新本页
export async function persist(state) {
  try {
    await api.save({ holdings: state.holdings, config: state.config });
    await refreshPage();
    return true;
  } catch (e) {
    alert('保存失败：' + e.message + '\n（写入需要正确的 API Key，且后端已启动）');
    return false;
  }
}

// 添加基金：market/估算由表单决定（删硬编码；QDII 走 T+2 无盘中估算）
// caliber（口径，2026-09-12）：仅宽基(broad)需要 —— cn=A股口径 / us=海外口径；其他类别不落该字段。
// trackIndex（2026-09-12 一键添加）：INDEX_HINTS 命中时自动带入（决策估值/PE历史用），缺省不落字段（走价格分位兜底）。
export async function addFund(code, name, category, market, estIndex, estLabel, caliber, trackIndex) {
  const state = store.getState();
  const funds = readFunds(state);
  if (funds.some(f => f.code === code)) { alert('该基金已存在'); return; }
  const newFund = Object.assign({
    code, name, category, market,
    caliber: (category === 'broad' && (caliber === 'cn' || caliber === 'us')) ? caliber : undefined,
    feeRate: 0, estimateIndex: estIndex || null, estimateLabel: estLabel || null,
    purchases: [],
  }, trackIndex ? { trackIndex } : {});
  state.holdings = Object.assign({}, state.holdings, { funds: funds.concat([newFund]) });
  const ok = await persist(state);
  if (ok) alert('已添加。新基金无买入记录，展开点「＋记一笔」录首笔买入后才有市值。');
}

// 删除基金：从 funds 数组移除后整体回写（经 /api/save 的 holdings 通道，无需新端点）
export async function removeFund(code) {
  if (!confirm('确定删除该基金及其全部买入记录？删除后不可恢复。')) return;
  const state = store.getState();
  state.holdings = Object.assign({}, state.holdings, { funds: readFunds(state).filter(f => f.code !== code) });
  await persist(state);
}

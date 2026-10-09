'use strict';
// ============================================================================
// 份额 → 基金合同 的折叠口径（**唯一实现**）。
//
// 为什么需要它：同一份基金合同的 A/C/E/后端/美元份额各占一个代码，
// 但**证据只需采集一次**（同一份招募说明书、同一份基金合同）。台账仍按代码逐条准入，
// 只是取证与排期以合同为单位。
//
// 口径经 2026-10-08 抽检定稿：
//   · 全市场 27,992 → 15,163 份合同；主动权益线 12,313 → 6,544 份（多份额组 5,409 / 一码一合同 1,135）
//   · 误并 0 例（跨公司同名 0）、漏并 0 例（A类/C类 未折叠 0）
//   · 3 步版比 2 步版多合并的 26 组，**全部是同一只基金的币种份额归一**，
//     已用华夏基金《新增美元销售币种…并修订本基金的基金合同》公告 + 证监会产品资料概要实证
//   · 已知缺陷已修：正则原本会把 ETF/LOF/FOF 的末字母当份额字母剥掉（52 个代码键名损坏），
//     现由 ACRONYM 保护；修正前后所有计数**不变**（因为那些键组内成员数均为 1，从未碰撞）
//
// ⚠️ 曾经踩过的坑，勿重蹈：
//   · 2 步版与 3 步版曾同时存在于两个临时脚本里（差 39 个合同），而**发布数字的脚本和
//     做抽样去重的脚本不是同一份**。折叠口径必须单份，且被测试锁住计数。
//   · 「份额类别设立日 ≠ 基金合同生效日」。本模块只折叠**证据的粒度**，
//     不产出准入起点（`initializationFrom` 仍须按每个份额各自判定）。
// ============================================================================

const CLASS_LETTER = /[ABCDEFHIJLMNOPRSTUVWXY]$/i;
const ACRONYM = /(ETF|LOF|FOF|QDII)$/;
const TRAILING_WORDS = /(后端|前端|美元现汇|美元现钞|人民币|现汇|现钞)$/;

/** 去掉份额类别标记，还原到基金合同名。 */
function baseName(name) {
  let s = String(name == null ? '' : name).replace(/[（(][^）)]*[）)]/g, '').trim();
  // 只有在「不以缩略语结尾」时才剥尾字母 —— 否则 FOF/LOF/ETF 的末字母会被误当份额类别。
  if (!ACRONYM.test(s)) s = s.replace(CLASS_LETTER, '');
  return s.replace(TRAILING_WORDS, '').trim();
}

/**
 * 把记录按合同折叠。
 * @param {Array<{code:string,name:string}>} rows
 * @param {(row:object)=>string} [codeOf] 取代码的函数（默认 row.code）
 * @returns {Map<string, {key:string, name:string, codes:string[]}>}
 */
function groupByContract(rows, codeOf) {
  const pick = codeOf || (r => r.code);
  const map = new Map();
  for (const r of rows) {
    const key = baseName(r.name);
    if (!key) continue;                        // 名字为空/全被剥掉 ⇒ 不参与折叠，避免整堆塌成一个假合同
    let g = map.get(key);
    if (!g) { g = { key, name: key, codes: [] }; map.set(key, g); }
    g.codes.push(pick(r));
  }
  for (const g of map.values()) g.codes.sort();
  return map;
}

module.exports = { baseName, groupByContract };
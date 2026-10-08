'use strict';
// Historical data compatibility service; never called by formal dividend decisions.
const store = require('../lib/store');
function loadYieldAnchor3y(code, windowYears, fallback) {
  const years = windowYears > 0 ? windowYears : 3;
  const fb = (fallback != null && fallback > 0) ? +fallback : 0.047;
  let raw = null;
  try { raw = store.readJSON('yield_history.json'); } catch (e) { raw = null; } // 首次运行文件不存在：ENOENT 容错
  // 迁移：旧平面 {日期:值} → 视作该基金=008163（历史唯一持有红利基金）；新结构 {code:{日期:值}} 直接取
  let seq = null;
  if (raw && typeof raw === 'object') {
    const isFlat = Object.keys(raw).some(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
    seq = isFlat ? { '008163': raw } : raw;
  }
  if (seq && typeof seq === 'object' && seq[code] && typeof seq[code] === 'object') {
    const sub = seq[code];
    const dates = Object.keys(sub).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if (dates.length) {
      const first = dates[0], last = dates[dates.length - 1];
      const spanYears = (new Date(last) - new Date(first)) / (365 * 24 * 3600 * 1000);
      const cutoff = new Date();
      // ★ 三个调用必须同属一个时区：原来用本机 getFullYear/setFullYear 配 toISOString()（UTC），
      //   两者差 8 小时，跨年边界会算出差一天的 cutoffStr。统一走 UTC。
      //   （窗口是「N 年 ≥100 个点」，差一天不影响判据，但混用本身就是 bug，见 lib/tradeDate.js 铁律）
      cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const inWin = dates.filter(d => d >= cutoffStr);
      // 修复：必须真实覆盖 windowYears 年才用滚动均值，否则沿用保守常量锚（消除"数月后无声翻转"）
      if (spanYears >= years && inWin.length >= 100) {
        const vals = inWin.map(d => sub[d]).filter(v => typeof v === 'number' && v > 0);
        if (vals.length >= 100) {
          const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
          return { anchor: +mean.toFixed(4), anchored: true };
        }
      }
    }
  }
  return { anchor: fb, anchored: false };
}
module.exports = { loadYieldAnchor3y };

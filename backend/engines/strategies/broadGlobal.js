'use strict';
/*
 * 策略：海外宽基（broad + caliber=us / 纳指100）
 *
 * 设计依据见 plans §8.6（2026-09-12 数据驱动修订），要点：
 *   ① 估值通道（自适应）：PE 在【滚动 3 年】窗口内的分位 ≤25 → 便宜。
 *      ★必须自算滚动分位，不能用蛋卷的 pe_percentile —— 那是固定约 10 年口径。
 *        纳指 PE 存在「台阶上移」（2016-19 中位 27.43 → 2023-26 中位 35.06，+30%），
 *        固定全样本分位会把新常态永久判成偏贵：实测 2023 年后触发 2/0/0/0 周（2024-26 连续三年归零）。
 *        改滚动 3 年后恢复触发（2025 触发 14 周、2026 触发 14 周）。
 *   ② 回撤通道（补盲区）：PE 距近 52 周高点回撤 ≤ −peDipPct（★2026-09-13 复验后由 15% 放宽至 12%）→ 便宜。
 *      ★用 PE 回撤而非净值回撤：纳指 60 日跌 15% 极罕见（2023 起净值回撤仅触发 2 次，PE 回撤 24 次）。
 *      ★不要求止跌（peDipRequireStop=false）。
 *   ③ 趋势：三重均线 MA60/120/250（跌破 MA120 = trendWeak）。喂 V 的超跌加分与 M 的止跌/趋势因子，不作触发。
 *   ④ ERP = 1/PE − 美债10年：仅综合分副锚 + 展示，★不作触发。
 *      方差分解：近5年美债 sd=0.88pp vs 盈利收益率 sd=0.45pp → ERP 变动主要由利率驱动，
 *      对纳指它是「利率指标」而非「估值指标」；且高利率期作触发信号近乎沉默。
 *      阈值 erpHigh=2.1 / erpLow=−1.5（10年 p90/p10 正式标定，见 §8.5）。
 *   ⑤ 总闸：复用 peGate，但分位改用滚动分位（gatePercentile）。
 *
 * 决策矩阵：① 或 ② 任一成立 → add；否则 hold。总闸命中 → 强制 hold。
 * 实测（2026-09-13 复验，backend/scripts/backtest_broad_global_us.js，270042 主序列 14 年）：
 *   阈值 12% 下事件 40、R6m +8.9%、ΔR6m +1.69pp、7 个关键底部覆盖 5/7（含 2024-08 套息急跌）、
 *   2024 触发 20 天（原 15% 时 0 天）；P0~P7 全过 → 由 15% 放宽至 12%。
 *   通道独有贡献：① 24 天/2 事件、② 301 天/20 事件 → 并联由②主导。
 *   ★原文件头所写"2023 起 29 次信号 / 超额 +16.7%"无脚本支撑且与文档矛盾，已作废。
 *
 * 边界：无风险利率只认美债（v.usTreasury10y → config.usTreasury10y），★绝不回退中债。
 *       A 股宽基仍只用中债，永不用美债。
 */
const { buildFundDecision } = require('../kernel');
const util = require('../../lib/util');

function buildBroadGlobalDecision(fund, valuationMap, config) {
  const g = (config && config.signals && config.signals.broadGlobal) || {};
  const peG = (config && config.signals && config.signals.peGate) || {};
  const v = (valuationMap && valuationMap[fund.code]) || (fund && fund.valuation) || {};
  const hist = (fund && fund.history) || [];
  const nav = fund && fund.latestNav != null ? fund.latestNav : (hist[0] ? hist[0].nav : null);

  // ---------- 参数（含兜底，全部可调不改码）----------
  const cheapPct = g.cheapPct != null ? g.cheapPct : 25;
  const expensivePct = g.expensivePct != null ? g.expensivePct : 80;
  const peWindowWeeks = g.peWindowWeeks != null ? g.peWindowWeeks : 156;   // 3 年
  const peDipPct = g.peDipPct != null ? g.peDipPct : 12;   // 2026-09-13 复验后默认值由 15 改 12（与 config 同步）
  const peDipWindowWeeks = g.peDipWindowWeeks != null ? g.peDipWindowWeeks : 52;
  const peDipRequireStop = g.peDipRequireStop === true;                     // 默认 false（见文件头 ★）
  const stopWindow = g.stopWindow != null ? g.stopWindow : 20;

  // ---------- PE 序列（由 analysis.js 挂载）----------
  const peHist = Array.isArray(v.peHistory) ? v.peHistory : null;
  const peSeries = peHist ? peHist.map(x => x.pe) : null;
  const pe = v.pe != null ? v.pe : (peSeries && peSeries.length ? peSeries[peSeries.length - 1] : null);
  const pePercentile = v.pePercentile != null ? v.pePercentile : null; // 蛋卷固定分位：仅展示对照

  // ---------- 通道①：滚动分位 ----------
  // 保留 2 位小数：既用于判定也用于总闸文案（避免长浮点进 reasons）
  const rawRolling = peSeries ? util.rollingPercentile(peSeries, peWindowWeeks) : null;
  const peRollingPct = (rawRolling != null) ? +rawRolling.toFixed(2) : null;
  const cheapByPct = peRollingPct != null && peRollingPct <= cheapPct;
  // 展示用分区（用滚动分位，与判据同源）
  const peZone = peRollingPct == null ? 'na'
    : (peRollingPct <= cheapPct ? 'cheap' : (peRollingPct >= expensivePct ? 'expensive' : 'neutral'));

  // ---------- 通道②：PE 回撤 ----------
  const peDipLevel = peSeries ? util.peDrawdownLevel(peSeries, peDipWindowWeeks) : null;

  // ---------- 趋势（三重均线，与 core.js 同款）----------
  const mas = (g.maWindows || [60, 120, 250]).map(w => util.computeMA(hist, w));
  let trendWeak = null, trendGrade = null;
  if (mas[1] != null && nav != null) {
    trendWeak = nav < mas[1];
    if (mas[0] != null && mas[2] != null) {
      if (nav < mas[0] && nav < mas[1] && nav < mas[2]) trendGrade = '全下(强降)';
      else if (nav > mas[0] && nav > mas[1] && nav > mas[2]) trendGrade = '全上(强升)';
      else trendGrade = '混杂';
    }
  }
  const recent20dChange = v.recent20dChange != null ? v.recent20dChange : util.recentChangePct(hist, 20);
  const stopFall = util.stableLow(hist, stopWindow);
  // ★2026-09-14 新增：动量因子的连续化（只算不判，仅供评分层动量分 M 使用，不参与任何 add/hold 判定）
  //   把二值的 stopFall 变成「低点抬高幅度%」，与 stableLow 同窗口同方向（> 0 ⟺ stableLow === true）
  const stopRisePct = util.lowRaisePct(hist, stopWindow);
  // 趋势强弱：现价相对 MA120 的偏离%（0 分界 = trendWeak 的临界点）
  const ma120DevPct = util.maDevPct(hist, 120, nav);

  // 通道②（可选止跌确认，默认关闭）
  const dipReady = peDipLevel != null && peDipLevel <= -peDipPct;
  const cheapByDip = peDipRequireStop ? (dipReady && stopFall === true) : dipReady;
  const cheap = cheapByPct || cheapByDip;

  // ---------- ERP 副锚（仅综合分 + 展示，不作触发）----------
  const usTreasury10y = (v.usTreasury10y != null && v.usTreasury10y > 0)
    ? v.usTreasury10y
    : (config && config.usTreasury10y != null ? config.usTreasury10y : null);
  let erp = null;
  if (pe != null && pe > 0 && usTreasury10y != null && usTreasury10y > 0) {
    erp = 1 / pe - usTreasury10y; // 小数，如 -0.0164 = -1.64%
  }

  return buildFundDecision({
    pe,
    pePercentile,                                  // 仅展示对照
    peRollingPct,                                  // ★主锚（滚动分位）
    peDipLevel,                                    // ★通道②
    cheapByPct, cheapByDip, cheap,
    gatePercentile: peRollingPct,                  // 总闸用滚动分位（比固定分位更不容易长期失效）
    erp,
    nav,
    history: hist,
    recent20dChange,
    trendWeak,
    stopFall,
    trendGrade,
    stopRisePct,                                  // ★新增（连续化，仅供 M）
    ma120DevPct                                   // ★新增（连续化，仅供 M）
  }, {
    cheapBy: 'broadGlobal',
    bondName: '美债',                              // reasons 文案用
    cheapPct,
    expensivePct,
    peWindowWeeks,
    peDipPct,
    peDipWindowWeeks,
    stopWindow,
    erpHigh: g.erpHigh != null ? g.erpHigh : null,
    erpLow: g.erpLow != null ? g.erpLow : null,
    peGatePct: peG.peGatePct != null ? peG.peGatePct : 85,
    surge20dPct: peG.surge20dPct != null ? peG.surge20dPct : 5
  });
}

module.exports = buildBroadGlobalDecision;

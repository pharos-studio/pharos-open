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
 * 实测（2026-09-13 复验，backend/backtest/broad/backtest_broad_global_us.js，270042 主序列 14 年）：
 *   阈值 12% 下事件 40、R6m +8.9%、ΔR6m +1.69pp、7 个关键底部覆盖 5/7（含 2024-08 套息急跌）、
 *   2024 触发 20 天（原 15% 时 0 天）；P0~P7 全过 → 由 15% 放宽至 12%。
 *   通道独有贡献：① 24 天/2 事件、② 301 天/20 事件 → 并联由②主导。
 *   ★原文件头所写"2023 起 29 次信号 / 超额 +16.7%"无脚本支撑且与文档矛盾，已作废。
 *
 * 边界：无风险利率只认美债（v.usTreasury10y → config.usTreasury10y），★绝不回退中债。
 *       A 股宽基仍只用中债，永不用美债。
 */
// Strategy-local matrix and reasons; no compatibility-kernel dependency.
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

  return buildSignalDecision({
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


// Low-level legacy signal contract, owned by this strategy.
function buildSignalDecision(signalSource, params) {
  const p = params || {};
  const cheapRatio = p.cheapRatio != null ? p.cheapRatio : 1.05;
  const expensiveRatio = p.expensiveRatio != null ? p.expensiveRatio : 0.90;
  const peGatePct = p.peGatePct != null ? p.peGatePct : 85;
  const surge20dPct = p.surge20dPct != null ? p.surge20dPct : 5;
  const s = signalSource || {};
  const reasons = [];
  const matrix = {};

  // ① 本策略的位置判断；兼容矩阵的其他字段保留原默认值
  let yieldZone = 'na';
  let ratio = null;
  let dipReady = false; // 科技专用：回撤到位+止跌
  let pctZone = 'na';   // 黄金专用：价格分位区（便宜/中性/贵）
  let peZone = 'na';    // 宽基双锚：PE 分位区
  let erpZone = 'na';   // 宽基双锚：ERP 区（高=股票划算）
  {
    if (s.yield != null && s.yield > 0) {
      const anchor = s.anchor3y != null && s.anchor3y > 0 ? s.anchor3y : (p.anchor3yFallback > 0 ? p.anchor3yFallback : null);
      if (anchor != null && anchor > 0) {
        ratio = s.yield / anchor;
        yieldZone = ratio >= cheapRatio ? 'cheap' : (ratio <= expensiveRatio ? 'expensive' : 'neutral');
      } else {
        yieldZone = 'na';
      }
    } else {
      yieldZone = 'na';
    }
  }

  // ② 本策略趋势及兼容展示字段
  let maZone = 'na';
  let devPct = null;
  let ma = null;
  {
    if (s.nav != null && s.nav > 0) {
      ma = s.ma250 != null ? s.ma250 : (s.history ? util.computeMA(s.history, p.windowDays || 250) : null);
      if (ma != null && ma > 0) {
        devPct = (s.nav - ma) / ma * 100;
        maZone = devPct < -3 ? 'below' : (devPct > 3 ? 'above' : 'near');
      }
    }
  }

  // ③ PE 初筛（总闸）：分位 ≥ peGatePct 且近20日急涨 > surge20dPct → 强制「不动」
  // 分位口径：优先 s.gatePercentile（海外宽基传**滚动分位**——固定分位遇水位台阶会长期失效），
  // 缺失时回退 s.pePercentile（A股 / 科技原口径，行为与文案逐字不变）。
  const gatePct = (s.gatePercentile != null) ? s.gatePercentile : s.pePercentile;
  let gate = 'pass';
  if (gatePct != null && gatePct >= peGatePct && (s.recent20dChange || 0) > surge20dPct) {
    gate = 'block';
    reasons.push(`PE 分位 ${gatePct}% 且近20日涨 ${s.recent20dChange}%，总闸拦截`);
  }
  // ③ 急涨总闸（仅 pricePercentile 模式用）：近20日涨 > surge20dPct → 仅中性区强拦（便宜区不拦）
  let surge = false;

  // 决策矩阵（二档）；PE 总闸命中 → 强制不动
  let action = 'hold';
  if (gate === 'block') {
    action = 'hold';
  } else {
    // 宽基·海外：两通道并联，任一成立即加仓
    //   ① 估值通道：PE 在滚动 N 周窗口内分位 ≤ cheapPct（自适应水位台阶）
    //   ② 回撤通道：PE 距近 M 周高点回撤 ≤ -peDipPct（★不要求止跌——加了反而降低信号质量，见 §8.6）
    // 实测并联覆盖 2018-12 / 2020-03 / 2022-12 / 2025-04 全部四个关键买点。
    action = (s.cheap === true) ? 'add' : 'hold';
  }

  // 理由文案（尽力解释触发路径）
  const anchorPct = (s.anchor3y != null ? s.anchor3y : p.anchor3yFallback) || 0;
  const anchorPctStr = (anchorPct * 100).toFixed(2);
  const yieldPctStr = s.yield != null ? (s.yield * 100).toFixed(2) : '?';
  {
    const peNowStr = (s.pe != null) ? (+s.pe).toFixed(2) : '?';
    const pctStr = (s.peRollingPct != null) ? (+s.peRollingPct).toFixed(1) : '?';
    const dipStr = (s.peDipLevel != null) ? (+s.peDipLevel).toFixed(1) : '?';
    const wPct = p.peWindowWeeks || 156;
    const wDip = p.peDipWindowWeeks || 52;
    const cPct = (p.cheapPct != null) ? p.cheapPct : 25;
    const dPct = (p.peDipPct != null) ? p.peDipPct : 12;   // 与 config.peDipPct 对齐（2026-09-13 由 15 改 12）
    if (action === 'add') {
      if (s.cheapByPct && s.cheapByDip) {
        reasons.push(`PE ${peNowStr} 滚动 ${wPct} 周分位 ${pctStr}%（≤${cPct}%），且距近 ${wDip} 周高点回撤 ${dipStr}%（≤-${dPct}%），双通道共振`);
      } else if (s.cheapByPct) {
        reasons.push(`PE ${peNowStr} 处于滚动 ${wPct} 周分位 ${pctStr}%（≤${cPct}%），相对近三年偏低`);
      } else if (s.cheapByDip) {
        reasons.push(`PE ${peNowStr} 距近 ${wDip} 周高点回撤 ${dipStr}%（≤-${dPct}%），估值回撤到位`);
      }
    } else if (gate !== 'block') {
      if (s.peRollingPct == null && s.peDipLevel == null) {
        reasons.push('PE 历史序列缺失，滚动分位与回撤均不可算，按不动处理');
      } else {
        reasons.push(`PE ${peNowStr} 滚动 ${wPct} 周分位 ${pctStr}%（>${cPct}%）且距近 ${wDip} 周高点回撤 ${dipStr}%（>-${dPct}%），两条通道均未触发`);
      }
    }
  }

  matrix.yieldZone = yieldZone;
  matrix.maZone = maZone;
  matrix.devPct = devPct != null ? +devPct.toFixed(2) : null;
  matrix.ratio = ratio != null ? +ratio.toFixed(3) : null;
  matrix.dipReady = dipReady;
  matrix.drawdown = (s.drawdown != null) ? +(+s.drawdown).toFixed(2) : null;
  matrix.stopFall = s.stopFall === true;
  // ★2026-09-14 新增：动量因子的连续量（只写 matrix，不参与任何 action 判定，供评分层动量分 M 使用）
  matrix.stopRisePct = (s.stopRisePct != null && !isNaN(s.stopRisePct)) ? +(+s.stopRisePct).toFixed(2) : null;  // 低点抬高幅度(pp)
  matrix.maSpreadPct = (s.maSpreadPct != null && !isNaN(s.maSpreadPct)) ? +(+s.maSpreadPct).toFixed(2) : null;  // 双均线乖离(pp)
  matrix.ma120DevPct = (s.ma120DevPct != null && !isNaN(s.ma120DevPct)) ? +(+s.ma120DevPct).toFixed(2) : null;  // 现价 vs MA120 偏离(pp)
  matrix.goldenState = maZone === 'golden';
  matrix.cross = s.cross || null;
  matrix.gate = gate;
  matrix.pctZone = pctZone;
  matrix.peZone = peZone;
  matrix.erpZone = erpZone;
  matrix.trendWeak = s.trendWeak === true;
  matrix.trendGrade = s.trendGrade || null;
  matrix.pricePercentile = (s.pricePercentile != null && !isNaN(s.pricePercentile)) ? +(+s.pricePercentile).toFixed(2) : null;
  matrix.recent20dChange = (s.recent20dChange != null) ? +(+s.recent20dChange).toFixed(2) : null;
  matrix.surge = surge;
  // 综合分连续化（2026-09-09 方案 A「相对尺」）所需原始连续量：综合分不再读切好的三档 zone，
  // 而是拿这些原始值自己在「贵线→便宜线」之间归一化（与 core.js/gold.js/dividend.js 同源，避免口径漂移）。
  matrix.pePercentile = (s.pePercentile != null && !isNaN(s.pePercentile)) ? +(+s.pePercentile).toFixed(2) : null;
  matrix.erp = (s.erp != null && !isNaN(s.erp)) ? +(+s.erp).toFixed(6) : null;          // 小数，如 0.045 = 4.5%
  matrix.yield = (s.yield != null && !isNaN(s.yield)) ? +(+s.yield).toFixed(6) : null; // 基金股息率（小数）
  matrix.cheapYield = (p.cheapYield != null && !isNaN(p.cheapYield)) ? +(+p.cheapYield).toFixed(6) : null;
  matrix.expensiveYield = (p.expensiveYield != null && !isNaN(p.expensiveYield)) ? +(+p.expensiveYield).toFixed(6) : null;
  // ★2026-09-17 新增（只增不改，纯展示）：000922 动态参考股息率（小数）。absYield 口径下
  // 便宜线/贵线 = 参考值 × cheapMult/expensiveMult，展示层需原值才能说明「带是怎么算出来的」。
  matrix.refYield = (s.refYield != null && !isNaN(s.refYield)) ? +(+s.refYield).toFixed(6) : null;
  {
    const cPct = (p.cheapPct != null) ? p.cheapPct : 25;
    const ePct = (p.expensivePct != null) ? p.expensivePct : 80;
    matrix.pe = (s.pe != null && !isNaN(s.pe)) ? +(+s.pe).toFixed(2) : null;
    matrix.peRollingPct = (s.peRollingPct != null && !isNaN(s.peRollingPct)) ? +(+s.peRollingPct).toFixed(2) : null;
    matrix.peDipLevel = (s.peDipLevel != null && !isNaN(s.peDipLevel)) ? +(+s.peDipLevel).toFixed(2) : null;
    matrix.peDipPct = (p.peDipPct != null) ? p.peDipPct : 12;   // 与 config.peDipPct 对齐
    matrix.peDipWindowWeeks = (p.peDipWindowWeeks != null) ? p.peDipWindowWeeks : 52;
    matrix.peWindowWeeks = (p.peWindowWeeks != null) ? p.peWindowWeeks : 156;
    matrix.cheapByPct = s.cheapByPct === true;
    matrix.cheapByDip = s.cheapByDip === true;
    matrix.cheap = s.cheap === true;
    matrix.peZone = (s.peRollingPct == null) ? 'na'
      : (s.peRollingPct <= cPct ? 'cheap' : (s.peRollingPct >= ePct ? 'expensive' : 'neutral'));
    // ERP 区：**仅作展示 + 综合分副锚，不参与 action 判定**（见 plans §8.6）。
    // 必须用海外独立带（2.1/−1.5），不可回退 A 股默认 6.9/5.3——美债 ERP 结构性为负，
    // 套用 A 股带会把 erpZone 恒压成 low、综合分副锚永久饱和（`p0010 的坑）。
    const eHi = (p.erpHigh != null) ? p.erpHigh : null;
    const eLo = (p.erpLow != null) ? p.erpLow : null;
    matrix.erpZone = (eHi == null || eLo == null || s.erp == null || isNaN(s.erp)) ? 'na'
      : (s.erp * 100 >= eHi ? 'high' : (s.erp * 100 <= eLo ? 'low' : 'neutral'));
  }
  return { action, reasons, matrix, positionScore: null };
}
module.exports.buildSignalDecision = buildSignalDecision;

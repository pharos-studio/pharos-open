'use strict';
/*
 * 策略：宽基 · A股口径（broad / caliber=cn）
 * 适用范围：**除 SH000300 专线外的 A 股宽基指数基金**——中证500/1000/A500、创业板、科创50
 *   等都可以挂到这条线，不限于沪深300。★必须填对「跟踪指数(trackIndex)」：本线的估值锚
 *   就是该指数自己的 PE 分位与 ERP，填错或缺失会直接退化成「数据缺失·按不动处理」。
 *   海外宽基请改用 caliber=us；行业主题请用「主题·行业」线。
 * 指标、限制、矩阵与理由由本策略完整负责；配置由调用方传入。
 */
// Strategy-local matrix and reasons; no compatibility-kernel dependency.
const util = require('../../lib/util');

// broad 类（宽基，如沪深300）信号线：双锚（PE分位×ERP股债利差）+ 三重均线(MA60/120/250) → 本策略矩阵
// 锚1=PE分位(纵向比自己贵不贵)，锚2=ERP=1/PE−无风险利率(横向比债券划不划算)。双锚交叉成四象限。
function buildCoreDecision(fund, valuationMap, config) {
  const b = (config && config.signals && config.signals.broad) || {};
  const peG = (config && config.signals && config.signals.peGate) || {};
  const v = (valuationMap && valuationMap[fund.code]) || (fund && fund.valuation) || {};
  const hist = (fund && fund.history) || [];
  const nav = fund && fund.latestNav != null ? fund.latestNav : (hist[0] ? hist[0].nav : null);
  const pe = v.pe != null ? v.pe : null;
  const pePercentile = v.pePercentile != null ? v.pePercentile : null;
  // ERP 第二锚：1/PE − 无风险利率。中债口径唯一（analysis 自动抓取东方财富，挂在 v.treasury10y）；
  // 仅当抓取失败时回退 config.treasury10y 常量兜底。严禁美债FRED（中美利差倒挂失真）。
  const treasury10y = (v.treasury10y != null && v.treasury10y > 0)
    ? v.treasury10y
    : (config && config.treasury10y != null ? config.treasury10y : null);
  let erp = null;
  if (pe != null && pe > 0 && treasury10y != null && treasury10y > 0) {
    erp = 1 / pe - treasury10y;
  }
  // 三重均线（MA60/120/250 = 季/半年/年）
  const stopWindow = b.stopWindow || 20;
  const mas = (b.maWindows || [60, 120, 250]).map(w => util.computeMA(hist, w));
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
  // 止跌：近 stopWindow 日最低 > 前 stopWindow 日最低
  const navs = hist.map(h => h.nav).filter(n => !isNaN(n) && n > 0);
  let stopFall = false;
  if (navs.length >= stopWindow * 2) {
    const near = navs.slice(0, stopWindow);
    const prev = navs.slice(stopWindow, stopWindow * 2);
    stopFall = Math.min.apply(null, near) > Math.min.apply(null, prev);
  }
  // ★2026-09-14 新增：动量因子的连续化（只算不判，仅供评分层动量分 M 使用，不参与任何 add/hold 判定）
  //   把二值的 stopFall 变成「低点抬高幅度%」，与 stableLow 同窗口同方向（> 0 ⟺ stableLow === true）
  const stopRisePct = util.lowRaisePct(hist, stopWindow);
  // 趋势强弱：现价相对 MA120 的偏离%（0 分界 = trendWeak 的临界点）
  const ma120DevPct = util.maDevPct(hist, 120, nav);
  return buildSignalDecision({
    pePercentile,
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
    cheapBy: 'peErp',
    cheapPct: b.cheapPct != null ? b.cheapPct : 30,
    expensivePct: b.expensivePct != null ? b.expensivePct : 70,
    erpHigh: b.erpHigh != null ? b.erpHigh : 6.9,          // 原策略默认值（2026-09-09 校准）
    erpLow: b.erpLow != null ? b.erpLow : 5.3,
    stopWindow,
    peGatePct: peG.peGatePct != null ? peG.peGatePct : 85,
    surge20dPct: peG.surge20dPct != null ? peG.surge20dPct : 5
  });
}

module.exports = buildCoreDecision;


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
    // 双锚锚1：PE 分位（便宜/中性/贵）
    const cp = p.cheapPct != null ? p.cheapPct : 30;
    const ep = p.expensivePct != null ? p.expensivePct : 70;
    peZone = (s.pePercentile != null && !isNaN(s.pePercentile))
      ? (s.pePercentile <= cp ? 'cheap' : (s.pePercentile >= ep ? 'expensive' : 'neutral'))
      : 'na';
    // 双锚锚2：ERP = 1/PE − 无风险利率（高=股票相对债券划算）
    const erpHigh = p.erpHigh != null ? p.erpHigh : 6.9;   // 2026-09-09 实测校准：近5年 ERP p90
    const erpLow = p.erpLow != null ? p.erpLow : 5.3;      // 近5年 ERP p10（旧 4.5/2.5 近5年从未触发，已失效）
    erpZone = (s.erp != null && !isNaN(s.erp))
      ? (s.erp * 100 >= erpHigh ? 'high' : (s.erp * 100 <= erpLow ? 'low' : 'neutral'))
      : 'na';
  }

  // ② 本策略趋势及兼容展示字段
  let maZone = 'na';
  let devPct = null;
  let ma = null;
  {
    // 趋势维度：trendWeak(现价<MA120) 由调用方算好传入 → below/above；null 表示历史不足
    maZone = s.trendWeak == null ? 'na' : (s.trendWeak ? 'below' : 'above');
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
    // 宽基双锚：PE分位主线 × ERP第二确认
    if (peZone === 'cheap') {
      action = 'add'; // 便宜主线优先（ERP低时理由标谨慎）
    } else if (peZone === 'expensive') {
      action = 'hold'; // 贵：ERP高→"不是真贵"，ERP低→"真贵不买"，均 hold，理由区分
    } else { // neutral
      if (erpZone === 'high') action = 'hold'; // 持有不追
      else if (erpZone === 'low') action = (s.trendWeak === true && s.stopFall === true) ? 'add' : 'hold'; // 谨慎：需跌破MA120+止跌
      else action = 'hold';
    }
  }

  // 理由文案（尽力解释触发路径）
  const anchorPct = (s.anchor3y != null ? s.anchor3y : p.anchor3yFallback) || 0;
  const anchorPctStr = (anchorPct * 100).toFixed(2);
  const yieldPctStr = s.yield != null ? (s.yield * 100).toFixed(2) : '?';
  {
    const gradeTxt = s.trendGrade || '';
    const bondName = p.bondName || '债券';   // A股默认「债券」（文案逐字不变）；海外宽基传「美债」
    const peStr = (s.pePercentile != null && !isNaN(s.pePercentile)) ? s.pePercentile.toFixed(0) : '?';
    const erpStr = (s.erp != null && !isNaN(s.erp)) ? (s.erp * 100).toFixed(2) : '?';
    if (action === 'add') {
      if (peZone === 'cheap' && erpZone !== 'low') {
        reasons.push(`PE 分位 ${peStr}%（便宜区 ≤${p.cheapPct}%）且 ERP ${erpStr}%（≥${p.erpHigh}%，股票相对${bondName}划算），双锚共振强买`);
      } else if (peZone === 'cheap' && erpZone === 'low') {
        reasons.push(`PE 分位 ${peStr}%（便宜区）但 ERP ${erpStr}% 偏低（利率偏高/${bondName}更香），谨慎买入`);
      } else if (peZone === 'neutral' && erpZone === 'low' && s.trendWeak === true && s.stopFall === true) {
        reasons.push(`PE 分位 ${peStr}% 中性、ERP ${erpStr}% 偏低，但净值跌破半年线（${gradeTxt}）且近${p.stopWindow || 20}日已止跌，谨慎机会区`);
      }
    } else {
      if (gate !== 'block') {
        if (peZone === 'expensive' && erpZone === 'high') {
          reasons.push(`PE 分位 ${peStr}%（贵区 ≥${p.expensivePct}%）但 ERP ${erpStr}% 偏高，利率低撑着估值，非真贵·持有不追`);
        } else if (peZone === 'expensive' && erpZone === 'low') {
          reasons.push(`PE 分位 ${peStr}%（贵区）且 ERP ${erpStr}% 偏低（${bondName}更划算），真贵·不买`);
        } else if (peZone === 'expensive') {
          reasons.push(`PE 分位 ${peStr}%（贵区），防高位接盘`);
        } else if (peZone === 'neutral' && erpZone === 'high') {
          reasons.push(`PE 分位 ${peStr}% 中性、ERP ${erpStr}% 偏高，持有不追`);
        } else if (peZone === 'neutral' && surge) {
          reasons.push(`PE 分位 ${peStr}% 中性，但近20日涨 ${(s.recent20dChange || 0).toFixed(1)}% 急涨（> ${p.surge20dPct}%），总闸强拦不追尖`);
        } else if (peZone === 'neutral' && s.trendWeak !== true) {
          reasons.push(`PE 分位 ${peStr}% 中性，未跌破半年线（${gradeTxt}），无加仓信号`);
        } else if (peZone === 'neutral') {
          reasons.push(`PE 分位 ${peStr}% 中性且跌破半年线，但近${p.stopWindow || 20}日未止跌，等止跌确认再加仓`);
        } else if (peZone === 'na') {
          reasons.push('PE 分位数据缺失，按不动处理');
        }
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
  return { action, reasons, matrix, positionScore: null };
}
module.exports.buildSignalDecision = buildSignalDecision;

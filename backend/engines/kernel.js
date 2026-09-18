'use strict';
/*
 * 决策信号内核（唯一真相源，供 strategies/* 复用；本文件 = 链路骨架 + 契约 + 共享拍板）。
 * 职责边界：只承载四步判定流水线的「骨架」——
 *   ① 便宜判定 → ② 趋势 → ③ 总闸 → ④ 决策矩阵 的固定顺序 + 信号契约 + 输出标准化。
 * 各策略的专属判定规则（含矩阵差异）在 strategies/*.js 中声明/定制，阶段二可直接在策略文件内改矩阵。
 * buildFundDecision 按 params.cheapBy 切换信号源：
 *   'yield'(红利旧锚) | 'techDip'(科技) | 'pricePercentile'(黄金/对冲) | 'peErp'(宽基双锚 PE分位×ERP) | 'absYield'(红利股息率带)
 */
const store = require('../lib/store');
const util = require('../lib/util');

// ---------- 通用决策信号引擎 ----------
// signalSource 约定：
//   { yield: 当前股息率(小数,如0.0443), anchor3y: 3年滚动均值(小数) 或 null→用 params.anchor3yFallback,
//     nav: 当前净值, ma250: 250日均线(或传 history 由引擎自算), pePercentile: 0-100, recent20dChange: %,
//     drawdown, stopFall, goldenState, cross, pricePercentile, trendWeak, trendGrade }
function buildFundDecision(signalSource, params) {
  const p = params || {};
  const cheapRatio = p.cheapRatio != null ? p.cheapRatio : 1.05;
  const expensiveRatio = p.expensiveRatio != null ? p.expensiveRatio : 0.90;
  const peGatePct = p.peGatePct != null ? p.peGatePct : 85;
  const surge20dPct = p.surge20dPct != null ? p.surge20dPct : 5;
  const s = signalSource || {};
  const reasons = [];
  const matrix = {};

  const cheapBy = p.cheapBy || 'yield'; // 'yield'(红利) | 'techDip'(科技) | 'pricePercentile'(黄金) | 'peErp'(宽基双锚)
  // ① 便宜主线：按 cheapBy 选择判定口径
  let yieldZone = 'na';
  let ratio = null;
  let dipReady = false; // 科技专用：回撤到位+止跌
  let pctZone = 'na';   // 黄金专用：价格分位区（便宜/中性/贵）
  let peZone = 'na';    // 宽基双锚：PE 分位区
  let erpZone = 'na';   // 宽基双锚：ERP 区（高=股票划算）
  if (cheapBy === 'techDip') {
    // 便宜 = 60日回撤≤-dipPct% 且止跌（stopFall 由调用方算好）
    const dd = (s.drawdown != null) ? s.drawdown : null;
    const dipPct = p.dipPct != null ? p.dipPct : 15;
    dipReady = (dd != null && dd <= -dipPct && s.stopFall === true);
  } else if (cheapBy === 'pricePercentile') {
    // 便宜 = 250日价格分位 ≤cheapPct 便宜 / ≥expensivePct 贵 / 中间中性
    const cp = p.cheapPct != null ? p.cheapPct : 35;
    const ep = p.expensivePct != null ? p.expensivePct : 75;
    pctZone = (s.pricePercentile != null && !isNaN(s.pricePercentile))
      ? (s.pricePercentile <= cp ? 'cheap' : (s.pricePercentile >= ep ? 'expensive' : 'neutral'))
      : 'na';
  } else if (cheapBy === 'peErp') {
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
  } else if (cheapBy === 'absYield') {
    // 绝对股息率带：相对参考股息率(中证红利000922动态)的高/低判定便宜/贵
    const cy = p.cheapYield != null ? p.cheapYield : 0.045;
    const ey = p.expensiveYield != null ? p.expensiveYield : 0.035;
    if (s.yield != null && s.yield > 0) {
      yieldZone = s.yield >= cy ? 'cheap' : (s.yield <= ey ? 'expensive' : 'neutral');
      ratio = (s.refYield != null && s.refYield > 0) ? +(s.yield / s.refYield).toFixed(3) : null;
    } else {
      yieldZone = 'na';
    }
  } else {
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

  // ② 趋势维度：红利用 MA250 偏离；科技用双均线金叉状态；黄金用三重均线位置
  let maZone = 'na';
  let devPct = null;
  let ma = null;
  if (cheapBy === 'techDip') {
    // 金叉状态：MA20 > MA60（goldenState 由调用方算好）
    maZone = s.goldenState === true ? 'golden' : (s.goldenState === false ? 'dead' : 'na');
  } else if (cheapBy === 'pricePercentile' || cheapBy === 'peErp') {
    // 趋势维度：trendWeak(现价<MA120) 由调用方算好传入 → below/above；null 表示历史不足
    maZone = s.trendWeak == null ? 'na' : (s.trendWeak ? 'below' : 'above');
  } else {
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
  if (cheapBy === 'pricePercentile' && (s.recent20dChange || 0) > surge20dPct) surge = true;

  // 决策矩阵（二档）；PE 总闸命中 → 强制不动
  let action = 'hold';
  if (gate === 'block') {
    action = 'hold';
  } else if (cheapBy === 'techDip') {
    // 科技：两条买入通道任一满足即加仓
    if (dipReady || maZone === 'golden') action = 'add';
    else action = 'hold';
  } else if (cheapBy === 'pricePercentile') {
    // 黄金：便宜即买；贵不买；中性需 跌破半年线(趋势弱) ∧ 已止跌 才加仓；中性急涨强拦
    if (pctZone === 'cheap') {
      action = 'add';
    } else if (pctZone === 'expensive') {
      action = 'hold';
    } else { // neutral
      if (surge) action = 'hold';
      else if (s.trendWeak === true && s.stopFall === true) action = 'add';
      else action = 'hold';
    }
  } else if (cheapBy === 'peErp') {
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
  } else if (cheapBy === 'broadGlobal') {
    // 宽基·海外：两通道并联，任一成立即加仓
    //   ① 估值通道：PE 在滚动 N 周窗口内分位 ≤ cheapPct（自适应水位台阶）
    //   ② 回撤通道：PE 距近 M 周高点回撤 ≤ -peDipPct（★不要求止跌——加了反而降低信号质量，见 §8.6）
    // 实测并联覆盖 2018-12 / 2020-03 / 2022-12 / 2025-04 全部四个关键买点。
    action = (s.cheap === true) ? 'add' : 'hold';
  } else {
    if (yieldZone === 'cheap') {
      action = 'add'; // 便宜 → 不管趋势都加仓（股息率是主线，优先）
    } else if (yieldZone === 'neutral' && maZone === 'below') {
      action = 'add'; // 中性 → 只有跌破年线才加仓（趋势确认）
    } else {
      action = 'hold';
    }
  }

  // 理由文案（尽力解释触发路径）
  const anchorPct = (s.anchor3y != null ? s.anchor3y : p.anchor3yFallback) || 0;
  const anchorPctStr = (anchorPct * 100).toFixed(2);
  const yieldPctStr = s.yield != null ? (s.yield * 100).toFixed(2) : '?';
  if (cheapBy === 'techDip') {
    const ddStr = (s.drawdown != null) ? s.drawdown.toFixed(1) : '?';
    if (action === 'add') {
      if (dipReady && maZone === 'golden') {
        reasons.push(`回撤 ${ddStr}% 已到位（≤-${p.dipPct}%）且止跌，同时均线金叉（MA20 上穿 MA60）趋势修复，双通道共振`);
      } else if (dipReady) {
        reasons.push(`回撤 ${ddStr}% 已到位（≤-${p.dipPct}%）且止跌（近${p.stopWindow || 20}日低点抬升），深度回撤通道`);
      } else if (maZone === 'golden') {
        reasons.push(`均线金叉（MA20 上穿 MA60）趋势修复，上升路线买入`);
      }
    } else if (gate !== 'block') {
      const ddNum = (s.drawdown != null) ? s.drawdown : null;
      const deepButNoStop = ddNum != null && ddNum <= -(p.dipPct || 15) && s.stopFall !== true;
      if (maZone === 'dead' && deepButNoStop) {
        reasons.push(`回撤 ${ddStr}% 已深（≤-${p.dipPct}%）但近${p.stopWindow || 20}日未止跌，且均线死叉（MA20<MA60）趋势偏弱，等止跌确认`);
      } else if (maZone === 'dead') {
        reasons.push(`回撤 ${ddStr}% 未到位，且均线死叉（MA20 在 MA60 下方）趋势偏弱，等回撤到位+止跌`);
      } else if (deepButNoStop) {
        reasons.push(`回撤 ${ddStr}% 已深（≤-${p.dipPct}%）但近${p.stopWindow || 20}日未止跌，等止跌确认再加仓`);
      } else {
        reasons.push(`回撤 ${ddStr}% 未到位，且未出现金叉，无加仓信号`);
      }
    }
  } else if (cheapBy === 'pricePercentile') {
    const gradeTxt = s.trendGrade || '';
    const pctStr = (s.pricePercentile != null && !isNaN(s.pricePercentile)) ? s.pricePercentile.toFixed(0) : '?';
    if (action === 'add') {
      if (pctZone === 'cheap') {
        reasons.push(`250日价格分位 ${pctStr}% 处于便宜区（≤${p.cheapPct}%），均值回归买点`);
      } else if (pctZone === 'neutral' && s.trendWeak === true && s.stopFall === true) {
        reasons.push(`分位 ${pctStr}% 中性，但净值已跌破半年线（${gradeTxt}）且近${p.stopWindow || 20}日已止跌，机会区`);
      }
    } else {
      if (gate !== 'block') {
        if (pctZone === 'expensive') {
          reasons.push(`250日价格分位 ${pctStr}% 处于贵区（≥${p.expensivePct}%），防高位接盘`);
        } else if (pctZone === 'neutral' && surge) {
          reasons.push(`分位 ${pctStr}% 中性，但近20日涨 ${(s.recent20dChange || 0).toFixed(1)}% 急涨（> ${p.surge20dPct}%），总闸强拦不追尖`);
        } else if (pctZone === 'neutral' && s.trendWeak !== true) {
          reasons.push(`分位 ${pctStr}% 中性，未跌破半年线（${gradeTxt}），无加仓信号`);
        } else if (pctZone === 'neutral' && s.stopFall !== true) {
          reasons.push(`分位 ${pctStr}% 中性且跌破半年线，但近${p.stopWindow || 20}日未止跌，等止跌确认再加仓`);
        } else if (pctZone === 'na') {
          reasons.push('价格分位数据缺失，按不动处理');
        }
      }
    }
  } else if (cheapBy === 'peErp') {
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
  } else if (cheapBy === 'broadGlobal') {
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
  } else if (cheapBy === 'absYield') {
    const cyPct = (p.cheapYield != null ? p.cheapYield : 0.045) * 100;
    const eyPct = (p.expensiveYield != null ? p.expensiveYield : 0.035) * 100;
    const refPct = (s.refYield != null ? s.refYield : 0) * 100;
    if (action === 'add') {
      if (yieldZone === 'cheap') {
        reasons.push(`股息率 ${yieldPctStr}% 高于便宜线 ${cyPct.toFixed(2)}%（相对中证红利000922动态参考 ${refPct.toFixed(2)}%，便宜区），红利资产低估`);
      } else if (yieldZone === 'neutral' && maZone === 'below') {
        // ★2026-09-17 补：action 由上方 else 分支的「中性 + 跌破年线」通道给出（本函数唯一一条
        // 非 cheap 的加仓路径），但理由文案此前只覆盖 cheap 一条路径 → 会出现「加仓」却零解释。
        // 参考带/000922 参考值已在决策卡的结构化摘要里，此处改报「距便宜线还差多少」——更可执行，且不重复。
        reasons.push(`股息率 ${yieldPctStr}% 中性、距便宜线还差 ${(cyPct - s.yield * 100).toFixed(2)}pp，但净值 ${s.nav != null ? s.nav.toFixed(4) : '?'} 已跌破 250 日线（偏离 ${devPct != null ? devPct.toFixed(2) + '%' : '?'}），趋势确认通道加仓`);
      }
    } else {
      if (gate !== 'block') {
        if (yieldZone === 'expensive') {
          reasons.push(`股息率 ${yieldPctStr}% 低于贵线 ${eyPct.toFixed(2)}%（参考带 ${eyPct.toFixed(2)}~${cyPct.toFixed(2)}%），偏贵防高位接盘`);
        } else if (yieldZone === 'neutral') {
          reasons.push(`股息率 ${yieldPctStr}% 中性（参考带 ${eyPct.toFixed(2)}~${cyPct.toFixed(2)}%，000922参考 ${refPct.toFixed(2)}%），无加仓信号`);
        } else if (yieldZone === 'na') {
          reasons.push('股息率数据缺失，按不动处理');
        }
      }
    }
  } else {
    if (action === 'add') {
      if (yieldZone === 'cheap') {
        reasons.push(`股息率 ${yieldPctStr}% 高于 3 年均值锚 ${anchorPctStr}%（ratio ${ratio.toFixed(2)}，便宜区）`);
      } else if (yieldZone === 'neutral' && maZone === 'below') {
        reasons.push(`股息率中性（ratio ${ratio.toFixed(2)}），但净值 ${s.nav.toFixed(4)} 已跌破 250 日线 ${ma != null ? ma.toFixed(4) : '?'}（偏离 ${devPct != null ? devPct.toFixed(2) + '%' : '?'}），机会区`);
      }
    } else {
      if (s.anchorUnstable) {
        reasons.push('股息率锚未稳定（自建序列不足年限），暂用保守常量锚，结论偏保守、仅供参考');
      }
      if (gate !== 'block') {
        if (yieldZone === 'expensive') {
          reasons.push(`股息率 ${yieldPctStr}% 低于 3 年均值锚 ${anchorPctStr}%（ratio ${ratio.toFixed(2)}，贵区，防高位接盘）`);
        } else if (yieldZone === 'neutral' && maZone === 'na') {
          reasons.push(`股息率中性（ratio ${ratio.toFixed(2)}），250 日线数据不足（历史不足 ${p.windowDays || 250} 个交易日），按不动处理`);
        } else if (yieldZone === 'neutral') {
          reasons.push(`股息率中性（ratio ${ratio.toFixed(2)}）且净值 ${maZone === 'above' ? '站上' : '贴近'} 250 日线，无加仓信号`);
        } else if (yieldZone === 'na') {
          reasons.push('股息率数据缺失，按不动处理（可人工核对蛋卷 yeild）');
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
  // 宽基·海外（cheapBy='broadGlobal'）专属字段：两通道的连续量与命中标志
  // ★pePercentile（蛋卷固定约10年分位，上方已赋值）继续保留作**对照展示**，不参与判定；
  //   判定与综合分主锚一律用 peRollingPct（自算滚动分位）——固定分位遇水位台阶会长期失效（见 plans §8.6）。
  if (cheapBy === 'broadGlobal') {
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

// 股息率 3 年滚动均值锚：优先用自建历史序列（data/series/yield_history.json）。
// 支持「按基金 code 分桶」存储：新结构 { code: { 日期: yield小数 } }；旧平面结构 { 日期: 值 } 自动视作 code='008163' 迁移。
// 积累 ≥windowYears 年后按日滚动求均值；不足则回退 config 常量 anchor3yFallback。
// 返回 { anchor, anchored }：anchored=false 表示自建序列不足年限，暂用保守常量锚（结论偏保守、仅供参考）
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

module.exports = { buildFundDecision, loadYieldAnchor3y };

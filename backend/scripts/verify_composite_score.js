'use strict';
/*
 * 综合分纯函数回归测试（2026-09-09 方案 A「相对尺」连续化；2026-09-14 起覆盖 V 估值分 / M 动量分 / 综合分）。
 * 不依赖网络、不依赖行情，直接给 synthesizePositionScore 喂构造好的 matrix。
 * 用途：改 config.json 阈值（如 broad.erpHigh/erpLow）或改 V/M/综合分公式后，跑一遍确认没跑偏。
 * 用法：node backend/scripts/verify_composite_score.js
 */
const config = require('../lib/config');
const {
  synthesizePositionScore, synthesizeValueScore, synthesizeMomentumScore,
  synthesizeCompositeScore, legacyPositionScore, relScale
} = require('../engines/alloc/allocation');

const cfg = config.getConfig();
// ★ 缺 data/config/config.json 时 config.getConfig() 会**静默**返回 {}，下面取 s.broad.cheapPct
//   就会直接崩栈（一屏 stack trace，看不出是「没跑 setup」）。这里提前拦成一句人话。
//   为什么不用默认值兜底：本脚本拿真实阈值当对照基准，阈值不同期望值就不同 ——
//   兜底 = 测了个无关的配置还报绿，是本项目最忌讳的「静默算错」。
if (!cfg.signals || !cfg.signals.broad || !cfg.signals.gold) {
  console.log('');
  console.log('⚠ 读不到 data/config/config.json 里的 signals.broad / signals.gold 阈值。');
  console.log('  本脚本用真实阈值当对照基准，缺了它就没法验。');
  console.log('  请先运行：npm run setup      （Windows 也可双击 setup.bat）');
  console.log('');
  process.exit(1);
}
const s = cfg.signals || {};
const a = s.allocation || {};
const bg = s.broadGlobal || {};              // 宽基·海外（caliber='us'）决策层参数带
const abg = a.broadGlobal || {};
const cp = a.composite || {};                // 2026-09-14 综合分（V/M 按派别加权）
const cpm = cp.momentum || {};
const AC = {
  neutralP: a.neutralP != null ? a.neutralP : 0.5,
  tech: a.tech || {},
  broad: {
    cheapPct: s.broad.cheapPct, expensivePct: s.broad.expensivePct,
    erpHigh: s.broad.erpHigh, erpLow: s.broad.erpLow,
    wMain: (a.broad && a.broad.wMain) != null ? a.broad.wMain : 0.7
  },
  // 宽基·海外：独立阈值带（★ERP 阈值 2.1/−1.5，绝不能沿用 A 股 6.9/5.3）
  broadUS: {
    cheapPct: bg.cheapPct != null ? bg.cheapPct : 25,
    expensivePct: bg.expensivePct != null ? bg.expensivePct : 80,
    erpHigh: bg.erpHigh != null ? bg.erpHigh : 2.1,
    erpLow: bg.erpLow != null ? bg.erpLow : -1.5,
    wMain: abg.wMain != null ? abg.wMain : 0.7
  },
  gold: { cheapPct: s.gold.cheapPct, expensivePct: s.gold.expensivePct },
  // 2026-09-14 综合分配置（与 allocation.js getAllocCfg 同款读法，保证口径一致）
  composite: {
    hardBlock: {
      gate: (cp.hardBlock && cp.hardBlock.gate === false) ? false : true,
      suspended: (cp.hardBlock && cp.hardBlock.suspended === false) ? false : true
    },
    wDip: cp.wDip != null ? cp.wDip : 0.1,
    weights: cp.weights || {
      dividend: { wV: 0.9, wM: 0.1 }, broad: { wV: 0.8, wM: 0.2 },
      broadUS: { wV: 0.8, wM: 0.2 }, cycle: { wV: 0.6, wM: 0.4 }, tech: { wV: 0.5, wM: 0.5 }
    },
    momentumWeights: cp.momentumWeights || {
      tech: { cross: 0.6, stopRise: 0.4, trend: 0 }, broad: { cross: 0, stopRise: 0.5, trend: 0.5 },
      broadUS: { cross: 0, stopRise: 0.5, trend: 0.5 }, cycle: { cross: 0, stopRise: 0.5, trend: 0.5 },
      dividend: { cross: 0, stopRise: 0, trend: 1 }
    },
    momentum: {   // 单位统一 pp；初始值，待 backtest_composite_weights.js 标定后覆盖
      crossFullPct: cpm.crossFullPct != null ? cpm.crossFullPct : 5,
      crossZeroPct: cpm.crossZeroPct != null ? cpm.crossZeroPct : -5,
      stopRiseFullPct: cpm.stopRiseFullPct != null ? cpm.stopRiseFullPct : 3,
      trendDevFullPct: cpm.trendDevFullPct != null ? cpm.trendDevFullPct : 10,
      divDevFullPct: cpm.divDevFullPct != null ? cpm.divDevFullPct : 8,
      dipFullPct: cpm.dipFullPct != null ? cpm.dipFullPct : 10,
      divDipFullPct: cpm.divDipFullPct != null ? cpm.divDipFullPct : 3
    }
  }
};
console.log('AC =', JSON.stringify(AC));

let pass = 0, fail = 0;
function t(name, got, want, tol) {
  tol = tol == null ? 0.05 : tol;
  const ok = Math.abs(got - want) <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | got=${got} want=${want}`);
  ok ? pass++ : fail++;
}
// 严格 null 断言（t() 走 Math.abs，对 null 会得 NaN，故单列）
function tn(name, got) {
  const ok = got === null;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | got=${got} want=null`);
  ok ? pass++ : fail++;
}
// caliber 为第 4 参（不传 = A 股口径，向后兼容）
// 综合分（= 估值分 V 与动量分 M 的加权）
const sc = (m, by, cal, suspended) => {
  const r = synthesizeCompositeScore({ matrix: m }, AC, by, cal, { suspended: !!suspended });
  return r.composite == null ? null : +r.composite.toFixed(2);
};
// V 估值分（剥离动量补丁后；不含动量字段的用例 ⇒ 与旧位置分逐点相等）
const scV = (m, by, cal) => {
  const v = synthesizeValueScore({ matrix: m }, AC, by, cal);
  return v == null ? null : +v.toFixed(2);
};
// M 动量分（连续化；全因子缺失 ⇒ null）
const scM = (m, by, cal) => {
  const v = synthesizeMomentumScore({ matrix: m }, AC, by, cal);
  return v == null ? null : +v.toFixed(2);
};
// 冻结的旧位置分（含 ±0.1 / ×0.3 二值补丁，用于证明旧逻辑没被改坏）
const scL = (m, by, cal) => +legacyPositionScore({ matrix: m }, AC, by, cal).toFixed(2);
// 字符串/布尔严格相等断言（t() 走 Math.abs，对字符串会得 NaN，故单列）
function ts(name, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | got=${got} want=${want}`);
  ok ? pass++ : fail++;
}

console.log('\n--- relScale 单元 ---');
t('relScale 中点 50 @25/80', relScale(50, 25, 80), 0.5455, 0.001);
t('relScale 便宜端 25', relScale(25, 25, 80), 1);
t('relScale 贵端 80', relScale(80, 25, 80), 0);
t('relScale 越界 90 → clamp 0', relScale(90, 25, 80), 0);
t('relScale 越界 10 → clamp 1', relScale(10, 25, 80), 1);
t('relScale 负 span(股息率) 便宜端', relScale(0.055, 0.055, 0.038), 1);
t('relScale 负 span(股息率) 贵端', relScale(0.038, 0.055, 0.038), 0);
// null 用例单独断言（不能走数值比较）
console.log('  ' + (relScale(null, 25, 80) === null ? 'PASS | relScale(null) === null' : 'FAIL | relScale(null)'));
console.log('  ' + (relScale(50, 25, 25) === null ? 'PASS | relScale(span=0) === null' : 'FAIL | relScale(span=0)'));

console.log('\n--- broad 线（PE分位 25/80 主锚 0.7 + ERP 6.9/5.3 副锚 0.3）---');
t('双锚都到便宜端 → 100', scV({ pePercentile: 25, erp: 0.069 }, 'broad'), 100);
t('双锚都到贵端 → 0', scV({ pePercentile: 80, erp: 0.053 }, 'broad'), 0);
t('ERP 量纲实测值 PE分位76.7 ERP6.07% → 3.5', scV({ pePercentile: 76.7, erp: 0.0607 }, 'broad'), 3.47);
t('同上 + 跌破连续化(ma120Dev−10) → V（★dipBonus 与旧 +0.1 逐点等价）', scV({ pePercentile: 76.7, erp: 0.0607, ma120DevPct: -10, stopRisePct: 3 }, 'broad'), 8.2);
t('同上 → M（跌破−10 ⇒ trend=0；止跌+3 ⇒ stop=1）', scM({ ma120DevPct: -10, stopRisePct: 3 }, 'broad'), 25);
t('同上 → 综合分', sc({ pePercentile: 76.7, erp: 0.0607, ma120DevPct: -10, stopRisePct: 3 }, 'broad'), 11.56);
t('贵端垫底(main=0,sub=1) → 9（非0，设计内）', scV({ pePercentile: 80, erp: 0.069 }, 'broad'), 9);
tn('PE 分位缺失（主锚 null）→ V 为 null（★不降级副锚撑 100）', scV({ erp: 0.075 }, 'broad'));
t('PE 分位缺失 → 综合分 25 兜底不撑 100', sc({ erp: 0.075 }, 'broad'), 25);
tn('全缺失 → V 为 null（★不冒充中性）', scV({}, 'broad'));
t('全缺失 → 综合分 25 兜底', sc({}, 'broad'), 25);
t('gate=block → 综合分 0（硬约束一票否决）', sc({ gate: 'block', pePercentile: 25, erp: 0.069 }, 'broad'), 0);
// ERP「越大越便宜」：7.76% 已上穿便宜线 6.9 → 副锚 clamp 1（便宜端），不是 0
t('ERP 极便宜 7.76% + PE 中性 → 38.2', scV({ pePercentile: 55, erp: 0.0776 }, 'broad'), 38.21);
// ERP 4.70%（近5年 min）低于贵线 5.3 → 副锚 0
t('ERP 极贵 4.70% + PE 中性 → 10.1', scV({ pePercentile: 55, erp: 0.047 }, 'broad'), 10.12);
t('ERP 漏乘反例校验：0.0607 若当百分数入尺 =', relScale(0.0607, 6.9, 5.3), 0); // 证明漏乘会 clamp 成 0（我们已 ×100）

console.log('\n--- cycle 线（价格分位 35/75）---');
t('35 → 100', scV({ pricePercentile: 35 }, 'cycle'), 100);
t('75 → 0', scV({ pricePercentile: 75 }, 'cycle'), 0);
t('55 → 25', scV({ pricePercentile: 55 }, 'cycle'), 25);
t('55 + 跌破连续化 → V（★与旧 +0.1 等价）', scV({ pricePercentile: 55, ma120DevPct: -10, stopRisePct: 3 }, 'cycle'), 36.0, 0.2);
t('55 → M', scM({ ma120DevPct: -10, stopRisePct: 3 }, 'cycle'), 25);
t('55 → 综合分', sc({ pricePercentile: 55, ma120DevPct: -10, stopRisePct: 3 }, 'cycle'), 31.6);
tn('缺失 → V 为 null', scV({}, 'cycle'));
t('缺失 → 综合分 25 兜底', sc({}, 'cycle'), 25);

console.log('\n--- dividend 线（股息率负 span）---');
t('到便宜线 → 100', scV({ yield: 0.055, cheapYield: 0.055, expensiveYield: 0.038 }, 'dividend'), 100);
t('到贵线 → 0', scV({ yield: 0.038, cheapYield: 0.055, expensiveYield: 0.038 }, 'dividend'), 0);
t('yield 0.05 → 49.8', scV({ yield: 0.05, cheapYield: 0.055, expensiveYield: 0.038 }, 'dividend'), 49.8, 0.3);
t('yield 0.05 + 跌破年线(devPct −3 连续化) → V', scV({ yield: 0.05, cheapYield: 0.055, expensiveYield: 0.038, devPct: -3 }, 'dividend'), 64.94, 0.5);
t('同上 → M（divDevFullPct=8）', scM({ devPct: -3 }, 'dividend'), 9.77);
t('同上 → 综合分', sc({ yield: 0.05, cheapYield: 0.055, expensiveYield: 0.038, devPct: -3 }, 'dividend'), 59.43);
tn('缺失 → V 为 null', scV({ cheapYield: 0.055, expensiveYield: 0.038 }, 'dividend'));
t('缺失 → 综合分 25 兜底', sc({ cheapYield: 0.055, expensiveYield: 0.038 }, 'dividend'), 25);

console.log('\n--- tech 线（不应变化，回归基线）---');
t('回撤-30 分位20 止跌 → 88.4', scV({ drawdown: -30, pricePercentile: 20, stopFall: true }, 'tech'), 88.36, 0.3);
t('未止跌 → V **不再 ×0.3**（★撕裂修复：旧 7.95 ⇒ 88.36）', scV({ drawdown: -30, pricePercentile: 20 }, 'tech'), 88.36, 0.3);
t('未止跌 → M(stopRise=0)', scM({ maSpreadPct: 0, stopRisePct: 0 }, 'tech'), 9);
t('未止跌 → 综合分', sc({ drawdown: -30, pricePercentile: 20, maSpreadPct: 0, stopRisePct: 0 }, 'tech'), 48.68);
t('金叉 → V 不含金叉（金叉已移至 M）', scV({ drawdown: -30, pricePercentile: 20 }, 'tech'), 88.36, 0.5);
t('金叉 → M(maSpread=+5 满标)', scM({ maSpreadPct: 5 }, 'tech'), 100, 0.5);
t('金叉 → 综合分', sc({ drawdown: -30, pricePercentile: 20, maSpreadPct: 5 }, 'tech'), 94.18);
tn('无数据 → V 为 null', scV({}, 'tech'));
t('无数据 → 综合分 25 兜底', sc({}, 'tech'), 25);

console.log('\n--- broad_us 线（宽基·海外，caliber=us；阈值 25/80 + ERP 2.1/-1.5）---');
t('双锚齐便宜 → 100', scV({ peRollingPct: 25, erp: 0.021 }, 'broad', 'us'), 100);
t('双锚齐贵 → 0', scV({ peRollingPct: 80, erp: -0.015 }, 'broad', 'us'), 0);
t('当前实测态（滚动分位46.72 + ERP-1.64%）→ 17.94', scV({ peRollingPct: 46.72, erp: -0.0164 }, 'broad', 'us'), 17.94);
t('同上 + 跌破连续化 → V（★与旧 +0.1 等价）', scV({ peRollingPct: 46.72, erp: -0.0164, ma120DevPct: -10, stopRisePct: 3 }, 'broad', 'us'), 27.41);
t('同上 → M', scM({ ma120DevPct: -10, stopRisePct: 3 }, 'broad', 'us'), 25);
t('同上 → 综合分', sc({ peRollingPct: 46.72, erp: -0.0164, ma120DevPct: -10, stopRisePct: 3 }, 'broad', 'us'), 26.93);
t('便宜态（滚动分位20 + ERP-1.16%）→ 53.05', scV({ peRollingPct: 20, erp: -0.0116 }, 'broad', 'us'), 53.05);
t('低估态（滚动分位33.25 + ERP2.11%）→ 80.10', scV({ peRollingPct: 33.25, erp: 0.0211 }, 'broad', 'us'), 80.10);
t('贵端垫底（main=0/sub=1）→ 9.0（设计内，非 0）', scV({ peRollingPct: 80, erp: 0.021 }, 'broad', 'us'), 9.0);
tn('主锚缺失（不降级副锚）→ V 为 null', scV({ erp: 0.021 }, 'broad', 'us'));
t('主锚缺失 → 综合分 25 兜底', sc({ erp: 0.021 }, 'broad', 'us'), 25);
t('副锚缺失（erp=null）→ 降级单锚 main=100', scV({ peRollingPct: 25 }, 'broad', 'us'), 100);
tn('全缺失 → V 为 null', scV({}, 'broad', 'us'));
t('全缺失 → 综合分 25 兜底', sc({}, 'broad', 'us'), 25);
t('gate=block → 综合分 0（硬约束一票否决）', sc({ gate: 'block', peRollingPct: 25, erp: 0.021 }, 'broad', 'us'), 0);

console.log('\n--- ★口径隔离（同一数值，两条口径必须给出不同结论）---');
// 台阶场景：滚动分位 30（便宜）vs 同一数值当固定分位 71（贵）——若两口径误串，这两条会相等
t('us 口径 滚动分位30 → 82.64', scV({ peRollingPct: 30 }, 'broad', 'us'), 82.64);
t('cn 口径 固定分位71 → 2.68', scV({ pePercentile: 71 }, 'broad', 'cn'), 2.68);
// 回归防线：低估态下，正确阈值 80.10 vs 误用 A 股 ERP 阈值 35.40（差 45 分 = 结论级差异）
t('低估态 us 口径（ERP2.11% 用 2.1/-1.5 带）→ 80.10', scV({ peRollingPct: 33.25, erp: 0.0211 }, 'broad', 'us'), 80.10);
t('同行情 cn 口径（ERP2.11% 落到 6.9/5.3 带）→ 35.40', scV({ pePercentile: 33.25, erp: 0.0211 }, 'broad', 'cn'), 35.40);
t('★错误阈值反例：relScale(-1.64, 6.9, 5.3) 必须为 0', relScale(-1.64, 6.9, 5.3), 0);
t('正确阈值：relScale(-1.64, 2.1, -1.5) = 0（下限外，符合预期）', relScale(-1.64, 2.1, -1.5), 0);
t('正确阈值：relScale(0, 2.1, -1.5) = 0.4167（中性区可分辨）', relScale(0, 2.1, -1.5), 0.4167, 0.001);

console.log('\n--- rollingPercentile / peDrawdownLevel（策略侧判定用）---');
const util = require('../lib/util');
// 台阶场景：老年代 144 个 22（水位低）+ 新年代 156 个 35/37（水位高），末值 35
const stair = [].concat(Array(144).fill(22), Array(156).fill(0).map((_, i) => (i % 2 === 0 ? 37 : 35)));
t('滚动156周分位：末值35 → 0（窗口内无更低值）', +util.rollingPercentile(stair, 156).toFixed(2), 0);
t('全样本分位：同一数值 → 48.17（被判偏贵，这就是固定分位失效）', +util.rollingPercentile(stair, stair.length).toFixed(2), 48.17, 0.05);
t('★两者结论必须不同（滚动便宜 / 固定不便宜）', util.rollingPercentile(stair, 156) <= 25 !== (util.rollingPercentile(stair, stair.length) <= 25), true);
t('样本不足（窗口<8）→ null', util.rollingPercentile([1, 2, 3], 10), null);
t('PE 回撤：末值低于窗口高点 16% → -16.00', +util.peDrawdownLevel([].concat(Array(60).fill(20), [16.8]), 52).toFixed(2), -16.0);
t('PE 回撤：末值低于窗口高点 14% → -14.00（不触发）', +util.peDrawdownLevel([].concat(Array(60).fill(20), [17.2]), 52).toFixed(2), -14.0);

console.log('\n--- 策略层触发（buildBroadGlobalDecision，离线合成序列）---');
const buildBroadGlobal = require('../engines/strategies/broadGlobal');
const G_CFG = {
  signals: {
    broadGlobal: {
      cheapPct: 25, expensivePct: 80, peWindowWeeks: 156,
      peDipPct: 12, peDipWindowWeeks: 52, peDipRequireStop: false,   // 2026-09-13 复验后由 15 放宽至 12
      stopWindow: 20, maWindows: [60, 120, 250], erpHigh: 2.1, erpLow: -1.5
    },
    peGate: { peGatePct: 85, surge20dPct: 5 }
  },
  usTreasury10y: 0.0496
};
// 合成基金：净值恒定（无回撤、无止跌），证明触发只可能来自 PE 通道
function runStrategy(peSeq) {
  const hist = Array(260).fill(0).map(() => ({ date: '2026-01-01', nav: 1 }));
  const fund = { code: 'T', history: hist, latestNav: 1 };
  const vm = { T: { peHistory: peSeq.map(pe => ({ date: '2026-01-01', pe })), pe: peSeq[peSeq.length - 1] } };
  return buildBroadGlobal(fund, vm, G_CFG);
}
// 场景1：台阶（滚动分位 0 ≤ 25）→ 通道①触发
const r1 = runStrategy(stair);
ts('台阶场景 → action=add', r1.action, 'add');
t('台阶场景 → 由通道①触发', r1.matrix.cheapByPct, true);
// 场景2：净值零回撤但 PE 回撤 16.25% → 只可能由通道②触发（反例：证明用的是 PE 回撤，不是净值回撤）
const dipOnly = [].concat(Array(100).fill(20), Array(50).fill(0).map((_, i) => 20 + (20 * i) / 49), [33.5]);
const r2 = runStrategy(dipOnly);
ts('PE回撤场景（净值零回撤）→ action=add', r2.action, 'add');
t('★该场景由通道②触发（证明用 PE 回撤而非净值回撤）', r2.matrix.cheapByDip, true);
t('该场景通道①未触发（滚动分位 > 25，两条通道确为并联）', r2.matrix.cheapByPct, false);
t('PE 回撤幅度约 -16.25%', +r2.matrix.peDipLevel.toFixed(2), -16.25, 0.05);
// 场景3：PE 回撤不到阈值（★2026-09-13 阈值由 15% 放宽至 12%）→ 不触发
const dipBelow = [].concat(Array(100).fill(20), Array(50).fill(0).map((_, i) => 20 + (20 * i) / 49), [35.6]); // 回撤 = -11.0%
const r3 = runStrategy(dipBelow);
ts('回撤仅 11% → action=hold（阈值 12% 生效）', r3.action, 'hold');
t('回撤仅 11% → 两条通道均未触发', r3.matrix.cheapByPct === false && r3.matrix.cheapByDip === false, true);
// 场景3b：★边界正向用例（放宽阈值后的目标回归，防未来无声回退）
const dipAbove = [].concat(Array(100).fill(20), Array(50).fill(0).map((_, i) => 20 + (20 * i) / 49), [34.8]); // 回撤 = -13.0%
const r3b = runStrategy(dipAbove);
ts('回撤 13% → action=add（新阈值 12% 生效）', r3b.action, 'add');
t('回撤 13% → 由通道②触发（peDipPct=12 已生效）', r3b.matrix.cheapByDip, true);
// 场景4：PE 序列缺失 → 降级不崩
const hist4 = Array(260).fill(0).map(() => ({ date: '2026-01-01', nav: 1 }));
const r4 = buildBroadGlobal({ code: 'T', history: hist4, latestNav: 1 }, { T: { pe: null } }, G_CFG);
ts('PE 序列缺失 → action=hold（降级不崩）', r4.action, 'hold');
t('PE 序列缺失 → 滚动分位与回撤均为 null', r4.matrix.peRollingPct === null && r4.matrix.peDipLevel === null, true);
// 场景5：总闸（PE 分位≥85 且近20日涨>5%）——用高滚动分位 + 构造的 recent20dChange
const gateSeq = Array(160).fill(0).map((_, i) => (i < 155 ? 20 : 60));   // 末值 60 远超窗口 → 分位 100
const hist5 = Array(260).fill(0).map((_, i) => ({ date: '2026-01-01', nav: i < 20 ? 1.2 : 1 }));
const r5 = buildBroadGlobal({ code: 'T', history: hist5, latestNav: 1 }, { T: { peHistory: gateSeq.map(pe => ({ date: '2026-01-01', pe })), pe: 60, recent20dChange: 9 } }, G_CFG);
ts('总闸命中（分位≥85 且 20日涨9%）→ action=hold', r5.action, 'hold');
ts('总闸命中 → gate=block', r5.matrix.gate, 'block');


// ==================== D 组：M 动量分连续因子（★二值变连续 + 防静默失败）====================
console.log('\n--- M 动量分（连续因子；tech 权重 cross .6 / stopRise .4）---');
t('maSpread +5（满标）→ M=100', scM({ maSpreadPct: 5 }, 'tech'), 100, 0.5);
t('maSpread 0（临界）→ M=25', scM({ maSpreadPct: 0 }, 'tech'), 25, 0.5);
t('maSpread −5（零端）→ M=0', scM({ maSpreadPct: -5 }, 'tech'), 0, 0.5);
tn('maSpread 缺失 → M=null（★不是 0）', scM({}, 'tech'));
t('金叉 + 止跌0 → M=36（权重归一后 0.6）', scM({ maSpreadPct: 5, stopRisePct: 0 }, 'tech'), 36, 0.5);
t('止跌 −2（低点更低）→ 不倒扣，仍 36', scM({ maSpreadPct: 5, stopRisePct: -2 }, 'tech'), 36, 0.5);
t('金叉 + 止跌满标 → M=100', scM({ maSpreadPct: 5, stopRisePct: 3 }, 'tech'), 100, 0.5);

console.log('\n--- M 趋势因子（broad/cycle：stopRise .5 / trend .5）---');
t('站上+止跌 → M=100', scM({ ma120DevPct: 10, stopRisePct: 3 }, 'broad'), 100, 0.5);
t('跌破−10+止跌 → M=25（trend=0, stop=1）', scM({ ma120DevPct: -10, stopRisePct: 3 }, 'broad'), 25, 0.5);
tn('broad 全因子缺失 → M=null', scM({}, 'broad'));
t('dividend devPct −8（跌破）→ M=0（★动量派：趋势弱；与 V 的 dipBonus 方向相反）', scM({ devPct: -8 }, 'dividend'), 0, 0.5);
t('dividend devPct +8（站上）→ M=100', scM({ devPct: 8 }, 'dividend'), 100, 0.5);
tn('dividend 缺失 → M=null', scM({}, 'dividend'));

console.log('\n--- ★ D 组静默失败反例（钉死最易犯的错）---');
// 反例1：尺度参数写反（crossFull/crossZero 对调）→ 结果应相差很大
const crossCorrect = scM({ maSpreadPct: 5 }, 'tech');
const ACFlip = JSON.parse(JSON.stringify(AC));
ACFlip.composite.momentum.crossFullPct = -5; ACFlip.composite.momentum.crossZeroPct = 5;
const crossFlipped = +require('../engines/alloc/allocation')
  .synthesizeMomentumScore({ matrix: { maSpreadPct: 5 } }, ACFlip, 'tech', undefined).toFixed(2);
t('★尺度写反 → M 归零（正确应为 100，差 100）', crossFlipped, 0, 0.5);
// 反例2：量纲未 ×100（0.05 当 5pp）→ 应≈25 而非 100
t('★量纲未×100（0.05 误当 5pp）→ M≈25 非 100', scM({ maSpreadPct: 0.05 }, 'tech'), 25, 1.5);
// 反例3：dipBonus 方向（跌破必须加分，不得翻转）
const vNoDev = scV({ pePercentile: 76.7, erp: 0.0607 }, 'broad');
const vDev = scV({ pePercentile: 76.7, erp: 0.0607, ma120DevPct: -10 }, 'broad');
t('★跌破 → V 必须变大（防语义翻转）', vDev - vNoDev, 4.7, 1.0);
// 反例4：dipBonus 幅度上限（远超满标也不超过 wDip 对应量）
const vDeep = scV({ pePercentile: 76.7, erp: 0.0607, ma120DevPct: -100 }, 'broad');
t('★跌破远超满标 → 与满标一致（有界）', vDeep, vDev, 0.2);
// 反例5：科技禁用 trend 因子
t('★tech 给 ma120DevPct 不影响 M', scM({ maSpreadPct: 5, ma120DevPct: -10 }, 'tech'), 100, 0.5);
// 反例6：lowRaisePct 与 stableLow 同向
let sameCnt = 0, totCnt = 0;
for (let k = 0; k < 30; k++) {
  const navs = []; let v = 1 + Math.random() * 0.5;
  for (let i = 0; i < 40; i++) { navs.push({ date: 'd' + i, nav: +(v = Math.max(0.5, v * (1 + (Math.random() - 0.5) * 0.06))).toFixed(4) }); }
  const hist = navs.slice().reverse();
  const lr = util.lowRaisePct(hist, 20), sl = util.stableLow(hist, 20);
  if (lr == null) continue;
  totCnt++;
  if ((lr > 0) === (sl === true)) sameCnt++;
}
t('★lowRaisePct 与 stableLow 同向（30 组随机）', sameCnt, totCnt, 0);
tn('lowRaisePct 数据不足（<2w）→ null', util.lowRaisePct([{ nav: 1 }, { nav: 2 }], 20));
tn('maSpreadPct hist<60 → null', util.maSpreadPct([{ nav: 1 }, { nav: 2 }], 20, 60));

// ==================== E 组：综合分层（权重 / 中性锚 / 硬约束 / legacy）====================
console.log('\n--- 综合分层 ---');
t('中性锚：V=25 且 M=25 → 综合 25（与权重无关）', sc({ drawdown: -15, pricePercentile: 50, maSpreadPct: 0 }, 'tech'), 25, 0.5);
t('V 缺失 + M=100（dividend 站上）→ 0.9×25+0.1×100=32.5', sc({ devPct: 8 }, 'dividend'), 32.5, 0.5);
t('M 缺失 + V=100（tech）→ 0.5×100+0.5×25=62.5', sc({ drawdown: -30, pricePercentile: 0 }, 'tech'), 62.5, 0.5);
t('V/M 双缺失 → 25', sc({}, 'tech'), 25, 0.5);
t('★gate=block 一票否决（V/M 皆满也归 0）', sc({ gate: 'block', drawdown: -30, pricePercentile: 0, maSpreadPct: 5 }, 'tech'), 0, 0.01);
t('★暂停申购 一票否决（第4参 suspended）', sc({ drawdown: -30, pricePercentile: 0 }, 'tech', null, true), 0, 0.01);
t('V 满 + M 满（tech）→ 100', sc({ drawdown: -30, pricePercentile: 0, maSpreadPct: 5, stopRisePct: 3 }, 'tech'), 100, 0.5);
t('V 零 + M 零（tech）→ 0', sc({ drawdown: 0, pricePercentile: 100, maSpreadPct: -5, stopRisePct: -1 }, 'tech'), 0, 0.5);

console.log('\n--- ★ legacy 旧逻辑冻结回归（证明旧公式没被改坏）---');
t('legacy 止跌基线 → 88.36', scL({ drawdown: -30, pricePercentile: 20, stopFall: true }, 'tech'), 88.36, 0.3);
t('legacy 未止跌 ×0.3 → 7.95', scL({ drawdown: -30, pricePercentile: 20, stopFall: false }, 'tech'), 7.95, 0.3);
t('legacy 金叉 → 100', scL({ drawdown: -30, pricePercentile: 20, stopFall: true, goldenState: true }, 'tech'), 100, 0.5);

console.log('\n--- ★ V ≡ 剥离后的旧公式（随机 50 组，matrix 不含动量字段）---');
let vMaxDiff = 0, vCnt = 0;
for (let k = 0; k < 50; k++) {
  const m = {
    drawdown: -(Math.random() * 40), pricePercentile: Math.random() * 100,
    pePercentile: Math.random() * 100, erp: (Math.random() * 0.08 - 0.02),
    yield: 0.02 + Math.random() * 0.05, cheapYield: 0.055, expensiveYield: 0.038,
    stopFall: true   // ★让 legacy 的 tech 不执行 ×0.3（V 已剥离该折扣，否则必然不等）
  };
  ['tech', 'broad', 'cycle', 'dividend'].forEach(by => {
    const a1 = synthesizeValueScore({ matrix: m }, AC, by, by === 'broad' ? 'us' : undefined);
    const a2 = legacyPositionScore({ matrix: m }, AC, by, by === 'broad' ? 'us' : undefined);
    if (a1 == null || a2 == null) return;
    vCnt++;
    vMaxDiff = Math.max(vMaxDiff, Math.abs(a1 - a2));
  });
}
t('★V 与 legacy 最大差 ≤0.01（' + vCnt + ' 组）', vMaxDiff, 0, 0.01);


console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);

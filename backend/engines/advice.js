'use strict';
/*
 * 每日建议引擎（规则引擎）：L1 组合状态 / per-fund 统一信号（决策判定 + 综合分 + 两维结论文案）。
 * 决策信号（红利/科技/黄金/宽基）经 registry.REGISTRY 遍历分发；统一引擎 computeAllocation 在
 * buildAnalysis 阶段已对每只持仓算好 dec（_dec/_marketScore 挂在 a.funds[i] 上），本文件组装 funds[] 时
 * **直接复用**（不再第二次调 builder，见 plans/tranquil-ember-galileo-Kx8Qm3Rv §七 已查证同引用无漂移）。
 * 响应结构：funds[] 每基金一条（verdict/score/scoreLabel/conclusion/净值全同源）；alerts[] 收非常规
 * 信号（trim/statementOnly）；l2/l3/fundSnap/navDates 已删除（信息全部并入 funds[]，2026-09-08 整合）。
 * session='pm' 只复盘不动作、不消耗冷却；session='am' 可执行、写 signals.json 冷却与决策历史。
 */
const analysis = require('./analysis');
const allocation = require('./alloc/allocation');
const { REGISTRY, resolveRegistry } = require('./registry');
const store = require('../lib/store');
const util = require('../lib/util');
const config = require('../lib/config');
const timing = require('./timing'); // 买入时机复盘：战役状态机采集（am-only，不进校准统计的用户买入 = buyScan 处理）

// factors 状态三态 helper：cheap=绿(偏便宜/有利买入) / expensive=红(偏贵/不利买入) / neutral=灰(信息项不判好坏)
function maStatus(z) { return z === 'below' ? 'cheap' : z === 'above' ? 'expensive' : 'neutral'; }
function gateStatus(g) { return g === 'block' ? 'expensive' : 'cheap'; }
function erpStatus(z) { return z === 'high' ? 'cheap' : z === 'low' ? 'expensive' : 'neutral'; }

// ---------- 结论文案两维派生（方案甲，2026-09-08 用户拍板：贴天然锚点分档，措辞与数字永远同源）----------
// score（0~100，marketScore）→ 便宜度形容词：[75,100] 深便宜 / [40,75) 中便宜 / [25,40) 中性 / [0,25) 偏贵；null → 无数据。
// 天然锚点：0=贵区/PE总闸拦截，25=中性(0.5²×100，无数据兜底同值)，100=满格便宜。25 分是"没信号"的数学锚。
function scoreLabelOf(score) {
  if (score == null) return null;
  if (score >= 75) return '深便宜';
  if (score >= 40) return '中便宜';
  if (score >= 25) return '中性';
  return '偏贵';
}
// 两维拼句：action（add/hold 机器值）给动作词，score 给便宜度词。措辞表见计划 §六。
// suspended（暂停申购）与 dailyLimit（每日限购 >0）作为尾注追加——保持原 action 句里的限购/暂停提示能力。
function conclusionOf(action, score, suspended, dailyLimit, compositeLabel) {
  const sl = scoreLabelOf(score);
  // ★硬约束一票否决（gate=block / 暂停申购）把综合分直接归零，与"贵不贵"无关。
  //   此时不能说"偏贵区"（否则出现「综合分 0，偏贵区」的误导文案），须改为说明归零原因。
  const blocked = score === 0 && (compositeLabel === '暂停申购' || compositeLabel === 'PE总闸拦截');
  let base;
  if (blocked) {
    base = action === 'add'
      ? `综合分 0（${compositeLabel} → 硬约束一票否决归零，不代表估值贵），已过确认门槛但当前不可买入`
      : `综合分 0（${compositeLabel} → 硬约束一票否决归零），维持不动：按你自己原来的节奏`;
  } else if (score == null) {
    base = action === 'add'
      ? '数据不足但已过确认门槛，可小步加仓（金额与节奏由你自己定）'
      : '数据不足，维持不动：按你自己原来的节奏';
  } else if (action === 'add') {
    if (sl === '中性') base = `综合分 ${score}，中性区但已过确认门槛，可小步加仓（金额与节奏由你自己定）`;
    else if (sl === '偏贵') base = `综合分 ${score}，偏贵区，本次靠趋势/纪律确认，加仓请谨慎（金额自行决定）`;
    else base = `综合分 ${score}，${sl}区，可加仓（金额与节奏由你自己定，系统不强制）`;
  } else {
    base = sl === '深便宜'
      ? `综合分 ${score}，已深便宜但未过确认门槛（如未止跌），维持不动，等确认`
      : `综合分 ${score}（${sl}），维持不动：按你自己原来的节奏`;
  }
  const tail = blocked
    ? '' // 归零原因已在 base 里说明，不再追加暂停/限购尾注（避免重复与误导）
    : (suspended
      ? '；当前暂停申购，仅作信号观察'
      : (dailyLimit != null && dailyLimit > 0 ? `；注意每日限购 ¥${dailyLimit}` : ''));
  return base + tail;
}

// 周对比：取 7 天前那天的决策快照（精确日期 → 否则 7 天窗口内最近一条 ≤ target → 都没有则 {}）
function pickWeekAgo(history) {
  if (!Array.isArray(history) || !history.length) return {};
  // ★ 「7 天前」要按**上海时区**的今天算，不能用 `new Date()` + 本机 getter：
  //   进程不在东八区时「本机今天」会与「上海今天」差一天，从而取错快照（且不报错）。
  //   这里与 lib/tradeDate.js 同一条铁律：UTC 锚点 + UTC getter 做纯日历减法。
  const d = new Date(util.todayStr() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 7);
  const target = d.toISOString().slice(0, 10);
  const exact = history.find(e => e.date === target);
  if (exact) return exact.funds || {};
  const before = history.filter(e => e.date <= target).sort((a, b) => a.date < b.date ? 1 : -1);
  return before.length ? (before[0].funds || {}) : {};
}

// 决策卡组装：按 dec.matrix._type 还原 title/detail/factors（展示层原样保留，含真实因子长文）。
// ⚠ 不再生成写死 action 中文句（R1：原 L2 条目 .action 是中文展示句，.verdict 才是机器值）——
// 结论文案由 conclusionOf(dec.action, score, ...) 两维派生（funds 组装处调用），verdict 字段保留机器值供历史/周对比。
function buildCard(f, dec, dailyLimits, cfg) {
  const actLabel = dec.action === 'add' ? '加仓' : '不动';
  if (dec.matrix._type === 'dividend') {
    const m = dec.matrix;
    const zoneTxt = m.yieldZone === 'cheap' ? '便宜' : m.yieldZone === 'expensive' ? '贵' : m.yieldZone === 'neutral' ? '中性' : '数据缺失';
    const maTxt = m.maZone === 'below' ? '年线下方' : m.maZone === 'above' ? '年线上方' : m.maZone === 'near' ? '年线附近' : '—';
    // ★2026-09-17 文案改 absYield 口径。旧版是 `股息率锚：xx（ratio r）｜MA250：xx｜PE闸：放行`，两处失真：
    //   ① ratio 已换义——旧口径 ratio = 基金股息率 / 3年均值锚，现口径 = 基金股息率 / 000922 参考股息率；
    //      继续叫「股息率锚」并把 ratio 单摆出来会误导（看不出带在哪）。
    //   ② PE闸 在红利线上恒为 pass（dividend.js 传 pePercentile:null，总闸对其不生效），是恒真装饰。
    // 现直接展示带本身：股息率 vs 参考带（贵线~便宜线）+ 000922 参考值，一眼能看出离加仓线多远。
    const pctOf = (x) => (x != null && !isNaN(x)) ? (x * 100).toFixed(2) : '—';
    const yieldTxt = pctOf(m.yield);
    const bandTxt = `${pctOf(m.expensiveYield)}~${pctOf(m.cheapYield)}`;
    const refTxt = pctOf(m.refYield);
    const matrixTxt = `股息率带：${zoneTxt}（股息率 ${yieldTxt}% ｜ 参考带 ${bandTxt}%，000922参考 ${refTxt}%）｜MA250：${maTxt}（${m.devPct != null ? m.devPct + '%' : '—'}）`;
    return {
      level: 'L2', type: 'dividend', code: f.code, name: f.name,
      title: `红利低波 决策：${actLabel}`,
      detail: matrixTxt + '。' + (dec.reasons.length ? dec.reasons.join('；') : ''),
      factors: [
        { dim: '股息率锚', value: zoneTxt, status: m.yieldZone },
        { dim: '股息率', value: `${yieldTxt}%`, status: 'neutral' },
        { dim: 'MA250', value: maTxt, status: maStatus(m.maZone) },
      ],
      verdict: dec.action === 'add' ? 'add' : 'hold',
    };
  } else if (dec.matrix._type === 'tech') {
    const m = dec.matrix;
    const dipTxt = m.drawdown != null ? `${m.drawdown.toFixed(1)}%` : '—';
    const maTxt = m.goldenState === true ? '金叉(MA20>MA60)' : m.goldenState === false ? '死叉(MA20<MA60)' : '—';
    const gateTxt = m.gate === 'block' ? '拦截' : '放行';
    const tCfg = (cfg && cfg.signals && cfg.signals.tech) || {};
    const limit = dailyLimits[f.code];
    const limitTxt = limit === 0 ? '（暂停申购）' : (limit != null ? `（每日限购 ¥${limit}）` : '（无上限）');
    const detail = `回撤 ${dipTxt}（阈值≤-${tCfg.dipPct || 15}%）｜止跌 ${m.stopFall ? '是' : '否'}｜双均线 ${maTxt}｜PE闸 ${gateTxt}${limitTxt}。${dec.reasons.length ? dec.reasons.join('；') : ''}`;
    return {
      level: 'L2', type: 'tech', code: f.code, name: f.name,
      title: `科技成长 决策：${f.name} → ${actLabel}`,
      detail,
      factors: [
        { dim: '回撤', value: dipTxt, status: m.drawdown != null && m.drawdown <= -(tCfg.dipPct || 15) ? 'cheap' : 'neutral' },
        { dim: '止跌', value: m.stopFall ? '是' : '否', status: m.stopFall ? 'cheap' : 'neutral' },
        { dim: '双均线', value: maTxt, status: 'neutral' },
        { dim: 'PE闸', value: gateTxt, status: gateStatus(m.gate) },
      ],
      verdict: dec.action === 'add' ? 'add' : 'hold',
    };
  } else if (dec.matrix._type === 'broad') {
    const m = dec.matrix;
    const isUS = m._caliber === 'us';   // 宽基·海外（纳指100）：两通道并联口径
    const peTxt = m.peZone === 'cheap' ? '便宜' : m.peZone === 'expensive' ? '贵' : (m.peZone === 'neutral' ? '中性' : '数据缺失');
    const trendTxt = m.trendWeak === true ? '跌破半年线' : m.trendWeak === false ? '站上半年线' : '—';
    const gateTxt = m.gate === 'block' ? '拦截' : '放行';
    if (isUS) {
      // 海外口径：主锚 = 自算滚动分位；副锚 ERP 对美债；通道② = PE 回撤
      const erpTxt = m.erpZone === 'high' ? '偏高(相对美债)' : m.erpZone === 'low' ? '偏低(相对美债)' : (m.erpZone === 'neutral' ? '中性' : '—');
      const dipTxt = m.peDipLevel != null ? `${m.peDipLevel}%` : '—';
      const pctTxt = m.peRollingPct != null ? `${m.peRollingPct}%` : '—';
      const winW = m.peWindowWeeks || 156;
      const dipW = m.peDipWindowWeeks || 52;
      const dipTh = m.peDipPct != null ? m.peDipPct : 12;   // 与 config.peDipPct 对齐（2026-09-13 由 15 改 12）
      const detail = `PE滚动${winW}周分位 ${pctTxt}（${peTxt}）｜PE回撤(近${dipW}周) ${dipTxt}（阈值≤-${dipTh}%）｜ERP(对美债) ${erpTxt}｜趋势 ${trendTxt}（${m.trendGrade || '—'}）｜PE闸 ${gateTxt}。${dec.reasons.length ? dec.reasons.join('；') : ''}`;
      return {
        level: 'L2', type: 'broad', code: f.code, name: f.name,
        title: `宽基·海外 决策：${f.name} → ${actLabel}`,
        detail,
        factors: [
          { dim: `PE滚动${winW}周分位`, value: `${pctTxt}（${peTxt}）`, status: m.peZone },
          { dim: 'PE回撤', value: dipTxt, status: m.cheapByDip ? 'cheap' : 'neutral' },
          { dim: 'ERP', value: erpTxt, status: erpStatus(m.erpZone) },
          { dim: '趋势', value: trendTxt, status: m.trendWeak ? 'cheap' : 'neutral' },
          { dim: 'PE闸', value: gateTxt, status: gateStatus(m.gate) },
        ],
        verdict: dec.action === 'add' ? 'add' : 'hold',
      };
    }
    // A 股口径：保持原样（文案逐字不变，作为回归基线）
    const erpTxt = m.erpZone === 'high' ? '偏高(股票划算)' : m.erpZone === 'low' ? '偏低(债券划算)' : (m.erpZone === 'neutral' ? '中性' : '—');
    const detail = `PE分位 ${peTxt}｜ERP(股债利差) ${erpTxt}｜趋势 ${trendTxt}（${m.trendGrade || '—'}）｜PE闸 ${gateTxt}。${dec.reasons.length ? dec.reasons.join('；') : ''}`;
    return {
      level: 'L2', type: 'broad', code: f.code, name: f.name,
      title: `宽基(双锚) 决策：${f.name} → ${actLabel}`,
      detail,
      factors: [
        { dim: 'PE分位', value: peTxt, status: m.peZone },
        { dim: 'ERP', value: erpTxt, status: erpStatus(m.erpZone) },
        { dim: '趋势', value: trendTxt, status: m.trendWeak ? 'cheap' : 'neutral' },
        { dim: 'PE闸', value: gateTxt, status: gateStatus(m.gate) },
      ],
      verdict: dec.action === 'add' ? 'add' : 'hold',
    };
  } else { // cycle
    const m = dec.matrix;
    const pctTxt = m.pctZone === 'cheap' ? '便宜' : m.pctZone === 'expensive' ? '贵' : (m.pctZone === 'neutral' ? '中性' : '—');
    const trendTxt = m.trendWeak === true ? '跌破半年线' : m.trendWeak === false ? '站上半年线' : '—';
    const stopTxt = m.stopFall ? '已止跌' : '未止跌';
    const surgeTxt = m.surge ? '急涨强拦' : '急涨放行';
    const detail = `250日分位 ${pctTxt}｜趋势 ${trendTxt}（${m.trendGrade || '—'}）｜止跌 ${stopTxt}｜急涨闸 ${surgeTxt}。${dec.reasons.length ? dec.reasons.join('；') : ''}`;
    return {
      level: 'L2', type: 'cycle', code: f.code, name: f.name,
      title: `黄金(对冲) 决策：${f.name} → ${actLabel}`,
      detail,
      factors: [
        { dim: '250日分位', value: pctTxt, status: m.pctZone },
        { dim: '趋势', value: trendTxt, status: m.trendWeak ? 'cheap' : 'neutral' },
        { dim: '止跌', value: stopTxt, status: m.stopFall ? 'cheap' : 'neutral' },
        { dim: '急涨闸', value: surgeTxt, status: m.surge ? 'expensive' : 'cheap' },
      ],
      verdict: dec.action === 'add' ? 'add' : 'hold',
    };
  }
}

async function buildAdvice(session = 'am') {
  const isPM = session === 'pm';
  const a = await analysis.buildAnalysis();
  const cfg = config.getConfig();
  const sig = cfg.signals || {};
  const policy = cfg.categoryPolicy || {};
  const dailyLimits = cfg.dailyLimits || {}; // 每日限购（0=暂停申购，null=无上限）
  const thresholds = sig.fundThresholds || {};
  const cooldownDays = sig.cooldownDays == null ? 7 : sig.cooldownDays;
  const today = util.todayStr();
  // 统一引擎结果（buildAnalysis 已算好挂在 a.plan 且 _dec/_marketScore 已挂在 a.funds[i]，见计划 §七 同引用查证）
  // 兜底分支同样组装 valuationMap（pePercentile/pricePercentile），保证「便宜度」维度不缺失
  const _fallbackVMap = {};
  (a.funds || []).forEach(f => { _fallbackVMap[f.code] = f.valuation || {}; });
  const plan = a.plan || allocation.computeAllocation(a.allocation, policy, a.funds, a.totals.totalValue, 0, _fallbackVMap, dailyLimits); // 预算已移除：只产出综合分信号

  let sigState = {};
  try { sigState = store.readJSON('signals.json'); } catch (e) { sigState = {}; }

  // ---------- L1：组合状态（常驻播报，不含操作指令）----------
  let dayGain = 0, dayBase = 0;
  a.funds.forEach(f => {
    if (f.dayChange != null && f.currentValue) {
      const prev = f.currentValue / (1 + f.dayChange / 100);
      dayGain += f.currentValue - prev;
      dayBase += prev;
    }
  });
  const allocationRows = a.allocation.map(c => ({
    key: c.key, name: c.name, pct: c.pct,
    value: c.value,
    policy: policy[c.key] || 'buy'
  }));

  const l1notes = [];
  // H1: 净值缺失/兜底提示（避免"市值缩水/假盈亏"被静默吞掉）
  const navMissing = a.funds.filter(f => f.currentValue == null);
  const navFallback = a.funds.filter(f => f.navFallback);
  if (navMissing.length) {
    l1notes.push(`⚠️ 净值缺失：${navMissing.map(f => `${f.code}(${f.name.slice(0, 8)})`).join('、')} 本次未取到最新净值，已从汇总中剔除（避免计入假市值）。`);
  }
  if (navFallback.length) {
    l1notes.push(`净值未更新：${navFallback.map(f => `${f.code} 已用 ${f.navFallbackDate} 快照兜底`).join('、')}，本次市值按快照估算。`);
  }
  // 冻结类别的深度回撤 → 只做纪律提醒，禁止任何买入措辞
  const frozenDeep = a.funds
    .filter(f => (policy[util.engineCategoryToBucket(f.category)] || 'buy') === 'frozen' && f.currentValue > 0)
    .map(f => ({ f, dd: util.drawdownFromHigh(f.history.slice(0, 60)) }))
    .filter(x => x.dd != null && thresholds[x.f.code] != null && x.dd <= thresholds[x.f.code]);
  if (frozenDeep.length) {
    l1notes.push('纪律提醒：' + frozenDeep.map(x => `${x.f.code} 回撤 ${x.dd.toFixed(2)}%`).join('、') +
      ' 处于深度回撤区。该类别按既定策略冻结，**不加仓、不动作**，等待占比自然稀释。');
  }

  const l1 = {
    totalPrincipal: a.totals.totalPrincipal,           // 实付（含申购费）
    totalNetInvested: a.totals.totalNetInvested,       // 净投入（扣申购费）= 下面的收益基准
    totalFee: a.totals.totalFee,                       // 累计申购费 = 实付 − 净投入
    totalValue: a.totals.totalValue,
    totalProfit: a.totals.totalProfit,                 // ★ 净口径（2026-09-18 起，基准 = totalNetInvested）
    totalProfitPct: a.totals.totalProfitPct,
    dayChangeValue: dayBase ? dayGain : null,
    dayChangePct: dayBase ? dayGain / dayBase * 100 : null,
    allocation: allocationRows,
    notes: l1notes
  };

  // ---------- per-fund 统一信号（整合主体，替代原 l2+l3+fundSnap 三源，2026-09-08）----------
  // funds[]：只收 resolveRegistry 命中的基金（= 原 l2 决策卡集合 ∪ scoreMap 全集）；判定/综合分/文案全同源。
  // alerts[]：非常规信号（原 l2 中无 factors 的条目：trim / statementOnly / 冷却期重复提示）。
  const scoreMap = (plan.scoreMap) || {};
  const funds = [];
  const alerts = [];
  const decMap = {}; // 买入时机复盘：am 会话收集全量基金当日判定（code → action/matrix/name/category），matrix 需带 _type

  for (const f of a.funds) {
    const hit = resolveRegistry(f);
    if (!hit) continue; // 类别外基金不进 funds[]（净值行由复盘页 live.funds 兜底，见 A6/R4 护栏）

    // ⚠ 副作用①（R2 保留）：红利基金每日把当天 dyr 写入自建序列（积累 ≥windowYears 年后算真 3 年滚动均值锚）。
    // 独立于 builder 调用（不放则删 L2 循环后 loadYieldAnchor3y 的序列断供）——reg.type==='dividend' 即触发。
    const reg = hit.reg;
    if (reg.type === 'dividend') {
      const todayYield = (f.valuation && f.valuation.dyr) || null;
      if (todayYield != null && todayYield > 0) {
        try {
          let seq = null;
          try { seq = store.readJSON('yield_history.json'); } catch (e) { seq = null; }
          seq = (seq && typeof seq === 'object') ? seq : {};
          // 按基金 code 分桶存储：支持多只红利基金各自积累独立序列（loadYieldAnchor3y 新结构）
          seq[f.code] = seq[f.code] || {};
          seq[f.code][today] = +(+todayYield).toFixed(4);
          store.writeJSONSafe('yield_history.json', seq);
        } catch (e) { /* 序列写入失败不致命 */ }
      }
    }

    // 决策判定：直接复用 computeAllocation 已挂在 a.funds[i] 上的 _dec（同一数组引用，同参等价无漂移，见计划 §七）；
    // 仅当异常路径（buildAnalysis 内打分半路中断）未挂载时补算一次兜底。
    let dec = f._dec;
    if (!dec) { dec = reg.builder(f, _fallbackVMap, cfg); f._dec = dec; }
    // computeAllocation 路径不设 matrix._type（strategies builder 均不写），决策卡格式化/timing 采集依赖它 → 这里补
    // （对 a.funds 上对象赋值会在 /api/refresh 响应多出 _type 字段，无害；decMap 引用的 matrix 因此带 _type）
    if (dec && dec.matrix) {
      dec.matrix._type = reg.type;
      dec.matrix._caliber = reg.caliber || null;  // 口径（broad 下 cn/us）：决策卡文案与 timing 分组用
    }

    const card = buildCard(f, dec, dailyLimits, cfg); // title/detail/factors/verdict（展示层原样保留）
    const sm = scoreMap[f.code] || {};
    const score = sm.marketScore != null ? sm.marketScore : null; // 真实市场分（0~100, toFixed(1)）；与决策页旧 scoreMap 同源
    const suspended = !!(sm && sm.suspended);
    const dailyLimit = dailyLimits[f.code] != null ? dailyLimits[f.code] : null;
    funds.push({
      code: f.code, name: f.name, category: f.category,
      caliber: reg.caliber || null,  // 口径（仅 broad 下有值：cn/us），供前端展示「宽基 · 海外口径」
      categoryName: reg.label, // = REGISTRY.label（引擎类别中文名：红利低波/科技成长/黄金(对冲)/宽基/宽基·海外）；⚠ 非分配桶名
      verdict: card.verdict,   // 机器判定值 'add'|'hold'（= kernel dec.action）
      title: card.title, detail: card.detail, factors: card.factors,
      matrix: (dec && dec.matrix) || null,
      score,                                   // ← 语义变更：位置分 → **综合分**（= wV×V + wM×M）
      scoreLabel: scoreLabelOf(score),
      // 2026-09-14 综合分构成（两派拆开，便于看懂分数来源；任一缺失为 null）
      valueScore: sm.valueScore != null ? sm.valueScore : null,           // V 估值分（均值回归派）
      momentumScore: sm.momentumScore != null ? sm.momentumScore : null,  // M 动量分（动量派，二值→连续）
      compositeLabel: sm.compositeLabel || null,                          // 拦截/降级说明
      weights: sm.weights || null,                                        // { wV, wM }
      degraded: sm.degraded || [],                                        // ['V'] / ['M'] / ['V','M']
      conclusion: conclusionOf(dec.action, score, suspended, dailyLimit, sm.compositeLabel), // ★ 两维派生；compositeLabel 用于区分「硬约束归零」与「估值真贵」
      suspended, dailyLimit,
      currentValue: f.currentValue != null ? f.currentValue : 0, // 未建仓（如 202015）为 0；净值缺失为 0（live.funds 兜底见 A6）
      latestNav: f.latestNav,
      dayChange: f.dayChange != null ? +f.dayChange.toFixed(2) : null,
      latestDate: f.latestDate,
      profitPct: f.profitPct != null ? +f.profitPct.toFixed(2) : null,
      eligible: !!(sm && sm.eligible) // = 原 scoreMap.eligible（policy=buy ∧ 未暂停申购）
    });
    if (!isPM) {
      // ⚠ 副作用②（D1 保留）：timing 采集输入（复盘「每月」tab 战役状态机），仅 am 收集——随 funds 组装保留
      decMap[f.code] = { action: dec.action, matrix: (dec && dec.matrix) || null, name: f.name, category: f.category, caliber: reg.caliber || null };
    }
  }

  // 信号 2：C 类份额涨到位清理（仅 frozen 类别；当前全 buy 故静默，未来恢复冻结自动重新生效）
  // 无 factors/verdict → 进 alerts[]（不进 funds[]，前端 decision 页按 verdictOf(title) 文字推断 stop）
  // ★ 判据口径（2026-09-18 变更）：f.profitPct 现为**净口径**（= 市值 − 净投入，扣申购费，见 analysis.js）。
  //   本规则当前**处于休眠**：categoryPolicy 全为 buy，下面第一道 continue 即跳过全部基金
  //   （实测 data/state/decision_history.json 15 条记录中 trim 命中 0 次）。
  //   将来恢复 frozen 时按净口径浮盈判断 —— 那更准确（收益本就该扣费）。仅 feeRate > 0 的基金两口径才有差异。
  const trimPct = sig.trimProfitPct == null ? 12 : sig.trimProfitPct;
  for (const f of a.funds) {
    if ((policy[util.engineCategoryToBucket(f.category)] || 'buy') !== 'frozen') continue;
    if (!f.currentValue || !f.principal) continue;
    if (!/C$/.test((f.name || '').trim())) continue; // 仅 C 类：按日计提销售服务费，长期持有更贵
    consider(`trim:${f.code}`, f.profitPct >= trimPct, {
      level: 'L2', type: 'trim', code: f.code, name: f.name,
      title: `${f.name} 达到减仓条件`,
      detail: `当前浮盈 ${f.profitPct.toFixed(2)}%，达到 +${trimPct}% 条件（净值日 ${f.latestDate}）。该动作实质是清理 C 类持有成本，而非择时。`,
      action: `可减仓该 C 类份额，回收资金转投核心/对冲类。`
    });
  }

  // consider 冷却状态机：满足条件才进 alerts；pm 只陈述（不写冷却/不给 action）
  function consider(id, cond, payload) {
    if (!cond) {
      if (sigState[id]) sigState[id].active = false;
      return;
    }
    const rec = sigState[id];
    if (isPM) {
      // 晚间只陈述状态：不写冷却、不给动作
      const p = Object.assign({}, payload);
      delete p.action;
      alerts.push(Object.assign({ id, firedAt: (rec && rec.lastFired) || today, statementOnly: true }, p));
      return;
    }
    const isNew = !rec || !rec.active;
    const expired = rec && rec.active && rec.lastFired && util.daysBetween(rec.lastFired, today) >= cooldownDays;
    if (isNew || expired) {
      sigState[id] = { active: true, lastFired: today };
      alerts.push(Object.assign({ id, firedAt: today }, payload));
    } else {
      sigState[id] = { active: true, lastFired: rec.lastFired }; // 冷却期内静默
      // M5: 冷却期内不重复触发，但若今天刚播报过，追加一条只陈述提示（避免"无信号"误导）
      if (rec.lastFired === today) {
        alerts.push({
          id, level: 'L2', type: payload.type || 'dip', code: payload.code, name: payload.name,
          title: `${payload.name || ''} 回撤信号今日已播报`,
          detail: '该信号今天已触发过，7 天冷却期内不重复催（详见早间/晚间播报）。',
          statementOnly: true
        });
      }
    }
  }

  if (!isPM) {
    store.writeJSONSafe('signals.json', sigState);
    // ⚠ 副作用③（R3）：写决策快照（供复盘「每日」tab 周对比）——来源由原 l2.filter 改为遍历 funds[]，
    // 只保留有 factors/verdict 的决策卡（alerts 无 factors 不进，避免污染前端按 code 取数）；conclusion 顺带存备用。
    const decSnap = {};
    funds.forEach(s => {
      if (s.factors && s.verdict) decSnap[s.code] = { factors: s.factors, verdict: s.verdict, conclusion: s.conclusion };
    });
    store.writeDecisionHistory({ date: today, funds: decSnap });
    // 买入时机复盘：战役状态机采集（am-only，pm 只陈述不改状态；采集失败不致命，不阻塞决策主流程）
    try {
      timing.onDecide(decMap, cfg);
    } catch (e) {
      console.warn('[timing] onDecide 失败:', e && e.message || e);
    }
  }

  return {
    asOf: a.asOf, date: today, session: isPM ? 'pm' : 'am',
    l1, funds, alerts,
    thresholds, categoryPolicy: policy,
    cooldownDays, calibratedAt: sig.calibratedAt,
    // 周对比快照：取 7 天前决策快照的 {code:{factors,verdict}}，前端只渲染不自己算 diff。
    // 早期无历史时返回 {}（前端不显示对比列）。
    weekAgo: pickWeekAgo(store.readDecisionHistory())
    // 已删除：l2、l3、fundSnap、navDates（信息全部并入 funds[]；latestDate 即原净值日，见计划 §三 字段去向表）
  };
}

module.exports = { buildAdvice };

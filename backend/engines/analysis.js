'use strict';
/*
 * 分析计算层（供 /api/refresh 与 /api/advice 复用）。
 * buildAnalysis：抓取净值/估值/盘中估算 → 计算每只基金市值盈亏与估值信号 → 穿透分析 → 配置与统一分配引擎。
 * buildPenetration：科技赛道透视（仅 growth 基金；输出基金画像卡 byFund + 旭日图 sunburst），只读不触发买卖。
 * 含网络 I/O（经 fetchers），纯计算部分无副作用（buildPenetration 只读、不写）。
 */
const fetchers = require('../fetchers');
const store = require('../lib/store');
const util = require('../lib/util');
const config = require('../lib/config');
const buyPlan = require('../lib/buyPlan');
const allocation = require('./alloc/allocation');
const trackIndex = require('../lib/trackIndex'); // 指数白名单与"这条线能不能用锚"（唯一真相源）
const { baseCategoryOf } = require('./registry'); // 自建分类(custom:xxx) → 绑定的内置算法

// ---------- 分析计算（纯计算，供 /api/refresh 与 /api/advice 复用）----------
async function buildAnalysis(opts) {
  const cfg = config.getConfig();
  const holdings = store.readJSON('holdings.json');
  // 防御：holdings 结构损坏（缺 funds/非数组/基金缺 purchases）时不崩，回退空组合
  if (!holdings || !Array.isArray(holdings.funds)) {
    return {
      asOf: util.shanghaiNow().ymd + 'T00:00:00.000Z', tradingHours: false,
      funds: [], totals: { totalPrincipal: 0, totalNetInvested: 0, totalFee: 0, totalValue: 0, totalProfit: 0, totalProfitPct: 0, estimateTotal: null, navMissingCount: 0, navFallbackCount: 0 },
      penetration: { reportDate: null, disclosedCoveragePct: 0, unmapped: [], byFund: [], sunburst: null },
      allocation: [], plan: { scoreMap: {} }
    };
  }
  const trading = util.isTradingHours();

  // ★ 并行抓取（本次优化的主要收益点）：每只基金需串行打最多 13 页净值 + 若干估值请求，
  //   9 只基金串行共约 89 次网络往返 → 冷缓存 6~11 秒（这就是用户按 F5 觉得「卡住」的真实原因）。
  //   改为 Promise.all 并行；实际并发由 lib/http 的全局闸门兜住（默认 6），不会被数据源限流。
  //   安全性已逐行核验：循环体内无 continue、无提前 return、无跨迭代依赖、不写任何文件。
  const results = await Promise.all(holdings.funds.map(async (f) => {
    // 宽基/红利/黄金：需长窗口（250 日）算 MA120/250、价格分位；其余（科技/成长）120 日
    const needLong = f.category === 'broad' || f.category === 'dividend' || f.category === 'cycle';
    const histDays = needLong ? 250 : 120;
    const navRes = await fetchers.fetchNavHistory(f.code, histDays);
    const history = navRes.history;
    const latest = history[0] || null;
    const purchases = Array.isArray(f.purchases) ? f.purchases : []; // 防御：缺 purchases 不崩
    const totalShares = purchases.reduce((s, p) => s + (p.shares || 0), 0);
    const principal = purchases.reduce((s, p) => s + (p.amount || 0), 0);
    // 净投入（2026-09-18 新增）：扣掉申购费后真正买成份额的钱 —— 券商「持仓成本」同口径。
    // ★ 与 principal（实付）是两个口径：fee = 被申购费收走、没变成份额的那部分。
    const netInvested = buyPlan.netInvestedTotal(purchases, f.feeRate);
    const fee = principal - netInvested;
    const pendingAmt = purchases.filter(p => p.shares == null).reduce((s, p) => s + (p.amount || 0), 0); // 在途**实付**本金（份额待 T+2 确认，先记金额后补份额）——仅用于界面「含在途」提示
    // 在途**净**投入（2026-09-18）：在途只知实付、不知份额，但**费率由基金档案决定、与净值无关**，
    // 故净投入可精确预估 = amount × (1 − 费率)。资产侧与成本侧都用它 ⇒ 在途行对 profit 贡献**恒为 0**。
    // ★ 为什么必须用净而不是实付：若资产侧用实付、成本侧用净，两侧之间会凭空冒出
    //   「手续费」大小的**假收益**（400 在途 → 假赚 0.6）。用净口径则两侧严格抵消。
    //   与「在途算入总资产」改动前的行为逐位一致（改动前两侧同为实付 → 同样抵消为 0）。
    const pendingNet = purchases
      .filter(p => p.shares == null)
      .reduce((s, p) => s + buyPlan.netInvestedOf({ amount: p.amount }, f.feeRate), 0);

    // H1: 净值抓取失败/空 → 用 history.json 最新快照该基金 value 兜底，绝不写 0
    let currentValue, navFallback = false, navFallbackDate = null;
    // 在途占位（2026-09-03 用户拍板「在途算入总资产」）：currentValue=已确认市值+在途净投入（钱已花出=真实资产；
    // 成本侧同为净投入 → 在途行对 profit 贡献 0，不假亏；补份额后 pendingNet 归零、市值接管，平滑过渡）
    if (latest && latest.nav) {
      currentValue = totalShares * latest.nav + pendingNet;
    } else if (navRes.failed || !history.length) {
      const snap = store.lastSnapshotFundValue(f.code); // history.json 最新快照 {value, date}
      if (snap) {
        currentValue = snap.value + pendingNet;
        navFallback = true;
        navFallbackDate = snap.date;
      } else {
        currentValue = pendingNet > 0 ? pendingNet : null; // 缺净值缺快照：至少在途净投入入总资产；无在途 → null 不参与汇总
      }
    } else {
      currentValue = pendingNet > 0 ? pendingNet : null;
    }
    // ★★ 收益基准 = 净投入（2026-09-18 口径变更，用户拍板）★★
    //   原为「实付」principal，现改为「净投入」netInvested —— 与券商「持仓成本」对齐，
    //   即收益不把申购费当成亏损的一部分。两者差额 = fee（当日的申购费合计）。
    //   注意 principal / totalPrincipal 的语义**未变**（仍是实付）：快照历史、穿透「待建仓」清单
    //   都依赖其实付语义，故只切收益基准这条线，不掀整张桌子。
    const profit = currentValue == null ? null : currentValue - netInvested;
    const profitPct = (netInvested && profit != null) ? profit / netInvested * 100 : null;

    // 估值信号：只有「这条策略线允许用指数锚」且拿得到 trackIndex 时才抓指数估值；
    // 否则（商品线 / 主动基金 / 抓失败）走价格分位兜底。
    // 注意：dividend 类即使无 pePercentile（红利 PE 线已砍，只返回 dyr）也须挂载，否则 dyr 丢失
    const recent20dChange = history.length ? util.recentChangePct(history, 20) : 0;
    // ★★ 判据是「策略线要不要锚」，**绝不是「有没有 trackIndex」**。
    //   商品线(cycle)/债券/现金刻意不读指数 PE；而东财会给黄金基金返回指数代码（上海金 SHAU）。
    //   若沿用旧的 `if (f.trackIndex)`，自动抓取一填锚就会把商品线的行为改掉（静默回归）。
    //   所以「能不能用锚」永远由策略线决定 —— 见 lib/trackIndex.js 的 usesIndexAnchor。
    //   ★ 用 baseCategoryOf 折算：用户自建的类别（custom:xxx）只是别名，能不能用锚
    //     要看它绑定的那条内置算法，不能因为是别名就当成"不能用锚"。
    const _baseCat = baseCategoryOf(f.category);
    const useIndexAnchor = trackIndex.usesIndexAnchor(_baseCat);
    let valuation = null;
    if (f.trackIndex && useIndexAnchor) {
      // 宽基乐咕滚动分位窗口 = config.signals.broad.peWindowYears（缺省 5，与提配置前一致）
      const peWinYears = (cfg.signals && cfg.signals.broad && cfg.signals.broad.peWindowYears) || 5;
      const ev = await fetchers.fetchValuation(f.trackIndex, peWinYears);
      if (ev && (ev.pePercentile != null || f.category === 'dividend')) {
        valuation = Object.assign({}, ev, { recent20dChange });
      }
    }
    const pricePercentile = history.length ? util.percentileOf(history) : null;
    // weak 的语义 = 「最终用的是价格分位兜底（拿不到指数口径估值）」。
    // 它只用于透传展示（全仓无消费者），改成语义正确的算法不影响任何判定。
    const usedPriceFallback = valuation == null;
    valuation = valuation || {
      pricePercentile, recent20dChange,
      weak: usedPriceFallback,
      source: 'price'
    };
    // 给前端一个「这只基金的估值锚是否降级」的显式标记，替代过去"偷偷显示 ? 且恒 hold"的静默行为。
    const anchorDegraded = trackIndex.needsTrackIndex(_baseCat)
      && !(f.trackIndex && useIndexAnchor && !usedPriceFallback);

    // 宽基：按「口径」补充无风险利率锚（ERP 第二锚用）——★中债只给 A 股、美债只给海外，二者不可互为兜底。
    //   cn(A股)：v.treasury10y ← 中债10年，失败回退 config.treasury10y 常量；
    //   us(海外)：v.usTreasury10y ← 美债10年，失败回退 config.usTreasury10y 常量。
    // 跨市场混算会让 ERP 失真（A股-中债、美股-美债才是同一市场内的股债比）。
    if (f.category === 'broad') {
      try {
        const b = await fetchers.fetchBond10Y();   // { cn, us, asOf }
        if (b && valuation) {
          if (util.caliberOf(f) === 'us') {
            if (b.us != null) valuation.usTreasury10y = b.us;
          } else {
            if (b.cn != null) valuation.treasury10y = b.cn;
          }
        }
      } catch (e) { /* 抓取失败不致命：策略侧各自回退各自 config 常量 */ }
    }

    // 宽基·海外：挂指数 PE 历史序列（滚动分位 与 PE回撤 的唯一数据源）。
    // ★必须自算：蛋卷的当期 pe_percentile 是固定约10年口径，遇纳指 PE「台阶上移」会长期失效（见 plans §8.6）。
    // 抓不到 → 不挂（策略侧通道①②失效、综合分 25 兜底），不报错。
    if (f.category === 'broad' && util.caliberOf(f) === 'us' && f.trackIndex) {
      try {
        const rows = await fetchers.fetchIndexPeHistory(f.trackIndex);
        if (rows && rows.length && valuation) valuation.peHistory = rows;
      } catch (e) { /* 不致命 */ }
    }

    // 红利：挂「中证红利000922 动态股息率」作参考带（标普SPCLLHCP无免费源，用000922代理；PE分位线已砍，纯股息率带）
    if (f.category === 'dividend') {
      try {
        const dj = await fetchers.fetchDanjuanEvaList();
        const ref = dj && dj['SH000922'];
        if (ref && ref.dyr != null && valuation) valuation.referenceYield = ref.dyr;
      } catch (e) { /* 不致命 */ }
    }

    let estimate = null, estimateChange = null;
    if (f.market === 'A' && f.estimateIndex && trading && latest) {
      const idx = (await fetchers.fetchSinaIndex([f.estimateIndex]))[f.estimateIndex];
      if (idx) {
        estimateChange = idx.changePct;
        estimate = latest.nav * (1 + idx.changePct / 100);
      }
    }
    return {
      principal,
      netInvested,
      fee,
      currentValue,
      fund: {
        code: f.code, name: f.name, category: f.category, market: f.market,
        caliber: util.caliberOf(f),  // ★口径（broad 下 cn/us）：computeAllocation/advice 的路由依据，缺它两层解析失效
        estimateIndex: f.estimateIndex, estimateLabel: f.estimateLabel || null,
        trackIndex: f.trackIndex || null,
        // ★ 估值锚状态（2026-09-19 新增）：让前端能**显式**告诉用户「这只基金缺估值锚、判定已降级」，
        //   替代过去"界面显示 ? 且恒定建议持仓不动"的静默误导。
        valuationAnchor: {
          hasTrackIndex: !!f.trackIndex,
          usable: !!(f.trackIndex && useIndexAnchor),
          degraded: anchorDegraded,
          reason: anchorDegraded ? (f.trackIndex ? 'fetch_failed' : 'no_track_index') : null,
        },
        latestNav: latest ? latest.nav : null, latestDate: latest ? latest.date : null,
        dayChange: latest ? latest.dayChange : null,
        totalShares, principal, netInvested, fee, currentValue, profit, profitPct,
        navFallback, navFallbackDate,
        estimate, estimateChange, history,
        pendingAmount: pendingAmt, // 在途**实付**本金（份额待确认；前端可标「含在途 ¥X」）—— 展示口径，非收益基准
        valuation,
        purchases // 原始买入记录（monthInvested 按月聚合 + 科技网格锚 last 模式数据源；成本均价用 principal/totalShares）
      }
    };
  }));

  // ★ 累加必须在 results 顺序上回放（Promise.all 保序，results 顺序 = 原 holdings.funds 顺序）。
  //   绝不可把累加写进上面的 map 里 —— 那样浮点加法的操作数顺序会随网络返回时序抖动，
  //   totalPrincipal/totalValue 的末位可能变化，是本改动唯一有风险的做法，明确禁止。
  //   回放后加法操作数顺序与旧串行 for 循环逐位相同。（2026-09-18 新增的 totalNetInvested 同受此约束）
  let totalPrincipal = 0, totalNetInvested = 0, totalValue = 0;
  for (const r of results) {
    totalPrincipal += r.principal;
    totalNetInvested += r.netInvested;
    if (r.currentValue != null) totalValue += r.currentValue;
  }
  const funds = results.map(r => r.fund);

  // 穿透分析（科技赛道透视：基金画像卡 + 旭日图，见 buildPenetration）
  const penetration = await buildPenetration(holdings.funds, funds, totalValue);

  // 统一注入人工校准 PE 分位锚点（蛋卷抓不到时，覆盖价格分位；蛋卷可用后自动优先）
  try {
    const _peFb = (cfg.signals && cfg.signals.peFallback) || {};
    funds.forEach(f => {
      if (f.valuation && f.valuation.pePercentile == null && _peFb[f.code] != null) {
        f.valuation.pePercentile = _peFb[f.code];
      }
    });
  } catch (e) { /* config 缺失不致命 */ }

  // 配置（按引擎 4 线汇总市值；净值缺失的基金 currentValue=null 不参与）。名单源 = categories.json 的 categories（=引擎线口径，不再并桶）
  const categories = store.readJSON('categories.json');
  const catList = (categories && Array.isArray(categories.categories)) ? categories.categories : [];
  const byCat = {};
  funds.forEach(f => { if (f.currentValue != null) { byCat[f.category] = (byCat[f.category] || 0) + f.currentValue; } });
  const allocationRows = catList.map(c => ({
    key: c.key, name: c.name,
    value: byCat[c.key] || 0,
    pct: totalValue ? (byCat[c.key] || 0) / totalValue * 100 : 0
  }));
  // ★ 兜底补行（2026-09-19）：基金实际用到的 category 若不在 categories 里
  //   （手改 json、或自建分类没登记），旧实现会让它的市值**从环形图里静默消失** ——
  //   但 totalValue 仍然含它，于是各段占比之和 <100%，用户只会看到"钱数对不上"。
  //   这里为每个漏网的类别补一行，保证「各段之和 ≡ 100%」这条不变量恒成立。
  const _seenCats = new Set(catList.map(c => c.key));
  for (const cat of Object.keys(byCat)) {
    if (_seenCats.has(cat)) continue;
    allocationRows.push({
      key: cat, name: '未归类', value: byCat[cat],
      pct: totalValue ? byCat[cat] / totalValue * 100 : 0,
      unsupported: true
    });
  }

  // 单一分配引擎结果（随 /api/refresh 下发，前端 renderAllocation 与 buildAdvice 共用）
  // 预算/分配金额机制已移除：computeAllocation 仅产出 scoreMap 综合分信号，catch 回退保留对象形态供 advice 取 plan.scoreMap 兼容
  let plan = { scoreMap: {} };
  try {
    const pol = (cfg && cfg.categoryPolicy) || {};
    const dl = (cfg && cfg.dailyLimits) || null;
    const valuationMap = {};
    funds.forEach(f => { valuationMap[f.code] = f.valuation; });
    // 预算机制已整体移除（用户拍板）：金额建议由用户自定，引擎只产出综合分/标签信号
    plan = allocation.computeAllocation(allocationRows, pol, funds, totalValue, 0, valuationMap, dl);
  } catch (e) { /* config 缺失不致命，plan 回退空 */ }

  // ★★ 全组合收益基准 = 净投入（2026-09-18 口径变更，用户拍板）★★
  //   原为 totalPrincipal（实付），现为 totalNetInvested（扣申购费）—— 与券商「持仓成本」对齐。
  //   totalPrincipal 语义**未变**（仍是实付），继续用于「实付合计」展示与快照历史。
  const totalProfit = totalValue - totalNetInvested;
  const totalProfitPct = totalNetInvested ? totalProfit / totalNetInvested * 100 : 0;
  const totalFee = totalPrincipal - totalNetInvested; // 累计申购费（实付 − 净投入）

  // 日内估算总额（仅 A 股有估算值时计入）
  let estTotal = 0, estHas = false;
  funds.forEach(f => { if (f.estimate != null) { estTotal += f.estimate * f.totalShares; estHas = true; } });
  const estimateTotal = estHas ? estTotal : null;

  const navMissingCount = funds.filter(f => f.currentValue == null).length;
  const navFallbackCount = funds.filter(f => f.navFallback).length;

  // asOf: 上海墙上时间（不带 Z——避免前端按 UTC 解析差 8h）
  const _sn = util.shanghaiNow();
  const asOfStr = _sn.ymd + 'T' + String(_sn.hour).padStart(2, '0') + ':' + String(_sn.minute).padStart(2, '0') + ':00';

  return {
    asOf: asOfStr,
    tradingHours: trading,
    funds,
    totals: { totalPrincipal, totalNetInvested, totalFee, totalValue, totalProfit, totalProfitPct, estimateTotal, navMissingCount, navFallbackCount },
    penetration,
    allocation: allocationRows,
    plan
  };
}

// 穿透分析（科技赛道透视）：只对 category==='growth'（科技）基金做个股穿透。
// 红利/宽基/黄金穿透无信息量（实测）不参与——范围动态跟随 holdings.category，不写死基金代码。
// 数据口径：
//   byFund 卡 = 基金自身口径（前十大按赛道累加占净值% → 披露内归一）+ disclosedPct/stockCount 覆盖度。
//   sunburst = 对科技仓位的有效暴露口径（基金权重 × 占净值%，跨基金可加；同级比例由 ECharts 归一）。
//   unmapped = 映射表未命中股票（归「未分类」不丢数据，提示补 theme_map.json）。
async function buildPenetration(fundDefs, funds, totalValue) {
  const themeMap = store.readJSON('theme_map.json') || null; // 股票→赛道（数据驱动；读失败按全未分类兜底）
  const tech = (fundDefs || []).filter(fd => fd && fd.category === 'growth');

  // 参与基金（须有现价市值）；统计科技总市值供旭日图权重
  const metas = [];
  const pending = [];
  let techTotal = 0;
  for (const fd of tech) {
    const fv = funds.find(x => x.code === fd.code);
    if (fv && fv.currentValue > 0) {
      techTotal += fv.currentValue;
      metas.push({ fd, fv });
      continue;
    }
    // 未进穿透的科技基金（无市值/无现价可见）→ pending 占位卡：可见但不伪造赛道数据。
    // 注：有在途买入的基金 currentValue=在途本金>0 会正常进 metas（「在途算入总资产」口径），
    //     故 pending 主体是「已添加未买入」；「确认待估值」= 份额已确认但净值/快照缺失（临时态）。
    const purchases = fd.purchases || [];
    const state = purchases.some(p => p.shares == null) ? '在途确认中'
      : (purchases.some(p => p.shares != null) ? '确认待估值' : '待记买入');
    pending.push({
      code: fd.code,
      name: fd.name,
      principal: +purchases.reduce((s, p) => s + (p.amount || 0), 0).toFixed(2),
      pendingAmount: +purchases.filter(p => p.shares == null).reduce((s, p) => s + (p.amount || 0), 0).toFixed(2),
      state
    });
  }
  const empty = { reportDate: null, disclosedCoveragePct: 0, unmapped: [], byFund: [], pending: [], sunburst: null };
  // ⚠️ metas 空但 pending 非空（全科技基金均未买入）也要把 pending 带出去，不能直接丢
  if (!metas.length || !(totalValue > 0)) return Object.assign({}, empty, { pending });

  // 抓取去重：同 acGroupKey（A/C 等份额）只抓一次、份额间共享；联接基金代理（holdings 里的 penetrationProxy）由 fetchers 内部处理
  const groups = new Map();
  for (const m of metas) {
    const gk = util.acGroupKey(m.fd.name, m.fd.category);
    if (!groups.has(gk)) groups.set(gk, { rep: m.fd, members: [] });
    groups.get(gk).members.push(m);
  }

  const byFund = [];
  const unmappedMap = new Map(); // stockName -> { stockCode, holderFunds:Set(fundCode) }。stockCode=股票代码（前端查行业用），funds=持有该股的基金码列表
  const sector = {};             // theme -> { value: 有效暴露, children: {fundName: eff} }
  const dates = [];
  let disclosedEff = 0;          // 已披露重仓对科技仓位的有效覆盖（含未分类，如实计覆盖度）

  for (const g of groups.values()) {
    let detail = null;
    try { detail = await fetchers.fetchHoldings(g.rep.code); }
    catch (e1) {
      try { detail = await fetchers.fetchHoldings(g.rep.code); } catch (e2) { detail = null; }
    }
    const stocks = (detail && Array.isArray(detail.stocks)) ? detail.stocks : [];
    if (detail && detail.date) dates.push(detail.date);
    const disclosedPct = stocks.reduce((s, x) => s + (x.pct || 0), 0);

    for (const m of g.members) {
      const wTech = m.fv.currentValue / techTotal; // 该基金占科技仓位权重（旭日图口径）

      // ① 基金自身口径赛道聚合：前十大按赛道累加占净值% → 披露内归一
      const agg = {}; // theme -> 占该基金净值%原始值
      for (const s of stocks) {
        const th = util.themeOf(s.name, themeMap);
        agg[th] = (agg[th] || 0) + (s.pct || 0);
        if (th === '未分类') {
          if (!unmappedMap.has(s.name)) unmappedMap.set(s.name, { stockCode: s.code, holderFunds: new Set() });
          unmappedMap.get(s.name).holderFunds.add(m.fd.code);
        }
      }
      const rawThemes = Object.entries(agg).map(([theme, pct]) => ({ theme, pct }));
      const rawSum = rawThemes.reduce((s, x) => s + x.pct, 0) || 0;
      const themes = rawThemes
        .map(x => ({ theme: x.theme, pct: rawSum ? +((x.pct / rawSum) * 100).toFixed(1) : 0 }))
        .sort((a, b) => b.pct - a.pct);

      byFund.push({
        code: m.fd.code, name: m.fd.name,
        weightPct: +((m.fv.currentValue / totalValue) * 100).toFixed(2), // 占全组合%（卡片右上角）
        date: (detail && detail.date) || null,
        proxyCode: (detail && detail.proxy) || null, // 联接代理来源（前端标注"经 XX 代理抓取"）
        acGroupKey: util.acGroupKey(m.fd.name, m.fd.category),
        siblings: g.members.filter(x => x.fd.code !== m.fd.code).map(x => x.fd.code), // 同持仓份额（前端标"同持仓"）
        topTags: themes.filter(t => t.theme !== '未分类').slice(0, 4).map(t => t.theme),
        themes,
        disclosedPct: +disclosedPct.toFixed(2), // 季报披露重仓合计占该基金净值%（覆盖度）
        stockCount: stocks.length
      });

      // ② 旭日图聚合：基金权重 × 原始占净值% = 对科技仓位的有效暴露（跨基金可相加）
      disclosedEff += wTech * disclosedPct;
      for (const s of stocks) {
        const th = util.themeOf(s.name, themeMap);
        if (th === '未分类') continue; // 未分类不进赛道图（已在 unmapped 收集提示）
        const eff = wTech * (s.pct || 0); // 百分点（如 0.27 × 6.76 = 1.83 → 占科技仓位 1.83%）
        if (!sector[th]) sector[th] = { value: 0, children: {} };
        sector[th].value += eff;
        sector[th].children[m.fd.name] = (sector[th].children[m.fd.name] || 0) + eff;
      }
    }
  }

  const sunburstChildren = Object.entries(sector)
    .map(([theme, v]) => ({
      name: theme,
      value: +v.value.toFixed(4),
      children: Object.entries(v.children)
        .map(([name, eff]) => ({ name, value: +eff.toFixed(4) }))
        .sort((a, b) => b.value - a.value)
    }))
    .sort((a, b) => b.value - a.value);

  return {
    reportDate: dates.length ? dates.slice().sort().reverse()[0] : null,
    disclosedCoveragePct: +disclosedEff.toFixed(1), // 已披露重仓占科技仓位%（前端旭日图覆盖度注记）
    unmapped: [...unmappedMap.entries()].map(([name, o]) => ({ name, code: o.stockCode, funds: [...o.holderFunds] })),
    pending,
    byFund,
    sunburst: sunburstChildren.length ? { root: '科技仓位', children: sunburstChildren } : null
  };
}

// ---------- /api/refresh（计算 + 写每日快照）----------
async function handleRefresh() {
  const a = await buildAnalysis();
  // M7: 快照防假值——净值缺失过多或总市值较昨骤变>30% 时跳过写快照（防塌缩值污染 history.json 走势图）
  const h = store.readHistory();
  const lastSnap = h[h.length - 1];
  // 防线用已确认口径（totalValue−Σ在途本金）：防净值塌缩假值，不误伤真实大额申购（在途本金会让总市值跳变 >30%）
  const pendingTotal = (a.funds || []).reduce((s, f) => s + (f.pendingAmount || 0), 0);
  const confirmedVal = (a.totals.totalValue || 0) - pendingTotal;
  let skipped = null;
  if (a.totals.navMissingCount > 0) {
    skipped = `有 ${a.totals.navMissingCount} 只基金净值缺失，本次跳过写快照（避免写入不完整市值）`;
  } else if (lastSnap && lastSnap.totalValue > 0 && Math.abs(confirmedVal - lastSnap.totalValue) / lastSnap.totalValue > 0.30) {
    skipped = `已确认市值较昨变动 >30%（${lastSnap.totalValue.toFixed(0)}→${confirmedVal.toFixed(0)}），疑似数据异常，本次跳过写快照`;
  }
  if (skipped) {
    console.warn('[snapshot] 跳过:', skipped);
    return Object.assign({}, a, { snapshotSkipped: skipped });
  }
  // 写快照（用上海本地日期，避免 UTC 跨日漂移）
  const sd = util.shanghaiNow();
  const snapDate = sd.ymd;
  // ★ 快照 schema **未变**（不新增字段），但 totalProfit/totalProfitPct 的口径自 2026-09-18 起
  //   由「实付」改为「净投入」（扣申购费）。⚠️ 旧快照（≤2026-09-17）仍为实付口径，
  //   新旧差值 = 当日累计申购费。该字段目前无任何读取方
  //   （走势图只用 totalValue），故混合口径不影响任何展示；若将来要用它画「收益曲线」，
  //   必须先按日期回算各日累计申购费再对齐。
  await store.appendSnapshot({
    date: snapDate,
    totalPrincipal: a.totals.totalPrincipal, totalValue: a.totals.totalValue,
    totalProfit: a.totals.totalProfit, totalProfitPct: a.totals.totalProfitPct,
    funds: a.funds.map(f => ({ code: f.code, value: f.currentValue, principal: f.principal }))
  });
  return a;
}

module.exports = { buildAnalysis, buildPenetration, handleRefresh };

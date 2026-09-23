'use strict';
/*
 * 回归测试：本金/收益口径 —— 「实付」与「净投入」的区分（2026-09-18 口径变更）
 *
 * 背景（真实起因，用户困惑）：
 *   用户从券商 App 读到的持仓成本，比看板显示的本金少了 2 元多。
 *   查实：差额全部来自 3 只 QDII 的申购费（★下列金额均为示意值，不代表任何人的真实仓位）——
 *     016664 天弘全球高端制造A  0.15% × 1200 = 1.80
 *     018966 汇添富纳斯达克100    0.12% ×  200 = 0.24
 *     012920 易方达全球成长QDII   0.15% ×  200 = 0.30
 *   两个数都对，只是口径不同：
 *     实付   = Σ 每笔 amount              → 1600（你实际掏出去的钱）
 *     净投入 = Σ shares × nav = Σ amount×(1−费率) → 1597.66（真正买成份额的钱，券商同口径）
 *
 * 本次变更（用户拍板）：
 *   ① 收益基准由「实付」改为「净投入」—— 与券商「持仓成本」对齐（收益不再把申购费算作亏损）；
 *   ② 概览页新增「累计投入」KPI，副行同时显示「实付（含申购费）」。
 *   ★ `principal` / `totalPrincipal` 的语义**未变**（仍是实付）：快照历史与穿透「待建仓」清单
 *     依赖其实付语义，故只切收益基准这一条线。
 *
 * 覆盖三层（本仓库能测到什么就测到什么，不装样子）：
 *   L1 纯函数   —— netInvestedOf / netInvestedTotal（可直接调用，最硬）
 *   L2 存量数据 —— 关系式断言（★ 不硬编码金额：用户下次买入就变红的断言是负债）
 *   L3 接线     —— analysis / advice / overview / buyPlan / sw 的源码级不变量
 *
 * ★ 本文件在「数据机（私有仓）」与「开源版（公开仓）」两仓**逐字节相同**。
 *   真实的「实付 / 净投入 / 申购费明细」基线下沉到私有夹具
 *   `data/state/regression_cases.json` 的 principalCaliber 段（已被 .gitignore 忽略）。
 *   夹具缺失 → L2b 打印 SKIP 并继续，**绝不 FAIL**，公开仓才能原样共用同一份脚本。
 *   本文件自身**不得**出现任何真实金额/份额字面量 —— 审计脚本的 FAIL 级红线。
 *
 * ★ 不联网、不写任何数据文件。用法：node backend/scripts/verify_principal_caliber.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const buyPlan = require(path.join(ROOT, 'backend', 'lib', 'buyPlan'));
const store = require(path.join(ROOT, 'backend', 'lib', 'store')); // 统一走数据访问层（归一 + 单一路径真相源）

let pass = 0, fail = 0;
function t(name, cond, actual) {
  if (cond) { pass++; console.log('  \u2705 ' + name); }
  else { fail++; console.log('  \u274c ' + name + (actual !== undefined ? '  \u2192 实际: ' + JSON.stringify(actual) : '')); }
}

// ══════════════════════════════════════════════════════════════
// 数据来源判定 —— 两仓共用同一份脚本，靠「数据长什么样」决定 L2 层是跑还是跳：
//   · 真实持仓          → 全量断言
//   · 示例数据 / 缺文件 / 缺夹具 → SKIP（不 FAIL）
// ══════════════════════════════════════════════════════════════
const FIXTURE_PATH = path.join(ROOT, 'data', 'state', 'regression_cases.json');

// 「我跑在示例数据上吗」的判据 = holdings.example.json 的顶层 _comment 标记。
const DEMO_RX = /DEMO DATA|NOT real holdings|placeholder/i;

function loadRealHoldings() {
  let h;
  try { h = store.readJSON('holdings.json'); } // 走数据访问层：与生产同一入口（含 schema 归一），测试/生产输入不分叉
  catch (e) { return { ok: false, reason: '读不到 data/state/holdings.json（还没跑 setup？）' }; }
  if (!h || !Array.isArray(h.funds)) return { ok: false, reason: 'holdings.json 结构异常（无 funds 数组）' };
  if (typeof h._comment === 'string' && DEMO_RX.test(h._comment))
    return { ok: false, reason: '当前是 setup 生成的示例数据（非真实持仓）' };
  return { ok: true, holdings: h };
}

function loadPrivateFixture() {
  try { return { ok: true, fixture: JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) }; }
  catch (e) { return { ok: false, reason: '无私有夹具 data/state/regression_cases.json（公开仓属正常）' }; }
}

function skip(what, reason) {
  console.log('  \u26a0 SKIP —— ' + reason);
  console.log('    （' + what + '：预期行为 —— 公开仓/示例数据下只跑 L1 与 L3）');
}

// ══════════════════════════════════════════════════════════════
console.log('\n【L1-1】netInvestedOf —— 已确认记录优先用券商真值（shares × nav）');
{
  // 有 shares+nav → 一律 shares×nav，**与费率无关**（真值已经是扣费后的结果，不能重算）
  // ★ 一律用**中性构造值**（与任何真实净值/份额都不相同），两仓才能共用同一份脚本。
  const NEUTRAL = { amount: 80, shares: 12.5, nav: 8 };
  t('有 shares+nav → shares × nav',
    Math.abs(buyPlan.netInvestedOf(NEUTRAL, 0) - NEUTRAL.shares * NEUTRAL.nav) < 1e-9,
    buyPlan.netInvestedOf(NEUTRAL, 0));
  t('★ 传入费率被忽略（真值优先，不二次扣费）',
    Math.abs(buyPlan.netInvestedOf(NEUTRAL, 0.5) - NEUTRAL.shares * NEUTRAL.nav) < 1e-9,
    buyPlan.netInvestedOf(NEUTRAL, 0.5));
}

console.log('\n【L1-2】netInvestedOf —— 在途记录用 amount × (1 − 费率) 预估');
{
  t('在途（shares=null）：400 @0.15% → 399.4',
    Math.abs(buyPlan.netInvestedOf({ amount: 400, shares: null, nav: null }, 0.0015) - 399.4) < 1e-9,
    buyPlan.netInvestedOf({ amount: 400, shares: null, nav: null }, 0.0015));
  t('在途：费率 0 → 净投入 === amount',
    buyPlan.netInvestedOf({ amount: 100, shares: null }, 0) === 100,
    buyPlan.netInvestedOf({ amount: 100, shares: null }, 0));
  t('在途：nav 缺失也能算（费率与净值无关）',
    Math.abs(buyPlan.netInvestedOf({ amount: 200, shares: null, nav: null }, 0.0012) - 199.76) < 1e-9,
    buyPlan.netInvestedOf({ amount: 200, shares: null, nav: null }, 0.0012));
}

console.log('\n【L1-3】netInvestedOf / netInvestedTotal —— 边界与非法输入');
{
  t('空数组 → 0', buyPlan.netInvestedTotal([], 0.0015) === 0);
  t('null → 0', buyPlan.netInvestedTotal(null, 0.0015) === 0);
  t('费率非法（>=1）按 0 处理', buyPlan.netInvestedOf({ amount: 100, shares: null }, 1.2) === 100,
    buyPlan.netInvestedOf({ amount: 100, shares: null }, 1.2));
  t('费率负数按 0 处理', buyPlan.netInvestedOf({ amount: 100, shares: null }, -0.1) === 100,
    buyPlan.netInvestedOf({ amount: 100, shares: null }, -0.1));
  t('amount 缺失 → 0', buyPlan.netInvestedOf({ shares: null }, 0.0015) === 0);
  t('amount 非法（字符串）→ 0', buyPlan.netInvestedOf({ amount: 'abc', shares: null }, 0.0015) === 0);
  t('p 为 null → 0', buyPlan.netInvestedOf(null, 0.0015) === 0);
  // 单调性：费率越高，净投入越低（两者是两个口径，不可互换）
  const ps = [{ amount: 1000, shares: null }];
  t('★ 费率单调性：0.15% 的净投入 < 0% 的净投入',
    buyPlan.netInvestedTotal(ps, 0.0015) < buyPlan.netInvestedTotal(ps, 0),
    { f15: buyPlan.netInvestedTotal(ps, 0.0015), f0: buyPlan.netInvestedTotal(ps, 0) });
}

// ══════════════════════════════════════════════════════════════
console.log('\n【L2】存量数据关系式（读 holdings.json，不硬编码金额）');
{
  const real = loadRealHoldings();
  if (!real.ok) {
    skip('L2「实付 / 净投入关系式」', real.reason);
  } else {
    const h = real.holdings;
    let totalPaid = 0, totalNet = 0, confirmed = 0, pending = 0;
    const badRatio = [], badZeroFee = [], badOrder = [];
    const zeroFeePctDiff = [];

    for (const f of h.funds) {
      const fr = buyPlan.validFeeRate(f.feeRate);
      const ps = Array.isArray(f.purchases) ? f.purchases : [];
      const paid = ps.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const net = buyPlan.netInvestedTotal(ps, f.feeRate);
      confirmed += ps.filter(p => p.shares != null).length;
      pending += ps.filter(p => p.shares == null).length;
      totalPaid += paid; totalNet += net;

      // ① 有费率的基金：净投入必须**严格小于**实付（差额 = 申购费）
      // ② 费率 = 0 的基金：两口径应**重合**，残差只来自份额 4 位小数舍入 ——
      //    ★ 注意这个残差**可正可负**（份额被舍入上去时 Σ shares×nav 会略高于 Σ amount，
      //      实测最大 +4.71e-4，如 016452 的 +0.00047），故不能断言「净投入必 ≤ 实付」。
      //      它也不是费用：纯舍入噪声，与费率无关。
      if (fr > 0) {
        if (!(net < paid - 1e-9)) badOrder.push(`${f.code} fr=${fr} net=${net} paid=${paid}`);
      } else {
        if (Math.abs(net - paid) > 0.01) badZeroFee.push(`${f.code} net=${net} paid=${paid}`);
        const pctDiff = paid > 0 ? Math.abs(net - paid) / paid * 100 : 0;
        zeroFeePctDiff.push(pctDiff);
      }
      // ③ 关联式：申购费 = 实付 − 净投入 ≥ 0（全组合层面恒成立，见下文总校验）
      if (fr > 0) {
        const expectFee = ps.reduce((s, p) => s + (Number(p.amount) || 0) * fr, 0);
        const actualFee = paid - net;
        if (Math.abs(actualFee - expectFee) > 0.01) badRatio.push(`${f.code} fee=${actualFee} expect≈${expectFee}`);
      }
    }

    console.log(`  （已确认 ${confirmed} 笔 / 在途 ${pending} 笔）`);
    t('★ 有费率的基金：净投入 < 实付（差额 = 申购费）', badOrder.length === 0, badOrder.slice(0, 3));
    t('费率 > 0 的基金：申购费 ≈ Σ amount × 费率（±0.01）', badRatio.length === 0, badRatio.slice(0, 3));
    t('★ 费率 = 0 的基金：净投入 ≡ 实付（残差 < 0.01，源自 4 位份额舍入，可正可负）',
      badZeroFee.length === 0, badZeroFee.slice(0, 3));
    t('★ 费率 = 0 ⇒ 两口径收益率偏差 < 0.01pp（算法零影响）',
      Math.max(...zeroFeePctDiff) < 0.01, Math.max(...zeroFeePctDiff));
    t('全组合：总净投入 ≤ 总实付（申购费非负）', totalNet <= totalPaid + 1e-9, { totalPaid, totalNet });
    console.log(`  合计：实付 ${totalPaid.toFixed(4)} · 净投入 ${totalNet.toFixed(4)} · 申购费 ${(totalPaid - totalNet).toFixed(4)}`);
  }
}

// ══════════════════════════════════════════════════════════════
console.log('\n【L2b】本金口径基线（真实值只在私有夹具里）');
{
  const fx = loadPrivateFixture();
  const pc = (fx.ok && fx.fixture.principalCaliber) ? fx.fixture.principalCaliber : null;
  if (!pc) {
    skip('L2b「本金口径基线」', fx.ok ? '夹具里没有 principalCaliber' : fx.reason);
  } else {
    const feeSum = (pc.feeDetail || []).reduce((s, x) => s + x.rate * x.amount, 0);
    t('实付 − 净投入 = 申购费总额',
      Math.abs((pc.paid - pc.netInvested) - pc.feeTotal) < 0.01,
      { paid: pc.paid, netInvested: pc.netInvested, diff: pc.paid - pc.netInvested, feeTotal: pc.feeTotal });
    t('费用明细 Σ(费率 × 金额) = 申购费总额（±0.01）',
      Math.abs(feeSum - pc.feeTotal) < 0.01, { feeSum, feeTotal: pc.feeTotal });
    t('交叉验证：实付 − 申购费 = 净投入',
      Math.abs((pc.paid - pc.feeTotal) - pc.netInvested) < 0.01);
    t('申购费 > 0（确有费率口径差异存在）', pc.feeTotal > 0 && pc.paid > pc.netInvested);
  }
}

// ══════════════════════════════════════════════════════════════
console.log('\n【L3】接线不变量（源码级）');
{
  const A = fs.readFileSync(path.join(ROOT, 'backend', 'engines', 'analysis.js'), 'utf8');
  const B = fs.readFileSync(path.join(ROOT, 'backend', 'lib', 'buyPlan.js'), 'utf8');
  const C = fs.readFileSync(path.join(ROOT, 'backend', 'engines', 'advice.js'), 'utf8');
  const O = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pages', 'overview.js'), 'utf8');
  const S = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

  // ── buyPlan 导出 ──
  t('buyPlan 导出 netInvestedOf / netInvestedTotal',
    /module\.exports = \{[^}]*netInvestedOf[^}]*netInvestedTotal/.test(B));

  // ── analysis：口径切换 ──
  t('analysis 引入 buyPlan', /require\('\.\.\/lib\/buyPlan'\)/.test(A));
  t('analysis 计算 netInvested（用 buyPlan.netInvestedTotal）',
    /const netInvested = buyPlan\.netInvestedTotal\(purchases, f\.feeRate\)/.test(A));
  t('★ 收益基准 = netInvested（而非 principal）',
    /currentValue - netInvested/.test(A) && !/currentValue - principal/.test(A));
  t('★ 收益率分母 = netInvested（而非 principal）',
    /profit \/ netInvested \* 100/.test(A) && !/profit \/ principal \* 100/.test(A));
  t('★ 全组合收益基准 = totalNetInvested',
    /totalValue - totalNetInvested/.test(A) && !/totalValue - totalPrincipal/.test(A));
  t('totals 透出 totalNetInvested / totalFee',
    /totals: \{[^}]*totalNetInvested[^}]*totalFee/.test(A));
  t('有费率的基金逐个透出 netInvested / fee（fund 对象）',
    /totalShares, principal, netInvested, fee, currentValue, profit, profitPct/.test(A));

  // ── analysis：★ 浮点累加必须在顺序 for 回环里（不得进 Promise.all 的 map）──
  //   map 块的结尾是 `  }));`（三个收尾符号），非贪婪匹配必须锚到这个才准确
  const mapBlock = A.match(/const results = await Promise\.all\(holdings\.funds\.map\([\s\S]*?\n {2}\}\)\);/);
  t('累加未写进 Promise.all 的 map 块（浮点操作数顺序约束）',
    !!mapBlock && !/totalNetInvested \+=/.test(mapBlock[0]), !!mapBlock);
  const loopBlock = A.match(/for \(const r of results\) \{[\s\S]*?\n {2}\}/);
  t('★ totalNetInvested 在顺序 for 回环内累加',
    !!loopBlock && loopBlock[0].includes('totalNetInvested += r.netInvested'));

  // ── analysis：principal 语义未变（仍是实付）──
  t('principal 仍 = Σ amount（语义未变，快照历史依赖）',
    /const principal = purchases\.reduce\(\(s, p\) => s \+ \(p\.amount \|\| 0\), 0\)/.test(A));
  t('totalPrincipal 仍累加 r.principal', /totalPrincipal \+= r\.principal/.test(A));

  // ── advice：口径注释 + l1 字段 ──
  t('advice 减仓判据仍用 f.profitPct（未改判据本身）', /f\.profitPct >= trimPct/.test(C));
  t('advice 注释标明 profitPct 为净口径', C.includes('净口径'));
  t('advice 注释标明该规则当前休眠', C.includes('休眠'));
  t('advice l1 补 totalNetInvested / totalFee',
    /l1 = \{[\s\S]*?totalNetInvested[\s\S]*?totalFee[\s\S]*?\};/.test(C));

  // ── overview：KPI ──
  const kpiCalls = O.match(/kpi\('/g) || [];
  t('overview 有 4 张 KPI', kpiCalls.length === 4, kpiCalls.length);
  t('overview 含「累计投入」KPI', /kpi\('累计投入'/.test(O));
  t('overview 引用 totalNetInvested / totalPrincipal / totalFee',
    O.includes('totalNetInvested') && O.includes('totalPrincipal') && O.includes('totalFee'));
  t('kpi() 支持第 5 参 title（口径可查）', /function kpi\(label, value, sub, tone, title\)/.test(O));
  t('★ 每月投入面板文案含「实付合计」（防与新 KPI 主值同屏矛盾）',
    O.includes('实付合计'));

  // ── sw：缓存版本已升（防「忘了升版本」回归）──
  const cache = (S.match(/const CACHE = '([^']+)'/) || [])[1];
  t('sw.js 缓存版本已升过 v23', !!cache && cache !== 'fund-board-v23', cache);
}

// ══════════════════════════════════════════════════════════════
// L3b —— 基金费率：抓取 → 落盘 → 防改（2026-09-23）
//   本组的重点是**负向**不变量：「界面改不动费率」是功能要求，不是编码风格。
//   一旦被破坏（有人加回输入框、或把写盘前的盖回删掉），后果是**静默算错成本**
//   而不是报错 —— 只能靠断言锁住，不能只靠 code review。
// ══════════════════════════════════════════════════════════════
console.log('\n【L3b】基金费率接线（抓取 / 落盘 / 防改）');
{
  const FEE = fs.readFileSync(path.join(ROOT, 'backend', 'engines', 'feeSync.js'), 'utf8');
  const FET = fs.readFileSync(path.join(ROOT, 'backend', 'fetchers.js'), 'utf8');
  const SRV = fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8');
  const A2 = fs.readFileSync(path.join(ROOT, 'backend', 'engines', 'analysis.js'), 'utf8');

  // ── 抓取层 ──
  t('fetchers 导出 fetchFundRates', /module\.exports = \{[\s\S]*?fetchFundRates[\s\S]*?\}/.test(FET), undefined);
  t('★ 费率走东财移动接口且用移动端 UA（桌面 UA 会被业务码 61136403 拦成「假 200」）',
    /FundMNRateInfo/.test(FET) && /fetchFundRates[\s\S]{0,600}?ARCHIVE_UA/.test(FET), undefined);

  // ── 落盘层 ──
  t('feeSync 导出 syncFundFees', /module\.exports = \{ syncFundFees/.test(FEE), undefined);
  t('★ 抓不到时保留原值：feeRate 仅在拿到折后价时覆盖，且没有 0 兜底（0 = 免申购费，是有效值）',
    /if \(it\.r\.sub && it\.r\.sub\.rate != null\) it\.f\.feeRate = it\.r\.sub\.rate;/.test(FEE)
    && !/feeRate\s*\|\|\s*0/.test(FEE), undefined);
  t('★ TTL 判据用数字时间戳 updatedAt（若误用日期串 updated，相减得 NaN ⇒ 每次全量重抓）',
    /d\.updatedAt = now;/.test(FEE) && /detail\.updatedAt/.test(FEE) && /d\.updated = day;/.test(FEE), undefined);

  // ── 防改层（负向）──
  t('server 定义 pinFundFees', /function pinFundFees\(incoming\)/.test(SRV), undefined);
  const idxPin = SRV.indexOf('pinFundFees(data.holdings)');
  const idxWrite = SRV.indexOf("writeJSONSafe('holdings.json'");
  t('★ /api/save 在写盘**之前**调用 pinFundFees（顺序不可对调，否则等于没保护）',
    idxPin > -1 && idxWrite > -1 && idxPin < idxWrite, { idxPin: idxPin, idxWrite: idxWrite });
  t('★ 新增基金剥掉费率字段（留下的 feeRate:0 会被当成「已知的 0」而跳过抓取）',
    /else \{\s*delete f\.feeRate;\s*delete f\.feeDetail;/.test(SRV), undefined);
  t('/api/fees/refresh 端点存在且带鉴权',
    /'\/api\/fees\/refresh'/.test(SRV) && /feeSync\.syncFundFees\(\{ force \}\)/.test(SRV), undefined);
  t('启动延迟 3s + 每 24h 定时（unref 不阻塞进程退出）',
    /setTimeout\(feeRun, 3000\)/.test(SRV) && /setInterval\(feeRun, 24 \* 3600 \* 1000\)/.test(SRV) && /unref/.test(SRV), undefined);

  // ── 展示层：只读（负向断言，扫全部 public/js）──
  const JSDIR = path.join(ROOT, 'public', 'js');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
  });
  const UISRC = walk(JSDIR).map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  t('★ 前端不得写入费率（全 public/js 无 feeRate 的赋值/字面量）',
    !/feeRate\s*[:=](?!=)/.test(UISRC), (UISRC.match(/feeRate\s*[:=](?!=)/g) || []));
  t('★ 前端不得有费率输入框', !/<input[^>]*\bfee/i.test(UISRC), undefined);
  t('analysis 透出 feeRate（经 validFeeRate 归一）/ feeDetail',
    /feeRate: buyPlan\.validFeeRate\(f\.feeRate\)/.test(A2) && /feeDetail: f\.feeDetail/.test(A2), undefined);
  t('★ 费率仍是净投入的输入（analysis 传 f.feeRate 给 netInvestedTotal，语义链未断）',
    /netInvestedTotal\(purchases, f\.feeRate\)/.test(A2), undefined);
}

// ══════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 结果: ' + pass + ' 通过 / ' + fail + ' 失败 \u2500\u2500');
process.exit(fail ? 1 : 0);

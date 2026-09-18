'use strict';
/*
 * 买入方案推导（口径 → 净值 → 份额 → 确认日）
 * ------------------------------------------------------------
 * 本模块是「买一笔要花多少钱、拿到多少份额、按哪天净值成交、份额哪天到账」这条链路的
 * **唯一实现**。在它之前，同一份份额公式在代码里有 3 份拷贝（server.js 编辑分支、
 * server.js 新增分支、engines/backfill.js），其中 server.js 新增分支那份还漏了四舍五入
 * 到 4 位 —— 与 backfill 不一致。现在统一收敛到这里。
 *
 * ★★ 两个日期是两回事（2026-09-17 订正，勿再混）：
 *   pricingDate（成交净值日 / 定价日）—— 份额**只**由它的净值决定
 *   settleDate （份额确认日 / 到账日）—— 份额登记入账的时间，**不参与任何计算**
 *   ⇒ 验证脚本有一条硬断言：**把 settleDate 改错，shares 必须一个字节都不变**。
 *
 * ★ 本模块还独占「名义日 → 真实日期」的顺延判据：
 *   nominalDate = tradeDate.nominalPricingDate(date, session)   （只跳周末，是候选不是答案）
 *   真实定价日  = 该基金净值序列中第一个 >= nominalDate 的日期（navQuote.resolveQuoteOnOrAfter）
 *   顺延 > tradeDate.MAX_ROLL_DAYS → 判 pending，交人工确认，绝不硬写份额。
 *   ⚠️ engines/backfill.js 必须与本文件**成对**改，否则预览与自动补填口径会分叉。
 *
 * 依赖方向：buyPlan → tradeDate（口径）、navQuote（有缓存的取净值）。
 * 反向无依赖，故不会成环。本模块**不落盘、无副作用**，预览与保存共用同一实现。
 */
const tradeDate = require('./tradeDate');
const navQuote = require('./navQuote');

// 申购费率安全降级：缺失/非法（非数、负数、>=1）→ 0（不扣费，静默）
function validFeeRate(fr) {
  const f = Number(fr);
  return isFinite(f) && f >= 0 && f < 1 ? f : 0;
}

// 申购费外扣法：份额 = 金额 × (1 − 费率) ÷ 净值，保留 4 位小数。
// 金额/费率/净值任一非法或算出非正数 → null（调用方视为「拿不到份额」）
function computeShares(amount, feeRate, nav) {
  const a = Number(amount), f = validFeeRate(feeRate), n = Number(nav);
  if (!isFinite(a) || a <= 0 || !isFinite(n) || n <= 0) return null;
  const s = a * (1 - f) / n;
  if (!isFinite(s) || s <= 0) return null;
  return Math.round(s * 10000) / 10000;
}

// ---------- 净投入口径（2026-09-18 新增）----------
// 背景：一笔买入实际付出 `amount`，但其中 (amount × 费率) 被当申购费收走、**没有变成份额**。
//   ⇒ 实付（Σ amount） ≠ 净投入（真正买成份额的钱）
//   例：10 元买 QDII，费率 0.15% → 实付 10，净投入 10×(1−0.0015) = 9.985
//
// ★ 两者是两个口径，都有用，不能互相替代：
//   实付   —— 你实际掏出去的钱（算「我投了多少」用这个）
//   净投入 —— 真正变成份额的成本（券商 App「持仓成本」同口径；收益基准用这个）
//
// ★ 已确认记录（有 shares + nav）优先用 `shares × nav`：那是券商真值，含 4 位小数舍入的最终结果，
//   不能用公式重算（否则会把高精度真值降级为公式近似）。
// ★ 在途记录（shares 未确认）无法用 shares×nav → 用 `amount × (1 − 费率)` 预估。
//   费率由基金档案决定、与净值无关，故这一步不依赖「净值已公布」。
function netInvestedOf(p, feeRate) {
  const a = Number(p && p.amount) || 0;
  if (p && p.shares != null && p.nav != null) return Number(p.shares) * Number(p.nav);
  return a * (1 - validFeeRate(feeRate));
}

// 一只基金的净投入合计
function netInvestedTotal(purchases, feeRate) {
  return (Array.isArray(purchases) ? purchases : []).reduce((s, p) => s + netInvestedOf(p, feeRate), 0);
}

// 份额确认日（到账日）：定价日 + 1 工作日（A股）/ + 2 工作日（QDII），
// 再过一次**净值序列顺延**到真实交易日 —— 与定价日**同一套机制、同一个防呆上限**，长假自动正确。
// ★ 顺延 > MAX_ROLL_DAYS（基金长期停牌 / 清盘）→ 日期仍给序列上那个交易日（比名义日靠谱），
//   但必须标 estimated（界面显示「预计到账」）—— **绝不冒充确定值**，判据与定价日那边保持一致。
//   （2026-09-17 补：此前只判断「有没有取到」，不看顺延多远 → 停牌时会把一个远期日期说成「确认」。）
// ★ 序列还没覆盖到那一天（未来）→ 退回名义日并标 estimated。
// ★ 与本文件其他逻辑无关的副作用：它**不参与份额计算**，改它一个字节都不影响 shares。
async function resolveSettleDate(code, pricingDate, market) {
  const nominal = tradeDate.settleNominalDate(pricingDate, market);
  const q = await navQuote.resolveQuoteOnOrAfter(code, nominal);
  if (!q || !q.date) return { settleDate: nominal, settleEstimated: true };
  const rollDays = tradeDate.naturalDayDiff(nominal, q.date);
  return { settleDate: q.date, settleEstimated: rollDays > tradeDate.MAX_ROLL_DAYS };
}

// 单档（某个 session）的预览结果。
//
// ★ 真实定价日 = 「该基金净值序列中第一个 >= 名义日的日期」，由 navQuote.resolveQuoteOnOrAfter 求。
//   名义日 = tradeDate.nominalPricingDate(date, session) —— 只跳周末，**不认节假日**，只是个候选。
//   这样不需要节假日表：顺延时自然收敛（非交易日下单选前选后 → 同一结果）。
//
// status 三态与 engines/backfill.js 的判定严格对齐，前端文案直接按它分支：
//   ok      —— 序列里找到 >= 名义日 的净值，且顺延 <= MAX_ROLL_DAYS，nav/shares 可算
//   pending —— 名义日之后尚无已公布净值（在途），或顺延超过上限（需人工确认）；不置份额
//   error   —— 名义日早于该基金可查范围 / 数据源异常；不阻塞保存
async function previewOne({ code, market, feeRate, date, session, amount }) {
  const nominalDate = tradeDate.nominalPricingDate(date, session);
  const hit = await navQuote.resolveQuoteOnOrAfter(code, nominalDate);
  const base = {
    session, nominalDate,
    pricingDate: null,                                  // ★ 真实成交净值日（主字段）
    settleDate: null, settleEstimated: false,           // ★ 份额确认日（到账日，不参与计算）
    // 【已于 2026-09-17 删除】旧字段名 confirmDate / navDate 不再下发，避免两套口径并存。
    //   磁盘上的老记录仍会被 server.js / backfill.js 当**定价日**读取 —— 那是数据兼容，不是接口协议。
    nav: null, navIsExact: false, shares: null,
    shifted: false, rollDays: null,
  };

  if (!hit || !hit.date) {
    const reason = hit && hit.reason;
    if (reason === 'tooOld') {
      return Object.assign(base, {
        status: 'error',
        message: '按 ' + nominalDate.slice(5) + ' 找不到该基金的净值（早于可查范围），请人工确认',
      });
    }
    if (reason === 'error' || !hit) {
      return Object.assign(base, {
        status: 'error',
        message: '净值暂不可用（数据源无响应），保存后会自动补份额',
      });
    }
    // reason === 'future'：名义日之后还没有已公布的净值 → 正常「在途」，公布后自动补
    return Object.assign(base, {
      status: 'pending',
      message: nominalDate.slice(5) + ' 之后的净值尚未公布，保存后为「在途」，公布后自动补份额',
    });
  }

  const rollDays = tradeDate.naturalDayDiff(nominalDate, hit.date);
  if (rollDays > tradeDate.MAX_ROLL_DAYS) {
    // 顺延太远（基金长期停牌/清盘）→ 不硬写份额，交人工确认
    return Object.assign(base, {
      pricingDate: hit.date,   // 顺延后的真实净值日；仅用于向用户说明「落到了哪天」，仍不写份额
      shifted: true, rollDays,
      status: 'pending',
      message: nominalDate.slice(5) + ' 之后 ' + rollDays + ' 天都没有新净值（超过 ' + tradeDate.MAX_ROLL_DAYS + ' 天上限），请人工确认',
    });
  }

  // 定价日已确定 → 顺带把「份额确认日」也算出来（仅作到账说明，不影响上面的份额公式）
  const settle = await resolveSettleDate(code, hit.date, market);

  return Object.assign(base, {
    pricingDate: hit.date,        // ★ 真实成交净值日（可能已顺延，不等于 nominalDate）
    settleDate: settle.settleDate,
    settleEstimated: settle.settleEstimated,
    nav: hit.nav, navIsExact: true,
    shares: computeShares(amount, feeRate, hit.nav),
    shifted: rollDays > 0, rollDays,
    status: 'ok', message: '',
  });
}

// 预览一笔买入：一次给出「15:00 前 / 15:00 后」两档，方便用户在界面上直接看出差别。
// 两档的定价日通常相同或相邻，navQuote 缓存能吃掉重复请求。
async function previewPurchase({ code, market, feeRate, date, amount, selected }) {
  const fr = validFeeRate(feeRate);
  const variants = {};
  for (const s of ['T', 'T+1']) {
    variants[s] = await previewOne({ code, market, feeRate: fr, date, session: s, amount });
  }
  // 两档收敛：下单日非交易日时，前/后顺延到同一个定价日 → 界面应合并成一行提示。
  // ★ 必须两档都 ok 才算收敛，且用 pricingDate 比较：
  //   - 用 pricingDate 而非别的（pending 时它为 null）；
  //   - 「两档都 pending」不算收敛 —— 长期停牌时两档的 navDate 也相同，但那是「都算不出来」，
  //     合并成「15:00 前后无差别：X 的净值」会误导用户以为 X 可用（实测踩到）。
  const a = variants.T, b = variants['T+1'];
  const converged = !!(a.status === 'ok' && b.status === 'ok' && a.pricingDate && b.pricingDate && a.pricingDate === b.pricingDate);
  return {
    ok: true, code, market: market === 'QDII' ? 'QDII' : 'A', feeRate: fr,
    orderDate: date, amount: Number(amount), selected, converged,
    variants,
  };
}

module.exports = { validFeeRate, computeShares, netInvestedOf, netInvestedTotal, resolveSettleDate, previewOne, previewPurchase };

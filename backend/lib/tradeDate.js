'use strict';
/*
 * 交易口径引擎 —— 买入订单「日期」的单一真相源。
 *
 * ★★ 三个日期必须分清（2026-09-17 订正；此前把 ②③ 压成了同一个字段名 `confirmDate`，是认知陷阱）：
 *
 *   ① 下单日 `date`（申请日 T）—— 用户填写的日期。
 *
 *   ② 成交净值日 = **定价日** `pricingDate` —— 「按哪一天的净值成交」。
 *      15:00 前下单 = T 日；15:00 后 = 下一交易日；非交易日 = 下一交易日。
 *      ★ A 股与 QDII **同规则**（QDII 的 T+2 只影响份额到账，不影响按哪天定价）。
 *      ★ **份额只由定价日的净值决定**：份额 = 金额 × (1 − 费率) ÷ nav(定价日)。
 *
 *   ③ 份额确认日 = 到账日 `settleDate` —— 份额登记入账、能在持仓里看到的时间。
 *      定价日 + 1 个工作日（A 股）/ + 2 个工作日（QDII）。
 *      ★ 它**不参与任何计算**，只说明「份额何时入账」。
 *
 * 「当天买就按当天净值」为什么是对的 —— **未知价原则（事后价法）**：
 *   下单时你能看到的净值是**前一交易日**的（当日净值当晚才算出），
 *   但成交价按**当日收盘净值** —— 基金公司要收齐当日申购款后才算得出来。
 *
 * 背景：session  'T'   = 15:00 前下单（当日交易时段内）
 *                 'T+1' = 15:00 后下单（顺延至下一交易日）
 *                 null  = 未知（2026-09 之前录入的老记录没有时段字段）
 *       market   'A' = A 股 / 'QDII' = 跨境
 *
 * ★ 本模块只产**名义日** —— 只跳周末、**不认节假日**，绝不能当真实日期使用，也不落盘。
 *   真实日期由消费端拿**该基金自己的净值日期序列**顺延：
 *     「序列中第一个 >= 名义日的日期」（见 lib/buyPlan.js / engines/backfill.js）。
 *   这样既不需要维护节假日表，又自动吃下 QDII 的境外休市差异：
 *   历史日期一查一个准；未来日期查不到 → pending（在途），当晚净值公布后自动落位。
 *   名义日因此是**中间量**，可随时由 date + session 重算。
 */
/*
 * 顺延上限（自然日）—— 「最多允许名义日往后顺延几天」的**防呆保险**，不是业务规则。
 *
 * 为什么需要：真实日期 = 序列中第一个 >= 名义日的日期。若某基金**长期停止公布净值**
 * （清盘 / 长期停牌），这个「第一个」可能落在几个月之后 —— 那时系统会拿一个隔了很久的
 * 净值硬算份额，是错的且危险的。> 上限 → 保持 pending，留人工确认。
 *
 * 实测（2026-09-16，对红利/黄金/纳指等 4 只不同类别基金各约 900 个交易日的净值日期序列
 *       逐自然日枚举）：四只基金最大顺延**都是 10 天**。
 *   最坏案例：下单 2023-09-28 选「15:00 后」→ 名义日 2023-09-29（中秋国庆连休首日）
 *             → 真实成交日 2023-10-09 = 顺延 10 天。
 *   原始最长无净值间隔：11 天（2023-09-28→10-09 / 2024-02-08→02-19 / 2026-02-13→02-24）。
 * ∴ 7 天会在国庆/春节卡住（此前默认值就是想当然，已废）；最小安全值 11；取 15 留余量。
 *
 * ★ 全局只此一处定义，buyPlan / backfill 一律 require 本常量，禁止第二份拷贝。
 */
const MAX_ROLL_DAYS = 15;

/*
 * ★★ 日期算术一律用 UTC 锚点 + UTC getter —— 这是本模块的铁律，改动前务必先读这段。
 *
 * 「YYYY-MM-DD」是**日历日**，不带时刻。若把它解析成带时区的瞬间（如 `+08:00`），
 * 再用**本机时区**的 getter/setter（`getDate`/`setDate`/`getDay`/`getFullYear`）去读写，
 * 结果就会随**进程时区**漂移：东八区下恰好正确，跑到 UTC 就整体早一天，
 * 跑到西半球更偏 —— 而且**不报错**，只是静默算出一个错的定价日。
 *
 * 2026-09-18 实测事故：首次 CI 跑在 UTC runner 上，
 * `nominalPricingDate('2026-09-02','T')` 返回 `'2026-09-01'`，
 * 连带 3 个校验脚本集体失败 —— 本机（GMT+8）永远复现不出来。
 *
 * 正确写法：`new Date(dateStr + 'T00:00:00Z')` + `getUTCDate()/setUTCDate()/getUTCDay()/...`
 *   → 纯粹在「日历日」上做加减，与进程时区完全无关，东八区下的结果与旧实现逐字相同。
 * 反例（禁止）：把 UTC 解析与本机 getter 混用；也不要用 `new Date(y, m, d)` 配合本机 getter
 *   去校验日期 —— 那个组合自洽但语义是「本机时区的当地日」，与业务时区（上海）不是一回事。
 */
function addBusinessDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay(); // 0=周日 6=周六
    if (day !== 0 && day !== 6) added++;
  }
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// 下单日 + 时段 → 名义「定价日」（= 申请日 T）。只跳周末，是候选不是答案。
// market 参数已移除：QDII 与 A 股同规则，本函数不再需要它。
function nominalPricingDate(orderDate, session) {
  return addBusinessDays(orderDate, session === 'T+1' ? 1 : 0);
}

/*
 * 【已于 2026-09-17 删除】此处曾有一个 deprecated 别名 `confirmDate`（值 = nominalPricingDate）。
 * 删因：旧名把「定价日」叫成了「确认日」，会让人误以为「份额按确认日的净值算」。
 * ⇒ 此后若在旧文档 / 旧笔记里看到 `confirmDate`，一律理解为**定价日 pricingDate**，
 *   切勿理解为「份额确认日」—— 后者见下面的 settleNominalDate，两者是两回事。
 */

/*
 * 真实定价日 → 名义「份额确认日」= 定价日 + 1 个工作日（A 股）/ + 2 个工作日（QDII）。
 * 这就是份额登记到账的交收节奏，**不参与份额计算**。
 *
 * ★ 它与 legacyConfirmDate 的 offset 完全相同 —— 因为 legacyConfirmDate 当年算的其实是它，
 *   只是被**误用成了「定价日」**（QDII 因此白白多取一天净值）。见到 T+2 即可断定是旧口径遗留。
 * ★ 真实确认日同样必须落在交易日上：消费端拿到本名义日后，要再过一次净值序列顺延。
 */
function settleNominalDate(pricingRealDate, market) {
  return addBusinessDays(pricingRealDate, market === 'QDII' ? 2 : 1);
}

/*
 * 【冻结的历史口径，切勿与新口径混用】
 * ★ 它的真实语义是「**份额确认日 offset**」被误用成了「定价日」—— A 股 +1 / QDII +2
 *   恰恰就是份额登记到账的节奏。2026-09 之前的 backfill 拿它当定价日去取净值，
 *   于是 QDII 白白多取一天 —— 这是历史 10 笔 nav 记错的根因（见 docs/历史买入核对清单.md）。
 * 仅供复现那批历史记录与 backfill 兜底，**勿动**。新代码一律走 nominalPricingDate。
 */
function legacyConfirmDate(orderDate, market) {
  return addBusinessDays(orderDate, market === 'QDII' ? 2 : 1);
}

// 两个日期间隔的「工作日数」（含终点当天，不含起点当天）
function businessDayDiff(fromStr, toStr) {
  let d = new Date(fromStr + 'T00:00:00Z');
  const end = new Date(toStr + 'T00:00:00Z');
  let count = 0;
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

// 两个日期相隔的**自然日数**（to - from，正数表示 to 在后）。
// 口径与 MAX_ROLL_DAYS 同一量纲（自然日），故顺延天数一律用它，禁止各消费端自己减时间戳。
// 注：本函数两个端点锚点相同，差值必是 86400000 的整数倍，故对时区本就不敏感；
//     仍统一用 Z 锚点，是为了让「本文件全部走 UTC」这条规则没有例外可被后人模仿。
function naturalDayDiff(fromStr, toStr) {
  const a = new Date(fromStr + 'T00:00:00Z');
  const b = new Date(toStr + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

// 反向：给定下单日 / 定价日 → 推断 session（校验辅助，与 nominalPricingDate 互逆）
// 新口径下 QDII 与 A 股一致：前=T(差 0) 后=T+1(差 1)
function sessionFromPricingDate(orderDate, pricingDate, market) { // eslint-disable-line no-unused-vars
  const diff = businessDayDiff(orderDate, pricingDate);
  return diff === 0 ? 'T' : 'T+1';
}

// 【已于 2026-09-17 删除】此处曾有 deprecated 别名 `sessionFromConfirm`（= sessionFromPricingDate）。
// 删因同上：旧名带 confirm，而它推的其实是**定价日**，与 confirmDate 属同源错误。

module.exports = {
  MAX_ROLL_DAYS,
  addBusinessDays,
  nominalPricingDate,
  settleNominalDate,
  legacyConfirmDate,
  businessDayDiff,
  naturalDayDiff,
  sessionFromPricingDate,
};

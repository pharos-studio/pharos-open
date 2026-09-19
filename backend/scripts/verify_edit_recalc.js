'use strict';
/*
 * 回归测试：买入记录「编辑重算」口径（2026-09-18 改造）
 *
 * 背景（改造前真实缺陷）：
 *   编辑表单靠一个「按新成交日重算净值/份额」勾选框驱动重算，而该框默认不勾
 *   （`chk.checked = (p.shares == null)`，实测全部记录都有份额 ⇒ 永不默认勾选）。
 *   于是「改了时段/日期 → 点保存」数值纹丝不动；更糟的是手动校正与重算写成
 *   **两个并列 if**，同时操作时重算分支被静默跳过、`payload.recalc` 从未赋值。
 *
 * 改造后口径（本脚本锁定）：
 *   ① 重算唯一判据 = 定价日键是否变化（movedKey = 日期 + 时段），与任何勾选框无关；
 *   ② 只改「金额 / 备注」**绝不触发重算** —— 保护券商真实值（高精度、6 位小数）不被
 *      4 位公式值静默覆盖；
 *   ③ 手动校正入口与在途补填入口全部移除（真实值修正走数据层）。
 *   ⇒ 定价日只由 `date + session` 唯一决定，见 backend/lib/tradeDate.js:nominalPricingDate。
 *
 * 覆盖分三层（本仓库能测到什么就测到什么，不装样子）：
 *   L1 纯函数   —— 定价日 / 份额确认日 / 份额公式（可直接调用，最硬）
 *   L2 存量数据 —— 全局不变量 + 已修正记录的逐字段断言（防漂回）
 *   L3 前端接线 —— holdings.js 源码级不变量（重算守卫、已删入口、无死变量）
 *
 * ★ 本文件在「数据机（私有仓）」与「开源版（公开仓）」两仓**逐字节相同**。
 *   真实数值一律下沉到私有夹具 `data/state/regression_cases.json`（已被 .gitignore 忽略）。
 *   夹具缺失、或当前跑在 setup 生成的示例数据上 → L2 打印 SKIP 并继续，**绝不 FAIL**
 *   （否则公开仓的 CI 第一天就是红的，闸门随即被所有人无视）。
 *   本文件自身**不得**出现任何真实净值/份额字面量 —— 这是审计脚本的 FAIL 级红线。
 *
 * ★ 不联网、不写任何数据文件。用法：node backend/scripts/verify_edit_recalc.js
 * ★ L2 刻意**不做**「定价日 vs 净值序列」比对：那需要联网取净值（本仓库净值序列无本地副本），
 *   会把这个回归脚本变成联网脚本 —— 那类核查留在临时审计脚本里做（一次性、可联网）。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const tradeDate = require(path.join(ROOT, 'backend', 'lib', 'tradeDate'));
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
// setup 是**整文件复制** ⇒ 该标记必然出现在运行期的 holdings.json 里，无需新增字段。
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
console.log('\n【L1-1】定价日规则：定价日只由「日期 + 时段」决定');
{
  // 2026-06-15 周一 / 06-16 周二 / 09-02 周三 / 09-04 周五 / 09-05 周六 / 09-07 周一
  t('T（15:00前）= 当日', tradeDate.nominalPricingDate('2026-09-02', 'T') === '2026-09-02',
    tradeDate.nominalPricingDate('2026-09-02', 'T'));
  t('T+1（15:00后）= 次一工作日', tradeDate.nominalPricingDate('2026-09-02', 'T+1') === '2026-09-03',
    tradeDate.nominalPricingDate('2026-09-02', 'T+1'));
  t('T+1 跨周末：周五 → 下周一', tradeDate.nominalPricingDate('2026-09-04', 'T+1') === '2026-09-07',
    tradeDate.nominalPricingDate('2026-09-04', 'T+1'));
  t('T+1 周六下单 → 周一', tradeDate.nominalPricingDate('2026-09-05', 'T+1') === '2026-09-07',
    tradeDate.nominalPricingDate('2026-09-05', 'T+1'));
  // ★ 名义日只跳周末、不认节假日 —— 这是刻意的：真实成交日交给净值序列顺延（navQuote）
  t('T 落在周六时不给「名义日」做周末修正（原样返回，交给序列顺延）',
    tradeDate.nominalPricingDate('2026-09-05', 'T') === '2026-09-05',
    tradeDate.nominalPricingDate('2026-09-05', 'T'));
  // 本次改造核心：两者任一变 → 键变 → 必重算；都不变 → 不重算
  t('改时段 → 键变（应重算）',
    tradeDate.nominalPricingDate('2026-09-02', 'T') !== tradeDate.nominalPricingDate('2026-09-02', 'T+1'));
  t('改日期 → 键变（应重算）',
    tradeDate.nominalPricingDate('2026-09-02', 'T') !== tradeDate.nominalPricingDate('2026-09-03', 'T'));
  t('只改金额 → 键不变（不得重算）',
    tradeDate.nominalPricingDate('2026-09-02', 'T') === tradeDate.nominalPricingDate('2026-09-02', 'T'));
}

// ══════════════════════════════════════════════════════════════
console.log('\n【L1-2】份额确认日：A 股 +1 工作日 / QDII +2 工作日');
{
  t('A 股：+1 工作日', tradeDate.settleNominalDate('2026-09-02', 'A') === '2026-09-03',
    tradeDate.settleNominalDate('2026-09-02', 'A'));
  t('QDII：+2 工作日', tradeDate.settleNominalDate('2026-09-02', 'QDII') === '2026-09-04',
    tradeDate.settleNominalDate('2026-09-02', 'QDII'));
  t('A 股跨周末：周五 → 下周一', tradeDate.settleNominalDate('2026-09-04', 'A') === '2026-09-07',
    tradeDate.settleNominalDate('2026-09-04', 'A'));
  t('QDII跨周末：周四 → 下周一', tradeDate.settleNominalDate('2026-09-03', 'QDII') === '2026-09-07',
    tradeDate.settleNominalDate('2026-09-03', 'QDII'));
  // ★ 确认日不参与份额计算 —— 上面 L1-1 的定价日与这里互不影响
  t('确认日顺延上限常量存在（防呆，避免各端自己减时间戳）',
    Number.isFinite(tradeDate.MAX_ROLL_DAYS) && tradeDate.MAX_ROLL_DAYS > 0, tradeDate.MAX_ROLL_DAYS);
}

// ══════════════════════════════════════════════════════════════
console.log('\n【L1-3】份额公式：金额 ×(1−费率) ÷ 净值，4 位四舍五入');
{
  // ★ 一律用**中性构造值**（与任何真实净值/份额都不相同），两仓才能共用同一份脚本。
  t('费率 0：100 / 2 = 50',
    buyPlan.computeShares(100, 0, 2) === 50, buyPlan.computeShares(100, 0, 2));
  t('费率 0.2%：200 ×0.998 / 2.5 = 79.84',
    buyPlan.computeShares(200, 0.002, 2.5) === 79.84, buyPlan.computeShares(200, 0.002, 2.5));
  t('四位小数（除不尽）：100 / 3 = 33.3333',
    buyPlan.computeShares(100, 0, 3) === 33.3333, buyPlan.computeShares(100, 0, 3));
  t('净值 <= 0 → null（不产出假份额）', buyPlan.computeShares(100, 0, 0) === null);
  t('金额 <= 0 → null', buyPlan.computeShares(0, 0, 1.5) === null);
  t('费率非法（>=1）按 0 处理', buyPlan.computeShares(100, 1.2, 2) === buyPlan.computeShares(100, 0, 2));
}

// ══════════════════════════════════════════════════════════════
console.log('\n【L2-1】存量数据全局不变量');
{
  const real = loadRealHoldings();
  if (!real.ok) {
    skip('L2-1「定价日 / 确认日全局不变量」', real.reason);
  } else {
    const h = real.holdings;
    let confirmed = 0, pending = 0;
    const badWeekend = [], badSettle = [], badSum = [];
    for (const f of h.funds) {
      const market = f.market === 'QDII' ? 'QDII' : 'A';
      const feeRate = buyPlan.validFeeRate(f.feeRate);
      for (const p of f.purchases || []) {
        if (p.shares == null) { pending++; continue; }
        confirmed++;
        const pd = p.pricingDate || p.navDate || null;
        if (!pd) { badSum.push(`${f.code} ${p.date} 缺定价日`); continue; }
        // ① 定价日必须是工作日（真实成交日；序列顺延的结果）
        // ★ 用 UTC getter 取星期几：本机时区 getter 会随进程时区漂移（UTC 下整体早一天）
        const dow = new Date(pd + 'T00:00:00Z').getUTCDay();
        if (dow === 0 || dow === 6) badWeekend.push(`${f.code} ${p.date} pd=${pd}`);
        // ② 确认日不得早于「定价日 + 名义 offset」
        if (p.settleDate) {
          const need = market === 'QDII' ? 2 : 1;
          if (tradeDate.businessDayDiff(pd, p.settleDate) < need) {
            badSettle.push(`${f.code} ${p.date} pd=${pd} sd=${p.settleDate}`);
          }
        }
      }
    }
    console.log(`  （已确认 ${confirmed} 笔 / 在途 ${pending} 笔）`);
    t('每笔定价日都落在工作日', badWeekend.length === 0, badWeekend.slice(0, 3));
    t('每笔确认日不早于 定价日+名义offset（A+1 / QDII+2）', badSettle.length === 0, badSettle.slice(0, 3));
    t('每笔都有定价日（无「有份额却无定价日」的悬空记录）', badSum.length === 0, badSum.slice(0, 3));
  }
}

// ══════════════════════════════════════════════════════════════
console.log('\n【L2-2】已修正记录逐字段锁定（防漂回旧值）');
{
  // 2026-09-18 修正：定价日错位（改过时段/日期但未重算）+ legacyConfirmDate 的 +1 偏移。
  // 用户已对照券商 App 核定：券商实际值 = 夹具里登记的「修正后」值。
  // ★ 这批数值**只存在于私有夹具**，本文件不得出现真实净值/份额字面量。
  const real = loadRealHoldings();
  const fx = loadPrivateFixture();
  const CASES = (fx.ok && Array.isArray(fx.fixture.editRecalcCases)) ? fx.fixture.editRecalcCases : [];
  if (!real.ok) {
    skip('L2-2「已修正记录逐字段锁定」', real.reason);
  } else if (!CASES.length) {
    skip('L2-2「已修正记录逐字段锁定」', fx.ok ? '夹具里没有 editRecalcCases' : fx.reason);
  } else {
    console.log(`  （夹具 ${CASES.length} 笔 · 来源 data/state/regression_cases.json）`);
    const h = real.holdings;
    for (const c of CASES) {
      const f = h.funds.find(x => x && x.code === c.code);
      const p = f && (f.purchases || []).find(x => x && x.date === c.date && x.amount === c.amount);
      const tag = `${c.code} ${c.date} ¥${c.amount}`;
      if (!p) { t(tag + ' 记录存在', false, 'NOT_FOUND'); continue; }
      t(`${tag} 定价日 = ${c.pd}`, p.pricingDate === c.pd, p.pricingDate);
      t(`${tag} 净值 = ${c.nav}`, Math.abs(Number(p.nav) - c.nav) < 1e-9, p.nav);
      t(`${tag} 份额 = ${c.sh}`, Math.abs(Number(p.shares) - c.sh) < 1e-9, p.shares);
      t(`${tag} 确认日 = ${c.sd}`, p.settleDate === c.sd, p.settleDate);
      t(`${tag} 时段 = ${c.session}`, p.session === c.session, p.session);
      // 定价日必须与「date + session」推出的名义日一致（这 5 笔都是工作日，无需顺延）
      t(`${tag} 定价日自洽（= nominalPricingDate）`,
        p.pricingDate === tradeDate.nominalPricingDate(p.date, p.session),
        { pd: p.pricingDate, nominal: tradeDate.nominalPricingDate(p.date, p.session) });
      // 份额与自身净值/费率互洽（服务端权威重算的产物）
      const exp = buyPlan.computeShares(p.amount, buyPlan.validFeeRate(f.feeRate), p.nav);
      t(`${tag} 份额 = 公式(金额, 费率, 净值)`, exp != null && Math.abs(Number(p.shares) - exp) < 1e-9,
        { got: p.shares, exp });
    }
  }
}

// ══════════════════════════════════════════════════════════════
console.log('\n【L3】前端接线不变量（public/js/pages/holdings.js 源码级）');
{
  const SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pages', 'holdings.js'), 'utf8');

  // ① 重算守卫 = movedKey()，且 payload.recalc 只在那个分支里被赋值
  const mkMatch = SRC.match(/const movedKey = \(\) => \(([\s\S]*?)\);/);
  t('movedKey 判据只依赖「日期 + 时段」',
    !!mkMatch && mkMatch[1].includes('dateI.value') && mkMatch[1].includes('sessT.getSession()')
    && !mkMatch[1].includes('amtI') && !mkMatch[1].includes('p.amount'),
    mkMatch && mkMatch[1].trim());
  const guard = SRC.match(/if \(movedKey\(\)\) \{[\s\S]*?\n {4}\}/);
  t('重算分支由 movedKey() 守卫', !!guard, !!guard);
  t('payload.recalc 在 movedKey 分支内赋值', !!guard && guard[0].includes('payload.recalc = true'));
  t('payload.recalc 全文件只赋值一次',
    (SRC.match(/payload\.recalc\s*=/g) || []).length === 1,
    (SRC.match(/payload\.recalc\s*=/g) || []).length);
  t('payload 初始对象不含 recalc（默认不重算）',
    !/const payload = \{[^}]*recalc/.test(SRC));

  // ② 勾选框已删除
  t('已无勾选框节点（type:"checkbox" 不存在）', !SRC.includes("type: 'checkbox'"));
  t('已无勾选框容器变量 chkRow', !SRC.includes('chkRow'));
  t('已无勾选框驱动（chk.checked 不存在）', !SRC.includes('chk.checked'));
  // 「按新成交日重算净值/份额」只允许出现在**正向提示文案**里（1 处），不得再有勾选框标签
  t('「按新成交日重算净值/份额」仅剩 1 处正向提示',
    (SRC.match(/按新成交日重算净值\/份额/g) || []).length === 1,
    (SRC.match(/按新成交日重算净值\/份额/g) || []).length);

  // ③ 手动校正入口已删除（addForm + editForm 两处）
  //    注意：注释里允许提到「手动校正」（记录本次删除），只断言**代码行**不再出现
  const codeOnly = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  t('代码中已无手动校正折叠块', !codeOnly.includes('手动校正'));
  t('代码中已无校正说明文案（填写后直接写回）', !codeOnly.includes('填写后直接写回'));
  t('已无真实净值/份额覆盖输入（placeholder 不存在）',
    !SRC.includes('真实净值') && !SRC.includes('真实份额'));
  t('已无校正输入变量 shOv / navOv', !SRC.includes('shOv') && !SRC.includes('navOv'));

  // ④ 在途补填入口已删除
  t('已无 backfillEditor 函数与入口', !SRC.includes('backfillEditor'));
  t("已无「补填」按钮文案", !SRC.includes("'补填'"));

  // ⑤ 无死变量
  t('已无 manual 死变量', !/\bmanual\b/.test(SRC));
  t('autoFilled 仍被正常使用（记一笔的在途判定）',
    (SRC.match(/autoFilled/g) || []).length >= 2, (SRC.match(/autoFilled/g) || []).length);

  // ⑥ 方案 B 两行带标签
  t('净值/份额两列均使用 .pv-kv 两行结构',
    (SRC.match(/class: 'pv-kv'/g) || []).length === 2, (SRC.match(/class: 'pv-kv'/g) || []).length);
  t('已无「→ 新值」行内箭头写法', !SRC.includes("'→ ' + v.nav.toFixed(4)"));

  // ⑦ 样式配套（public/style.css）
  const CSS = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  t('style.css 已定义 .pv-kv', CSS.includes('.pv-kv {'));
  t('style.css 已定义 .pv-kv .k 标签列', CSS.includes('.pv-kv .k {'));
  t('style.css 已清理勾选框样式 .chk（功能已删除）', !CSS.includes('.chk {'));
}

// ══════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 结果: ' + pass + ' 通过 / ' + fail + ' 失败 \u2500\u2500');
process.exit(fail ? 1 : 0);

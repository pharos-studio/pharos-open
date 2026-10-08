'use strict';
// 降级视图（路线 3）离线验证。纯计算，不联网、不写盘。
const assert = require('assert');
const degradedView = require('../lib/degradedView');
const identity = require('../lib/activeEquityIdentity');

// 最新在前、日期严格递减 —— 与 fetchers.fetchNavHistory 的返回顺序一致。
const rows = [
  { date: '2026-09-25', nav: 1.20 }, { date: '2026-09-24', nav: 1.10 },
  { date: '2026-09-23', nav: 1.00 }, { date: '2026-09-22', nav: 1.25 },
  { date: '2026-09-19', nav: 1.50 }, { date: '2026-09-18', nav: 1.40 },
];

function main() {
  // ── 1. 正常降级视图 ────────────────────────────────────────────────
  const v = degradedView.build({
    code: '123456', name: '合成混合', fundType: '混合型-偏股', market: 'A',
    rows, blockedReason: 'profile_unverified',
    source: 'https://fundf10.eastmoney.com/jjjz_123456.html', sourceFetchedAt: 1750000000000,
  });
  assert(v.ok && v.degraded === true, '应当产出降级视图');
  assert.strictEqual(v.isAdvice, false);
  assert.strictEqual(v.viewVersion, 'degraded-view-v1');
  assert.strictEqual(v.navBasis, 'raw_unit_nav');
  assert.strictEqual(v.adjustmentsApplied, false);
  assert.strictEqual(v.blockedReason, 'profile_unverified');
  assert.strictEqual(v.blockedLabel, '官方身份或自动档案未核验');
  assert(v.disclaimer.includes('不构成任何买入'), '必须带免责声明');

  // ★ 最关键的一条：返回体里不允许出现任何「判断类」字段（连 null 都不行）。
  const FORBIDDEN = ['action', 'verdict', 'marketVerdict', 'executable', 'trigger', 'eligible',
    'positionScore', 'compositeScore', 'compositeLabel', 'candidate', 'scoreMap'];
  const seen = new Set();
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') for (const k of Object.keys(node)) { seen.add(k); walk(node[k]); }
  })(v);
  for (const k of FORBIDDEN) assert(!seen.has(k), '降级视图不得包含判断类字段：' + k);
  // 不给 verdict 的 false/空值版本：也确认没有 marketVerdict:null 这种诱导性形状
  assert(!JSON.stringify(v).includes('"marketVerdict"'), '不得出现 marketVerdict:null 这种诱导形状');

  // ── 2. 事实算术 ────────────────────────────────────────────────────
  // 升序：1.40, 1.50, 1.25, 1.00, 1.10, 1.20  → 峰值 1.50(09-19)，谷值 1.00(09-23)，回撤 33.33%
  assert.strictEqual(v.facts.observations, 6);
  assert.strictEqual(v.facts.firstDate, '2026-09-18');
  assert.strictEqual(v.facts.latestDate, '2026-09-25');
  assert.strictEqual(v.facts.firstNav, 1.4);
  assert.strictEqual(v.facts.latestNav, 1.2);
  assert.strictEqual(v.facts.cumulativeReturnUnadjustedPct, Math.round((1.2 / 1.4 - 1) * 10000) / 100);
  assert.strictEqual(v.facts.maxDrawdownUnadjustedPct, 33.33);
  assert.strictEqual(v.facts.maxDrawdownPeakDate, '2026-09-19');
  assert.strictEqual(v.facts.maxDrawdownTroughDate, '2026-09-23');
  // 单调上涨 ⇒ 回撤为 0（同样必须「最新在前」：09-24 → 09-22）
  const up = [{ date: '2026-09-24', nav: 1.3 }, { date: '2026-09-23', nav: 1.2 }, { date: '2026-09-22', nav: 1.1 }];
  const upView = degradedView.build({ code: '123456', rows: up, blockedReason: 'scope_unsupported' });
  assert(upView.ok === true, '单调上涨样本应通过校验：' + JSON.stringify(upView));
  assert.strictEqual(upView.facts.maxDrawdownUnadjustedPct, 0);

  // ── 3. 不可用项必须写明原因（而不是给一个看起来能用的错数）────────────
  const keys = v.unavailable.map(x => x.key);
  assert.deepStrictEqual(keys, ['adjusted_nav', 'dca_simulation', 'buy_or_sell_judgement']);
  v.unavailable.forEach(x => assert(x.reason && x.reason.length > 10, '每项不可用都必须写原因：' + x.key));
  assert(v.caveats.some(c => /未复权/.test(c)), '必须声明未复权口径');
  assert(v.caveats.some(c => /跳空/.test(c)), '必须说明分红日跳空');

  // ── 4. fail-closed：原因码不认识 ⇒ 不降级 ──────────────────────────
  for (const bad of ['', 'whatever', 'nav_rows_invalid', 'RELEASE_PENDING', null, undefined]) {
    const r = degradedView.build({ code: '123456', rows, blockedReason: bad });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.degraded, false, '未知原因码不得降级：' + bad);
    assert.strictEqual(r.error, 'block_reason_not_recognized');
  }
  // 全部已知原因码都能降级
  for (const reason of degradedView.KNOWN_BLOCK_REASONS) {
    const r = degradedView.build({ code: '123456', rows, blockedReason: reason });
    assert(r.ok === true, '已知原因码应可降级：' + reason);
    assert(r.blockedLabel, '每个已知原因码都要有中文标签：' + reason);
  }

  // ── 5. fail-closed：净值行不合法 ⇒ 不降级 ──────────────────────────
  const bad = [
    ['空数组', []],
    ['非数组', 'nope'],
    ['日期非法', [{ date: '2026-13-40', nav: 1 }, { date: '2026-09-22', nav: 1 }]],
    ['缺 nav', [{ date: '2026-09-23' }, { date: '2026-09-22', nav: 1 }]],
    ['nav<=0', [{ date: '2026-09-23', nav: 0 }, { date: '2026-09-22', nav: 1 }]],
    ['nav 非数', [{ date: '2026-09-23', nav: 'x' }, { date: '2026-09-22', nav: 1 }]],
    ['日期递增(顺序反了)', [{ date: '2026-09-22', nav: 1 }, { date: '2026-09-23', nav: 1.1 }]],
    ['日期重复', [{ date: '2026-09-22', nav: 1 }, { date: '2026-09-22', nav: 1.1 }]],
  ];
  for (const [label, r] of bad) {
    const out = degradedView.build({ code: '123456', rows: r, blockedReason: 'profile_unverified' });
    assert.strictEqual(out.ok, false, '非法净值行必须拒绝：' + label);
    assert.strictEqual(out.error, 'nav_rows_invalid', '错误码不对：' + label);
  }
  // 代码格式
  for (const c of ['12345', '1234567', 'abcdef', '']) {
    assert.strictEqual(degradedView.build({ code: c, rows, blockedReason: 'profile_unverified' }).error, 'invalid_fund_code');
  }

  // ── 6. 已核验基金不得走降级：一套口径 ────────────────────────────────
  // 直接对真实台账验证：四门全过的条目 eligibility() 必须返回 null，
  // 于是 server.js 的 /api/fund-degraded 会返回 fund_verified 而不是降级视图。
  const verified = identity.LEDGER.funds.filter(e => identity.eligibility(e) === null).map(e => e.code);
  assert(verified.length > 0, '台账里应至少有已核验条目');
  for (const code of verified) {
    const entry = identity.LEDGER.funds.find(e => e.code === code);
    const gateError = identity.eligibility(entry);
    assert.strictEqual(gateError, null, code + ' 已核验却被闸门拦下');
  }
  // 未核验条目必须给出本模块认识的原因码（否则降级端点会 422）
  const blocked = identity.LEDGER.funds.filter(e => identity.eligibility(e) !== null);
  for (const e of blocked) {
    const r = identity.eligibility(e);
    assert(degradedView.KNOWN_BLOCK_REASONS.has(r), '闸门原因码必须被降级视图认识：' + e.code + ' → ' + r);
  }
  // 被闸门拦下的条目必须都能降级 —— 否则真实数据走到降级端点会拿到 422。
  // 注意：拦下它们的通常是采样/连续性/规则门，不是身份门（台账 9 条的 identityVerified 都为 true）。
  assert(blocked.length > 0, '台账里应存在被闸门拦下的条目，否则降级路径无从验证');
  const reasonTally = {};
  blocked.forEach(e => { const r = identity.eligibility(e); reasonTally[r] = (reasonTally[r] || 0) + 1; });

  console.log('degraded view: 事实口径、禁字段、fail-closed 与一套口径校验通过');
  console.log('  降级已知原因码 ' + degradedView.KNOWN_BLOCK_REASONS.size + ' 种；已核验 ' + verified.length +
    ' 只不回退降级；被闸门拦下 ' + blocked.length + ' 只 → ' + JSON.stringify(reasonTally));
}
main();
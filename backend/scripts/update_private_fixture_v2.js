'use strict';

// 数据机专用：严格份额迁移成功后，把被 .gitignore 忽略的私有回归夹具同步到 v2 真值。
// 不联网；只从已完成迁移的 holdings.json 派生，原子替换 regression_cases.json。
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const buyPlan = require('../lib/buyPlan');
const math = require('../lib/purchaseMath');

const fixturePath = store.dataPath('regression_cases.json');
if (!fs.existsSync(fixturePath)) {
  console.error('未找到私有夹具 data/state/regression_cases.json；公开仓无需运行本脚本。');
  process.exit(2);
}

const holdings = store.readJSONRaw('holdings.json');
if (!holdings || holdings._schemaVersion !== 2 || !holdings._shareMigration || holdings._shareMigration.status !== 'complete') {
  console.error('holdings 尚未完成 v2 份额迁移，拒绝更新私有夹具。');
  process.exit(2);
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const byCode = new Map((holdings.funds || []).filter(Boolean).map((f) => [String(f.code), f]));
let updatedCases = 0;
for (const c of (fixture.editRecalcCases || [])) {
  const fund = byCode.get(String(c.code));
  const purchase = fund && (fund.purchases || []).find((p) =>
    String(p.date) === String(c.date) && Math.round(Number(p.amount) * 100) === Math.round(Number(c.amount) * 100));
  if (!purchase) throw new Error('私有夹具引用的买入记录不存在，拒绝发布部分更新');
  c.session = purchase.session == null ? null : purchase.session;
  c.pd = purchase.pricingDate || purchase.navDate || purchase.confirmDate || null;
  c.nav = purchase.nav;
  c.sh = purchase.shares;
  c.sd = purchase.settleDate || null;
  c.shareCalcVersion = math.SHARE_CALC_VERSION;
  updatedCases++;
}

let paid = 0, netInvested = 0;
const feeGroups = new Map();
for (const fund of (holdings.funds || [])) {
  for (const p of (fund.purchases || [])) {
    const amount = Number(p.amount) || 0;
    paid += amount;
    netInvested += buyPlan.netInvestedOf(p, fund.feeRate);
    const rate = p.feeWaived ? 0 : math.normalizeRate(p.quotedFeeRate != null ? p.quotedFeeRate : fund.feeRate);
    if (rate == null || rate <= 0 || amount <= 0) continue;
    const key = String(fund.code) + '|' + rate;
    const old = feeGroups.get(key) || { code: String(fund.code), rate, amount: 0 };
    old.amount += amount;
    feeGroups.set(key, old);
  }
}
fixture.principalCaliber = Object.assign({}, fixture.principalCaliber, {
  _note: 'v2 外扣法：feeTotal = 实付 − Σ(shares×nav)，feeDetail 理论费 = Σ[amount−amount/(1+rate)]；两者允许 4 位份额舍入产生分级误差。',
  paid,
  netInvested,
  feeTotal: paid - netInvested,
  feeDetail: Array.from(feeGroups.values()),
});
fixture.shareCalcVersion = math.SHARE_CALC_VERSION;
fixture.generatedAt = new Date().toISOString();

const tmp = fixturePath + '.v2-' + process.pid + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(fixture, null, 2), 'utf8');
fs.renameSync(tmp, fixturePath);
console.log(`私有夹具已升级到 v2：${updatedCases} 个锁定用例，${feeGroups.size} 个费率分组。`);

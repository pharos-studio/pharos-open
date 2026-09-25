'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const math = require('../lib/purchaseMath');
const store = require('../lib/store');
const fetchers = require('../fetchers');
const migration = require('../engines/shareMigration');
const feeSync = require('../engines/feeSync');
const allocation = require('../engines/alloc/allocation');

let pass = 0, fail = 0;
function t(name, cond, actual) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (actual === undefined ? '' : ' → ' + JSON.stringify(actual))); }
}

console.log('\n【申购 v2 数学内核】');
const normal = math.calculatePurchase({ amount: 200, nav: 2.5, quotedFeeRate: 0.002, feeWaived: false });
t('外扣除法 amount/(1+rate)/nav', normal.ok && normal.shares === 79.8403, normal);
const waived = math.calculatePurchase({ amount: 200, nav: 2.5, quotedFeeRate: null, feeWaived: true });
t('积分抵扣允许未知标准费率且有效费率为 0', waived.ok && waived.shares === 80 && waived.effectiveRate === 0, waived);
t('未知费率且不抵扣时拒算', math.calculatePurchase({ amount: 100, nav: 1, quotedFeeRate: null }).code === 'UNKNOWN_FEE_RATE');
t('非法金额拒算', math.calculatePurchase({ amount: 0, nav: 1, quotedFeeRate: 0 }).code === 'INVALID_AMOUNT');
t('非法净值拒算', math.calculatePurchase({ amount: 1, nav: 0, quotedFeeRate: 0 }).code === 'INVALID_NAV');
t('四位舍入', math.calculatePurchase({ amount: 100, nav: 3, quotedFeeRate: 0 }).shares === 33.3333);
t('固定金额费率不猜测', math.normalizeRate('每笔 1 元') === null);

console.log('\n【申购状态与可执行性】');
const now = Date.now();
const open = feeSync.normalizePurchaseStatus({ sgState: '开放申购', maxBuyRaw: '不限额', maxBuy: 100000000000 }, now);
const limited = feeSync.normalizePurchaseStatus({ sgState: '限大额', maxBuyRaw: '5000', maxBuy: 5000 }, now);
const suspended = feeSync.normalizePurchaseStatus({ sgState: '暂停申购', maxBuyRaw: '10', maxBuy: 10 }, now);
t('开放不限额哨兵在后端归一', open.state === 'open' && open.unlimited === true && open.maxBuy === null, open);
t('限额保留实际正数上限', limited.state === 'limited' && limited.maxBuy === 5000 && !limited.unlimited, limited);
t('暂停不显示伪造小额上限', suspended.state === 'suspended' && suspended.maxBuy === null && !suspended.unlimited, suspended);
const freshOpen = allocation.purchaseStatusMeta({ purchaseStatus: open }, now);
const freshSuspended = allocation.purchaseStatusMeta({ purchaseStatus: suspended }, now);
const staleOpen = allocation.purchaseStatusMeta({ purchaseStatus: Object.assign({}, open, { updatedAt: now - 25 * 3600 * 1000 }) }, now);
t('开放且新鲜时市场 add 可执行', allocation.purchaseDecision('add', freshOpen, 100).executable === true);
t('暂停时强制 hold 且不可执行', allocation.purchaseDecision('add', freshSuspended, 100).verdict === 'hold' && !allocation.purchaseDecision('add', freshSuspended, 100).executable);
t('状态过期时保留 marketVerdict 输入但对外 hold', staleOpen.unavailable && allocation.purchaseDecision('add', staleOpen, 100).verdict === 'hold');
t('用户上限 0 硬拦截，正数不拦截', allocation.purchaseDecision('add', freshOpen, 0).blocked && !allocation.purchaseDecision('add', freshOpen, 1).blocked);

console.log('\n【严格迁移准备】');
(async () => {
  const oldFetch = fetchers.fetchNavHistory;
  fetchers.fetchNavHistory = async () => ({ failed: false, history: [{ date: '2026-01-02', nav: 2 }] });
  try {
    const v1 = { _schemaVersion: 1, funds: [
      { code: '000000', feeRate: 0.002, purchases: [{ date: '2026-01-01', pricingDate: '2026-01-01', amount: 200, nav: 2.5, shares: 1 }] },
      { code: '000001', feeRate: 0, purchases: [] },
    ] };
    const hist = [{ date: '2026-01-02', funds: [
      { code: '000000', value: 1, principal: 1 },
      { code: '000001', value: 0, principal: 0 },
    ] }];
    const before = JSON.stringify(v1);
    const out = await migration._prepare(v1, hist);
    const p = out.holdings.funds[0].purchases[0];
    t('迁移准备不修改原对象', JSON.stringify(v1) === before);
    t('旧份额全部覆盖为公式 v2', p.shares === 79.8403 && p.sharesSource === 'formula-v2' && p.shareCalcVersion === 2, p);
    t('冻结升级时当前费率', p.quotedFeeRate === 0.002 && p.shareCalcBasis === 'migration-current-rate', p);
    t('历史日期和记录数保持不变', out.history.length === hist.length && out.history[0].date === hist[0].date);
    t('历史按累计份额×最近官方净值重建', Math.abs(out.history[0].funds[0].value - 159.6806) < 1e-9, out.history[0]);
    t('历史收益按净投入而非实付重建',
      Math.abs(out.history[0].totalNetInvested - p.shares * p.nav) < 1e-9 &&
      Math.abs(out.history[0].totalProfit - (out.history[0].totalValue - out.history[0].totalNetInvested)) < 1e-9,
      out.history[0]);
    t('无买入流水的零值快照占位允许迁移',
      out.history[0].funds[1].value === 0 && out.history[0].funds[1].netInvested === 0,
      out.history[0].funds[1]);
    const orphanValue = await migration._prepare(v1, [{ date: '2026-01-02', funds: [{ code: '000001', value: 1, principal: 1 }] }]);
    t('无流水但有历史价值时严格失败', orphanValue.errors.some(e => e.code === 'HISTORICAL_VALUE_WITHOUT_LEDGER'), orphanValue.errors);
    const deleted = await migration._prepare(v1, [{ date: '2026-01-02', funds: [{ code: '999999', value: 0, principal: 0 }] }]);
    t('已删除基金即使快照为零也严格失败', deleted.errors.some(e => e.code === 'DELETED_FUND_WITHOUT_LEDGER'), deleted.errors);
    const bad = { _schemaVersion: 1, funds: [{ code: '000000', feeRate: 0.002, purchases: [{ date: '2026-01-01', amount: 10 }] }] };
    const badBefore = JSON.stringify(bad);
    const failed = await migration._prepare(bad, []);
    t('缺成交净值使整次准备失败', failed.errors.some(e => e.code === 'MISSING_PURCHASE_NAV'), failed.errors);
    t('失败仍不修改输入', JSON.stringify(bad) === badBefore);
  } finally { fetchers.fetchNavHistory = oldFetch; }

  console.log('\n【并发锁与源码门禁】');
  const seq = [];
  await Promise.all([
    store.withFileLocks(['test-holdings'], async () => { seq.push('a1'); await new Promise(r => setTimeout(r, 15)); seq.push('a2'); }),
    store.withFileLocks(['test-holdings'], async () => { seq.push('b1'); seq.push('b2'); }),
  ]);
  t('同文件写操作严格串行', seq.join(',') === 'a1,a2,b1,b2', seq);
  const sourceFiles = [path.join(ROOT, 'backend', 'server.js')];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full); else if (ent.name.endsWith('.js')) sourceFiles.push(full);
  });
  walk(path.join(ROOT, 'backend', 'lib')); walk(path.join(ROOT, 'backend', 'engines'));
  const all = sourceFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  t('生产代码不再包含 amount × (1-rate) 计算', !/\*\s*\(\s*1\s*-\s*(?:f|fee|rate)|amount\s*\*\s*\(\s*1\s*-/i.test(all));
  const service = fs.readFileSync(path.join(ROOT, 'backend', 'engines', 'purchaseService.js'), 'utf8');
  t('普通请求仅在 sharesSource=broker 时接受客户端份额', /d\.sharesSource === 'broker'/.test(service) && /INVALID_BROKER_TRUTH/.test(service));
  t('broker 切换抵扣分支不调用公式覆盖份额', /old\.sharesSource === 'broker' && d\.revokeBroker !== true/.test(service));

  console.log('\n── 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ──');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

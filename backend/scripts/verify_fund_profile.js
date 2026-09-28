'use strict';
const assert = require('assert');
const profile = require('../lib/fundProfile');
const fetchers = require('../fetchers');
const quote = require('../lib/indexQuote');

async function main() {
  const originalAuto = fetchers.fundAutoFill, originalQuote = quote.fetchIndexQuote;
  const samples = {
    '000311': { name: '沪深300基金', type: '指数型-股票', market: 'A', indexCode: '000300', indexName: '沪深300', trackIndex: 'SH000300', suggestedCategory: 'broad', suggestedCaliber: 'cn', suggestedBy: 'index' },
    '000312': { name: '沪深300基金B', type: '指数型-股票', market: 'A', indexCode: '000300', indexName: '沪深300', trackIndex: 'SH000300', suggestedCategory: 'broad', suggestedCaliber: 'cn', suggestedBy: 'index' },
    '161725': { name: '中证白酒基金', type: '指数型-股票', market: 'A', indexCode: '399997', indexName: '中证白酒', suggestedCategory: 'broad', suggestedCaliber: 'cn', suggestedBy: 'type' },
    '000216': { name: '上海金ETF联接', type: '指数型-其他', market: 'A', indexCode: 'AU9999', indexName: '上海金', suggestedCategory: 'cycle', suggestedBy: 'type' },
    '270042': { name: '纳指QDII', type: 'QDII-指数', market: 'QDII', indexCode: 'NDX100', indexName: '纳斯达克100', suggestedCategory: 'broad', suggestedCaliber: 'us', suggestedBy: 'type' },
    '110022': { name: '主动股票基金', type: '股票型', market: 'A', suggestedCategory: 'growth', suggestedBy: 'type' },
  };
  try {
    assert.strictEqual(quote.eastmoneySymbol('000300'), '1.000300');
    assert.strictEqual(quote.eastmoneySymbol('399997'), '0.399997');
    assert.strictEqual(quote.eastmoneySymbol('AU9999'), null);
    const stamp = Math.floor(Date.now() / 1000);
    const rawQuote = await quote.fetchIndexQuote('eastmoney', '1.000300', {
      fetchText: async () => JSON.stringify({ data: { f43: 402312, f60: 400000, f58: '沪深300', f86: stamp } }),
    });
    assert(rawQuote && rawQuote.changePct > 0 && rawQuote.provider === 'eastmoney');
    assert.strictEqual(await quote.fetchIndexQuote('eastmoney', '1.000300', {
      fetchText: async () => JSON.stringify({ data: { f43: 0, f60: 400000, f86: stamp } }),
    }), null);
    fetchers.fundAutoFill = async code => ({ found: true, code, source: 'archive', ...samples[code] });
    quote.fetchIndexQuote = async (provider, symbol) => ({ name: symbol, quoteTime: new Date().toISOString(), provider, symbol, current: 100, prevClose: 99, changePct: 1 });
    const tracked = await profile.lookup('000311');
    assert.strictEqual(tracked.autoProfile.estimateIndex, '1.000300');
    assert.strictEqual(tracked.autoProfile.estimateRelation, 'tracked');
    assert.strictEqual(tracked.confirmations.proxy, false);
    assert.strictEqual(profile.applySelected(tracked, tracked.profileRevision, {}).profile.category, 'broad');
    const saved = { funds: [{ code: '000311', ...tracked.autoProfile, purchases: [{ amount: 10 }] }] };
    assert(profile.profileWriteError({ funds: [{ code: '000311', ...tracked.autoProfile, name: '伪造名称' }] }, saved));
    assert(profile.profileWriteError({ funds: [{ code: '123456', ...tracked.autoProfile }] }, saved));
    assert.strictEqual(profile.profileWriteError({ funds: [{ ...saved.funds[0] }] }, saved), null);
    assert.strictEqual(profile.applySelected(tracked, 'stale', {}).error, 'PROFILE_REVISION_STALE');
    const sector = await profile.lookup('161725');
    assert.strictEqual(sector.autoProfile.estimateIndex, '0.399997');
    assert.strictEqual(sector.confirmations.category, true);
    assert.strictEqual(profile.applySelected(sector, sector.profileRevision, {}).error, 'INVALID_CONFIRMATION');
    assert.strictEqual(profile.applySelected(sector, sector.profileRevision, { category: 'growth' }).profile.category, 'growth');
    const gold = await profile.lookup('000216');
    assert.strictEqual(gold.confirmations.proxy, true);
    assert.strictEqual(profile.applySelected(gold, gold.profileRevision, { proxy: false }).profile.estimateIndex, null);
    assert.strictEqual(profile.applySelected(gold, gold.profileRevision, { proxy: true }).profile.estimateRelation, 'proxy');
    assert.strictEqual((await profile.lookup('270042')).autoProfile.estimateIndex, null);
    assert.strictEqual((await profile.lookup('110022')).autoProfile.estimateIndex, null);
    quote.fetchIndexQuote = async () => null;
    const outage = await profile.lookup('000312'); // 同一固定样本，使用不同代码避免命中缓存
    assert.strictEqual(outage.estimateStatus, 'temporarily_unavailable');
    assert.strictEqual(outage.autoProfile.estimateIndex, null);
    const old = { funds: [
      { code: '000311', name: '旧名', category: 'custom:a', estimateIndex: 'sh000300', estimateLabel: '沪深300', purchases: [{ amount: 100, shares: 1 }] },
      { code: '110022', name: '旧名2', category: 'custom:missing', purchases: [] },
    ] };
    const cat = { customCategories: [{ key: 'custom:a', name: '旧类别', category: 'broad' }] };
    const migrated = profile.migrateFundRecords(old, cat, new Map([['000311', tracked.autoProfile]]), '2026-09-28T00:00:00Z');
    assert.strictEqual(migrated.holdings.funds[0].category, 'broad');
    assert.strictEqual(migrated.holdings.funds[0].legacyCategoryAudit.key, 'custom:a');
    assert.strictEqual(migrated.holdings.funds[0].estimateIndex, 'sh000300');
    assert.strictEqual(migrated.holdings.funds[0].estimateProvider, 'sina');
    assert.strictEqual(migrated.holdings.funds[1].profileState, 'needs_review');
    assert.deepStrictEqual(migrated.holdings.funds[0].purchases, old.funds[0].purchases);
    assert.strictEqual(profile.migrateFundRecords(migrated.holdings, cat, new Map()).changed, false);
    console.log('fund profile: 识别、确认、行情异常与分类迁移通过');
  } finally { fetchers.fundAutoFill = originalAuto; quote.fetchIndexQuote = originalQuote; }
}
main().catch(e => { console.error(e); process.exitCode = 1; });

'use strict';
// Real analysis/advice code with fixed synthetic external responses and in-memory storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fixture } = require('./fixtures/strategyInputs');
async function snapshot() {
  const config = require('../lib/config'), util = require('../lib/util'), store = require('../lib/store');
  const fetchers = require('../fetchers'), adjusted = require('../lib/fundAdjustedNav');
  const cfg = require('../../data/example/config.example.json');
  const mutations = [];
  const patch = (object, key, value) => { const previous = object[key]; mutations.push(() => { object[key] = previous; }); object[key] = value; };
  const funds = ['core', 'tech', 'gold', 'global', 'hs300'].map(kind => ({ ...fixture(kind, 2),
    purchases: [{ date: '2026-01-02', amount: 100, nav: 2, shares: 50, quotedFeeRate: 0,
      sharesSource: 'broker', shareCalcVersion: 2 }], feeRate: 0 }));
  for (const fund of funds) fund.purchaseStatus.updatedAt = Date.UTC(2026, 8, 24);
  funds.find(f=>f.trackIndex==='SH000300').code='999001'; // New formal identity requires an actual six-digit shape.
  patch(Date, 'now', () => Date.UTC(2026, 8, 24, 1));
  patch(config, 'getConfig', () => cfg);
  patch(util, 'todayStr', () => '2026-09-24');
  patch(util, 'isTradingHours', () => false);
  patch(util, 'shanghaiNow', () => ({ ymd: '2026-09-24', hour: 9, minute: 0 }));
  patch(store, 'readJSON', key => key === 'holdings.json' ? { funds } : key === 'categories.json'
    ? require('../../data/example/categories.example.json') : {});
  for (const key of ['writeJSONSafe', 'writeJSON', 'writeDecisionHistory', 'appendSnapshot'])
    patch(store, key, () => { throw Error('unexpected test write: ' + key); });
  patch(fetchers, 'fetchNavHistory', async code => ({ history: funds.find(f => f.code === code).history, failed: false }));
  patch(fetchers, 'fetchValuation', async () => ({ ...fixture('core', 2).valuation }));
  patch(fetchers, 'fetchBond10Y', async () => ({ cn: .025, us: .04, asOf: '2026-09-22' }));
  patch(fetchers, 'fetchIndexPeHistory', async () => fixture('global', 2).valuation.peHistory);
  patch(fetchers, 'fetchHoldings', async () => ({ holdings: [], reportDate: null }));
  patch(adjusted, 'fetchActions', async () => ({ dividends: [], splits: [] }));
  patch(require('../services/hs300Data'),'forFund',async fund=>require('./fixtures/hs300Inputs').input(fund.code));
  try {
    const analysis = require('../engines/analysis'), advice = require('../engines/advice');
    const built = await analysis.buildAnalysis();
    patch(analysis, 'buildAnalysis', async () => built);
    // Builders must not be called again by advice when analysis already prepared results.
    const { REGISTRY } = require('../engines/registry');
    for (const reg of Object.values(REGISTRY)) patch(reg, 'builder', () => { throw Error('duplicate strategy calculation'); });
    const card = await advice.buildAdvice('pm');
    for (const f of card.funds) {
      const sm = built.plan.scoreMap[f.code];
      assert.equal(f.score, sm.marketScore);
      assert.equal(f.verdict, sm.verdict);
      assert.equal(f.executable, sm.executable);
    }
    const compact = value => Array.isArray(value) ? value.length > 100
      ? { length: value.length, sha256: crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex') }
      : value.map(compact) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, val]) => [key, compact(val)])) : value;
    return JSON.parse(JSON.stringify(compact({ analysis: built, advice: card })));
  } finally { mutations.reverse().forEach(restore => restore()); }
}
if (require.main === module) snapshot().then(result => {
  const previous=JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/strategy-api.json'), 'utf8'));
  const hsCode='999001',oldCode=fixture('hs300',2).code;
  const withoutHs=value=>{const copy=structuredClone(value);copy.analysis.funds=copy.analysis.funds.filter(f=>![hsCode,oldCode].includes(f.code));
    copy.advice.funds=copy.advice.funds.filter(f=>![hsCode,oldCode].includes(f.code));for(const code of [hsCode,oldCode]){
      delete copy.analysis.plan.scoreMap[code];delete copy.advice.weekAgo[code];}return copy;};
  assert.deepEqual(withoutHs(result),withoutHs(previous));
  const h=result.advice.funds.find(f=>f.code===hsCode),sm=result.analysis.plan.scoreMap[hsCode];
  assert.equal(h.strategyVersion,'hs300-dual-v1');assert.equal(h.marketVerdict,sm.marketVerdict);
  assert.equal(h.route,'both');assert.equal(h.score,null);assert.equal(h.valueScore,null);
  console.log('正式接口：analysis/advice 冻结响应完全一致，建议未重复调用策略');
}).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { snapshot };

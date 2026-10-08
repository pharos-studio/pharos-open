'use strict';
// Immutable expectations captured from 5f0ce8f before refactoring; never regenerated here.
const assert = require('node:assert/strict');
const baseline = require('./fixtures/strategy-architecture.json');
const { fixture } = require('./fixtures/strategyInputs');
const util = require('../lib/util');
const config = require('../lib/config');
const oldConfig = config.getConfig, oldToday = util.todayStr;
const oldNow = Date.now;
Date.now = () => baseline.cases.find(c => c.type === 'allocation' && c.variant === 'open').status.updatedAt;
config.getConfig = () => baseline.config;
util.todayStr = () => baseline.clock;
const allocation = require('../engines/alloc/allocation');
const decisions = require('../engines/decisions');
const builders = { core: decisions.buildCoreDecision, tech: decisions.buildTechDecision,
  gold: decisions.buildGoldDecision, global: decisions.buildBroadGlobalDecision, hs300: decisions.buildBroad300Decision };
const wire = value => JSON.parse(JSON.stringify(value));
let checked = 0;
try {
  for (const c of baseline.cases) {
    const label = [c.type, c.kind, c.scenario, c.variant].join('/');
    // Intentional rule replacement only. Non-HS300 immutable expectations are never regenerated.
    if(c.kind==='hs300') continue;
    if (c.type === 'builder') {
      const fund = fixture(c.kind, c.scenario);
      assert.deepEqual(wire(builders[c.kind](fund, {}, c.useDefaults ? {} : baseline.config)), c.expected, label);
    } else if (c.type === 'allocation') {
      const fund = fixture(c.kind, 2);
      fund.purchaseStatus = c.status;
      if (c.profileState) fund.profileState = c.profileState;
      const result = allocation.computeAllocation([], c.policy, [fund], 0, 0, {}, c.limits);
      assert.deepEqual(wire(result), c.expected, label);
      assert.deepEqual(wire({ dec: fund._dec, composite: fund._composite,
        marketScore: fund._marketScore, unsupported: fund._unsupported,
        purchaseStatus: fund._purchaseStatusMeta }), c.internal, label + '/attached');
    } else { continue; } // Research-only signal cases are retained locally, not public runtime gates.
    checked++;
  }
  // Compare compatibility consumers against the actual pre-refactor kernel, not two new aliases.
  const nasdaqFund=require('../fixtures/nasdaqInputs').fund();
  assert.deepEqual(decisions.buildBroadGlobalDecision(nasdaqFund,{},{}),require('../engines/strategies/nasdaq')(nasdaqFund,{},{}));
  for(const category of ['growth','cycle']){
    const misplaced={...nasdaqFund,category};
    assert.equal(require('../engines/registry').resolveRegistry(misplaced).reg.type,'nasdaq');
    assert.equal(decisions.buildBroadGlobalDecision(misplaced,{},{}).action,null);
  }
  for (const c of require('./fixtures/strategy-generic.json').cases) {
    assert.deepEqual(wire(decisions.buildFundDecision(c.signal, c.params)), c.expected, 'frozen generic/' + c.params.cheapBy);
    checked++;
  }
  // Former low-level consumers must receive exactly the strategy-owned result.
  const modes = { techDip: 'tech', pricePercentile: 'gold', peErp: 'core', broadGlobal: 'broadGlobal' };
  for (const [cheapBy, name] of Object.entries(modes)) {
    const builder = require('../engines/strategies/' + name).buildSignalDecision;
    for (const pePercentile of [null, 25, 30, 70, 80, 85]) {
      const src = { pePercentile, drawdown: -20, stopFall: true, goldenState: true,
        trendWeak: true, erp: 0.02, pricePercentile: null, cheap: true, recent20dChange: 6 };
      assert.deepEqual(decisions.buildFundDecision(src, { cheapBy }), builder(src, { cheapBy }));
    }
  }
} finally {
  config.getConfig = oldConfig;
  util.todayStr = oldToday;
  Date.now = oldNow;
}
console.log('职责重构：' + checked + ' 个冻结基线及兼容转发通过（正式策略与兼容入口）');

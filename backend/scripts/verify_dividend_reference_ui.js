'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { Node, tree, fixture } = require('./verify_gold_simple_ui');
function source(file) { return fs.readFileSync(path.join(__dirname, '../../public/js', file), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export /g, ''); }
function harness() {
  const root = new Node('main'), funds = fixture();
  const dividend = funds.find(f => f.category === 'dividend');
  Object.assign(dividend, { purchaseStatus: { state: 'suspended' }, suspended: true, dailyLimit: 500 });
  funds.push({ ...dividend, code: '999888', unsupported: true, displayKind: null, marketState: 'profile_unverified' });
  let calls = 0, fail = false, deferred = false, resolve, response = { state: 'ready',
    explanation: '位置接近近期低点，日RSI开始回升。是否增加投入由你决定。',
    conditions: { lowPosition: true, dailyRsiRising: true },
    metrics: { distancePct: 1.234, previousDailyRsi14: 31.01, dailyRsi14: 35.72, navDate: '2026-10-08', previousNavDate: '2026-09-30' } };
  const context = vm.createContext({ console, document: { createElement: t => new Node(t), createTextNode: t => Object.assign(new Node('#text'), { textContent: t }), getElementById: () => null },
    store: { reloadAdvice: async () => ({ funds, alerts: [] }) }, getDividendReference: async code => {
      assert.equal(code, dividend.code); calls++; if (fail) throw Error('offline');
      return deferred ? new Promise(r => { resolve = r; }) : response;
    } });
  for (const p of ['util.js', 'pages/decision-explanation.js', 'pages/decision-card.js', 'pages/dividend-reference.js', 'pages/decision.js']) vm.runInContext(source(p), context, { filename: p });
  return { context, root, funds, get calls() { return calls; }, fail: v => { fail = v; }, defer: v => { deferred = v; }, response: v => { response = v; }, resolve: value => resolve(value) };
}
async function run() {
  const h = harness(); await h.context.render(h.root);
  assert.equal(h.calls, 0);
  const allCards = h.root.querySelectorAll('.decision-card'), refs = h.root.querySelectorAll('.dividend-reference');
  assert.equal(allCards.length, h.funds.length); assert.equal(refs.length, 1);
  for (let i = 0; i < h.funds.length; i++) if (h.funds[i].category !== 'dividend')
    assert.deepEqual(tree(allCards[i]), tree(h.context.decisionStatusCard(h.funds[i])), 'other cards unchanged');
  const details = refs[0], card = details.parentElement, before = card.children[0].textContent;
  assert.equal(details.open, false); assert.match(before, /计划：每月定投/);
  h.defer(true); details.open = true; await details.fire('toggle'); await details.fire('toggle');
  assert.equal(h.calls, 1, 'single in-flight load');
  h.resolve({ state: 'unavailable', explanation: '近期净值存在缺口。' }); await new Promise(r => setImmediate(r));
  assert.match(details.textContent, /数据不足/); assert.match(details.textContent, /净值存在缺口/); assert(!details.textContent.includes('NaN'));
  h.defer(false); h.fail(true); await details.querySelector('button').fire('click');
  assert.match(details.textContent, /数据不足/); assert.match(details.textContent, /加载失败/); assert.match(details.textContent, /重试/);
  h.fail(false); await details.querySelector('button').fire('click');
  assert.match(details.textContent, /参考条件满足/); assert.match(details.textContent, /1\.23%/);
  assert.match(details.textContent, /31\.01 → 35\.72/); assert.match(details.textContent, /2026-10-08/);
  assert.match(details.textContent, /暂停申购/); assert.match(details.textContent, /用户每日上限 500元/);
  assert.match(details.textContent, /历史回测未显示明显收益优势/);
  assert.equal(card.children[0].textContent, before);
  const calls = h.calls; details.open = false; await details.fire('toggle'); details.open = true; await details.fire('toggle');
  assert.equal(h.calls, calls, 'reopening does not refetch a loaded card');
  h.response({ state: 'not_met', explanation: '<img onerror=evil()>日RSI尚未上升。', conditions: { lowPosition: true, dailyRsiRising: false },
    metrics: { distancePct: 2, previousDailyRsi14: 50, dailyRsi14: 50, navDate: '2026-10-09', previousNavDate: '2026-10-08' } });
  await details.querySelector('button').fire('click');
  assert.match(details.textContent, /尚未满足/); assert.match(details.textContent, /未上升/);
  assert.equal(details.querySelectorAll('img').length, 0); assert.match(details.textContent, /<img/);
  assert.equal(card.children[0].textContent, before); assert(!/下单|订单/.test(details.textContent));
  console.log('dividend reference UI: actual decision-page lazy disclosure, ready/not-met/unavailable/error recovery, values/dates/constraints, unchanged monthly/other cards, XSS and single-flight passed');
}
if (require.main === module) run().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { run };

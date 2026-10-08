'use strict';
// ============================================================================
// 路线 2（B）· 待核验队列：按「同一份合同还差多少个代码没进台账」排序。
//
// 为什么用这个排序（而不是规模/热度）：
//   实查确认代码里**没有规模/热度数据源**（fundlist_cache 每行只有代码/缩写/名/类型/拼音全称；
//   fetchFundArchive 不返回规模）。而「一只合同还差几个代码没进台账」是**零新依赖**的真实指标：
//   一次取证就能同时清掉 N 个代码的准入，N 越大越划算。
//   ⚠️ 这是**代理指标**：份额多 ≠ 热门。它衡量的是「单位取证能清掉多少条准入」，
//      不是「这只基金有多少人买」。别把两件事混为一谈。
//
// 只读：读 data/cache/fundlist_cache.json 与 backend/data/activeEquityIdentity.json，
//       只往 stdout 或 --out（且 --out 指向 data/ 时拒绝）写。
// ============================================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { isActiveEquityRoute } = require('../lib/activeEquityIdentity');
const identity = require('../lib/activeEquityIdentity');
const { baseName, groupByContract } = require('../lib/fundShareContract');

const FORBIDDEN_OUT = [path.join(ROOT, 'data'), path.join(ROOT, 'backend', 'data')];
function guardOut(dir) {
  const abs = path.resolve(dir);
  for (const bad of FORBIDDEN_OUT)
    if (abs === bad || abs.startsWith(bad + path.sep)) throw new Error('拒绝写进数据目录：' + abs);
  return abs;
}

function loadUniverse() {
  const cache = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cache', 'fundlist_cache.json'), 'utf8'));
  return cache.list.map(r => ({
    code: r[0], short: r[1], name: String(r[2] || ''),
    fundType: String(r[3] || ''), market: /QDII|海外/.test(String(r[3] || '')) ? 'QDII' : 'A',
  }));
}

function main() {
  const outIdx = process.argv.indexOf('--out');
  const limitIdx = process.argv.indexOf('--limit');
  const limit = limitIdx > -1 ? Number(process.argv[limitIdx + 1]) || 30 : 30;

  const rows = loadUniverse();
  const routed = rows.filter(f => isActiveEquityRoute(f));
  const contracts = groupByContract(routed);

  // 已被闸门放行的代码集合 = 台账里 eligibility() 为 null 的条目
  const cleared = new Set(identity.LEDGER.funds.filter(e => identity.eligibility(e) === null).map(e => e.code));
  const inLedger = new Set(identity.LEDGER.funds.map(e => e.code));

  const pending = [];
  for (const g of contracts.values()) {
    const missing = g.codes.filter(c => !cleared.has(c));
    if (!missing.length) continue;
    pending.push({
      contractKey: g.key,
      representative: g.codes[0],
      shares: g.codes,
      shareCount: g.codes.length,
      missingCount: missing.length,
      ledgerHit: g.codes.filter(c => inLedger.has(c)).length,
    });
  }
  // 排序：一次取证能清掉的准入条数 desc → 份额总数 desc → 代码升序（保证可复现）
  pending.sort((a, b) => b.missingCount - a.missingCount || b.shareCount - a.shareCount ||
    (a.representative < b.representative ? -1 : a.representative > b.representative ? 1 : 0));

  const multi = [...contracts.values()].filter(g => g.codes.length > 1);
  console.log('待核验队列（口径：一次取证能清掉的准入条数）\n');
  console.log('全市场代码            =', rows.length);
  console.log('主动权益线代码        =', routed.length);
  console.log('折算合同数            =', contracts.size, '（多份额组 ' + multi.length + '）');
  console.log('已被闸门放行的代码    =', cleared.size);
  console.log('待办合同数            =', pending.length);
  console.log('待办准入条数（代码）  =', pending.reduce((a, g) => a + g.missingCount, 0));
  const buckets = {};
  pending.forEach(g => { const k = g.missingCount; buckets[k] = (buckets[k] || 0) + 1; });
  console.log('按「还差几个代码」分布 =', JSON.stringify(buckets));
  console.log('\n前 ' + Math.min(limit, pending.length) + ' 个合同：');
  console.log('  还差  份额  代表代码  合同名');
  pending.slice(0, limit).forEach((g, i) => {
    console.log('  ' + String(g.missingCount).padStart(4) + '  ' + String(g.shareCount).padStart(4) + '  ' +
      g.representative.padEnd(8) + '  ' + g.contractKey + (g.ledgerHit ? '   （台账已有 ' + g.ledgerHit + ' 条）' : ''));
  });
  console.log('\n⚠️ 这是代理指标（单位取证的准入产出），不是热度排序。');
  console.log('   取证一条合同：node backend/scripts/collect_evidence.js <代表代码>');

  if (outIdx > -1 && process.argv[outIdx + 1]) {
    const dir = guardOut(process.argv[outIdx + 1]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'verification-queue.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), ranking: 'missingCount desc, shareCount desc, representative asc',
      universe: { all: rows.length, activeEquity: routed.length, contracts: contracts.size },
      clearedCodes: [...cleared], pending,
    }, null, 1));
    console.log('\n队列已写 ' + path.join(dir, 'verification-queue.json'));
  }
}
main();
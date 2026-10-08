'use strict';
// 份额折叠口径回归：把 2026-10-08 抽检定稿的数字**锁死**，防止口径被无声改回去。
//
// 为什么必须有这个测试：折叠口径曾以两份分叉实现存在（2 步 vs 3 步，差 39 个合同），
// 且「发布数字的脚本」与「抽样去重的脚本」不是同一份。这份测试让口径的任何改动都会显形。
//
// 输入 data/cache/fundlist_cache.json 是**私有派生缓存**（.gitignore 排除），
// 公开仓上没有 ⇒ 整组跳过而不是失败（与项目既有 SKIP 约定一致）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { baseName, groupByContract } = require('../lib/fundShareContract');
const { isActiveEquityRoute } = require('../lib/activeEquityIdentity');

const CACHE = path.join(__dirname, '..', '..', 'data', 'cache', 'fundlist_cache.json');

// ── 不依赖私有缓存也能跑的单元断言 ────────────────────────────────────
function unit() {
  // ① 缩略语保护：ETF/LOF/FOF/QDII 的末字母**不得**被当份额类别剥掉
  //    （原缺陷：汇添富聚焦成长三个月混合FOF → …混合FO，国投中国价值LOF → …价值LO）
  assert.strictEqual(baseName('汇添富聚焦成长三个月混合FOF'), '汇添富聚焦成长三个月混合FOF');
  assert.strictEqual(baseName('景顺长城养老2055五年持有混合FOF'), '景顺长城养老2055五年持有混合FOF');
  assert.strictEqual(baseName('国投中国价值LOF'), '国投中国价值LOF');
  assert.strictEqual(baseName('招商快线ETF'), '招商快线ETF');
  assert.strictEqual(baseName('华夏中证500ETF'), '华夏中证500ETF');
  //    有份额字母时仍要正常剥（ETF 后缀 + 份额字母的情形）
  assert.strictEqual(baseName('华夏中证500ETF联接A'), '华夏中证500ETF联接');

  // ② 份额字母折叠：A股/后端/中概互联 三种典型
  assert.strictEqual(baseName('中海可转债债券A'), baseName('中海可转债债券C'));
  assert.strictEqual(baseName('华夏成长混合'), baseName('华夏成长混合(后端)'));

  // ③ 币种份额折叠（抽检实证：同一份基金合同的币种类别，已由合同修订公告 + 产品资料概要定证）
  const ccy = groupByContract([
    { code: '000041', name: '华夏全球股票(QDII)(人民币)' },
    { code: '019549', name: '华夏全球股票美元现汇(QDII)' },
    { code: '019550', name: '华夏全球股票美元现钞(QDII)' },
  ]);
  assert.strictEqual(ccy.size, 1, '三个币种份额应折成同一份合同');
  assert.deepStrictEqual([...ccy.values()][0].codes, ['000041', '019549', '019550']);

  // ④ (LOF) 是**份额级属性**（挂在 A 类上，C 类不带）⇒ 应折叠（季报「下属分级基金」实证）
  const lof = groupByContract([
    { code: '501219', name: '华夏智胜先锋股票(LOF)A' },
    { code: '014198', name: '华夏智胜先锋股票C' },
  ]);
  assert.strictEqual(lof.size, 1, '(LOF) 与非 LOF 的 A/C 应折成同一份合同');

  // ⑤ 不同基金不得因折叠而合并（防跨公司同名误并）
  assert.notStrictEqual(baseName('华夏中证500ETF'), baseName('南方中证500ETF'));
  assert.notStrictEqual(baseName('兴全盈禧多元配置三个月持有混合'), baseName('兴全盈泰多元配置三个月持有混合'));

  // ⑥ 空名字不得整堆塌成一个假合同
  assert.strictEqual(groupByContract([{ code: '1', name: '' }, { code: '2', name: '' }]).size, 0);
  // ⑦ 只接受真实代码序
  const g = groupByContract([{ code: 'B', name: 'X混合C' }, { code: 'A', name: 'X混合A' }]);
  assert.deepStrictEqual([...g.values()][0].codes, ['A', 'B'], '组内代码应升序，保证结果可复现');
}

// ── 依赖私有缓存的计数回归 ────────────────────────────────────────────
function universe() {
  if (!fs.existsSync(CACHE)) { console.log('跳过份额折叠计数回归：无 data/cache/fundlist_cache.json（公开仓正常）'); return; }
  const list = JSON.parse(fs.readFileSync(CACHE, 'utf8')).list
    .map(r => ({ code: r[0], name: String(r[2] || ''), fundType: String(r[3] || '') }));

  // 数据卫生：代码必须唯一，否则折叠计数不可信
  assert.strictEqual(new Set(list.map(r => r.code)).size, list.length, '基金代码必须唯一');

  const all = groupByContract(list);
  assert.strictEqual(all.size, 15163, '全市场合同数应为 15163（抽检定稿值）');

  const routed = list.filter(f => isActiveEquityRoute(f));
  const line = groupByContract(routed);
  assert.strictEqual(routed.length, 12313, '主动权益线代码应为 12313');
  assert.strictEqual(line.size, 6544, '主动权益线合同数应为 6544（抽检定稿值）');
  const sizes = [...line.values()].map(g => g.codes.length);
  const multi = sizes.filter(n => n > 1);
  assert.strictEqual(multi.length, 5409, '多份额组应为 5409（抽检定稿值）');
  // 恒等式：合同数 − 多份额组 = 一码一合同
  assert.strictEqual(line.size - multi.length, sizes.filter(n => n === 1).length,
    '恒等式「合同数 − 多份额组 = 一码一合同」必须成立');
  assert.strictEqual(line.size - multi.length, 1135, '一码一合同应为 1135（抽检定稿值）');

  // A类/C类 不得漏并：全量键中不允许出现以「类」结尾的残留
  const leftovers = [...line.keys()].filter(k => /类$/.test(k));
  assert.strictEqual(leftovers.length, 0, '出现未折叠的「类」后缀键：' + leftovers.slice(0, 5).join(', '));

  // 覆盖率自检：每个代码都必须落在且只落在一个合同里
  const total = [...line.values()].reduce((a, g) => a + g.codes.length, 0);
  assert.strictEqual(total, routed.length, '折叠不得丢代码或重复计数');
  console.log('  份额折叠计数回归通过：全市场 ' + list.length + '→' + all.size +
    '；主动权益线 ' + routed.length + '→' + line.size + '（多份额组 ' + multi.length + '）');
}

function main() {
  unit();
  universe();
  console.log('fund share contract: 缩略语保护/份额折叠/币种归一/防误并/定稿计数全部通过');
}
main();
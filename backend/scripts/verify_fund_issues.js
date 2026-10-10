'use strict';
const assert = require('node:assert/strict');
const { collectIssues } = require('../lib/fundIssues');

const rows = collectIssues([
  { code: '000001', name: '未识别类别基金', unsupportedReason: 'needs_review' },
  { code: '000009', name: '缺少分类基金', unsupportedReason: 'unknown' },
  { code: '000002', name: '身份待核基金', strategyVersion: 'hs300-dual-v1',
    unsupportedReason: 'profile_unverified', marketState: 'profile_unverified' },
  { code: '000003', name: '范围外基金', unsupportedReason: 'scope_unsupported' },
  { code: '000004', name: '历史数据不足', strategyVersion: 'hs300-dual-v1', marketState: 'insufficient',
    matrix: { dataError: 'price_warmup' } },
  { code: '000005', name: '正常等待', marketState: 'waiting', matrix: { dataError: null } },
  { code: '000006', name: '暂停申购', marketState: 'candidate', blockedReason: 'purchase_suspended' },
  { code: '000007', name: '用户限额', marketState: 'candidate', blockedReason: 'user_limit_zero' },
  { code: '000008', name: '红利月定投', strategyVersion: 'dividend-monthly-dca-v1', marketState: 'monthly_dca' },
]);

assert.deepEqual(rows.map(x => [x.code, x.type, x.action]), [
  ['000001', 'category', 'reidentify'],
  ['000009', 'category', 'reidentify'],
  ['000002', 'verification', 'wait'],
  ['000003', 'scope', 'wait'],
  ['000004', 'data', 'retry'],
]);
assert.equal(rows.find(x => x.code === '000001').reasonCode, 'needs_review');
assert.match(rows.find(x => x.code === '000001').nextStep, /重新识别/);
assert.match(rows.find(x => x.code === '000002').nextStep, /不能通过手动分类跳过/);
assert.match(rows.find(x => x.code === '000004').detail, /预热完成/);
console.log('基金问题归集：分类、身份、范围、历史数据与普通等待/申购限制隔离通过');

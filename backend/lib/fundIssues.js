'use strict';

const EVIDENCE_REASONS = new Set([
  'profile_unverified', 'daily_sampling_unverified', 'initialization_unverified',
  'official_actions_history_unverified', 'fund_calendar_unverified', 'calendar_unverified',
  'calendar_coverage_short', 'publication_time_unverified', 'valuation_date_unverified',
]);

const DATA_LABELS = {
  hs300_data_unavailable: '沪深300策略数据暂未取得',
  price_warmup: '基金净值历史不足，指标尚未预热完成',
  rsi_incomplete_or_warmup: '已完成周数据不足或不完整',
  pe_not_yet_available: '当期可用估值数据尚未发布',
  pe_missing_prior_months: '历史估值数据不完整',
  stale_pe: '估值数据已过期',
  stale_price: '基金净值数据已过期',
  nav_calendar_coverage_gap: '应已公布的基金净值缺失',
  stale_nav_over_14d: '最新可用基金净值已过期',
  no_known_nav: '当前尚无可用基金净值',
  nav_snapshot_not_current: '基金净值快照已过期',
  active_equity_input_missing: '策略所需数据尚未取得',
  gold_input_missing: '策略所需数据尚未取得',
  path_data_insufficient: '策略所需历史数据不完整',
  data_insufficient: '策略所需历史数据不完整',
  insufficient_adjusted_nav: '复权净值历史不足',
  insufficient_completed_weeks: '已完成周数据不足',
  incomplete_week_close: '最新完整周收盘净值尚不可知',
  dividend_data_unavailable: '复权净值或分红拆分数据暂未取得',
  reported_return_mismatch: '净值收益与分红拆分数据尚未核对一致',
};

function makeIssue(fund, type, reasonCode, detail, nextStep) {
  return {
    code: fund.code, name: fund.name, category: fund.category || null,
    strategyVersion: fund.strategyVersion || null,
    type, reasonCode: reasonCode || type, detail, nextStep,
    action: type === 'category' ? 'reidentify' : type === 'data' ? 'retry' : 'wait',
  };
}

function issueForFund(fund) {
  if (!fund || !fund.code) return null;
  const reason = fund.unsupportedReason || fund.matrix?.dataError || null;
  if (reason === 'needs_review' || reason === 'unknown') {
    return makeIssue(fund, 'category', reason, '基金类别尚未识别。', '在基金详情中选择基础类别并重新识别。');
  }
  if (reason === 'scope_unsupported') {
    return makeIssue(fund, 'scope', reason, '基金身份或跟踪范围不符合当前策略。', '请核对基金跟踪标的；手动改类别不会绕过策略核验。');
  }
  if (reason === 'profile_unverified' || EVIDENCE_REASONS.has(reason)) {
    return makeIssue(fund, 'verification', reason, '必要的官方身份、策略连续性或规则证据尚未核验。', '等待系统取得可靠核验证据；不能通过手动分类跳过。');
  }
  const dataReason = fund.marketState === 'insufficient' || (reason && reason !== 'rule_disabled' && reason !== 'pending');
  if (dataReason) {
    const label = DATA_LABELS[reason] || '策略所需数据暂不完整或已过期。';
    return makeIssue(fund, 'data', reason || 'insufficient', label, '可重新检查；数据恢复后策略信号会自动恢复。');
  }
  return null;
}

function collectIssues(funds) {
  return (Array.isArray(funds) ? funds : []).map(issueForFund).filter(Boolean);
}

module.exports = { issueForFund, collectIssues };

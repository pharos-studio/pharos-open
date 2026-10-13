'use strict';
const LEDGER = require('../data/goldMonthlyIdentity.json');
const { isGoldRoute } = require('./goldIdentity');
const CODES = new Set(['000216','000217','000218','000307','002610','018391','018392']);
const OFFICIAL_HOSTS = new Set(['www.huaan.com.cn','wap.huaan.com.cn','www.gtfund.com','st.gtfund.com','www.efunds.com.cn','cdn.efunds.com.cn','www.bosera.com','www.nffund.com']);
function enabled() { return LEDGER.releaseEnabled === true; }
function isMonthlyRoute(fund) { return enabled() && isGoldRoute(fund); }
function eligibility(e, now = Date.now()) {
  if (!e || !CODES.has(e.code)) return 'scope_unsupported';
  if (e.identityVerified !== true || !/^[a-f0-9]{64}$/.test(e.sourceSha256 || '') || !Number.isFinite(Date.parse(e.verifiedAt)) || Date.parse(e.verifiedAt) > Number(now)) return 'profile_unverified';
  try { const u = new URL(e.source); if (u.protocol !== 'https:' || !OFFICIAL_HOSTS.has(u.hostname) || u.username || u.password) return 'profile_unverified'; } catch (_) { return 'profile_unverified'; }
  if (e.domestic !== true || e.otc !== true || e.currency !== 'CNY' || e.kind !== 'gold-etf-link' || !['A','C'].includes(e.shareClass) || !['spot-gold','shanghai-gold'].includes(e.group)) return 'scope_unsupported';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.effectiveFrom || '') || e.effectiveFrom > new Date(Number(now)).toISOString().slice(0,10)) return 'profile_unverified';
  return null;
}
function evidenceOf(code) { return LEDGER.funds.find(e => e.code === code); }
function monthlyFields(fund, {policy = {}, ps = {}, limit = null} = {}) {
  const constraints = [];
  if (ps.suspended) constraints.push('purchase_suspended');
  else if (ps.unavailable) constraints.push('purchase_status_unverified');
  if (limit != null && limit <= 0) constraints.push('user_limit_zero');
  const bucket = require('./util').engineCategoryToBucket(fund.category);
  if ((policy[bucket] || 'buy') !== 'buy') constraints.push('policy_blocked');
  return { constraints, blockedReason: constraints[0] || null, eligible:false, executable:false, marketVerdict:null, verdict:null };
}
module.exports = { LEDGER, CODES, enabled, isMonthlyRoute, eligibility, evidenceOf, monthlyFields };

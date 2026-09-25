'use strict';

// 申购金额计算的唯一纯数学内核。这里不读文件、不访问网络，也不猜测未知费率。
const SHARE_CALC_VERSION = 2;

function normalizeRate(value) {
  if (value === null || value === undefined || value === '') return null;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate < 1 ? rate : null;
}

function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

function calculatePurchase({ amount, nav, quotedFeeRate, feeWaived }) {
  const paid = Number(amount);
  const price = Number(nav);
  if (!Number.isFinite(paid) || paid <= 0) return { ok: false, code: 'INVALID_AMOUNT' };
  if (!Number.isFinite(price) || price <= 0) return { ok: false, code: 'INVALID_NAV' };

  const quoted = normalizeRate(quotedFeeRate);
  const waived = feeWaived === true;
  if (!waived && quoted === null) return { ok: false, code: 'UNKNOWN_FEE_RATE' };

  const effectiveRate = waived ? 0 : quoted;
  const netAmount = paid / (1 + effectiveRate);
  const shares = round4(netAmount / price);
  if (!Number.isFinite(netAmount) || netAmount <= 0 || !Number.isFinite(shares) || shares <= 0) {
    return { ok: false, code: 'INVALID_RESULT' };
  }
  return {
    ok: true,
    amount: paid,
    nav: price,
    quotedFeeRate: quoted,
    effectiveRate,
    feeWaived: waived,
    netAmount,
    shares,
    shareCalcVersion: SHARE_CALC_VERSION,
  };
}

module.exports = { SHARE_CALC_VERSION, normalizeRate, round4, calculatePurchase };

'use strict';

const store = require('../lib/store');
const buyPlan = require('../lib/buyPlan');
const math = require('../lib/purchaseMath');

function err(code, message, status) {
  const e = new Error(message); e.code = code; e.status = status || 400; return e;
}
function keyIndex(list, key) {
  const date = String(key.date);
  const amount = Math.round(Number(key.amount) * 100) / 100;
  return list.findIndex((p) => p.date === date && Number(p.amount) === amount);
}
function setWaiver(record, waived) {
  if (waived) record.feeWaived = true;
  else delete record.feeWaived;
}
function applyFormula(record, amount, nav, rate, waived) {
  record.quotedFeeRate = rate;
  record.shareCalcVersion = math.SHARE_CALC_VERSION;
  record.sharesSource = 'formula-v2';
  record.shareCalcBasis = record.shareCalcBasis || 'purchase-current-rate';
  setWaiver(record, waived);
  if (nav == null) { record.nav = null; record.shares = null; return; }
  const calc = math.calculatePurchase({ amount, nav, quotedFeeRate: rate, feeWaived: waived });
  if (!calc.ok) throw err(calc.code, calc.code === 'UNKNOWN_FEE_RATE' ? '申购费率未知，无法计算份额' : '申购参数无法计算份额', 422);
  record.nav = Number(nav);
  record.shares = calc.shares;
}

async function mutatePurchase(d) {
  return store.withFileLocks(['holdings.json'], async () => {
    const holdings = store.readJSON('holdings.json');
    if (!holdings || !Array.isArray(holdings.funds)) throw err('INVALID_DATA', 'holdings.json 结构异常', 500);
    const fund = holdings.funds.find((f) => f && f.code === d.code);
    if (!fund) throw err('NOT_FOUND', '基金代码不存在：' + d.code, 404);
    const purchases = Array.isArray(fund.purchases) ? fund.purchases : [];

    if (d.action === 'delete') {
      const index = keyIndex(purchases, d.editKey || {});
      if (index < 0) throw err('NOT_FOUND', '原记录不存在（可能已被删除）', 404);
      purchases.splice(index, 1); fund.purchases = purchases;
      if (!store.writeJSONSafe('holdings.json', holdings)) throw err('WRITE_FAILED', '保存失败', 500);
      return { ok: true, mode: 'delete', name: fund.name };
    }

    const amount = Math.round(Number(d.amount) * 100) / 100;
    const waived = d.feeWaived === true;
    const fundRate = math.normalizeRate(fund.feeRate);
    const brokerInput = d.sharesSource === 'broker';
    if (brokerInput && (!Number.isFinite(Number(d.shares)) || Number(d.shares) <= 0 || !Number.isFinite(Number(d.nav)) || Number(d.nav) <= 0)) {
      throw err('INVALID_BROKER_TRUTH', '券商真值必须同时包含有效 shares 与 nav', 400);
    }
    const rawPricingDate = d.pricingDate || d.navDate || d.confirmDate;
    const pricingDate = typeof rawPricingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawPricingDate) ? rawPricingDate : null;
    const market = fund.market === 'QDII' ? 'QDII' : 'A';
    const settleDate = pricingDate ? (await buyPlan.resolveSettleDate(d.code, pricingDate, market)).settleDate : null;
    let record, mode = 'new';

    if (d.editKey) {
      const index = keyIndex(purchases, d.editKey);
      if (index < 0) throw err('NOT_FOUND', '原记录不存在（可能已被删除）', 404);
      const collision = purchases.findIndex((p, i) => i !== index && p.date === d.date && Number(p.amount) === amount);
      if (collision >= 0) throw err('DUPLICATE', '已存在同日期同金额的记录', 409);
      const old = purchases[index];
      record = Object.assign({}, old, { date: d.date, amount, session: d.session || null, note: d.note || old.note || '' });
      if (brokerInput) {
        record.shares = Number(d.shares); record.nav = Number(d.nav); record.sharesSource = 'broker';
        record.quotedFeeRate = fundRate; record.shareCalcVersion = math.SHARE_CALC_VERSION; record.shareCalcBasis = 'purchase-current-rate';
        record.pricingDate = pricingDate || old.pricingDate || null;
        record.settleDate = settleDate || old.settleDate || null;
        setWaiver(record, waived);
      } else if (old.sharesSource === 'broker' && d.revokeBroker !== true) {
        // 券商真值优先：积分状态只留痕，不碰份额/净值。
        setWaiver(record, waived);
      } else {
        const frozen = math.normalizeRate(old.quotedFeeRate);
        const rate = frozen === null ? fundRate : frozen;
        const changedPricing = d.recalc === true || d.navAuto === true;
        const nav = changedPricing ? (d.nav == null ? null : Number(d.nav)) : Number(old.nav);
        applyFormula(record, amount, Number.isFinite(nav) && nav > 0 ? nav : null, rate, waived);
        record.pricingDate = changedPricing ? pricingDate : (old.pricingDate || old.navDate || old.confirmDate || null);
        record.settleDate = changedPricing ? settleDate : (old.settleDate || null);
      }
      delete record.navDate; delete record.confirmDate;
      purchases[index] = record; mode = 'edit';
    } else {
      const index = purchases.findIndex((p) => p.date === d.date && Number(p.amount) === amount);
      if (index >= 0) {
        const old = purchases[index];
        if (old.shares != null || (d.nav == null && !brokerInput)) throw err('DUPLICATE', '该笔已确认或重复，勿重复录入', 409);
        record = Object.assign({}, old, { session: d.session || null, note: d.note || old.note || '' });
        if (brokerInput) {
          record.shares = Number(d.shares); record.nav = Number(d.nav); record.sharesSource = 'broker';
          record.quotedFeeRate = fundRate; record.shareCalcVersion = math.SHARE_CALC_VERSION; record.shareCalcBasis = 'purchase-current-rate'; setWaiver(record, waived);
        } else applyFormula(record, amount, d.nav == null ? null : Number(d.nav), math.normalizeRate(old.quotedFeeRate) ?? fundRate, waived);
        record.pricingDate = pricingDate; record.settleDate = settleDate;
        purchases[index] = record; mode = 'backfill';
      } else {
        record = { date: d.date, amount, session: d.session || null, pricingDate, settleDate, note: d.note || '' };
        if (brokerInput) {
          record.shares = Number(d.shares); record.nav = Number(d.nav); record.sharesSource = 'broker';
          record.quotedFeeRate = fundRate; record.shareCalcVersion = math.SHARE_CALC_VERSION; record.shareCalcBasis = 'purchase-current-rate'; setWaiver(record, waived);
        } else applyFormula(record, amount, d.nav == null ? null : Number(d.nav), fundRate, waived);
        purchases.push(record);
      }
    }
    fund.purchases = purchases;
    if (!store.writeJSONSafe('holdings.json', holdings)) throw err('WRITE_FAILED', '保存失败（文件被占用）', 500);
    return { ok: true, mode, purchase: record, name: fund.name };
  });
}

module.exports = { mutatePurchase };

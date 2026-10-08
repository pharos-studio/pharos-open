'use strict';
// Fund-own dividend-reinvested NAV. Never substitute accumulated NAV for total return.
const { fetchText } = require('./http');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const cache = new Map();
const sourceUrl = code => `https://fundf10.eastmoney.com/fhsp_${code}.html`;
const clean = html => html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').trim();

function tableRows(html, className) {
  const re = new RegExp(`<table[^>]*class=['"][^'"]*\\b${className}\\b[^'"]*['"][^>]*>[\\s\\S]*?<tbody>([\\s\\S]*?)<\\/tbody>`, 'i');
  const body = html.match(re);
  if (!body) throw new Error(`missing_${className}_table`);
  return [...body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(m => [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(x => clean(x[1])));
}

function parseActions(html, code) {
  const dividends = [], splits = [];
  for (const cells of tableRows(html, 'cfxq')) {
    if (cells.length === 1 && /暂无/.test(cells[0])) continue;
    if (cells.length !== 5 || !DAY.test(cells[2])) throw new Error('unverified_dividend_row');
    const ten = cells[3].match(/每\s*10\s*份派现金\s*([\d.]+)\s*元/);
    const one = cells[3].match(/每\s*份派现金\s*([\d.]+)\s*元/);
    const amount = ten ? Number(ten[1]) / 10 : one ? Number(one[1]) : NaN;
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('unverified_dividend_amount');
    dividends.push({ date: cells[2], amount });
  }
  for (const cells of tableRows(html, 'fhxq')) {
    if (cells.length === 1 && /暂无/.test(cells[0])) continue;
    if (cells.length < 4 || !DAY.test(cells[1])) throw new Error('unverified_split_row');
    const ratio = cells[3].match(/(?:1\s*[:：]\s*|每\s*1\s*份[^\d]*)([\d.]+)/);
    const factor = ratio ? Number(ratio[1]) : NaN;
    if (!Number.isFinite(factor) || factor <= 0) throw new Error('unverified_split_ratio');
    splits.push({ date: cells[1], factor });
  }
  const unique = a => new Set(a.map(x => x.date)).size === a.length;
  if (!unique(dividends) || !unique(splits)) throw new Error('duplicate_corporate_action');
  // 南方基金 2024-10-15 公告：202015 于 2024-10-18 每 10 份派 0.7900 元。
  if (code === '202015' && !dividends.some(x => x.date === '2024-10-18' && Math.abs(x.amount - 0.079) < 1e-8))
    throw new Error('official_distribution_mismatch');
  return { dividends, splits, sourceUrl: sourceUrl(code) };
}

async function fetchActions(code) {
  if (!/^\d{6}$/.test(String(code))) return { error: 'invalid_fund_code' };
  const cached = cache.get(code);
  if (cached && Date.now() < cached.expires) return cached.value;
  try {
    const html = await fetchText(sourceUrl(code), { Referer: 'https://fundf10.eastmoney.com/' }, 20000);
    const value = parseActions(html, code);
    cache.set(code, { value, expires: Date.now() + 24 * 3600000 });
    return value;
  } catch (e) {
    const value = { error: e && e.message || 'corporate_actions_unavailable' };
    cache.set(code, { value, expires: Date.now() + 5 * 60000 });
    return value;
  }
}

function reinvestedNav(history, actions) {
  if (!actions || actions.error || !Array.isArray(actions.dividends) || !Array.isArray(actions.splits))
    return { error: actions && actions.error || 'corporate_actions_unavailable' };
  if (!Array.isArray(history) || history.length < 2) return { error: 'insufficient_nav_history' };
  const rows = history.slice().sort((a, b) => a.date.localeCompare(b.date));
  const dates = new Set();
  for (const r of rows) {
    if (!DAY.test(r.date) || !Number.isFinite(r.nav) || r.nav <= 0 || dates.has(r.date))
      return { error: 'invalid_nav_history' };
    dates.add(r.date);
  }
  const start = rows[0].date, end = rows.at(-1).date;
  const div = new Map(), split = new Map();
  for (const a of actions.dividends) {
    if (!DAY.test(a.date) || !Number.isFinite(a.amount) || a.amount <= 0) return { error: 'invalid_dividend' };
    if (a.date >= start && a.date <= end) {
      if (!dates.has(a.date) || div.has(a.date)) return { error: 'dividend_date_not_in_nav' };
      div.set(a.date, a.amount);
    }
  }
  for (const a of actions.splits) {
    if (!DAY.test(a.date) || !Number.isFinite(a.factor) || a.factor <= 0) return { error: 'invalid_split' };
    if (a.date >= start && a.date <= end) {
      if (!dates.has(a.date) || split.has(a.date) || div.has(a.date)) return { error: 'split_date_unverified' };
      split.set(a.date, a.factor);
    }
  }
  const adjusted = [{ date: rows[0].date, close: 1, rawNav: rows[0].nav }];
  for (let i = 1; i < rows.length; i++) {
    const cur = rows[i], prev = rows[i - 1];
    const factor = split.get(cur.date) || 1, cash = div.get(cur.date) || 0;
    const growth = (cur.nav * factor + cash) / prev.nav;
    if (!Number.isFinite(growth) || growth <= 0) return { error: 'invalid_adjusted_return' };
    const reported = cur.dayChange;
    if ((div.has(cur.date) || split.has(cur.date)) && !Number.isFinite(reported))
      return { error: 'action_return_unverified', date: cur.date };
    if (Number.isFinite(reported) && Math.abs((growth - 1) * 100 - reported) > 0.2)
      return { error: 'reported_return_mismatch', date: cur.date };
    adjusted.push({ date: cur.date, close: adjusted.at(-1).close * growth, rawNav: cur.nav });
  }
  return { rows: adjusted, sourceUrl: actions.sourceUrl, distributionCount: div.size, splitCount: split.size };
}

module.exports = { sourceUrl, parseActions, fetchActions, reinvestedNav };

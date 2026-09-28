'use strict';
// 盘中估算行情只用于近似展示；指数估值锚 trackIndex 由另一套数据源负责。
const { fetchText } = require('./http');

function eastmoneySymbol(indexCode) {
  const code = String(indexCode || '').replace(/^(SH|SZ)/i, '');
  if (!/^\d{6}$/.test(code)) return null;
  if (/^399\d{3}$/.test(code)) return '0.' + code;
  if (/^(000|930)\d{3}$/.test(code)) return '1.' + code;
  return null;
}

function validQuote(q, now = Date.now()) {
  if (!q || !Number.isFinite(q.current) || q.current <= 0 || !Number.isFinite(q.prevClose) || q.prevClose <= 0 || !Number.isFinite(q.changePct)) return false;
  const at = Date.parse(q.quoteTime);
  // 周末、节假日允许最近一个收盘价用于路由验证；运行时另行判断是否盘中。
  return Number.isFinite(at) && at <= now + 10 * 60 * 1000 && now - at <= 7 * 86400000;
}

async function fetchIndexQuote(provider, symbol, options = {}) {
  const getText = options.fetchText || fetchText;
  if (provider === 'eastmoney') {
    if (!/^\d\.\d{6}$/.test(symbol)) return null;
    const raw = await getText('https://push2.eastmoney.com/api/qt/stock/get?secid=' + encodeURIComponent(symbol)
      + '&fields=f43,f57,f58,f60,f86,f170', {}, 5000);
    const d = JSON.parse(raw).data;
    if (!d) return null;
    const current = Number(d.f43) / 100, prevClose = Number(d.f60) / 100;
    const stamp = Number(d.f86) * 1000;
    if (!Number.isFinite(stamp) || stamp <= 0) return null;
    const quoteTime = new Date(stamp).toISOString();
    const q = { name: d.f58 || d.f57 || symbol, current, prevClose,
      changePct: (current - prevClose) / prevClose * 100, quoteTime, tradingDate: quoteTime.slice(0, 10), provider, symbol };
    return validQuote(q, options.now || Date.now()) ? q : null;
  }
  if (provider === 'sina') {
    if (!/^(sh|sz)\d{6}$/.test(symbol)) return null;
    const raw = await getText('https://hq.sinajs.cn/list=' + symbol, { Referer: 'https://finance.sina.com.cn/' }, 5000);
    const m = raw.match(/="([^"]*)"/);
    if (!m) return null;
    const f = m[1].split(',');
    const prevClose = Number(f[2]), current = Number(f[3]);
    const stamp = f[30] && f[31] ? Date.parse(f[30] + 'T' + f[31] + '+08:00') : NaN;
    const quoteTime = Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
    const q = { name: f[0], current, prevClose, changePct: (current - prevClose) / prevClose * 100,
      quoteTime, tradingDate: f[30] || null, provider, symbol };
    return validQuote(q, options.now || Date.now()) ? q : null;
  }
  return null;
}

module.exports = { eastmoneySymbol, validQuote, fetchIndexQuote };

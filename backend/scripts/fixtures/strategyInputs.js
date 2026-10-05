'use strict';
// Synthetic fixtures; no runtime or private data inputs.
function fixture(kind, scenario) {
  const category = kind === 'tech' ? 'growth' : kind === 'gold' ? 'cycle' : 'broad';
  const history = Array.from({length: scenario === 0 ? 0 : scenario === 1 ? 35 : 320}, (_, i) => ({
    date: new Date(Date.UTC(2026, 8, 23) - i * 86400000).toISOString().slice(0, 10),
    nav: 2 + (scenario % 2 ? -1 : 1) * i / 800 + Math.sin(i / 12) / 10
  }));
  const adjustedHistory = history.map(h => ({date:h.date, close:h.nav})).reverse();
  const valuation = {pe: scenario === 0 ? null : 15 + scenario, pePercentile: [null,25,30,70,80,85,95,50][scenario],
    treasury10y: 0.025, recent20dChange: scenario === 5 ? 8 : scenario === 6 ? 5 : 0,
    asOf:'2026-09-22', previousAsOf:'2026-09-21', previousPePercentile:20, previousPe:15,
    peHistory: Array.from({length:200}, (_,i)=>({date:new Date(Date.UTC(2026,8,20)-i*7*86400000).toISOString().slice(0,10),pe:18+i/20}))};
  return {code:'DEMO-'+kind, name:'DEMO '+kind, category, caliber:kind==='global'?'us':'cn',
    trackIndex:kind==='hs300'?'SH000300':'SH000905', history, adjustedHistory,
    latestNav:history[0]?.nav || null, latestDate:'2026-09-23', valuation,
    purchaseStatus:{state:'open',updatedAt:Date.now()}};
}

module.exports = { fixture };

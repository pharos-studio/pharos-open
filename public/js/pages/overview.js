// 概览页：总资产 / 今日盈亏 / 累计收益 + 近 N 日走势（信号仅决策页呈现）
import * as store from '../store.js';
import { fmtMoney, signPct, cls, el } from '../util.js';

function portfolioDayChange(live) {
  let gain = 0, base = 0;
  (live.funds || []).forEach(f => {
    if (f.dayChange != null && f.currentValue) {
      const prev = f.currentValue / (1 + f.dayChange / 100);
      gain += f.currentValue - prev; base += prev;
    }
  });
  return base ? { value: gain, pct: gain / base * 100 } : { value: null, pct: null };
}

// 每月投入：聚合每只基金 purchases 流水（YYYY-MM 分组累加 amount）。
// 在途记录（shares 未确认）amount 已记入流水，天然包含；数据随 /api/refresh 下发，无需后端改动。
function monthlyInvest(live) {
  const map = {};
  (live.funds || []).forEach(f => {
    (f.purchases || []).forEach(p => {
      const d = String(p.date || '');
      if (d.length < 7) return;
      const mk = d.slice(0, 7);
      map[mk] = (map[mk] || 0) + (Number(p.amount) || 0);
    });
  });
  return Object.keys(map).sort().map(k => ({ month: k, amount: Math.round(map[k]) }));
}

export async function render(root) {
  const live = store.getLive();
  const state = store.getState();

  const dc = portfolioDayChange(live);
  const totals = live.totals || {};
  // 口径约定（2026-09-18）：
  //   「累计投入」= 净投入（扣申购费）= 券商App「持仓成本」同口径，也是「累计收益」的基准
  //   「实付」     = 你实际掏出去的钱（含申购费），差额即申购费
  // 三者自洽：累计投入 − |累计收益| = 总资产
  const feeTxt = fmtMoney(totals.totalFee || 0);
  const paidTxt = fmtMoney(totals.totalPrincipal || 0);
  const netTxt = fmtMoney(totals.totalNetInvested || 0);
  const paidProfitTxt = fmtMoney((totals.totalValue || 0) - (totals.totalPrincipal || 0));
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'kpis' }, [
    kpi('总资产', fmtMoney(totals.totalValue), '含持仓市值'),
    kpi('今日盈亏', dc.value == null ? '—' : (dc.value >= 0 ? '+' : '') + fmtMoney(dc.value), dc.pct == null ? '' : signPct(dc.pct), dc.value),
    kpi('累计收益',
      totals.totalProfit == null ? '—' : (totals.totalProfit >= 0 ? '+' : '') + fmtMoney(totals.totalProfit),
      totals.totalProfitPct == null ? '' : signPct(totals.totalProfitPct),
      totals.totalProfit,
      '累计收益 = 现在市值 − 累计投入（与券商「持仓成本」同口径，不含申购费）。'
      + '若把申购费 ' + feeTxt + ' 一并计入成本，全成本收益为 ' + paidProfitTxt + '。'),
    kpi('累计投入', netTxt,
      '实付 ' + paidTxt + '（含申购费 ' + feeTxt + '）',
      null,
      '累计投入 = 扣掉申购费后真正买入份额的钱，与券商App「持仓成本」同口径，也是「累计收益」的基准。'
      + '实付 = 你实际掏出去的钱，两者差额即申购费。'
      + '★ 注意这是「成本」，不随净值变化；现在值多少钱请看「总资产」。'),
  ]));

  // 走势
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-head' }, [
    el('span', { text: '资产走势' }),
    el('span', { class: 'sub', id: 'trendRange' }),
  ]));
  const chartBox = el('div', { class: 'chart', id: 'trendChart' });
  panel.appendChild(chartBox);
  root.appendChild(panel);

  const history = (state && state.history) || [];
  if (history.length >= 2) {
    const dates = history.map(h => h.date);
    const values = history.map(h => h.totalValue);
    document.getElementById('trendRange').textContent = `近 ${dates.length} 日`;
    // 动态 import：trend.js 会连带加载 1MB 的 echarts，只有真的要画走势图时才拉。
    // 其余 6 个页面因此完全不负担这笔开销。
    import('../charts/trend.js')
      .then(({ renderTrend }) => {
        // 竞态防护：render() 不等待本 Promise 就 resolve，用户可能在 echarts 加载完成前
        // 切走页面，此时 app.js 的 view.innerHTML=... 已把 chartBox 移出 DOM。
        // 不检查就 init：echarts 告警 "Can't get dom width or height"，
        // 且 chart 实例挂在孤立节点上永不 dispose → 每次快速切页泄漏一个实例。
        if (!chartBox.isConnected) return;
        return renderTrend(chartBox, { dates, values, color: '#D9A441' });
      })
      .catch((err) => {
        if (!chartBox.isConnected) return;
        chartBox.innerHTML = '';
        chartBox.appendChild(el('div', { class: 'hint', text: '走势图加载失败：' + err.message }));
      });
  } else {
    chartBox.appendChild(el('div', { class: 'hint', text: '暂无历史快照，刷新几次后即可生成走势。' }));
  }

  // 每月投入（2026-09-06 新增）：按月聚合 purchases 流水，独立柱状面板放走势下方。
  const mInvest = monthlyInvest(live);
  const mPanel = el('div', { class: 'panel' });
  const nBuy = (live.funds || []).reduce((s, f) => s + ((f.purchases || []).length), 0);
  const mTotal = mInvest.reduce((s, r) => s + r.amount, 0);
  mPanel.appendChild(el('div', { class: 'panel-head' }, [
    el('span', { text: '每月投入' }),
    el('span', { class: 'sub', text: nBuy ? `买入流水 ${nBuy} 笔 · 实付合计 ${fmtMoney(mTotal)}` : '按月聚合买入流水' }),
  ]));
  const mChartBox = el('div', { class: 'chart', id: 'monthlyChart' });
  mPanel.appendChild(mChartBox);
  root.appendChild(mPanel);

  if (mInvest.length) {
    import('../charts/trend.js')
      .then(({ renderMonthlyBar }) => {
        // 竞态防护与走势图一致：切页后 chartBox 已移出 DOM 则不再 init
        if (!mChartBox.isConnected) return;
        return renderMonthlyBar(mChartBox, {
          months: mInvest.map(r => r.month),
          amounts: mInvest.map(r => r.amount),
        });
      })
      .catch((err) => {
        if (!mChartBox.isConnected) return;
        mChartBox.innerHTML = '';
        mChartBox.appendChild(el('div', { class: 'hint', text: '月度投入图加载失败：' + err.message }));
      });
  } else {
    mChartBox.appendChild(el('div', { class: 'hint', text: '暂无买入流水，录入买入后自动按月统计。' }));
  }
}

// title（可选）：口径解释，鼠标悬停可见。放 title 而非常驻文案，是因为口径细节不适合占版面，
// 但「口径必须可查」——2026-09-18 用户正是被「实付 vs 净投入」两个口径绕住过，故关键卡片都挂 title。
function kpi(label, value, sub, tone, title) {
  return el('div', { class: 'card kpi', title: title || null }, [
    el('div', { class: 'kpi-label', text: label }),
    el('div', { class: 'kpi-value ' + (tone != null && tone !== 0 ? cls(tone) : ''), text: value }),
    el('div', { class: 'kpi-sub', text: sub || '' }),
  ]);
}

// ECharts 图表封装（G0 主题）。echarts 按需加载：首次调用时动态注入 script，
// 之后复用同一个 Promise。首屏不再为 1MB 的 echarts 买单（loadEcharts 被概览页走势/月度投入与配置页旭日图共用）。
let _ecPromise = null;
export function loadEcharts() {
  if (window.echarts) return Promise.resolve(window.echarts);
  if (!_ecPromise) {
    _ecPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/echarts.min.js';   // 绝对路径，对齐 sw.js SHELL 写法
      s.onload = () => window.echarts
        ? resolve(window.echarts)
        : reject(new Error('echarts 已加载但全局变量缺失'));
      s.onerror = () => reject(new Error('echarts 加载失败（检查网络或 vendor/ 目录）'));
      document.head.appendChild(s);
    });
  }
  return _ecPromise;
}

export async function renderTrend(container, { dates, values, color = '#D9A441', area = true }) {
  const echarts = await loadEcharts();
  // 二次竞态防护：await 期间用户可能已切走页面，容器脱离 DOM。
  // 此时 init 只会得到 0 宽高的孤立节点，且 chart 实例永远不会 dispose。
  if (!container.isConnected) return null;
  if (container._chart) { container._chart.dispose(); container._chart = null; }
  const chart = echarts.init(container, null, { renderer: 'canvas' });
  container._chart = chart;

  const maxVal = Math.max(...values.filter(v => v != null));
  const useWan = maxVal >= 10000;
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 8, right: 14, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(10,16,32,0.92)',
      borderColor: 'rgba(255,255,255,0.12)',
      textStyle: { color: '#EDEFF7', fontSize: 12 },
      formatter: p => {
        const it = p[0];
        return `${it.axisValue}<br/>资产 <b>¥${Number(it.value).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</b>`;
      }
    },
    xAxis: {
      type: 'category', data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
      axisLabel: { color: '#9AA3C0', fontSize: 11, hideOverlap: true },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value', scale: true,
      axisLabel: {
        color: '#9AA3C0', fontSize: 11,
        formatter: v => useWan ? '¥' + (v / 10000).toFixed(1) + '万' : '¥' + Number(v).toFixed(0)
      },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
    },
    series: [{
      type: 'line', data: values, smooth: true, symbol: 'none',
      lineStyle: { color, width: 2 },
      areaStyle: area ? {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: color + '55' },
          { offset: 1, color: color + '00' },
        ])
      } : null,
    }],
  });
  // 防抖 resize
  const onResize = () => chart.resize();
  window.addEventListener('resize', onResize);
  return chart;
}

// 月度投入柱状图（概览页「每月投入」面板）：months 传完整 'YYYY-MM'，柱色 G0 鎏金 #D9A441，
// x 轴标签显示「M月」（跨年由 tooltip 完整年月兜底），柱顶标金额，量纲 ¥。
export async function renderMonthlyBar(container, { months, amounts }) {
  const echarts = await loadEcharts();
  // 竞态防护：await 期间用户可能已切走页面，容器脱离 DOM → init 只得到 0 宽高孤立节点且实例永不 dispose
  if (!container.isConnected) return null;
  if (container._chart) { container._chart.dispose(); container._chart = null; }
  const chart = echarts.init(container, null, { renderer: 'canvas' });
  container._chart = chart;

  const fmtYuan = n => '¥' + Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 8, right: 20, top: 30, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(10,16,32,0.92)', borderColor: 'rgba(255,255,255,0.12)',
      textStyle: { color: '#EDEFF7', fontSize: 12 },
      formatter: p => { const it = p[0]; return `${it.axisValue}<br/>当月投入 <b>${fmtYuan(it.value)}</b>`; },
    },
    xAxis: {
      type: 'category', data: months,
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
      axisTick: { show: false },
      axisLabel: {
        color: '#9AA3C0', fontSize: 11,
        formatter: v => { const m = /-(\d{2})$/.exec(v); return m ? Number(m[1]) + '月' : v; },
      },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#9AA3C0', fontSize: 11, formatter: v => '¥' + Number(v).toFixed(0) },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
    },
    series: [{
      type: 'bar', data: amounts, barWidth: '46%',
      itemStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: '#E3B94C' },
          { offset: 1, color: '#8A6A1F' },
        ]),
        borderRadius: [4, 4, 0, 0],
      },
      label: { show: true, position: 'top', color: '#C8CDDD', fontSize: 11, formatter: p => fmtYuan(p.value) },
    }],
  });
  // 防抖 resize
  const onResize = () => chart.resize();
  window.addEventListener('resize', onResize);
  return chart;
}

// ============================================================================
// 降级视图的前端渲染 —— 对应后端 lib/degradedView.js 与 GET /api/fund-degraded。
//
// ★ 与后端同一条铁律：**这里只画事实，不画判断。**
//   本模块刻意不提供任何「加仓/持有/减仓」文案，也**不读取**后端可能出现的
//   verdict / action 字段（后端根本不会给，见 lib/degradedView.js 的禁字段清单）。
//   UI 上的措辞必须与 facts 同源：只说「发生了什么」，不说「因此该怎么做」。
//
// ★ 懒加载：净值要走外网（一次 500 行），所以**只在用户展开卡片时才拉**。
//   复盘页一次可能列十几只基金，若进页面就全量拉，既慢又打爆数据源。
// ============================================================================
import * as api from './api.js';
import { el, signPct, cls, loadingHTML } from './util.js';

const UNAVAILABLE_LABEL = {
  adjusted_nav: '复权净值',
  dca_simulation: '定投模拟',
  buy_or_sell_judgement: '买卖判断',
};

export function isDegraded(d) { return !!(d && d.ok === true && d.degraded === true); }

/** 降级视图 → DOM 节点。非降级视图返回 null（调用方自行决定要不要提示「已核验」）。 */
export function renderDegraded(d) {
  if (!isDegraded(d)) return null;
  const f = d.facts || {};
  const pct = v => (v == null || isNaN(v) ? '—' : v.toFixed(2) + '%');

  const head = el('div', { class: 'dec-sec-h' }, [
    document.createTextNode('净值事实'),
    el('span', { class: 'badge badge-hold', style: 'margin-left:8px', text: '非建议' }),
  ]);

  const lines = el('div', { class: 'dec-raw', style: 'line-height:1.9' }, [
    el('div', { text: '未出判断的原因：' + (d.blockedLabel || d.blockedReason || '—') }),
    el('div', { text: '区间 ' + (f.firstDate || '—') + ' → ' + (f.latestDate || '—')
      + '（' + (f.observations != null ? f.observations : '—') + ' 个净值日）' }),
    // ⚠️ 涨跌色要挂在**子节点**上：把 DOM 节点塞进 el() 的 text 属性会被 toString 成
    //    "[object HTMLSpanElement]"（这个坑真踩过，文本断言查不出来，只有截图能看见）。
    el('div', {}, [
      document.createTextNode('净值 ' + (f.firstNav != null ? f.firstNav : '—') + ' → ' + (f.latestNav != null ? f.latestNav : '—') + '　区间累计 '),
      el('span', { class: cls(f.cumulativeReturnUnadjustedPct), text: signPct(f.cumulativeReturnUnadjustedPct) }),
    ]),
    el('div', { text: '最大回撤（未复权） ' + pct(f.maxDrawdownUnadjustedPct)
      + (f.maxDrawdownPeakDate ? '（' + f.maxDrawdownPeakDate + ' → ' + f.maxDrawdownTroughDate + '）' : '') }),
  ]);

  const notes = el('div', { class: 'hint', style: 'margin-top:6px' },
    [document.createTextNode('口径：未复权单位净值。' + (d.caveats || []).join(' '))]);

  const missing = (d.unavailable || []).filter(x => UNAVAILABLE_LABEL[x.key]);
  const why = el('details', { style: 'margin-top:8px' }, [
    el('summary', { style: 'cursor:pointer;font-weight:600', text: '为什么不提供这些？' }),
    el('div', { class: 'dec-raw', style: 'line-height:1.8;margin-top:4px' },
      missing.map(x => el('div', { text: '· ' + (UNAVAILABLE_LABEL[x.key] || x.key) + '：' + x.reason }))),
  ]);

  return el('div', { class: 'dec-sec' }, [head, lines, notes, why,
    el('div', { class: 'hint', style: 'margin-top:6px', text: d.disclaimer || '' })]);
}

/**
 * 给 <details> 挂一个懒加载降级视图：展开时才拉数据。
 * 已经拉过就不再拉；失败如实显示原因，不静默。
 */
export function attachLazyDegraded(details, code, days) {
  let done = false;
  const slot = el('div');
  details.addEventListener('toggle', async () => {
    if (done || !details.open) return;
    done = true;
    slot.innerHTML = loadingHTML('正在获取净值事实…', true);
    try {
      const d = await api.getFundDegraded(code, days);
      const node = renderDegraded(d);
      slot.innerHTML = '';
      if (node) {
        slot.appendChild(node);
      } else if (d && d.reason === 'fund_verified') {
        // 已核验的基金走正常策略链路，这里**不重复**给事实，避免一只基金两套口径。
        slot.appendChild(el('div', { class: 'hint', text: '该基金已通过本项目核验，按正常策略给出建议。' }));
      } else {
        slot.appendChild(el('div', { class: 'hint', text: '未取到净值事实（' + ((d && d.error) || '未知原因') + '）。' }));
      }
    } catch (e) {
      slot.innerHTML = '';
      slot.appendChild(el('div', { class: 'hint', text: '净值事实获取失败：' + e.message }));
    }
  });
  details.appendChild(slot);
}
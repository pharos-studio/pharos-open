'use strict';
/*
 * 信号占空比监控 —— 只读诊断，**不写任何文件、不改生产代码**。
 *
 * 目的（待办清单 §1 根问题的防线）：
 *   「状态型条件在趋势资产上会长期为真」这个问题，是靠回测偶然撞见的（科技线金叉占 66%、
 *   黄金 2023-2025 三年零事件）。本脚本把它变成**可主动发现**的例行检查：
 *   任何一条线的买入信号占空比异常（灯常亮 / 灯常灭），或状态型条件近恒真/恒假 → 告警。
 *
 * 覆盖范围（按数据可得性分档）：
 *   ✅ 科技成长(growth) / 黄金对冲(cycle) —— 纯净值即可完整回放
 *   ⏳ 红利低波(dividend) —— 需股息率历史序列（data/series/yield_history.json 目前过短）
 *   ⏳ 宽基 A股(broad) / 宽基·海外(broad:us) —— 需 PE 历史序列
 *   扩展方式：在 LINES 里加一条 + 提供 build/stateOf 即可（数据腿齐了再加）。
 *
 * 判读：
 *   add 占空比 > 50%  → ⚠ 灯常亮（信号失去区分度，如科技线改造前 68.6%）
 *   add 占空比 < 3%   → ⚠ 灯常灭（系统性错过机会，如黄金 2023-2025 零事件）
 *   状态条件 > 90% / < 1% → ⚠ 该状态型条件近常量，作为准入门槛已失效
 *
 * ★ 告警 ≠ 必须改（重要，2026-09-13 回测结论）：
 *   「灯常亮」提示的是"该通道可能失去择时区分度"，**不等于缺陷**。科技线回测证明：
 *   把金叉状态改成"事件型"（只在穿越后 N 日买）反而 ΔR6m = −11.01pp —— 因为趋势资产在
 *   趋势期间持续给买入信号，本身有正收益（被筛掉的信号 R6m 27.2% > 保留的 16.1%）。
 *   而"趋势中逢回调买"（C5）方向有正向证据（Δ+4.52pp）但未达统计显著，且未过全部判据。
 *   → 结论：**维持现状**。详见 data/config/config.json 的 signals.tech._note 与
 *     docs/算法设计复盘手册.md §九。告警的用途是"提示值得关注"，不是"触发自动改动"。
 *
 * 用法：node backend/scripts/duty_cycle_monitor.js
 */
const f = require('../fetchers');
const config = require('../lib/config');
const { REGISTRY } = require('../engines/registry');
const store = require('../lib/store');

const RECENT = 250;      // "近期"窗口（交易日）
const MIN_HIST = 250;    // 回放起点：保证 250 日价格分位 / 三重均线可算
const ADD_HI = 50, ADD_LO = 3;          // add 占空比告警阈值（%）
const ST_HI = 90, ST_LO = 1;            // 状态条件占比告警阈值（%）

const fx = (v, d) => (v == null || isNaN(v) ? '—' : (+v).toFixed(d == null ? 1 : d));

// 各线：category → { label, stateName, stateOf(matrix) }
const LINES = [
  {
    cat: 'growth', label: '科技成长',
    stateName: '金叉状态(MA20>MA60)',
    stateOf: m => m.maZone === 'golden',
  },
  {
    cat: 'cycle', label: '黄金对冲',
    stateName: '价格分位便宜(≤cheapPct)',
    stateOf: m => m.pctZone === 'cheap',
  },
];

async function fetchSeries(code, maxDays) {
  const r = await f.fetchNavHistory(code, maxDays);
  const h = (r && r.history) || [];
  return h.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).filter(x => x.nav > 0);
}

// 单只基金回放：返回 [{date, action, matrix}]
function replay(navs, build, cfg) {
  const out = [];
  for (let i = MIN_HIST - 1; i < navs.length; i++) {
    const cur = navs[i];
    const hist = navs.slice(i - MIN_HIST + 1, i + 1).reverse().map(x => ({ date: x.date, nav: x.nav }));
    let dec = null;
    try {
      dec = build({ code: 'PROBE', category: 'PROBE', latestNav: cur.nav, history: hist }, {}, cfg);
    } catch (e) { continue; }
    if (!dec) continue;
    out.push({ date: cur.date, action: dec.action, matrix: dec.matrix || {} });
  }
  return out;
}

(async () => {
  const cfg = config.getConfig();
  const holdings = store.readJSON('holdings.json');
  const funds = (holdings && holdings.funds) || [];

  console.log('=== 信号占空比监控（只读诊断）===');
  console.log(`近端窗口 = 最近 ${RECENT} 个交易日 ｜ 回放起点需 ≥${MIN_HIST} 点历史`);
  console.log(`告警线：add 占空比 >${ADD_HI}%（灯常亮）或 <${ADD_LO}%（灯常灭）；状态条件占比 >${ST_HI}% 或 <${ST_LO}%\n`);

  const alarms = [];

  for (const line of LINES) {
    const reg = REGISTRY[line.cat];
    if (!reg) { console.log(`（${line.label}：registry 无此线，跳过）`); continue; }
    const mine = funds.filter(x => x.category === line.cat);
    if (!mine.length) { console.log(`（${line.label}：无持仓，跳过）\n`); continue; }

    console.log(`── ${line.label}（${line.cat}）｜ 状态型条件：${line.stateName} ──`);
    console.log('  基金       回放点  全期add%  近端add%  近期状态%   告警');

    for (const fund of mine) {
      const navs = await fetchSeries(fund.code, 4500);
      if (navs.length < MIN_HIST + 20) {
        console.log(`  ${fund.code}  ${String(navs.length).padStart(6)}  （历史不足 ${MIN_HIST + 20} 点，跳过）`);
        continue;
      }
      const rows = replay(navs, reg.builder, cfg);
      if (!rows.length) { console.log(`  ${fund.code}  回放无数据`); continue; }
      const recent = rows.slice(-RECENT);
      const addAll = rows.filter(r => r.action === 'add').length / rows.length * 100;
      const addRec = recent.filter(r => r.action === 'add').length / recent.length * 100;
      const stRec = recent.filter(r => line.stateOf(r.matrix)).length / recent.length * 100;

      const tags = [];
      if (addRec > ADD_HI) tags.push(`⚠灯常亮(${fx(addRec)}%)`);
      if (addRec < ADD_LO) tags.push(`⚠灯常灭(${fx(addRec)}%)`);
      if (stRec > ST_HI) tags.push(`⚠状态近恒真(${fx(stRec)}%)`);
      if (stRec < ST_LO) tags.push(`⚠状态近恒假(${fx(stRec)}%)`);
      if (tags.length) alarms.push({ line: line.label, code: fund.code, tags: tags.join(' ') });

      console.log('  ' + fund.code + String(rows.length).padStart(9)
        + fx(addAll).padStart(10) + fx(addRec).padStart(10) + fx(stRec).padStart(11)
        + '   ' + (tags.length ? tags.join(' ') : '✓ 正常'));
    }
    console.log('');
  }

  console.log('=== 汇总 ===');
  if (!alarms.length) {
    console.log('  ✓ 各线信号占空比均在合理区间，无告警。');
  } else {
    alarms.forEach(a => console.log(`  ⚠ ${a.line} ${a.code}：${a.tags}`));
    console.log('\n  处置建议：占空比异常的线，参考内部维护文档《算法待办清单》§1（未随开源发布）（状态型条件的改造方法论）');
    console.log('    · 灯常亮 → 该通道加反向约束（如"趋势中逢回调"）或改事件型');
    console.log('    · 灯常灭 → 该条件改用"变化量/回撤"而非"绝对状态"');
    console.log('    · 改造前必须走回测（scripts/backtest_*.js 范式）+ P0~P7 判据，不得凭感觉改。');
    console.log('  ★ 但"告警 ≠ 必须改"：科技线 2026-09-13 回测已证"灯常亮"不一定是缺陷（详见文件头说明）；');
    console.log('    当前科技线的告警属**已知状态**（结论=维持现状）；本监控的意义是防止其他线出现新增异常。');
  }
  console.log('\n（本脚本为只读诊断，未修改任何生产代码或配置）');
})().catch(e => { console.log('FATAL', (e && e.stack) || e); process.exit(1); });

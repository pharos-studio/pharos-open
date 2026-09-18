'use strict';
/*
 * 海外宽基（caliber=us / 纳指100）阈值标定脚本 —— 联网只读，**不写任何文件**。
 *
 * 为什么需要它：
 *   signals.broadGlobal 的两组阈值是「用量化方法从真实历史数据推出来的」，
 *   而数据会变（利率体制切换、纳指盈利增速变化），阈值需要定期重标。
 *   本脚本把当初的推导过程固化下来，随时可复算，避免阈值变成没人知道怎么来的魔数。
 *
 * 标定方法（与 A 股 signals.broad 的 p10/p90 方法学一致，但阈值独立）：
 *   ① 取蛋卷 NDX 周频 PE 全历史（约 10 年，fetchIndexPeHistory）
 *   ② 取东方财富美债10年 日频历史（翻页）
 *   ③ 按日期对齐：每个 PE 点取 ≤ 它日期的最近一个美债值 → ERP = 1/PE − 美债
 *   ④ 对 ERP 序列取 p10/p90 → 建议的 erpLow / erpHigh
 *
 * ★ 为什么不能直接抄 A 股的 6.9 / 5.3：
 *   美股 ERP 结构性为负（盈利收益率 < 无风险利率），A 股结构性为正。
 *   套用 A 股带会让 erpZone 恒为 'low'、综合分副锚永久饱和在 0（便宜区硬顶 49 分）。
 *   本脚本输出的建议值若与 config 差异较大，说明该重新标定了。
 *
 * 窗口怎么选（脚本会打印三个窗口供对比）：
 *   近 3 年：只含单边高利率期，p90 甚至可能为负 → 「便宜」永远触发不到（饱和陷阱）
 *   近 5 年：仍是单边高利率期，美债一回落就失真
 *   全期 10 年：跨完整利率周期，体制中性 ← **采用这个**（与 A 股同口径）
 *
 * 用法：node backend/scripts/calibrate_broad_global.js
 *      跑完把建议值人工填进 data/config/config.json 的 signals.broadGlobal.erpHigh / erpLow
 *      （引擎从不会自动改 config，与 timing 候选同原则）
 */
const f = require('../fetchers');
const config = require('../lib/config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 分位数（线性插值，与 util.percentileOf 口径不同：这里给标定用，取整点）
function q(arr, p) {
  const a = arr.filter(x => x != null && !isNaN(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.min(a.length - 1, Math.max(0, Math.round(p / 100 * (a.length - 1))));
  return a[i];
}
const fx = (v, d) => (v == null ? '—' : (+v).toFixed(d == null ? 2 : d));

// 东财美债10年历史（日频，翻页）。EMG00001310 = 美国国债收益率10年（%）。
// ★同一行还有 EMM00166466 = 中债10年，但本脚本只取美债——A 股口径不在这里标定。
async function fetchUsBondHistory(maxPages) {
  const out = [];
  for (let p = 1; p <= (maxPages || 8); p++) {
    const url = 'https://datacenter.eastmoney.com/api/data/get?type=RPTA_WEB_TREASURYYIELD&sty=ALL'
      + '&st=SOLAR_DATE&sr=-1&token=894050c76af8597a853f5b408b759f5d'
      + `&p=${p}&ps=500&pageNo=${p}&pageNum=${p}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/cjsj/zmgzsyl.html' } });
    if (!res.ok) break;
    const j = JSON.parse(await res.text());
    const rows = (j && j.result && j.result.data) || [];
    if (!rows.length) break;
    rows.forEach(r => {
      if (r.EMG00001310 != null) out.push({ date: String(r.SOLAR_DATE).slice(0, 10), us: r.EMG00001310 });
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// 取 ≤ day 的最近一条（序列已升序）
function lookup(arr, day) {
  let lo = 0, hi = arr.length - 1, res = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].date <= day) { res = arr[m]; lo = m + 1; } else hi = m - 1;
  }
  return res;
}

function report(label, joined) {
  const erp = joined.map(x => x.erp);
  if (erp.length < 30) { console.log(`  ${label}：样本不足（n=${erp.length}），跳过`); return null; }
  const p10 = q(erp, 10), p50 = q(erp, 50), p90 = q(erp, 90);
  console.log(`  ${label.padEnd(14)} n=${String(erp.length).padStart(4)}`
    + `  min=${fx(Math.min(...erp))}  p10=${fx(p10)}  p50=${fx(p50)}  p90=${fx(p90)}  max=${fx(Math.max(...erp))}`);
  return { n: erp.length, p10, p50, p90, min: Math.min(...erp), max: Math.max(...erp) };
}

(async () => {
  const cfg = config.getConfig();
  const g = (cfg.signals && cfg.signals.broadGlobal) || {};

  console.log('=== 海外宽基阈值标定（纳指100 × 美债10年）===\n');

  // ① 纳指 PE 全历史
  console.log('--- ① 纳指 PE 周频序列（蛋卷 index_eva/pe_history?day=all）---');
  const peRows = await f.fetchIndexPeHistory('NDX');
  if (!Array.isArray(peRows) || !peRows.length) {
    console.log('  ✗ 取不到 NDX PE 历史，无法标定。检查 fetchers.fetchIndexPeHistory 与蛋卷接口。');
    process.exit(1);
  }
  const pes = peRows
    .map(r => ({ date: r.date, pe: r.pe }))
    .filter(x => x.pe > 0 && x.pe < 200)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`  范围 ${pes[0].date} ~ ${pes[pes.length - 1].date}，n=${pes.length}，最新 PE=${fx(pes[pes.length - 1].pe)}`);

  // ② 美债10年历史
  console.log('\n--- ② 美债10年日频历史（东财 RPTA_WEB_TREASURYYIELD / EMG00001310）---');
  const us = await fetchUsBondHistory(8);
  if (!us.length) {
    console.log('  ✗ 取不到美债历史，无法标定。');
    process.exit(1);
  }
  console.log(`  范围 ${us[0].date} ~ ${us[us.length - 1].date}，n=${us.length}，最新 ${fx(us[us.length - 1].us)}%`);

  // ③ 对齐
  const joined = [];
  pes.forEach(p => {
    const u = lookup(us, p.date);
    if (u) joined.push({ date: p.date, pe: p.pe, us: u.us, erp: (1 / p.pe - u.us / 100) * 100 });
  });
  console.log(`\n--- ③ 按日期对齐 ---\n  对齐后 n=${joined.length}（${joined[0].date} ~ ${joined[joined.length - 1].date}）`);

  // ④ 分窗口 ERP 分布
  console.log('\n--- ④ ERP 分布（%），按窗口对比 ---');
  const cutoff = d => joined.filter(x => x.date >= d);
  const all = report('全期 10 年 ★', joined);
  report('近 5 年', cutoff('2021-09-12'));
  report('近 3 年', cutoff('2023-09-12'));

  const last = joined[joined.length - 1];
  console.log(`\n  当前：${last.date}  PE=${fx(last.pe)}  美债=${fx(last.us)}%  ERP=${fx(last.erp)}%`);

  // ⑤ PE 分位参考（cheapPct / expensivePct 是否还合适）
  const pev = pes.map(x => x.pe);
  console.log('\n--- ⑤ 纳指 PE 分布（供 cheapPct / expensivePct 参考）---');
  console.log(`  全期：min=${fx(Math.min(...pev))}  p10=${fx(q(pev, 10))}  p25=${fx(q(pev, 25))}`
    + `  p50=${fx(q(pev, 50))}  p75=${fx(q(pev, 75))}  p80=${fx(q(pev, 80))}  p90=${fx(q(pev, 90))}  max=${fx(Math.max(...pev))}`);
  console.log(`  当前 PE=${fx(last.pe)} 落在全期约 ${fx(pev.filter(v => v < last.pe).length / (pev.length - 1) * 100, 0)} 分位`);
  console.log(`  ⚠ 注意：阈值 cheapPct/expensivePct 作用于【滚动 156 周分位】（自算），不是这里的全期分位。`);
  console.log(`     此处仅作「PE 绝对水平是否整体抬升（台阶移动）」的健康检查。`);

  // ⑥ 建议值 + 与当前 config 对比
  console.log('\n--- ⑥ 建议值 vs 当前 config ---');
  if (!all) {
    console.log('  样本不足，无法给出建议。');
  } else {
    const sugHigh = +all.p90.toFixed(2), sugLow = +all.p10.toFixed(2);
    console.log(`  建议 erpHigh（全期 p90） = ${fx(sugHigh)}      当前 config = ${g.erpHigh != null ? g.erpHigh : '(未设 → 副锚关闭)'}`);
    console.log(`  建议 erpLow （全期 p10） = ${fx(sugLow)}      当前 config = ${g.erpLow != null ? g.erpLow : '(未设 → 副锚关闭)'}`);
    const dH = (g.erpHigh != null) ? Math.abs(g.erpHigh - sugHigh) : null;
    const dL = (g.erpLow != null) ? Math.abs(g.erpLow - sugLow) : null;
    if (dH == null || dL == null) {
      console.log('  → 当前未设阈值（副锚关闭，单锚运行）。若要让 ERP 参与综合分副锚，填入上面两个数字。');
    } else if (dH > 0.5 || dL > 0.5) {
      console.log(`  → ⚠ 与建议值偏离较大（Δhigh=${fx(dH)}pp, Δlow=${fx(dL)}pp），建议重标。`);
    } else {
      console.log(`  → ✓ 与建议值接近（Δhigh=${fx(dH)}pp, Δlow=${fx(dL)}pp），暂无需重标。`);
    }
    console.log(`\n  极端边界提示：当前 ERP=${fx(last.erp)}%  全期 p10=${fx(all.p10)}%`);
    if (last.erp != null && all.p10 != null && last.erp <= all.p10) {
      console.log('     → 当前 ERP 已 ≤ 全期 p10：副锚处于饱和低位（美股相对美债处 10 年最贵区间），');
      console.log('       这是真实结论而非故障；综合分被副锚压住属预期行为。');
    }
  }

  console.log('\n完成。改阈值：编辑 data/config/config.json → signals.broadGlobal.erpHigh / erpLow');
  console.log('改完跑回归：node backend/scripts/verify_composite_score.js');
})().catch(e => { console.log('FATAL', (e && e.message) || e); process.exit(1); });

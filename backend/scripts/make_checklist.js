'use strict';
/*
 * 生成《历史买入核对清单》
 * ------------------------------------------------------------
 * 只读：读 data/state/holdings.json + 联网取各基金官方净值序列，输出
 *   docs/历史买入核对清单.md
 *
 * 判据（2026-09-17 起）—— 分两种记录，**不再问用户任何问题**，只做事实陈述：
 *   ① 已带 pricingDate 的记录（2026-09-17 批量回填后应全部如此）：
 *      校验 nav 是否**逐位等于** pricingDate 当天的官方净值 → ✅ 一致 / ⚠️ 不符。
 *   ② 未带 pricingDate 的旧记录（兼容分支）：
 *      沿用旧判据 —— nav 等于下单日 = 正确；等于 T+1/T+2/序列别处 = 需核对。
 *
 * 用法：
 *   node backend/scripts/make_checklist.js
 *   node backend/scripts/make_checklist.js --diff            # 附加「与最近一次备份的差异」节
 *   node backend/scripts/make_checklist.js --diff=<bak路径>   # 指定备份文件
 */

const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const fetchers = require('../fetchers');
const tradeDate = require('../lib/tradeDate');
const buyPlan = require('../lib/buyPlan');

const argv = process.argv.slice(2);
const DIFF_ARG = argv.find((a) => a === '--diff' || a.indexOf('--diff=') === 0);
const DAY = 86400000;

function onOrAfter(dates, nominal) {
  let lo = 0, hi = dates.length - 1, ans = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] >= nominal) { ans = dates[m]; hi = m - 1; } else lo = m + 1; }
  return ans;
}
function dayDiff(a, b) {
  return Math.round((new Date(b + 'T00:00:00+08:00') - new Date(a + 'T00:00:00+08:00')) / DAY);
}
function md(s) { return String(s == null ? '' : s); }
function sessionLabel(s) { return s === 'T+1' ? '15:00 后' : '15:00 前'; }

// 找最近一次备份（holdings.json.bak-*），供 --diff 使用
function newestBak() {
  // 备份落在 holdings.json 的同目录（即 state/ 分区，分区表见 lib/store.js 的 LAYOUT）
  const dir = path.dirname(store.dataPath('holdings.json'));
  let best = null, bestT = -1;
  for (const f of fs.readdirSync(dir)) {
    if (f.indexOf('holdings.json.bak-') !== 0) continue;
    const t = fs.statSync(path.join(dir, f)).mtimeMs;
    if (t > bestT) { bestT = t; best = path.join(dir, f); }
  }
  return best;
}

(async () => {
  const holdings = store.readJSON('holdings.json');
  if (!holdings || !Array.isArray(holdings.funds)) { console.error('读不到 holdings.json'); process.exit(1); }

  console.log('拉取净值序列…');
  const navMap = {}, datesArr = {};
  for (const f of holdings.funds) {
    if (!Array.isArray(f.purchases) || !f.purchases.length) continue;
    let hist = [];
    try { const r = await fetchers.fetchNavHistory(f.code, 400); hist = (r && r.history) || []; } catch (e) { console.log('  ⚠️ ' + f.code + ' ' + (e && e.message)); }
    const m = new Map();
    for (const x of hist) if (x.date && x.nav) m.set(x.date, Number(x.nav));
    navMap[f.code] = m;
    datesArr[f.code] = [...m.keys()].sort();
    console.log('  ' + f.code + '  ' + datesArr[f.code].length + ' 个交易日');
  }

  const L = [];
  const now = new Date();
  const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') +
    ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

  const groups = [];   // { code, name, market, feeRate, rows:[...] }
  const suspects = []; // 校验不通过
  const untagged = []; // 还没打标签的旧记录
  const bySession = { T: 0, 'T+1': 0 };
  let gid = 0, nPending = 0, nPendingWithSession = 0, nVerified = 0, nSettleMissing = 0;

  for (const f of holdings.funds) {
    const ps = (f.purchases || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (!ps.length) continue;
    const market = f.market === 'QDII' ? 'QDII' : 'A';
    const fee = buyPlan.validFeeRate(f.feeRate);
    const dates = datesArr[f.code] || [];
    const navs = navMap[f.code] || new Map();
    const rows = [];

    for (const p of ps) {
      gid++;
      const row = { gid, date: p.date, amount: p.amount, nav: p.nav, shares: p.shares };
      if (p.shares == null) {
        row.kind = 'pending';
        row.session = p.session || null;   // 在途也可先落时段（净值公布前唯一能确定的事）
        nPending++;
        if (p.session) nPendingWithSession++;
        rows.push(row); continue;
      }

      // ---------- ① 已带 pricingDate：按定价日校验 ----------
      if (p.pricingDate) {
        row.pricingDate = p.pricingDate;
        row.settleDate = p.settleDate || null;
        row.session = p.session === 'T+1' ? 'T+1' : 'T';
        const official = navs.has(p.pricingDate) ? navs.get(p.pricingDate) : null;
        const ok = official != null && Math.abs(official - Number(p.nav)) < 1e-9;
        row.official = official;
        if (ok) {
          row.kind = 'verified';
          nVerified++;
          bySession[row.session]++;
          if (!row.settleDate) nSettleMissing++;
        } else {
          row.kind = 'suspect';
          suspects.push(Object.assign({ code: f.code, name: f.name, market }, row));
        }
        rows.push(row); continue;
      }

      // ---------- ② 未打标签：旧判据（兼容） ----------
      let hit = null, hitDay = null;
      const cands = [['T', p.date], ['T+1', tradeDate.addBusinessDays(p.date, 1)], ['T+2', tradeDate.addBusinessDays(p.date, 2)]];
      for (const [lab, nd] of cands) {
        const real = onOrAfter(dates, nd);
        if (real && Math.abs(navs.get(real) - p.nav) < 1e-9) { hit = lab; hitDay = real; break; }
      }
      row.hit = hit; row.hitDay = hitDay;
      if (hit === 'T') {
        row.kind = 'legacy-ok';
        row.mark = hitDay.slice(5) + ' 当天（未打标签）';
      } else {
        row.kind = 'suspect';
        if (hit) row.mark = '**⚠️ ' + hitDay.slice(5) + '（' + hit + '）**';
        else {
          let found = null;
          for (const d of dates) if (Math.abs(navs.get(d) - p.nav) < 1e-9) { found = d; break; }
          if (found) { const dd = dayDiff(p.date, found); row.mark = '**⚠️ ' + found.slice(5) + '（' + (dd >= 0 ? '晚' : '早') + Math.abs(dd) + ' 天）**'; }
          else row.mark = '**⚠️ 序列中找不到该净值**';
        }
        suspects.push(Object.assign({ code: f.code, name: f.name, market }, row));
      }
      const dF = onOrAfter(dates, p.date);
      const dA = onOrAfter(dates, tradeDate.addBusinessDays(p.date, 1));
      row.front = dF ? { nav: navs.get(dF), date: dF, shares: buyPlan.computeShares(p.amount, fee, navs.get(dF)) } : null;
      row.after = dA ? { nav: navs.get(dA), date: dA, shares: buyPlan.computeShares(p.amount, fee, navs.get(dA)) } : null;
      untagged.push(row);
      rows.push(row);
    }
    groups.push({ code: f.code, name: f.name, market, feeRate: f.feeRate || 0, rows });
  }

  // ---------- 头部 ----------
  L.push('# 历史买入核对清单（已核实）');
  L.push('');
  L.push('> 生成时间：' + stamp + '　|　数据源：`data/state/holdings.json` + 各基金官方净值序列（东财）');
  L.push('> 生成方式：`node backend/scripts/make_checklist.js`（**只读**，不改任何数据）');
  L.push('');
  L.push('## 汇总');
  L.push('');
  L.push('- 总笔数 **' + gid + '**');
  L.push('- ✅ **已核实 ' + nVerified + '** 笔（15:00 前 **' + bySession.T + '** · 15:00 后 **' + bySession['T+1'] + '**）');
  L.push('- ⚠️ 校验不符 **' + suspects.length + '** 笔');
  if (nPending) {
    L.push('- 在途待确认 **' + nPending + '** 笔' +
      (nPendingWithSession ? '（其中 **' + nPendingWithSession + '** 笔时段已记录，等该日净值公布后自动补实）' : '（**请补时段**）'));
  } else {
    L.push('- 在途待确认 **0** 笔');
  }
  if (untagged.length) L.push('- ⚠️ 尚未打日期标签的旧记录 **' + untagged.length + '** 笔（跑 `fix_nav_caliber.js` 可回填）');
  if (nSettleMissing) L.push('- 份额确认日待补（净值序列未覆盖到）**' + nSettleMissing + '** 笔');
  L.push('');
  L.push('## 怎么读');
  L.push('');
  L.push('校验只做一件事：把库里那个 `nav` 拿去和**定价日当天**的官方净值**逐位精确比对**（无容差）。');
  L.push('三个日期千万别混：');
  L.push('');
  L.push('| 字段 | 含义 | 参与份额计算 |');
  L.push('|---|---|---|');
  L.push('| `date` | 下单日（你填的那天） | 否 |');
  L.push('| `pricingDate` | **成交净值日**：15:00 前 = 下单日；15:00 后 = 下一交易日；非交易日顺延 | **是，份额只由它决定** |');
  L.push('| `settleDate` | **份额确认日**：定价日 +1 工作日（A 股）/ +2（QDII） | 否 |');
  L.push('');
  L.push('> 依据：证监会《如何申购和赎回开放式基金》与基金合同「未知价」原则 —— 申购价格以**受理申请当日**收市后计算的净值为基准；');
  L.push('> 合同约定之外的时点提出申请，其价格为**下一开放日**的价格。所以「当天买按当天净值」是标准做法，不是 bug。');
  L.push('');
  L.push('## 逐笔清单');
  L.push('');
  for (const g of groups) {
    L.push('### ' + g.code + '　' + g.name);
    L.push('');
    L.push('`' + g.market + '` · feeRate `' + g.feeRate + '` · 共 ' + g.rows.length + ' 笔');
    L.push('');
    L.push('| # | 下单日 | 金额 | 时段 | 定价日 | 份额确认日 | 净值 | 份额 | 校验 |');
    L.push('|---|--------|------|------|--------|-----------|------|------|------|');
    for (const r of g.rows) {
      if (r.kind === 'pending') {
        // 在途：净值未公布 ⇒ nav/份额/确认日全是「—」；但若时段已落盘，把名义定价日写出来
        const nom = r.session ? tradeDate.nominalPricingDate(r.date, r.session) : null;
        L.push('| ' + r.gid + ' | ' + r.date + ' | ' + md(r.amount) + ' | ' +
          (r.session ? sessionLabel(r.session) : '**待定**') + ' | ' +
          (nom ? '名义 ' + nom : '—') + ' | — | — | — | 在途' +
          (nom ? '（等 ' + nom + ' 净值公布后自动补实）' : '（**请补时段**）') + ' |');
      } else if (r.kind === 'verified') {
        L.push('| ' + r.gid + ' | ' + r.date + ' | ' + md(r.amount) + ' | ' + sessionLabel(r.session) + ' | ' + r.pricingDate +
          ' | ' + (r.settleDate || '待补') + ' | ' + md(r.nav) + ' | ' + md(r.shares) + ' | ✅ |');
      } else if (r.kind === 'legacy-ok') {
        L.push('| ' + r.gid + ' | ' + r.date + ' | ' + md(r.amount) + ' | — | — | — | ' + md(r.nav) + ' | ' + md(r.shares) + ' | ✅ ' + r.mark + ' |');
      } else {
        L.push('| ' + r.gid + ' | ' + r.date + ' | ' + md(r.amount) + ' | ' + (r.session ? sessionLabel(r.session) : '—') +
          ' | ' + (r.pricingDate || '—') + ' | ' + (r.settleDate || '—') + ' | ' + md(r.nav) + ' | ' + md(r.shares) + ' | ' + (r.mark || '**⚠️**') + ' |');
      }
    }
    L.push('');
  }

  // ---------- 差异节（可选） ----------
  if (DIFF_ARG) {
    let bakPath = DIFF_ARG.indexOf('--diff=') === 0 ? DIFF_ARG.slice('--diff='.length) : newestBak();
    L.push('---');
    L.push('');
    L.push('## 与备份的差异（`' + (bakPath ? path.basename(bakPath) : '未找到备份') + '`）');
    L.push('');
    if (!bakPath || !fs.existsSync(bakPath)) {
      L.push('未找到可比对的备份文件。');
      L.push('');
    } else {
      const oldH = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
      const key = (code, p) => code + '|' + p.date + '|' + p.amount;
      const oldMap = new Map();
      for (const f of oldH.funds || []) for (const p of (f.purchases || [])) {
        const k = key(f.code, p);
        if (!oldMap.has(k)) oldMap.set(k, []);
        oldMap.get(k).push(p);
      }
      let nChanged = 0, nTagged = 0;
      const lines = [];
      for (const g of groups) {
        for (const r of g.rows) {
          const k = key(g.code, r);
          const arr = oldMap.get(k);
          if (!arr || !arr.length) continue;
          const o = arr.shift();
          const dNav = (o.nav != null && r.nav != null && Number(o.nav) !== Number(r.nav));
          const dSh = (o.shares != null && r.shares != null && Number(o.shares) !== Number(r.shares));
          if (dNav || dSh) {
            nChanged++;
            lines.push('| ' + r.gid + ' | ' + g.code + ' | ' + r.date + ' | ' + md(o.nav) + ' → ' + md(r.nav) + ' | ' + md(o.shares) + ' → ' + md(r.shares) + ' |');
          } else if (!o.session && r.session) nTagged++;
        }
      }
      L.push('- 仅**新增日期标签**（`session`/`pricingDate`/`settleDate`，数值零改动）：**' + nTagged + '** 笔');
      L.push('- **数值被修正**（`nav`/`shares`）：**' + nChanged + '** 笔');
      L.push('');
      if (nChanged) {
        L.push('| # | 基金 | 下单日 | 净值 旧 → 新 | 份额 旧 → 新 |');
        L.push('|---|------|--------|---------------|---------------|');
        for (const s of lines) L.push(s);
        L.push('');
      }
    }
  }

  // ---------- 疑点明细 ----------
  if (suspects.length) {
    L.push('---');
    L.push('');
    L.push('## ⚠️ 校验不符明细（' + suspects.length + ' 笔）');
    L.push('');
    L.push('| # | 基金 | 下单日 | 金额 | 现值 nav → 份额 | 定价日应为 | 15:00 前 → 净值@日 / 份额 | 15:00 后 → 净值@日 / 份额 |');
    L.push('|---|------|--------|------|-----------------|-----------|---------------------------|---------------------------|');
    for (const s of suspects) {
      const f = s.front ? s.front.nav + '@' + s.front.date.slice(5) + ' / ' + s.front.shares.toFixed(4) : '—';
      const a = s.after ? s.after.nav + '@' + s.after.date.slice(5) + ' / ' + s.after.shares.toFixed(4) : '—';
      const should = s.pricingDate ? (s.official != null ? s.official + '@' + s.pricingDate : '序列无此日 ' + s.pricingDate) : '—';
      L.push('| ' + s.gid + ' | ' + s.code + ' | ' + s.date + ' | ' + md(s.amount) + ' | ' + md(s.nav) + ' → ' + md(s.shares) +
        ' | ' + should + ' | ' + f + ' | ' + a + ' |');
    }
    L.push('');
    L.push('修法：`node backend/scripts/fix_nav_caliber.js --session=T`（或 `=T+1`）先看方案，加 `--apply` 落盘（自动备份）。');
    L.push('');
  }

  // ---------- 结语 ----------
  L.push('---');
  L.push('');
  L.push('## 历史病因（已闭环，留档备查）');
  L.push('');
  L.push('2026-09-17 批量核实前，91 笔里有 13 笔的 `nav` 对不上下单日，成因两类：');
  L.push('');
  L.push('1. **旧口径自动补填**：`backfill` 按已废弃的旧口径（A 股 +1 / QDII +2 个工作日）取净值。');
  L.push('   旧口径的 +1/+2 其实就是**份额确认日的 offset**，当年被误当成「定价日」→ QDII 白多取一天。');
  L.push('   新口径下 QDII 与 A 股同规则（15:00 前 = 下单日），**根本产生不了 +2**，所以那 4 笔必然错。');
  L.push('2. **手填了「下单时能看到的最近一条净值」**：当日净值当晚才公布，下单时可见的是**前一交易日**的，');
  L.push('   被当成了成交净值（4 笔）。');
  L.push('');
  L.push('两者的共同点是：**日期是你录的（可信），净值是事后补/抄的（不可信）** —— 所以一律按');
  L.push('「下单日 + 你确认的时段」用官方净值重算。');
  L.push('');
  L.push('## 口径备注');
  L.push('');
  L.push('- 长假顺延由各基金**自己的净值序列**决定，不查节假日表；上限 `MAX_ROLL_DAYS = 15` 自然日，超限标「预计」。');
  L.push('- 份额公式 `金额×(1−费率)÷净值`，与本看板「记一笔」预览用的**同一个函数**（`lib/buyPlan.js`）。');
  L.push('- 份额只依赖 `pricingDate` 的净值，与 `settleDate` 完全无关（改 `settleDate` 份额一个字节不变，有单测锁定）。');
  L.push('');

  const outPath = path.join(__dirname, '..', '..', 'docs', '历史买入核对清单.md');
  fs.writeFileSync(outPath, L.join('\n') + '\n', 'utf8');
  console.log('');
  console.log('✅ 已生成 ' + outPath);
  console.log('   总 ' + gid + ' 笔：已核实 ' + nVerified + '（前 ' + bySession.T + ' / 后 ' + bySession['T+1'] +
    '） / 不符 ' + suspects.length + ' / 未打标签 ' + untagged.length + ' / 在途 ' + nPending);
  process.exit(0);
})().catch((e) => { console.error('生成失败：', e); process.exit(2); });

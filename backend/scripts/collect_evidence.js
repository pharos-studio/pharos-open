'use strict';
// ============================================================================
// 路线 1（C）· 一键取证：脚本产出「证据包 + 草稿台账条目」，人工 5 分钟复核。
//
// ★★★ 三条不可越过的边界（写死在本文件里）：
//   1. **永不写入** `data/`、`backend/data/` 或任何仓库文件。只写 --out 指定的目录，
//      默认落在 %TEMP%。误传 --out 指向 data/ 时**直接报错退出**，不静默写进去。
//   2. **永不把任何 `*Verified` 填成 true。** 台账的核验标记是「人的结论」，不是「脚本的产出」。
//      草稿条目里四道门一律 false，并在 `_needsHuman` 里点名还差哪几道。
//      理由见 AGENTS.md 与 .workbuddy/门禁解除方案-QDII与港股通.md §4.2：本脚本
//      「不能全自动放行」——它只把 30–60 分钟的人工动作压成 5 分钟复核。
//   3. **不重写已有口径。** 净值抓取/复权/交易日历一律调用仓库自己那份实现
//      （activeEquityData / activeEquityNav / activeEquityCalendar），
//      免得「取证时看到的数」和「运行时算的数」对不上。
//
// 用法：
//   node backend/scripts/collect_evidence.js <code> [--out <dir>]
//   例：node backend/scripts/collect_evidence.js 110022
// ============================================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const { fetchText } = require('../lib/http');
const activeEquityData = require('../services/activeEquityData');
const activeEquityNav = require('../lib/activeEquityNav');
const calendar = require('../lib/activeEquityCalendar');
const fundProfile = require('../lib/fundProfile');

const TOOL = 'collect_evidence/v1';

// ── 边界 1：输出目录守卫 ────────────────────────────────────────────────
const FORBIDDEN_OUT = [path.join(ROOT, 'data'), path.join(ROOT, 'backend', 'data')];
function guardOut(dir) {
  const abs = path.resolve(dir);
  for (const bad of FORBIDDEN_OUT) {
    if (abs === bad || abs.startsWith(bad + path.sep))
      throw new Error('拒绝把取证产物写进数据目录（会污染真实数据/台账）：' + abs);
  }
  return abs;
}

const API_H = {
  Referer: 'https://fundf10.eastmoney.com/',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
};
const PDF_H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Referer: 'https://fundf10.eastmoney.com/' };
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// ── 步骤 1：定位并下载最新版《招募说明书》 ──────────────────────────────
async function latestProspectus(code) {
  const url = `https://api.fund.eastmoney.com/f10/JJGG?callback=&fundcode=${code}&pageIndex=1&pageSize=60&type=1`;
  const raw = String(await fetchText(url, API_H, 25000));
  const m = raw.match(/[\{\[][\s\S]*[\}\]]/);
  const json = JSON.parse(m ? m[0] : raw);
  const arr = (json && json.Data) || [];
  const sm = arr.filter(x => /招募说明书/.test(String(x.TITLE || '')));
  if (!sm.length) return { error: 'no_prospectus', scanned: arr.length };
  sm.sort((a, b) => String(b.PUBLISHDATE).localeCompare(String(a.PUBLISHDATE)));
  const hit = sm[0];
  return {
    title: String(hit.TITLE).trim(),
    publishDate: String(hit.PUBLISHDATE).slice(0, 10),
    announcementId: hit.ID,
    pdfUrl: `https://pdf.dfcfw.com/pdf/H2_${hit.ID}_1.pdf`,
    candidates: sm.length,
  };
}

async function downloadPdf(url) {
  const r = await fetch(url, { headers: PDF_H });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.slice(0, 5).toString() !== '%PDF-') throw new Error('返回不是 PDF');
  return buf;
}

// ── 步骤 2：净值完整性（复用仓库口径：完整分页 + 复权 + 单飞缓存）────────
// ★ 用 createService 打桩掉 write：默认实现会把抓到的净值写进 data/cache/，
//   那等于破坏「本脚本不写 data/」这条边界（也污染用户自己的缓存目录）。
//   read 保持默认 —— 读既有缓存是好事，能显著加速重复取证。
const evidenceService = activeEquityData.createService({ write: () => { } });
async function navEvidence(code) {
  const data = await evidenceService.fetchFull(code);
  const adjusted = activeEquityNav.adjust(data.history, data.actions, code);
  if (adjusted.error) return { error: adjusted.error + (adjusted.date ? '@' + adjusted.date : '') };
  const rows = adjusted.rows;                       // 复权后，按时间升序
  const navDays = new Set(rows.map(r => r.date));
  const rawDays = new Set(data.history.map(r => r.date));
  const first = rows[0].date, last = rows[rows.length - 1].date;
  // 与仓库自带的 A 股交易日历求差集：**这是观测，不是判定** ——
  // 「这些交易日没有净值」可能是停业/暂停申赎，也可能只是缺数据，必须由人对着公告判断。
  const inWindow = calendar.dates.filter(d => d >= first && d <= last);
  const noNav = inWindow.filter(d => !navDays.has(d));
  const rawVsAdjGap = [...rawDays].filter(d => !navDays.has(d));
  return {
    source: data.source,
    fetchedAt: new Date(data.fetchedAt).toISOString(),
    totalRawRows: data.total,
    checksum: data.checksum,
    actionsHash: data.actionsHash,
    dividends: (data.actions.dividends || []).length,
    splits: (data.actions.splits || []).length,
    firstNavDate: first,
    lastNavDate: last,
    adjustedRows: rows.length,
    tradingDaysInWindow: inWindow.length,
    tradingDaysWithoutNav: noNav.length,
    tradingDaysWithoutNavDates: noNav,
    rawRowsDroppedByAdjustment: rawVsAdjGap.length,
    adjustmentNote: adjusted.adjustment ? String(adjusted.adjustment).slice(0, 200) : null,
  };
}

// ── 步骤 3：组装证据包 ─────────────────────────────────────────────────
function buildEvidence(code, profile, prospectus, pdf, nav, failures) {
  const ap = (profile && profile.autoProfile) || {};
  return {
    tool: TOOL,
    code,
    generatedAt: new Date().toISOString(),
    identity: {
      name: profile && profile.name,
      fundType: (profile && profile.type) || ap.fundType || null,
      market: ap.market || null,
      category: ap.category || null,
      caliber: ap.caliber || null,
      profileState: ap.profileState || null,
      source: profile && profile.source || null,
    },
    prospectus: prospectus ? {
      title: prospectus.title,
      publishDate: prospectus.publishDate,
      announcementId: String(prospectus.announcementId),
      url: prospectus.pdfUrl,
      candidatesSeen: prospectus.candidates,
      bytes: pdf ? pdf.length : null,
      sha256: pdf ? sha256(pdf) : null,
    } : null,
    nav,
    // ★ 本脚本**判不了**的项，逐条列出，交人判断。这是本工具的核心产出之一。
    humanQuestions: [
      { key: 'identityVerified', question: '招募说明书里的基金管理人/基金名称/份额类别，是否与本条目一致？' },
      { key: 'rulesVerified', question: '合同约定的开放日/估值日/披露时限/港股通例外分别是什么？属于哪个变体？' },
      { key: 'continuityVerified', question: 'initializationFrom 应取哪天？（份额类别设立日 ≠ 基金合同生效日；本脚本不给候选值）' },
      { key: 'samplingVerified', question: `交易日历比对出 ${nav && nav.tradingDaysWithoutNav != null ? nav.tradingDaysWithoutNav : '?'} 个「有交易日无净值」的日子，是否都属于停业/暂停申赎？` },
      { key: 'typeChange', question: 'initializationFrom 之后是否发生过类型变更/转型/基准变更？是否属于已裁定模式？' },
    ],
    failures,
  };
}

// ── 步骤 4：草稿台账条目（★ 所有核验标记一律 false）─────────────────────
function buildDraft(code, evidence) {
  const gates = ['identityVerified', 'samplingVerified', 'continuityVerified', 'rulesVerified'];
  const draft = {
    code,
    name: evidence.identity.name,
    fundType: evidence.identity.fundType,
    market: evidence.identity.market,
    kind: null, kindNote: '由人按招募说明书投资范围填写（stock / mixed-equity / …）',
    otc: null, currency: null, active: null, enhanced: null, domestic: null,
    // ★ 四道门一律 false —— 脚本不得代替人签字。
    identityVerified: false, samplingVerified: false, continuityVerified: false, rulesVerified: false,
    source: evidence.prospectus ? evidence.prospectus.url : null,
    initializationFrom: null,
    contractSource: null,
    sampling: null,
    _needsHuman: gates.slice(),
    _autoFilled: ['code', 'name', 'fundType', 'market', 'source'],
    _generatedBy: TOOL,
    _generatedAt: evidence.generatedAt,
    _warning: '这是草稿，不是台账条目。四道门必须由人核对证据后手动改写 backend/data/activeEquityIdentity.json。',
  };
  return draft;
}

// ── main ──────────────────────────────────────────────────────────────
async function main() {
  const code = (process.argv[2] || '').trim();
  if (!/^\d{6}$/.test(code)) { console.error('用法：node backend/scripts/collect_evidence.js <6位基金代码> [--out <目录>]'); process.exit(2); }
  const outIdx = process.argv.indexOf('--out');
  const outDir = guardOut(outIdx > -1 && process.argv[outIdx + 1]
    ? process.argv[outIdx + 1]
    : path.join(os.tmpdir(), 'pharos-evidence', code));
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`取证 ${code} → ${outDir}\n（产物只写这里；不碰 data/ 与仓库文件）\n`);
  const failures = [];

  // 1) 档案
  let profile = null;
  try { profile = await fundProfile.lookup(code); }
  catch (e) { failures.push({ step: 'identity', error: e.message }); }
  console.log('① 档案      ', profile && profile.found ? `${profile.name}｜${profile.type}｜${(profile.autoProfile || {}).market}` : '取不到');

  // 2) 招募说明书
  let prospectus = null, pdf = null;
  try {
    prospectus = await latestProspectus(code);
    if (prospectus.error) failures.push({ step: 'prospectus', error: prospectus.error });
    else {
      pdf = await downloadPdf(prospectus.pdfUrl);
      fs.writeFileSync(path.join(outDir, `prospectus-${code}.pdf`), pdf);
      console.log(`② 招募说明书  ${(pdf.length / 1024).toFixed(0)}KB  ${prospectus.publishDate}  ${prospectus.title.slice(0, 40)}`);
      console.log(`             sha256 ${sha256(pdf)}`);
    }
  } catch (e) { failures.push({ step: 'prospectus', error: e.message }); console.log('② 招募说明书  失败：' + e.message); }

  // 3) 净值与连续性
  let nav = null;
  try {
    nav = await navEvidence(code);
    if (nav.error) { failures.push({ step: 'nav', error: nav.error }); console.log('③ 净值      失败：' + nav.error); }
    else {
      console.log(`③ 净值      ${nav.totalRawRows} 行原始 → ${nav.adjustedRows} 行复权  ${nav.firstNavDate} → ${nav.lastNavDate}`);
      console.log(`             分红 ${nav.dividends} 次 / 拆分 ${nav.splits} 次`);
      console.log(`             窗口内交易日 ${nav.tradingDaysInWindow}，其中无净值 ${nav.tradingDaysWithoutNav} 天`);
      if (nav.tradingDaysWithoutNav > 0) console.log(`             ⚠ 观测（不是判定）：${nav.tradingDaysWithoutNavDates.slice(0, 12).join(', ')}${nav.tradingDaysWithoutNav > 12 ? ' …' : ''}`);
    }
  } catch (e) { failures.push({ step: 'nav', error: e.message }); console.log('③ 净值      失败：' + e.message); }

  // 4) 落盘
  const evidence = buildEvidence(code, profile, prospectus, pdf, nav, failures);
  fs.writeFileSync(path.join(outDir, `evidence-${code}.json`), JSON.stringify(evidence, null, 1));
  const draft = buildDraft(code, evidence);
  fs.writeFileSync(path.join(outDir, `draft-${code}.json`), JSON.stringify(draft, null, 1));

  console.log('\n──────────── 人工复核清单（5 分钟）────────────');
  evidence.humanQuestions.forEach((q, i) => console.log(`  ${i + 1}. [${q.key}] ${q.question}`));
  console.log('\n草稿条目已写 draft-' + code + '.json（四道门一律 false，需人工改写台账后才生效）');
  if (failures.length) {
    console.log('\n⚠ 未完成的步骤：');
    failures.forEach(f => console.log('   · ' + f.step + ': ' + f.error));
    process.exitCode = 1;
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
'use strict';
/*
 * 脱敏审计 —— 拦住「真实数据混进公开仓」
 *
 * 为什么存在：2026-09-18 公开仓 `pharos-open` 把一个测试脚本推上了公网，脚本里写死了
 * 用户 5 笔真实买入的「金额 / 净值 / 份额 / 定价日 / 确认日」，与私有 holdings.json 逐字段一致。
 * 根因：那轮脱敏**只查了关键词**（姓名 / 路径 / 密钥），**没查数值指纹** ——
 * 而**数值本身不含任何敏感词** —— 精度就是它的隐蔽性，关键词扫描永远抓不到。
 *
 * ── 判据与严重度（全部经实测，2026-09-18 对当时**含泄露**的公开仓跑真实数据）──
 *   FAIL  numeric-fingerprint  命中私有持仓的高精度净值/份额（小数位 >= 4）
 *                              命中 12 / 误报 0 —— 唯一有信息论依据的判据，本方案的防线
 *   FAIL  forbidden-path       目标树**被 git 跟踪**的文件里出现「公开仓绝不该有」的路径
 *   FAIL  keyword              机器绝对路径 / 个人标识 / 本机工具隐藏目录名 / 真实密钥 / 本机网卡 IP
 *   FAIL  inline-data          `nav|shares|sh` 后跟 >=4 位小数字面量（对象写法）  命中 9 / 误报 0
 *   WARN  inline-call          `computeShares(...)` 里带 >=4 位小数（函数实参写法）
 *                              命中 15 / 误报 8（费率常量 0.0015 等）→ 误报 >50%，只提示不拦截
 *   WARN  stale-url            残留的旧仓库地址（搬家漏改）
 *   WARN  amount-date          --paranoid 才开：整数金额与真实买入日同行共现（实测误报 100% / 20%）
 *
 *   ★ 刻意**不**把整数金额（10 / 50 / 100 / 500）当判据：公开仓本就有示例金额与回测样本，
 *     信息论上不可分（实测命中 5 / 误报 5 = 100%）。**精度本身就是判别式。**
 *
 * ── 双形态自动降级（这是「CI 在公开仓没有真实数据」这个矛盾的解法）──
 *   Mode A（数据机 / 私有仓）—— 有真实 holdings.json → 指纹比对全量生效
 *   Mode B（公开仓 / CI）    —— 无真实数据可比 → 只做结构 + 关键词 + 内联 lint
 *   ★ 看到 Mode B 的绿，**不等于**脱敏安全 —— 它只是防呆；真正的门禁是 Mode A。
 *
 * 用法：
 *   node backend/scripts/audit_desensitize.js                     # 审自己所在的树
 *   node backend/scripts/audit_desensitize.js --repo <dir>        # 审另一棵树（私有仓 CI 用它扫公开仓）
 *   node backend/scripts/audit_desensitize.js --files <list.txt>  # 只审清单内的文件（publish.js 的复制前预检）
 *   node backend/scripts/audit_desensitize.js .                   # 等价于「审自己」（npm run audit 用它）
 *   附加：--show-values（打印命中值，默认隐藏，避免 CI 日志二次扩散）/ --paranoid / --quiet
 *
 * 退出码：0 干净 · 1 有 FAIL 级命中（CI 拦截）· 2 用法或 IO 错误
 *
 * ★ 本文件在两仓**逐字节相同**，自适配：指纹来源永远是「本脚本所在仓库」的 holdings.json，
 *   而扫描目标由 --repo 指定。所以私有仓 CI 可以「在私有仓里跑、扫公开仓」。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

// ── 正则判据 ──
const INLINE_DATA_RX = /(?:^|[\s,{[(])(?:nav|shares|sh)\s*[:=]\s*-?\d+\.\d{4,}/;
const INLINE_CALL_RX = /(?:computeShares|netInvestedOf|calcShares)\s*\([^)]*\d+\.\d{4,}/;
const PRIVATE_IP_RX = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;

// ── 关键词一律**拼接构造**，避免审计脚本自己命中自己（自扫描守卫）──
const KW_ABS = [
  'C:' + '\\Us' + 'ers\\',
  'C:' + '/Us' + 'ers/',
  '/Us' + 'ers/',
  '/ho' + 'me/',
  '/ro' + 'ot/',
];
const KW_WORKBUDDY = '.' + 'workbuddy';
const KW_STALE = [
  'Zarek-' + 'Zhao1112',
  'zarek-' + 'zhao1112',
];

// ── 公开仓绝不该「被 git 跟踪」的路径（前缀匹配）──
const FORBIDDEN_PATHS = [
  'data/state/',
  'data/series/',
  'data/cache/',
  'data/config/config.json',
  'data/config/categories.json',
  'docs/_local/',
  'GITHUB_UPLOAD.md',
  'publish.manifest.json',
  '.' + 'workbuddy/',
  'backend/.' + 'workbuddy/',
  'fund_server.log',
  '支线/',
  '_bak_',
];

// docs/ 下允许公开的文档白名单（= 同步清单里的 shared 文档）。
// ★ 刻意用**白名单**而不是点名禁止某个文件：既不把私有文档的文件名写进公开仓，
//   又能保证「以后新增一份 docs/*.md 忘了归类」时默认被拒绝（宁可吵，不可静默漏）。
const DOCS_ALLOWED = new Set([
  'docs/算法设计复盘手册.md',
  'docs/决策分配算法模型.md',
  'docs/前端设计系统.md',
  'docs/后端架构清单.md',
]);

const TEXT_EXT = /\.(js|mjs|cjs|json|html|css|md|txt|bat|cmd|sh|ps1|yml|yaml|svg|webmanifest|example)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor']);
const DEMO_RX = /DEMO DATA|NOT real holdings|placeholder/i;

// ── 基础读取 ──
function readJSONIf(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function isRealHoldings(h) {
  if (!h || !Array.isArray(h.funds)) return false;
  if (typeof h._comment === 'string' && DEMO_RX.test(h._comment)) return false;
  return true;
}
function hasRealHoldings(root) {
  return isRealHoldings(readJSONIf(path.join(root, 'data', 'state', 'holdings.json')));
}
function gitBin() {
  if (process.platform === 'win32') {
    const p = 'C:\\Program Files\\Git\\bin\\git.exe';
    if (fs.existsSync(p)) return p;
  }
  return 'git';
}
function gitTrackedFiles(repo) {
  try {
    const out = execFileSync(gitBin(), ['-C', repo, 'ls-files', '-z'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch (e) { return null; }
}

// ── 指纹：来自**本脚本所在仓库**（数据机）的真实持仓 ──
function loadFingerprints() {
  const h = readJSONIf(path.join(ROOT, 'data', 'state', 'holdings.json'));
  if (!isRealHoldings(h)) return null;
  const set = new Set();
  let n = 0;
  for (const f of h.funds) {
    for (const p of (f.purchases || [])) {
      n++;
      for (const v of [p.nav, p.shares]) {
        if (typeof v === 'number' && /\.\d{4,}/.test(String(v))) set.add(String(v));
      }
    }
  }
  return { values: [...set], purchases: n };
}
function loadFixtureKeywords() {
  const fx = readJSONIf(path.join(ROOT, 'data', 'state', 'regression_cases.json'));
  return (fx && Array.isArray(fx.forbiddenKeywords)) ? fx.forbiddenKeywords.filter(Boolean) : [];
}
function loadSecret() {
  const c = readJSONIf(path.join(ROOT, 'data', 'config', 'config.json'));
  const k = c && c.apiKey;
  return (typeof k === 'string' && k.length >= 8 && k !== 'dev') ? k : null;
}
function loadLanIPs() {
  const out = [];
  try {
    const nics = os.networkInterfaces();
    for (const name of Object.keys(nics)) {
      for (const a of (nics[name] || [])) {
        if (a && a.family === 'IPv4' && !a.internal) out.push(a.address);
      }
    }
  } catch (e) { /* 拿不到网卡信息不影响其余判据 */ }
  return out;
}

// ── 遍历 ──
function isTextFile(p) {
  const b = path.basename(p);
  if (b === '.gitignore' || b === '.gitattributes' || b === '.nojekyll' || b === '.npmrc') return true;
  return TEXT_EXT.test(b);
}
function walk(root, isSkipped) {
  const skip = isSkipped || (() => false);
  const out = [];
  (function rec(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (rel === 'public/vendor') continue;
        if (skip(rel)) continue;
        rec(p);
      } else {
        if (skip(rel)) continue;
        out.push({ full: p, rel });
      }
    }
  })(root);
  return out;
}

// ── 内容检查 ──
// skipEnv：审的是「数据机自己」时为 true。
//   机器绝对路径、工具隐藏目录名、本机网卡 IP 在数据机上本来就是常态（连它的 .gitignore
//   都必然要写着忽略规则），不构成违规。这类规则只在「审公开仓」与「复制前预检源文件」时才有意义。
function buildKeywords(mode, skipEnv) {
  const kws = [];
  if (skipEnv) return kws;
  for (const v of KW_ABS) kws.push({ value: v, rule: 'abs-path', level: 'FAIL' });
  kws.push({ value: KW_WORKBUDDY, rule: 'workbuddy-dir', level: 'FAIL' });
  for (const v of KW_STALE) kws.push({ value: v, rule: 'stale-url', level: 'WARN' });
  if (mode === 'A') {
    for (const v of loadFixtureKeywords()) kws.push({ value: v, rule: 'personal-id', level: 'FAIL' });
    const sec = loadSecret();
    if (sec) kws.push({ value: sec, rule: 'secret', level: 'FAIL' });
    for (const ip of loadLanIPs()) kws.push({ value: ip, rule: 'lan-ip', level: 'FAIL' });
  }
  // 通用私网段（RFC1918）：两模式都查，但只 WARN ——
  // 公开文档里拿 192.168.x.x 举例是合法且常见的（实测误报 1 处：前端错误提示文案里的示例地址）。
  // 真正该 FAIL 的是「本机那张网卡的真实地址」，那条已在上面的 Mode A 分支单独登记为 FAIL。
  kws.push({ value: null, rx: PRIVATE_IP_RX, rule: 'private-ip-sample', level: 'WARN' });
  return kws;
}

function checkFile(entry, ctx) {
  let content;
  try {
    const st = fs.statSync(entry.full);
    if (st.size > 4 * 1024 * 1024) return [{ level: 'WARN', rule: 'skipped-large', file: entry.rel, line: 0 }];
    content = fs.readFileSync(entry.full, 'utf8');
  } catch (e) { return []; }
  if (content.indexOf('\0') >= 0) return []; // 二进制

  const hits = [];
  const lines = content.split(/\r?\n/);
  const seen = new Set();
  const push = (level, rule, line, value) => {
    const k = level + '|' + rule + '|' + line + '|' + (value || '');
    if (seen.has(k)) return;
    seen.add(k);
    hits.push({ level, rule, file: entry.rel, line, value });
  };

  // ① 数值指纹（Mode A）—— 先整体 includes 快速过滤，再定位行
  if (ctx.fingerprints) {
    for (const v of ctx.fingerprints.values) {
      if (content.indexOf(v) < 0) continue;
      for (let i = 0; i < lines.length; i++) if (lines[i].indexOf(v) >= 0) push('FAIL', 'numeric-fingerprint', i + 1, v);
    }
  }

  // ② 关键词 + 内联 lint（逐行）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const kw of ctx.keywords) {
      const hit = kw.rx ? kw.rx.test(line) : line.indexOf(kw.value) >= 0;
      if (hit) push(kw.level, kw.rule, i + 1, kw.value);
    }
    if (INLINE_DATA_RX.test(line)) push('FAIL', 'inline-data', i + 1, null);
    if (INLINE_CALL_RX.test(line)) push('WARN', 'inline-call', i + 1, null);
  }

  // ③ paranoid：整数金额 + 真实买入日期同行共现
  if (ctx.paranoid && ctx.fingerprints) {
    for (const amt of ctx.amounts || []) {
      if (content.indexOf(amt) < 0) continue;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf(amt) >= 0 && /\d{4}-\d{2}-\d{2}/.test(lines[i])) {
          push('WARN', 'amount-date', i + 1, amt);
        }
      }
    }
  }
  return hits;
}

// ── 禁止路径（按 git 跟踪口径，避免把 setup 生成物误判）──
function checkForbiddenPaths(root) {
  const tracked = gitTrackedFiles(root);
  if (!tracked) {
    return { hits: [], note: '目标不是 git 仓库（或无 git）→ 跳过路径检查。CI 里 setup 生成的文件因此不会误报。' };
  }
  const hits = [];
  for (const f of tracked) {
    const norm = f.split('\\').join('/');
    for (const pat of FORBIDDEN_PATHS) {
      if (norm === pat || norm.startsWith(pat)) hits.push({ level: 'FAIL', rule: 'forbidden-path', file: norm, line: 0, value: null });
    }
    // docs/ 下除白名单外的任何文档一律禁止（防止私有文档被顺手带进公开仓）
    if (norm.startsWith('docs/') && norm.endsWith('.md') && !DOCS_ALLOWED.has(norm)) {
      hits.push({ level: 'FAIL', rule: 'forbidden-doc', file: norm, line: 0, value: null });
    }
  }
  return { hits, note: '按 git ls-files 口径：工作区里有但被 .gitignore 挡住 = 合法。', tracked: tracked.length };
}

// ── 主流程 ──
function audit(opts) {
  const o = opts || {};
  const target = o.repo ? path.resolve(o.repo) : ROOT;
  const showValues = !!o.showValues;
  const quiet = !!o.quiet;

  // ★ 拒绝「扫了 0 个文件却判干净」——那是最危险的假绿。
  //   实测踩过：在 Windows 上把 Git-Bash 风格的路径（以斜杠开头的盘符写法）传给 --repo，
  //   path.resolve 会把它拼成一个不存在的绝对路径，walk 静默返回空数组，
  //   于是打出一片 ✅ 干净。CI 里如果 clone 路径写错，门禁就是这样被绕过的。
  if (!fs.existsSync(target)) {
    throw new Error('扫描目标不存在：' + target
      + '\n  提示：Windows 上请传 Windows 风格的绝对路径（以「盘符 + 冒号」开头）。'
      + 'Git-Bash / MSYS 里那种以斜杠开头的盘符写法，在 Windows 上会被解析成不存在的路径。');
  }

  const fp = loadFingerprints();
  const mode = fp ? 'A' : 'B';
  // 审「数据机自己」时跳过环境关键词；--files（复制前预检）与审公开仓时必须保留。
  const skipEnv = !o.files && hasRealHoldings(target);
  const ctx = {
    fingerprints: fp,
    keywords: buildKeywords(mode, skipEnv),
    paranoid: !!o.paranoid,
  };
  if (fp) {
    const h = readJSONIf(path.join(ROOT, 'data', 'state', 'holdings.json'));
    const amts = new Set();
    for (const f of (h.funds || [])) for (const p of (f.purchases || [])) {
      if (typeof p.amount === 'number') amts.add(String(p.amount));
    }
    ctx.amounts = [...amts];
  }

  let entries, pathCheck = null;
  let filesSeen = 0;

  if (o.files) {
    // --files：只审指定文件（复制前预检）
    const listTxt = fs.readFileSync(o.files, 'utf8');
    entries = listTxt.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .map(p => ({ full: path.isAbsolute(p) ? p : path.resolve(p), rel: p }));
    filesSeen = entries.length;
  } else {
    // 指纹扫描必须跳过「数据机自己的私有数据区」，否则必然全红（它本身就含全部真实值）。
    // 但对**公开仓**（无真实持仓）不跳过 —— 万一真实数据被误放进去，也要能被抓到。
    const targetIsDataMachine = hasRealHoldings(target);
    let isSkipped = () => false;
    if (targetIsDataMachine) {
      const prefixes = FORBIDDEN_PATHS.map(s => s.replace(/\/$/, ''));
      isSkipped = (rel) => {
        if (prefixes.some(p => rel === p || rel.startsWith(p))) return true;
        // docs/ 下不在公开白名单里的文档（私有资料）也跳过
        if (rel.startsWith('docs/') && rel.endsWith('.md') && !DOCS_ALLOWED.has(rel)) return true;
        return false;
      };
    } else {
      pathCheck = checkForbiddenPaths(target);
    }
    entries = walk(target, isSkipped).filter(e => isTextFile(e.full));
    filesSeen = entries.length;
  }

  // 同上：0 个文件不构成「通过」——空清单同样是配置错误，必须吵出来。
  if (entries.length === 0) {
    throw new Error(o.files
      ? '待审清单里没有任何文件（' + o.files + '）：什么都没查，不能判为通过。'
      : '在 ' + target + ' 下没找到任何文本文件：路径可能不对，不能判为通过。');
  }

  const hits = [];
  for (const e of entries) hits.push(...checkFile(e, ctx));
  if (pathCheck) hits.push(...pathCheck.hits);

  const fails = hits.filter(h => h.level === 'FAIL');
  const warns = hits.filter(h => h.level === 'WARN');

  // ── 输出 ──
  if (!quiet) {
    console.log('\n\u2500\u2500 脱敏审计 \u2500\u2500');
    if (mode === 'A') {
      console.log(`  模式：A（数据机）—— 数值指纹 ${fp.values.length} 个 · 来自 ${fp.purchases} 笔真实买入`);
    } else {
      console.log('  模式：B（公开仓 / CI）');
      console.log('  \u26a0 降级声明：本仓库没有真实持仓，**无法做真实数值把关** ——');
      console.log('    这里只做「结构 + 关键词 + 内联 lint」的防呆。看到绿 ≠ 脱敏安全。');
      console.log('    真正的门禁在数据机（Mode A）与 publish.js 的复制前预检。');
    }
    console.log(`  扫描：${target}`);
    console.log(`  文本文件 ${filesSeen} 个` + (pathCheck && pathCheck.tracked != null ? ` · git 跟踪 ${pathCheck.tracked} 个` : ''));
    if (pathCheck) console.log(`  路径口径：${pathCheck.note}`);
    console.log('');
    for (const h of fails) {
      console.log(`  FAIL  [${h.rule}] ${h.file}${h.line ? ':' + h.line : ''}` + (showValues && h.value ? `  → ${h.value}` : ''));
    }
    for (const h of warns) {
      console.log(`  WARN  [${h.rule}] ${h.file}${h.line ? ':' + h.line : ''}` + (showValues && h.value ? `  → ${h.value}` : ''));
    }
    console.log(`\n  FAIL ${fails.length} 处 · WARN ${warns.length} 处`);
    if (fails.length === 0) console.log('  \u2705 干净');
    else console.log('  \u274c 有 FAIL 级命中 —— 绝不可发布');
    console.log('');
  }
  return { mode, fails, warns, filesSeen, fingerprints: fp ? fp.values.length : 0, purchases: fp ? fp.purchases : 0 };
}

module.exports = { audit, loadFingerprints, FORBIDDEN_PATHS, INLINE_DATA_RX, INLINE_CALL_RX };

// ── CLI ──
if (require.main === module) {
  const argv = process.argv.slice(2);
  const o = { repo: null, files: null, showValues: false, paranoid: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') o.repo = argv[++i];
    else if (a === '--files') o.files = argv[++i];
    else if (a === '--show-values') o.showValues = true;
    else if (a === '--paranoid') o.paranoid = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '.') o.repo = null;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node backend/scripts/audit_desensitize.js [--repo <dir>] [--files <list.txt>] [--show-values] [--paranoid] [--quiet]');
      process.exit(0);
    } else { console.error('未知参数: ' + a + '（--help 看用法）'); process.exit(2); }
  }
  try {
    const r = audit(o);
    process.exit(r.fails.length ? 1 : 0);
  } catch (e) {
    console.error('审计脚本出错: ' + (e && e.message));
    process.exit(2);
  }
}

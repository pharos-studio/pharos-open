'use strict';
/*
 * 提交信息扫描 —— 补上 audit_desensitize.js 抓不到的那条通道
 *
 * 为什么存在：`audit_desensitize.js` 是**内容扫描器**——它读的是文件内容，
 * 而**提交信息不在任何文件里**，只在 git object 里。于是「9 只真实持仓 / 37 笔已确认记录」
 * 这种只写在 commit message 里的话，跑一万次内容审计也抓不到（实测：audit FAIL 0，而它就在日志里）。
 *
 * 判据分两档：
 *   FAIL  machine-path   机器绝对路径（泄露用户名/目录结构）
 *   FAIL  secret-shape   常见凭据前缀 + 足够长度的字面量
 *   FAIL  stale-owner    旧仓库归属名（搬家漏改）
 *   FAIL  private-ip     本机内网 IP
 *   WARN  portfolio-shape 「N 只真实持仓 / N 笔已确认记录 / N/N 基金」这类**形态陈述**
 *   WARN  hidden-dir     工具隐藏目录名字面量
 *
 * ★ 全部判据**拼接构造**，避免本文件被 audit_desensitize 自己扫到时自我命中。
 * ★ portfolio-shape 只 WARN：它是隐私形态陈诉，不是凭据；且「N/N 测试通过」有正当用法，
 *   信息论上不可分（与整数金额同理）。真正的门禁是 commit-msg 钩子在**写之前**拦住。
 *
 * 用法：
 *   node backend/scripts/scan_commit_msg.js                 # 扫 HEAD 可达的全部提交
 *   node backend/scripts/scan_commit_msg.js --range A..B    # 只扫区间（CI 增量用）
 *   node backend/scripts/scan_commit_msg.js --message-file <path>   # 只扫单条（commit-msg 钩子用）
 *   node backend/scripts/scan_commit_msg.js --quiet
 *
 * 退出码：0 干净 · 1 有 FAIL · 2 用法/IO 错误
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

// ── 判据（拼接构造，见文件头）──
const HARD = [
  ['machine-path', new RegExp(
    'C:' + '\\\\+' + '[Uu]sers' + '\\\\' + '|' +
    'C:' + '/' + '[Uu]sers' + '/' + '|' +
    '(?:^|[^.\\w])/' + 'Users' + '/[A-Za-z0-9._-]+' + '|' +
    '(?:^|[^.\\w])/' + 'home' + '/[A-Za-z0-9._-]+' + '|' +
    '(?:^|[^.\\w])/' + 'root' + '/' + '|' +
    '\\\\App' + 'Data\\\\' + '|' +
    '/' + 'App' + 'Data/')],
  ['secret-shape', new RegExp(
    'gh' + 'p_[A-Za-z0-9]{20,}|ght' + 'oken_[A-Za-z0-9]{20,}|' +
    'github_' + 'pat_[A-Za-z0-9_]{20,}|' +
    'sk' + '-[A-Za-z0-9]{20,}|' +
    'AK' + 'IA[0-9A-Z]{16}')],
  ['stale-owner', new RegExp(
    'Zarek' + '-' + 'Zhao1112' + '|' +
    'zarek' + '-' + 'zhao1112')],
  ['private-ip', new RegExp(
    '\\b(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|' +
    '192\\.168\\.\\d{1,3}\\.\\d{1,3}|' +
    '172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})\\b')],
];

const SOFT = [
  // 「N 只真实持仓」「N 笔已确认记录」——泄露组合形态
  ['portfolio-shape', new RegExp(
    '\\d+\\s*只' + '(?:真实|个人)?' + '持' + '仓' + '|' +
    '\\d+\\s*笔' + '(?:已)?确认' + '(?:的)?' + '记录' + '|' +
    '\\d+\\s*/\\s*\\d+\\s*' + '基金' + '|' +
    '(?:真实|个人)' + '持' + '仓')],
  ['hidden-dir', new RegExp('(?:^|[^.\\w])' + '\\.' + 'work' + 'buddy')],
];

const gitBin = () => {
  const cands = [
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files/Git/mingw64/bin/git.exe',
    'git',
  ];
  for (const c of cands) { try { execFileSync(c, ['--version'], { stdio: 'pipe' }); return c; } catch (e) { /* next */ } }
  return 'git';
};

function runGit(args) {
  try {
    return execFileSync(gitBin(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return null;
  }
}

function scanMessage(text) {
  const hits = [];
  for (const [rule, re] of HARD) {
    const m = text.match(re);
    if (m) hits.push({ level: 'FAIL', rule, value: m[0] });
  }
  for (const [rule, re] of SOFT) {
    const m = text.match(re);
    if (m) hits.push({ level: 'WARN', rule, value: m[0] });
  }
  return hits;
}

function commitsFromLog(range) {
  const args = ['log', '--format=%H%x1f%ci%x1f%s%x1f%b%x1e'];
  if (range) args.splice(1, 0, range);
  const out = runGit(args);
  if (out == null) return null;
  return out.split('\x1e').map(s => s.trim()).filter(Boolean).map(blob => {
    const p = blob.split('\x1f');
    return { sha: (p[0] || '').trim(), date: (p[1] || '').trim(), subject: (p[2] || '').trim(), body: (p[3] || '') };
  });
}

function main() {
  const argv = process.argv.slice(2);
  const o = { range: null, messageFile: null, quiet: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--range') o.range = argv[++i];
    else if (argv[i] === '--message-file') o.messageFile = argv[++i];
    else if (argv[i] === '--quiet') o.quiet = true;
    else if (argv[i] === '--strict') o.strict = true;
    else { console.error('未知参数: ' + argv[i]); process.exit(2); }
  }

  let items;
  if (o.messageFile) {
    if (!fs.existsSync(o.messageFile)) { console.error('消息文件不存在: ' + o.messageFile); process.exit(2); }
    items = [{ sha: '(pending)', date: '', subject: '', body: fs.readFileSync(o.messageFile, 'utf8') }];
  } else {
    items = commitsFromLog(o.range);
    if (items == null) { console.error('无法读取 git 日志（本机 git 不可用？）'); process.exit(2); }
  }

  const hits = [];
  for (const c of items) {
    const text = c.subject + '\n' + c.body;
    for (const h of scanMessage(text)) hits.push({ ...h, sha: c.sha, date: c.date, subject: c.subject });
  }

  const fails = hits.filter(h => h.level === 'FAIL');
  const warns = hits.filter(h => h.level === 'WARN');

  const required = o.strict ? hits : fails;
  const blocking = required.length;

  if (!o.quiet) {
    console.log('\n\u2500\u2500 提交信息扫描 \u2500\u2500');
    console.log('  提交 ' + items.length + ' 条' + (o.range ? '（区间 ' + o.range + '）' : '') + (o.strict ? ' · strict 模式' : ''));
    if (items.length === 0) {
      console.log('  \u26a0 一条都没扫到 —— 若是浅克隆（shallow clone）属正常，不构成通过。');
    }
    console.log('');
    for (const h of fails) console.log('  FAIL  [' + h.rule + '] ' + h.sha.slice(0, 8) + '  ' + h.subject.slice(0, 42) + '  \u2192 ' + h.value);
    for (const h of warns) console.log('  WARN  [' + h.rule + '] ' + h.sha.slice(0, 8) + '  ' + h.subject.slice(0, 42) + '  \u2192 ' + h.value);
    console.log('\n  FAIL ' + fails.length + ' 处 · WARN ' + warns.length + ' 处');
    if (blocking === 0) console.log('  \u2705 干净' + (fails.length ? '' : '（无凭据级泄露）'));
    else console.log('  \u274c 提交信息含不得发布的表述');
    if (warns.length && !o.strict) console.log('  \u2139 WARN 项默认不拦截 —— 但请确认它没在描述你的真实持仓。');
    console.log('');
  }

  process.exit(blocking === 0 ? 0 : 1);
}

module.exports = { scanMessage, HARD, SOFT };
if (require.main === module) main();

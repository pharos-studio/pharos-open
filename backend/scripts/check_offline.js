'use strict';
/*
 * 离线契约守卫 —— 证明 `npm run test:offline` 里的脚本**真的不联网**。
 *
 * 为什么要专门有个工具：`test:offline` 这个名字是一个**承诺**。CI 跑在境外 runner 上，
 * 连不上东财/蛋卷这类国内数据源 —— 一旦某个脚本偷偷联网，CI 会**稳定误报失败**，
 * 而且报出来的是「断言不过」，看不出真正原因是网络。
 *
 * 2026-09-18 就是这么翻的车：`verify_bond10y` 内部调用 `fetchBond10Y()` / `fetchIndexPeHistory()`，
 * 在本机（能连上）跑得又快又好，看着完全像离线 —— 直到 CI 在 UTC runner 上把 3 个 job 全跑红。
 *
 * ── 用法 ──
 *   ① 跑整条链：`npm run check:offline`
 *   ② 只验一个脚本：`node -r ./backend/scripts/check_offline.js backend/scripts/xxx.js`
 *
 * 脚本清单不在这里另写一份 —— 它从 package.json 的 `test:offline` 里读，
 * 保证「要验的就是要跑的那批」。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

// ── 断网器：把所有对外网络入口换成「一调用就抛错」──
// ★ 刻意抛错而不是静默返回空值：静默返回空会让脚本「跑绿」，等于换一种方式骗人。
function boom(what) {
  return () => { throw new Error('NETWORK BLOCKED by check_offline: ' + what); };
}
function blockNetwork() {
  globalThis.fetch = boom('global fetch');
  for (const mod of ['http', 'https']) {
    try {
      const m = require(mod);
      m.request = boom(mod + '.request');
      m.get = boom(mod + '.get');
    } catch (e) { /* 模块不存在则跳过 */ }
  }
  try {
    const net = require('net');
    net.connect = boom('net.connect');
    net.createConnection = boom('net.createConnection');
  } catch (e) { /* 跳过 */ }
  try {
    const dns = require('dns');
    dns.lookup = boom('dns.lookup');
    dns.resolve = boom('dns.resolve');
  } catch (e) { /* 跳过 */ }
}

if (require.main !== module) {
  // ── 以预加载模块运行（node -r）：只装断网器 ──
  blockNetwork();
} else {
  // ── 以主模块运行：读 package.json 的 test:offline，逐个脚本带断网器跑 ──
  console.log('');
  console.log('── 离线契约守卫 ──');
  console.log('  把 test:offline 里的每个脚本都挂上断网器复跑一遍。');
  console.log('  任何脚本触网都会立刻抛错 —— 那说明它不该留在离线链里。');
  console.log('');

  let chain = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    chain = (pkg.scripts || {})['test:offline'] || '';
  } catch (e) {
    console.error('❌ 读不到 package.json：' + (e && e.message));
    process.exit(2);
  }

  const targets = [];
  for (const seg of chain.split('&&').map(s => s.trim()).filter(Boolean)) {
    const m = seg.match(/^node\s+(\S+)$/);
    if (!m) {
      console.error('❌ 无法解析 test:offline 里的这一段（本工具只认 `node <脚本>`）：');
      console.error('     ' + seg);
      process.exit(2);
    }
    targets.push(m[1]);
  }
  if (!targets.length) {
    console.error('❌ package.json 里没有 test:offline，或它是空的。');
    process.exit(2);
  }

  const broken = [];
  for (const t of targets) {
    const full = path.join(ROOT, t);
    const r = spawnSync(process.execPath, ['-r', __filename, full],
      { stdio: 'pipe', encoding: 'utf8', timeout: 5 * 60 * 1000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const touchedNet = out.includes('NETWORK BLOCKED by check_offline');
    const name = path.basename(t).replace(/\.js$/, '');
    if (r.status === 0 && !touchedNet) {
      console.log('  ✅ ' + name.padEnd(28) + '真离线');
    } else {
      console.log('  ❌ ' + name.padEnd(28) + (touchedNet ? '联网了（被断网器抓住）' : '离线跑不过，退出码 ' + r.status));
      broken.push({ name, touchedNet });
    }
  }

  console.log('');
  if (!broken.length) {
    console.log('✅ 离线契约成立：' + targets.length + ' 个脚本一个都没联网。');
    console.log('   （往那条链里加脚本之前，先跑一遍本命令。）');
    console.log('');
    process.exit(0);
  }
  console.log('❌ 离线契约被破坏：' + broken.length + ' / ' + targets.length + ' 个脚本不合格。');
  console.log('   处理方式：把它移出 test:offline，改挂一个独立的 npm script（如 test:network），');
  console.log('   并在 README 注明它需要联网、不进 CI。');
  console.log('');
  process.exit(1);
}

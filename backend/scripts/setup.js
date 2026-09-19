'use strict';
/*
 * 跨平台首次运行 —— 从 data/example/ 的脱敏模板生成你自己的工作数据。
 *
 * 为什么要有这个：此前只有 setup.bat（Windows 专用），macOS / Linux 的协作者
 * 得手工 `cp` 三个文件，还得先猜出目标目录名。现在三平台跑同一份逻辑。
 *
 *   Windows        双击 setup.bat（它只负责探测 node，然后调用本文件）
 *   macOS / Linux  npm run setup   （或 node backend/scripts/setup.js）
 *
 * ★ 幂等：目标文件已存在就**跳过**，绝不覆盖 —— 反复运行不会毁掉你的数据。
 * ★ 目标目录名必须与 backend/lib/store.js 的 LAYOUT 保持一致（state / config）。
 *   那是目录映射的唯一真相源；改目录结构时两处必须同改。
 * ★ 本文件在「数据机」与「开源版」两仓逐字节相同。
 * ★ 不联网、不上传任何东西，只在本机复制文件。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');

// [模板, 目标, 说明]  —— 目标目录名 = store.js 的 LAYOUT 分区名
const PAIRS = [
  ['data/example/holdings.example.json',   'data/state/holdings.json',    '持仓记录'],
  ['data/example/config.example.json',     'data/config/config.json',     '运行配置'],
  ['data/example/categories.example.json', 'data/config/categories.json', '类别映射'],
];

const failed = [];
let created = 0, skipped = 0;

console.log('');
console.log('── Pharos 首次运行初始化 ──');
console.log('');

for (const [tpl, dst, label] of PAIRS) {
  const src = path.join(ROOT, tpl);
  const out = path.join(ROOT, dst);
  if (fs.existsSync(out)) {
    console.log('  跳过（已存在，不覆盖）  ' + dst + '   ' + label);
    skipped++;
    continue;
  }
  try {
    if (!fs.existsSync(src)) throw new Error('模板缺失 ' + tpl);
    // ★ data/state/ 与 data/config/ 都不被 git 跟踪，新 clone 里根本没有这些目录
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(src, out);
    console.log('  已创建                  ' + dst + '   ' + label);
    created++;
  } catch (e) {
    console.log('  失败                    ' + dst + '   ' + (e && e.message));
    failed.push(dst + '  --  ' + (e && e.message));
  }
}

console.log('');
if (failed.length) {
  console.log('初始化未完成，有 ' + failed.length + ' 项失败：');
  for (const f of failed) console.log('  - ' + f);
  console.log('');
  process.exit(1);
}

console.log('完成：新建 ' + created + ' 个 · 跳过 ' + skipped + ' 个（已存在的一律不覆盖）');
console.log('');
if (created > 0) {
  console.log('已生成一份**空看板**（funds 为空数组），不需要你手改任何 json：');
  console.log('  · data/state/holdings.json   空的持仓文件，等你在页面上添加基金');
  console.log('  · data/config/config.json    运行配置（阈值已给通用默认值）');
  console.log('  （这两个文件以及 data/state/ 整目录都不会被提交，放心用）');
  console.log('');
}
console.log('下一步：');
if (process.platform === 'win32') {
  console.log('  双击 start.bat 启动，然后打开 http://localhost:3000');
} else {
  console.log('  npm start   然后打开 http://localhost:3000');
  const lan = [];
  const nics = os.networkInterfaces();
  for (const name of Object.keys(nics)) {
    for (const a of (nics[name] || [])) {
      if (a && a.family === 'IPv4' && !a.internal) lan.push(a.address);
    }
  }
  if (lan.length) {
    console.log('  手机访问：把下面这个地址填进「设置 → 连接」（需同一 WiFi）');
    for (const ip of lan) console.log('    http://' + ip + ':3000');
  }
}
console.log('');

'use strict';
/*
 * 介绍页「整页翻页骨架」结构断言（v2 第一阶段）
 *
 * 为什么存在：翻页骨架把 8 个 section + 6 个 tab 重排成 13 个 .page，
 * 并引入「页名单一数据源 PHAROS_PAGES」与右侧导航轮。这一层没有运行时探针，
 * 一旦有人改了页名、删了页、或把页名写死在别处，只有肉眼能发现 —— 故用静态断言钉住。
 * 导航轮后升级为「弧形滚轮」（移植 OptionWheel 的算法与视觉，刻意不引入 React / 构建链）：
 * ⑧ 节同时钉住「移植到位」与「没被改回 React」这两件事。
 *
 * 判据：读 index.html 与 landing/ 下的 css / js 原文 + 正则。不联网、零依赖。
 * 退出码：0 全过 / 1 有失败（挂进 npm test 的 test:offline）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/* 2026-09-23 结构调整：介绍页的 CSS / JS 已从 index.html 拆到 landing/ 下，
   index.html 只保留 13 页骨架与引用。这里把 6 个文件拼成同一份 src 继续断言
   —— 判据不变，只是换了"从哪里读"。 */
const PARTS = [
  'index.html',
  'landing/base.css', 'landing/blocks.css', 'landing/deck.css',
  'landing/landing.js', 'landing/hero-3d.js'
];
PARTS.forEach(function (rel) {
  if (!fs.existsSync(path.join(ROOT, rel))) { console.error('✗ 缺少文件：' + rel); process.exit(1); }
});
const src = PARTS.map(function (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }).join('\n');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, actual) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  实际：' + String(actual)); }
}

// 期望的 13 页（须与 landing/landing.js 的 PHAROS_PAGES 一致）
// 注：privacy 与 limits 原为合并一页，2026-09-23 按展示效果拆回两页。
const WANT = ['cover', 'why', 'overview', 'decision', 'holdings', 'allocation', 'review', 'settings', 'algo', 'start', 'privacy', 'limits', 'faq'];

console.log('\n── 介绍页翻页骨架结构 ──');

// ① 13 个 .page 容器
const pageIds = (src.match(/data-page="([^"]+)"/g) || []).map(function (s) { return s.replace(/.*"(.*)"/, '$1'); });
t('页容器共 13 个（data-page 出现 13 次）', pageIds.length === 13, pageIds.length);
t('页 id 集合与期望一致', new Set(pageIds).size === 13 && WANT.every(function (x) { return pageIds.indexOf(x) >= 0; }), pageIds.join(','));

// ② PHAROS_PAGES 单一数据源与 DOM 一致
const mPg = src.match(/var PHAROS_PAGES = \[([\s\S]*?)\];/);
t('存在 PHAROS_PAGES 定义', !!mPg, !!mPg);
if (mPg) {
  const ids = (mPg[1].match(/id:\s*'([^']+)'/g) || []).map(function (s) { return s.replace(/.*'([^']+)'.*/, '$1'); });
  t('PHAROS_PAGES 长度 13', ids.length === 13, ids.length);
  t('PHAROS_PAGES 的 id 集合 == DOM 的 data-page 集合', ids.slice().sort().join() === pageIds.slice().sort().join(), ids.join(','));
}

// ③ 导航轮容器为空（由 JS 渲染，防文案漂移）
t('#pager 静态内容为空（页名只在 PHAROS_PAGES 里）', /<nav class="pager" id="pager"[^>]*>\s*<\/nav>/.test(src), '见 index.html');

// ④ 新增 token（缓动复用既有 --ease-out，不新增重复 token）
t(':root 含 --dur-page', /--dur-page\s*:/.test(src), '-');
t(':root 含 --topbar-h', /--topbar-h\s*:/.test(src), '-');
t('未新增重复的 --ease-page', !/--ease-page\s*:/.test(src), '-');

// ⑤ 翻页相关 CSS
t('存在 html.deck-mode 规则', /html\.deck-mode\s*\{/.test(src), '-');
t('存在 .deck 定位规则', /html\.deck-mode \.deck\s*\{/.test(src), '-');
t('存在 .pager 样式', /\.pager\s*\{/.test(src), '-');
t('存在滑动+淡入的 page 过渡', /html\.deck-mode \.page\{[\s\S]{0,320}?translateY\(7%\)/.test(src), '-');
t('reduced-motion 下退化为静态长页', /html\.deck-mode,html\.deck-mode body\{overflow:auto\}/.test(src), '-');

// ⑥ 原锚点 id 未丢失（缩略导航 / 外部链接仍可用）
['why', 'feat', 'algo', 'start', 'privacy', 'limits', 'faq'].forEach(function (id) {
  t('保留锚点 #' + id, new RegExp('id="' + id + '"').test(src), '-');
});

// ⑦ 旧 tab 结构已清除
t('已无 role="tablist"', !/role="tablist"/.test(src), '-');
t('已无 class="pane…" 元素', !/class="pane[ "'']/.test(src), '-');
t('已无 class="tabs" 元素', !/class="tabs"/.test(src), '-');

// ⑧ 导航轮的「弧形滚轮」形态（deck 模式 + ≥761px；窄屏自动落回点阵）
//    轮盘算法移植自 OptionWheel，但刻意不引入 React / 构建链 —— 这几条同时钉住"移植到位"与"没被改回 React"
t('存在 --wheel-w token（内容让位据此算）', /--wheel-w\s*:/.test(src), '-');
t('存在 --wheel-fs token', /--wheel-fs\s*:/.test(src), '-');
t('存在 --wheel-inset token', /--wheel-inset\s*:/.test(src), '-');
t('存在 WHEEL 配置对象（轮盘参数的单一来源）', /var WHEEL = \{/.test(src), '-');
t('轮盘只在 ≥761px 生效（CSS 媒体查询）', /@media \(min-width:761px\)\{/.test(src), '-');
t('轮盘只在 ≥761px 生效（JS matchMedia 同条件）', /matchMedia\('\(min-width:761px\)'\)/.test(src), '-');
t('移植到位：帧率无关指数平滑', /Math\.exp\(-dt \/ tau\)/.test(src), '-');
t('移植到位：圆环横向偏移', /1 - Math\.cos\(ang\)/.test(src), '-');
t('移植到位：逐项写入 --ow-p', /setProperty\('--ow-p'/.test(src), '-');
t('移植到位：color-mix 随 --ow-p 在静色与金色间过渡', /color-mix\(in srgb, var\(--gold\)/.test(src), '-');
t('存在外部受控入口 __pharosWheel（原组件缺这个能力）', /__pharosWheel = \{ to:/.test(src), '-');
t('页名取自数据源（渲染处不写死页名）', /textContent = p\.title/.test(src), '-');
t('键盘防护：轮盘 keydown 阻止冒泡（防与全局翻页重复触发）', /e\.stopPropagation\(\)/.test(src), '-');
t('内容让位为动态计算（大屏不白留）', /padding-right:calc\(22px \+ max\(0px, var\(--wheel-w\)/.test(src), '-');
t('窄屏点阵兜底仍在（max-width:760px 下 .pager）', /@media \(max-width:760px\)\{[\s\S]{0,240}?\.pager\{/.test(src), '-');
t('未引入 React / JSX（保持零依赖零构建）', !/(from\s*['"]react|require\(\s*['"]react|React\.createElement|jsx)/i.test(src), '-');

// ⑨ 拆分成多文件后的组织（2026-09-23：CSS / JS 移入 landing/，index.html 只留骨架 + 引用）
t('index.html 引用 landing/ 的三个样式表', /<link rel="stylesheet" href="landing\/base\.css">[\s\S]*?landing\/blocks\.css[\s\S]*?landing\/deck\.css/.test(html), '-');
t('index.html 引用 landing/ 的两个脚本（普通 + module）', /<script src="landing\/landing\.js"><\/script>/.test(html) && /<script type="module" src="landing\/hero-3d\.js"><\/script>/.test(html), '-');
t('index.html 里已无内联 <style> / 内联脚本', !/<style>/.test(html) && !/<script>/.test(html), '-');
t('hero-3d.js 的 three 路径已改为 ../public/vendor/', /import\('\.\.\/public\/vendor\/three\.module\.min\.js'\)/.test(src), '-');
t('五个资源文件都非空', ['landing/base.css', 'landing/blocks.css', 'landing/deck.css', 'landing/landing.js', 'landing/hero-3d.js']
  .every(function (rel) { return fs.statSync(path.join(ROOT, rel)).size > 500; }), '-');

console.log('\n结果：PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);

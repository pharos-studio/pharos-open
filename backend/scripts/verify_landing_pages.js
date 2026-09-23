'use strict';
/*
 * 介绍页「整页翻页骨架」结构断言（v2 第一阶段）
 *
 * 为什么存在：翻页骨架把 8 个 section + 6 个 tab 重排成 13 个 .page，
 * 并引入「页名单一数据源 PHAROS_PAGES」与右侧导航轮。这一层没有运行时探针，
 * 一旦有人改了页名、删了页、或把页名写死在别处，只有肉眼能发现 —— 故用静态断言钉住。
 *
 * 判据：读 index.html 原文 + 正则。不联网、零依赖。
 * 退出码：0 全过 / 1 有失败（挂进 npm test 的 test:offline）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'index.html');
const src = fs.readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
function t(name, cond, actual) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  实际：' + String(actual)); }
}

// 期望的 13 页（须与 index.html 的 PHAROS_PAGES 一致）
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

console.log('\n结果：PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);

// 基金看板 Service Worker（极简外壳缓存）
// 注意：echarts（1MB）刻意不在预缓存清单内 —— 它由 charts/trend.js 按需加载，
// 首次请求后才经下方 fetch 分支入缓存。预缓存等于让首屏优化白做。
// v24（2026-09-18）：收益基准改净口径 + 概览页新增「累计投入」KPI。
// v25（2026-09-23）：持仓页拆分为 pages/holdings/（13 个模块）；子模块与 pages/*.js 同策，**不入 SHELL**。
// v26（2026-09-23）：持仓页显示只读「申购费」（后端抓取写入，界面无修改入口）—— 改了 pages/holdings/ 下的模块，
//   同 v25 的理由必须升号，否则老用户首次加载仍是旧页（pages/*.js 走 fetch 分支入缓存）。
// ★ 为什么必须升：js/pages/*.js 不在 SHELL 预缓存里，靠下方 fetch 分支的 stale-while-revalidate 入缓存
//   ⇒ 不升版本时用户**首次加载仍看到旧页**（要刷第二次才更新）。升版本会让 activate 删掉旧桶，
//   首次加载即拿到新版。（v23 那次漏升，导致 09-18 持仓页改造可能被旧缓存挡住，本次一并冲掉。）
// v27：我的基金合并、申购 v2、积分抵扣与迁移状态界面。
const CACHE = 'fund-board-v27';
const SHELL = [
  '/', '/index.html', '/style.css',
  '/js/app.js', '/js/store.js', '/js/api.js', '/js/util.js',
  '/js/icons.js', '/js/ui-prefs.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // 必须清理旧桶：下方 fetch 的 caches.match(req) 不指定桶名，会跨所有桶按插入顺序查找，
  // 旧桶先命中就永远返回旧文件 —— 只改版本号是无效的，必须把旧桶删掉。
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // API：网络优先，失败回退缓存（保证离线也能看旧数据）
  if (req.url.includes('/api/')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // 静态资源：stale-while-revalidate——先回缓存秒开，同时后台拉新版本入缓存。
  // （原来是 cache-first：改代码后浏览器永远命中旧缓存，导致新模块调旧 api 报 is not a function）
  e.respondWith(
    caches.match(req).then((cached) => {
      const refresh = fetch(req)
        .then((r) => {
          if (r && (r.status === 200 || r.type === 'opaque')) {
            const copy = r.clone();
            try { caches.open(CACHE).then((ca) => ca.put(req, copy)); } catch (_) {}
          }
          return r;
        })
        .catch(() => null);
      if (cached) {
        refresh.catch(() => {}); // 后台更新失败不影响本次展示
        return cached;
      }
      return refresh.then((r) => r || cached);
    })
  );
});

(function () {
  'use strict';

  /* ══ v2 整页翻页骨架 ══
     PHAROS_PAGES 是「页序 + 页名」的**单一数据源**：导航轮据它渲染，
     backend/scripts/verify_landing_pages.js 据它断言。改页名只改这里。*/
  var PHAROS_PAGES = [
    { id: 'cover',      title: '封面' },
    { id: 'why',        title: '为什么做它' },
    { id: 'overview',   title: '功能 · 概览' },
    { id: 'decision',   title: '功能 · 决策' },
    { id: 'holdings',   title: '功能 · 持仓' },
    { id: 'allocation', title: '功能 · 配置' },
    { id: 'review',     title: '功能 · 复盘' },
    { id: 'settings',   title: '功能 · 设置' },
    { id: 'algo',       title: '算法' },
    { id: 'start',      title: '开始使用' },
    { id: 'privacy',    title: '数据与隐私' },
    { id: 'limits',     title: '数据来源 · 已知局限' },
    { id: 'faq',        title: '常见问题' }
  ];
  window.PHAROS_PAGES = PHAROS_PAGES;

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  // 入场动画：非「减少动态效果」时启用（沿用既有行为）
  if (!reduce.matches) document.documentElement.classList.add('js');

  // 关动画 → 或用 ?long=1 强制 → 保持自由长滚动，不启用翻页
  if (reduce.matches || /[?&]long=1\b/.test(location.search)) return;

  document.documentElement.classList.add('deck-mode');

  var pages = Array.prototype.slice.call(document.querySelectorAll('.page'));
  var pager = document.getElementById('pager');
  var cur = -1, locked = false;

  window.__pharosCur = function () { return cur; };
  window.__pharosHero = null;

  /* ── 入场：改为「页被激活时」播放（不再靠 IntersectionObserver）── */
  function playEnter(page) {
    page.querySelectorAll('.reveal,.cascade').forEach(function (n) {
      n.classList.remove('in');
      void n.offsetWidth;              // 强制重排，让动画可重播
      n.classList.add('in');
    });
  }

  /* ══ 导航轮 ══
     基础形态 = 圆点点阵（窄屏用）。deck 模式 + ≥761px 时升级为「弧形滚轮」：
     移植 OptionWheel 的圆环布局 / 帧率无关指数平滑 / 远处模糊淡出，
     去掉它的 React 外壳、滚轮输入、无限循环与声音。
     滚轮始终归翻页引擎（滚轮翻页 → 轮盘跟着滑）；轮盘只响应点击 / 拖动 / 键盘。 */
  var WHEEL = {
    fontSize: .9,    // rem：13 项的弧高与轮盘总宽都由它推出
    spacing: 1.7,    // 行高倍数
    tilt: 5.5,       // 相邻项夹角（度）：越大弧越紧
    curve: .3,       // 横向外扩系数：弧的"深度感"靠 tilt，横向占位靠它压低
    blur: .8,        // 每远离中心一项 +0.8px 模糊
    fade: .13,       // 每远离中心一项 -13% 不透明度
    minOpacity: .2,  // 最远端的不透明度下限
    smoothing: 190,  // 缓动时间常数（ms）：越大越"沉"
    rowH: 24         // 由 measure() 实算
  };
  var dots = [];
  if (pager) {
    PHAROS_PAGES.forEach(function (p, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', p.title);
      b.innerHTML = '<span class="plabel"></span>';
      b.firstChild.textContent = p.title;      // 页名只来自数据源，绝不写死
      pager.appendChild(b);
      dots.push(b);
    });
    wheelSetup();
  }

  function wheelSetup() {
    var wide = window.matchMedia('(min-width:761px)');
    var pos = 0, target = 0, raf = null, last = 0;
    var drag = null, moved = false, swallowClick = false;

    function enabled() {
      return wide.matches && document.documentElement.classList.contains('deck-mode');
    }
    function remPx() {
      return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    }
    function measure() { WHEEL.rowH = Math.max(WHEEL.fontSize * WHEEL.spacing * remPx(), 1); }
    function clampIdx(v) { return Math.max(0, Math.min(dots.length - 1, v)); }

    /* 一帧：先把位置朝目标按时间常数推进，再按"离中心多远"逐项布局。
       堆叠顺序与 OptionWheel 一致（圆环弧长 = 一项行高，故 tilt 控制弧的松紧）。 */
    function frame(now) {
      var dt = Math.min((now - last) / 1000, .05);
      last = now;
      var tau = Math.max(WHEEL.smoothing, 1) / 1000;
      var k = 1 - Math.exp(-dt / tau);
      var next = pos + (target - pos) * k;
      var settled = Math.abs(target - next) < .001;
      if (settled) next = target;
      pos = next;

      var tiltRad = WHEEL.tilt * Math.PI / 180;
      var R = tiltRad > .0005 ? WHEEL.rowH / tiltRad : 0;

      for (var i = 0; i < dots.length; i++) {
        var el = dots[i];
        var d = i - pos, dist = Math.abs(d);
        /* 垂直用均匀间距 —— 项多、容器窄，若照圆环压缩间距，远端会挤成一团；
           弧的观感改由「横向偏移 + 扭转」给出（两端向左弯），并把扭转压在 ~20° 内。 */
        var y = d * WHEEL.rowH;
        var x = 0, rot = 0;
        if (R > 0) {
          var ang = Math.min(dist * tiltRad, Math.PI / 2);
          x = R * (1 - Math.cos(ang)) * WHEEL.curve;
          rot = -(d < 0 ? -1 : 1) * ang * WHEEL.curve * 180 / Math.PI;
        }
        el.style.transform = 'translate(' + x.toFixed(2) + 'px, calc(' + y.toFixed(2) + 'px - 50%)) rotate(' + rot.toFixed(3) + 'deg)';
        el.style.opacity = String(Math.max(WHEEL.minOpacity, 1 - dist * WHEEL.fade));
        el.style.filter = WHEEL.blur > 0 ? 'blur(' + (dist * WHEEL.blur).toFixed(2) + 'px)' : 'none';
        el.style.setProperty('--ow-p', Math.max(0, 1 - Math.min(dist, 1)).toFixed(4));
      }
      raf = settled ? null : requestAnimationFrame(frame);   // 静止即停，不空转
    }

    function start() {
      if (!enabled()) return;
      if (raf != null) cancelAnimationFrame(raf);
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function reset() {
      if (raf != null) { cancelAnimationFrame(raf); raf = null; }
      dots.forEach(function (el) {
        el.style.transform = ''; el.style.opacity = ''; el.style.filter = '';
        el.style.removeProperty('--ow-p');
      });
    }
    function sync() {
      measure();
      if (!enabled()) { reset(); return; }        // 窄屏 → 交回 CSS 点阵
      var c = window.__pharosCur();
      pos = target = c > 0 ? c : 0;
      start();
    }

    /* 外部受控：翻页引擎翻到第 i 页时把轮盘滑过去 —— 原组件缺这个能力，
       而"滚轮翻页 → 轮盘跟随"恰好需要它。 */
    window.__pharosWheel = { to: function (i) { target = clampIdx(i); start(); }, pos: function () { return pos; } };
    window.__pharosWheelSync = sync;

    /* 拖动：位移超 4px 才算拖（否则算点击）；松手吸附到最近一项并跳页 */
    pager.addEventListener('pointerdown', function (e) {
      if (!enabled()) return;
      drag = { y: e.clientY, start: target, id: e.pointerId };
      moved = false;
    });
    pager.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dy = e.clientY - drag.y;
      if (!moved && Math.abs(dy) > 4) {
        moved = true;
        try { pager.setPointerCapture(drag.id); } catch (err) { /* 捕获失败不影响拖动 */ }
      }
      if (moved) { target = clampIdx(drag.start - dy / WHEEL.rowH); start(); }
    });
    function endDrag() {
      if (!drag) return;
      drag = null;
      if (!moved) return;
      swallowClick = true;                       // 紧跟其后的 click 不算点击
      var n = Math.round(clampIdx(target));
      if (n === window.__pharosCur()) { target = n; start(); } else { go(n); }
    }
    pager.addEventListener('pointerup', endDrag);
    pager.addEventListener('pointercancel', endDrag);

    dots.forEach(function (b, i) {
      b.addEventListener('click', function () {
        if (swallowClick) { swallowClick = false; return; }
        go(i);
      });
      // 焦点落进来（Tab / 方向键）时把该项滑到中间，但不翻页
      b.addEventListener('focus', function () { if (enabled()) { target = i; start(); } });
    });

    /* 键盘：方向键在轮盘内移焦点。
       ★ 必须阻止冒泡 —— 否则 window 上的全局翻页监听会同时翻页（实测确认的既有 bug）。 */
    pager.addEventListener('keydown', function (e) {
      var i = dots.indexOf(document.activeElement);
      if (i < 0) return;
      var nx = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') nx = dots[(i + 1) % dots.length];
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') nx = dots[(i - 1 + dots.length) % dots.length];
      if (nx) { e.preventDefault(); e.stopPropagation(); nx.focus(); }
    });

    wide.addEventListener('change', sync);
  }

  /* ── 翻页 ── */
  function go(i, instant) {
    i = Math.max(0, Math.min(pages.length - 1, i));
    if (i === cur) return;
    if (locked && !instant) return;
    cur = i;
    locked = !instant;

    pages.forEach(function (pg, k) {
      pg.removeAttribute('data-active');
      pg.removeAttribute('data-left');
      if (k === i) { pg.setAttribute('data-active', ''); pg.removeAttribute('inert'); }
      else { pg.setAttribute('inert', ''); if (k < i) pg.setAttribute('data-left', ''); }
    });

    dots.forEach(function (b, k) {
      if (k === i) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });

    // 轮盘跟随：翻页是唯一的源，轮盘只是跟着滑过去（滚轮语义 = 跟随型）
    if (window.__pharosWheel) window.__pharosWheel.to(i);

    playEnter(pages[i]);

    if (window.__pharosHero) {
      if (i === 0) window.__pharosHero.resume(); else window.__pharosHero.pause();
    }

    if (!instant) {
      // 焦点正在轮盘内时不要抢走 —— 否则用户用键盘操作导航会被打断（实测确认的 bug）
      var fromWheel = pager && pager.contains(document.activeElement);
      if (!fromWheel) {
        var h = pages[i].querySelector('h1,h2');
        if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
      }
      setTimeout(function () { locked = false; }, 780);
    }
  }
  window.__pharosGo = go;

  /* ── 输入：滚轮 / 触摸 / 键盘 ── */
  var lastT = 0;
  window.addEventListener('wheel', function (e) {
    // 页内还有可滚内容时，先让页面自己滚（到边界才翻页）
    var pg = pages[cur];
    if (pg && pg.scrollHeight > pg.clientHeight + 2) {
      var atTop = pg.scrollTop <= 0;
      var atBot = pg.scrollTop + pg.clientHeight >= pg.scrollHeight - 2;
      if (!(e.deltaY > 0 && atBot) && !(e.deltaY < 0 && atTop)) return;
    }
    e.preventDefault();
    var now = Date.now();
    if (now - lastT < 520 || Math.abs(e.deltaY) < 8) return;
    lastT = now;
    go(cur + (e.deltaY > 0 ? 1 : -1));
  }, { passive: false });

  var ty = null;
  window.addEventListener('touchstart', function (e) { ty = e.touches[0].clientY; }, { passive: true });
  window.addEventListener('touchend', function (e) {
    if (ty == null) return;
    var dy = e.changedTouches[0].clientY - ty; ty = null;
    if (Math.abs(dy) < 56) return;
    go(cur + (dy < 0 ? 1 : -1));
  }, { passive: true });

  window.addEventListener('keydown', function (e) {
    var t = document.activeElement && document.activeElement.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
    var k = e.key;
    if (k === 'ArrowDown' || k === 'PageDown') { e.preventDefault(); go(cur + 1); }
    else if (k === 'ArrowUp' || k === 'PageUp') { e.preventDefault(); go(cur - 1); }
    else if (k === 'Home') { e.preventDefault(); go(0); }
    else if (k === 'End') { e.preventDefault(); go(pages.length - 1); }
  });

  // 顶栏锚点 → 翻页（不再跳锚点）
  document.querySelectorAll('.top nav a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href').slice(1);
      for (var k = 0; k < pages.length; k++) {
        if (pages[k].id === id) { e.preventDefault(); go(k); return; }
      }
    });
  });

  go(0, true);
  if (window.__pharosWheelSync) window.__pharosWheelSync();   // 轮盘按当前页就位（首帧不动画）
})();

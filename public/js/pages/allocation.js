// 配置页：组合构成（引擎 4 线当前实际占比，环形图 + 图例；不做目标偏离刻度/健康度徽章）
// + 穿透分析（底层股有效暴露）。2026-09-09 用户拍板：组合构成按算法 4 条信号线（宽基/红利低波/科技成长/黄金对冲）分段，
// 与引擎/算法文档口径对齐（不再把宽基+红利并成"核心"）；2026-09-04 曾去掉「目标 vs 当前偏离 ±5pt」体系，
// 纯粹展示「钱现在怎么分的」；精确占比照实显示（原「不显示精确占比防盯盘」设计废除）。
import * as store from '../store.js';
import * as api from '../api.js';
import { el, fmtMoney, tableWrap, loadingHTML } from '../util.js';
import { loadEcharts } from '../charts/trend.js';

// 展示线配色（G0 深藏蓝×鎏金衍生：蓝=宽基 / 青=红利·低波 / 紫=主题·行业 / 金=商品·对冲 / 灰蓝=债券 / 浅金=现金；
// 未知 key 与“未归类”走 FALLBACK_COLOR 灰兜底）。2026-09-19 新增 bond/cash：它们是**待建设**类别，
// 有独立分块（不再被算成“未归类”），只是暂时不给买卖结论。
const BUCKET_COLORS = {
  broad: '#4C9AF0', dividend: '#3FBF9F', growth: '#9A8CF5', cycle: '#E3B94C',
  bond: '#6E8AB8', cash: '#C9B47A'
};
const FALLBACK_COLOR = '#8A8F98';
// 上一次渲染的旭日图实例（页面切换 / 自动更新重复渲染时先 dispose，防 ECharts 实例泄漏）
let _lastSunburstChart = null;

// 环形图 SVG（纯内联，无外部图表库）：中心 = 总资产，外环按 pct 分色。
// 0% 的桶不画段（环上无可见弧），但仍出现在图例里（置灰标 0.00%），避免"某个类别是不是消失了"的困惑。
function composeDonutSVG(rows, total) {
  const CX = 90, CY = 90, R = 56, W = 26;
  const C = 2 * Math.PI * R;
  let acc = 0, segs = '';
  (rows || []).forEach(c => {
    const p = Number(c.pct) || 0;
    if (p <= 0.05) return; // 0% 跳过画段（弧长 ~0 会产生残留描点）
    const len = (p / 100) * C;
    segs += `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${BUCKET_COLORS[c.key] || FALLBACK_COLOR}" stroke-width="${W}" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}"></circle>`;
    acc += len;
  });
  const money = fmtMoney(total);
  return `<svg viewBox="0 0 ${CX * 2} ${CY * 2}" style="width:100%;display:block" role="img" aria-label="组合构成占比环形图">` +
    `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="${W}"></circle>` +
    (segs ? `<g transform="rotate(-90 ${CX} ${CY})">${segs}</g>` : '') +
    `<text x="${CX}" y="${CY + 2}" text-anchor="middle" style="fill:var(--text);font-size:17px;font-weight:500">${money}</text>` +
    `<text x="${CX}" y="${CY + 21}" text-anchor="middle" style="fill:var(--text-muted);font-size:11px">总资产</text>` +
    `</svg>`;
}

// 图例行：色块 + 类别名 + 占比（有持仓的追加金额）。0% 整行置灰。
function legendRows(rows) {
  const box = el('div', { style: 'display:flex;flex-direction:column;gap:10px;flex:1;min-width:0' });
  rows.forEach(c => {
    const pct = Number(c.pct) || 0;
    const muted = pct <= 0;
    const row = el('div', {
      style: `display:flex;align-items:center;gap:9px;font-size:13px;min-width:0;` +
        (muted ? 'color:var(--text-muted)' : 'color:var(--text)')
    });
    row.appendChild(el('span', { style: `width:9px;height:9px;border-radius:3px;flex:none;background:${BUCKET_COLORS[c.key] || FALLBACK_COLOR}` }));
    row.appendChild(el('span', { text: c.name, style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }));
    row.appendChild(el('span', {
      text: pct.toFixed(2) + '%' + (muted ? '' : ' · ' + fmtMoney(c.value || 0)),
      style: 'font-weight:500;flex:none'
    }));
    box.appendChild(row);
  });
  return box;
}

// ── 类别管理（2026-09-19）──
// 让用户在前端增删「自建分类」。★ 自建分类**不是新算法**，只是给某条内置线起个别名
// （例如把「主题·行业」叫成「我的医药」），所以新增时必须选一条内置算法去绑定。
// 保存走 /api/save 的 categories 键；后端的 okCategories 会校验绑定的算法必须在册。
// 为什么必须同时写进 categories 段：环形图的分块是按 categories 来的，
// 只写 customCategories 的话，该基金在配置页会落到「未归类」那一块。
async function appendCategoryManager(root) {
  const st = store.getState();
  const cats = st.categories || {};
  const presets = Array.isArray(cats.presets) ? cats.presets : [];
  const customs = Array.isArray(cats.customCategories) ? cats.customCategories.slice() : [];
  const engines = Array.isArray(cats.engines) ? cats.engines : [];
  const engineName = (k) => { const e = engines.find(x => x.key === k); return e ? e.name : k; };

  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-head' }, [
    el('span', { text: '类别管理' }),
    el('span', { class: 'sub', text: '预设 + 自建分类' }),
  ]));

  // ① 内置预设（只读）：把「这条线适用于哪类基金」摆出来，避免用户挂错线
  const presetBox = el('div', { class: 'hint', style: 'line-height:1.9' });
  if (!presets.length) {
    presetBox.appendChild(el('div', { text: '没有预设段。重启一次服务即可 —— 程序会在启动时自动把缺失的内置项补齐（补前会备份 categories.json）。' }));
  } else {
    presets.forEach(p => {
      const line = el('div');
      line.appendChild(el('b', { text: p.name }));
      if (p.supported === false) {
        line.appendChild(el('span', { style: 'color:#8a6d3b', text: '（待建设 · 暂不给买卖结论）' }));
      }
      if (p.applies) line.appendChild(el('span', { text: '　适用：' + p.applies }));
      presetBox.appendChild(line);
    });
  }
  panel.appendChild(el('div', { class: 'field' }, [el('label', { text: '内置预设（不可删除）' }), presetBox]));

  // ② 自建分类列表 + 删除
  const listBox = el('div');
  const msg = el('div', { class: 'hint' });
  const renderList = () => {
    listBox.innerHTML = '';
    if (!customs.length) {
      listBox.appendChild(el('div', { class: 'hint', text: '还没有自建分类。' }));
      return;
    }
    customs.forEach((c, i) => {
      const row = el('div', { style: 'display:flex;align-items:center;gap:10px;padding:3px 0;flex-wrap:wrap' });
      row.appendChild(el('span', { text: c.name + '（绑定算法：' + engineName(c.category) + '）' }));
      const del = el('button', { class: 'btn', text: '删除' });
      del.addEventListener('click', () => { customs.splice(i, 1); renderList(); });
      row.appendChild(del);
      listBox.appendChild(row);
    });
  };
  renderList();
  panel.appendChild(el('div', { class: 'field' }, [el('label', { text: '自建分类' }), listBox]));

  // ③ 新增：名字 + 绑定的内置算法
  const nameInput = el('input', { class: 'input', placeholder: '分类名，例如「我的医药」' });
  const baseSel = el('select', {}, engines.map(e => el('option', { value: e.key, text: e.name })));
  const addBtn = el('button', { class: 'btn btn-primary', text: '新增分类' });
  addBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { msg.textContent = '请先填分类名'; msg.style.color = '#c0392b'; return; }
    if (!baseSel.value) { msg.textContent = '没有可选的内置算法，无法绑定'; msg.style.color = '#c0392b'; return; }
    if ((cats.categories || []).some(x => x && x.name === name)) {
      msg.textContent = '已有同名分类'; msg.style.color = '#c0392b'; return;
    }
    // key 用时间戳生成，避开中文名无法做 slug 的问题，也避免与内置 key 撞车
    const key = 'custom:' + Date.now().toString(36).slice(-6);
    const next = Object.assign({}, cats, {
      categories: (cats.categories || []).concat([{ key, name }]),
      customCategories: customs.concat([{
        key, name, category: baseSel.value, createdAt: new Date().toISOString().slice(0, 10),
      }]),
    });
    addBtn.disabled = true;
    try {
      const r = await api.save({ categories: next });
      if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
      await store.reloadState();          // 重新拉 /api/state，让新类别立刻出现在「添加基金」的下拉里
      msg.style.color = '#3fbf9f';
      msg.textContent = '已新增「' + name + '」—— 到「持仓」页添加基金时就能选到它了';
      nameInput.value = '';
      const st2 = store.getState();
      cats.categories = (st2.categories || {}).categories || cats.categories;
      cats.customCategories = (st2.categories || {}).customCategories || cats.customCategories;
      customs.length = 0;
      (cats.customCategories || []).forEach(x => customs.push(x));
      renderList();
    } catch (e) {
      msg.style.color = '#c0392b';
      msg.textContent = '保存失败：' + ((e && e.message) || String(e));
    } finally {
      addBtn.disabled = false;
    }
  });
  panel.appendChild(el('div', { class: 'field' }, [
    el('label', { text: '新增自建分类' }),
    el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' }, [nameInput, baseSel, addBtn]),
    el('div', { class: 'hint', style: 'margin-top:4px', text: '自建分类只是给内置算法起个别名（选哪条算法决定用哪套买卖规则）。删除后，已挂在该分类上的基金会变成「未归类」，需要到「持仓」页改类别。' }),
  ]));
  panel.appendChild(msg);
  root.appendChild(panel);
}

export async function render(root) {
  const live = store.getLive();
  const rows = live.allocation || [];
  const total = (live.totals && live.totals.totalValue) || 0;

  root.innerHTML = '';
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-head' }, [
    el('span', { text: '组合构成' }),
    el('span', { class: 'sub', text: '当前实际占比，打开自动更新' }),
  ]));

  if (!rows.length) {
    panel.appendChild(el('div', { class: 'hint', text: '暂无配置数据。先去「持仓」页添加第一只基金，这里会显示各类资产的占比与穿透。' }));
    root.appendChild(panel);
    await appendCategoryManager(root); // ★ 空看板时恰恰最需要它：这时候用户正要去建自己的分类
    return;
  }

  const card = el('div', { class: 'card health-card' });
  const flex = el('div', { style: 'display:flex;align-items:center;gap:22px;flex-wrap:wrap' });
  const svgHolder = el('div', { style: 'width:172px;max-width:100%;margin:0 auto' });
  svgHolder.innerHTML = composeDonutSVG(rows, total);
  flex.appendChild(svgHolder);
  flex.appendChild(legendRows(rows));
  card.appendChild(flex);
  panel.appendChild(card);
  root.appendChild(panel);

  // 穿透分析「占位槽」：只为保住视觉顺序 —— 不 await 它，但它的面板必须仍落在 note 之前。
  // 否则就得先 await 穿透（内含 await loadEcharts()，1MB）才能挂 note，note 迟迟不出现。
  // renderPenetration 内部本就是「往传入的容器 appendChild」，故传槽即可，函数体不用改。
  const penSlot = el('div');
  root.appendChild(penSlot);

  const note = el('div', { class: 'panel' });
  note.appendChild(el('div', { class: 'hint', text: `总资产 ${fmtMoney(total)}。占比 = 每只基金最新官方净值 × 份额 / 总资产，净值每晚公布后自动更新。` }));
  root.appendChild(note);

  // 不 await → render() 变全同步；代价是脱离了 renderRoute 的 try/catch，
  // 必须自己兜住异常，否则会退化成 unhandled rejection 而静默失败。
  renderPenetration(penSlot, live).catch((err) => {
    penSlot.innerHTML = '';
    const box = el('div', { class: 'panel' });
    box.appendChild(el('div', { class: 'error-box', text: '穿透分析加载失败：' + err.message }));
    penSlot.appendChild(box);
  });

  // 类别管理（放在最后：它是设置型面板，不该抢在「钱怎么分的」前面）
  await appendCategoryManager(root);
}

// ---------- 穿透分析（2026-09-05 重写：科技赛道透视，仅 growth 基金）----------
// 上半 = ECharts 旭日图：内圈=赛道（占科技仓位，ECharts 同级归一）、外圈=基金贡献（悬停看「基金名 + %」）；
//       覆盖度注记常驻（季报仅披露前十大，防止把"已披露内部分布"误读成"全部仓位"）。
// 下半 = 基金画像卡：主赛道 chips + 赛道占比条（基金自身口径·披露内归一）+ 披露覆盖度 + 同持仓/代理标注。
// 同赛道同色贯穿卡片与旭日图；基金色 = 所属赛道色浅化档（"基金随赛道色系"，认赛道 > 认基金）。
const ROOT_DISC = 'rgba(10,16,32,0.9)'; // 旭日图根盘＝面板同深色，杜绝自动调色板(#5470c6系)/基金蓝大饼
// 赛道色带：旭日图按「出现顺序」取模映射（不固定赛道对应色），故只追加不与前 8 色撞的 2 色即可——
// 数组加长不改前 8 索引 → 现有赛道取色零漂移，新色只服务第 9/10 个出现的赛道（AI应用/软件、消费电子/终端等）。
const THEME_COLORS = ['#D85A30', '#7F77DD', '#639922', '#D4537E', '#888780', '#378ADD', '#E3B94C', '#45B8AC', '#A066D6', '#3FBF9F'];
// 向白混合浅化：t∈[0,1]，0=原色、1=纯白。基金色 = lighten(所属赛道色, 0.35+0.12×份额排名)（"基金随赛道色系"）。
function lighten(hex, t) {
  t = Math.max(0, Math.min(1, Number(t) || 0));
  const c = String(hex || '#888').replace('#', '');
  const mix = v => Math.round(v + (255 - v) * t);
  const r = mix(parseInt(c.substr(0, 2), 16) || 0), g = mix(parseInt(c.substr(2, 2), 16) || 0), b = mix(parseInt(c.substr(4, 2), 16) || 0);
  const h = n => (n < 16 ? '0' : '') + n.toString(16);
  return `#${h(r)}${h(g)}${h(b)}`;
}
function hexRgb(h) { const n = parseInt(String(h).slice(1), 16); return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`; }

async function renderPenetration(root, live) {
  const pen = live.penetration || {};
  const panel = el('div', { class: 'panel' });
  const subTxt = pen.reportDate ? `季报重仓数据 ${pen.reportDate} · 仅科技基金` : '仅科技基金';
  panel.appendChild(el('div', { class: 'panel-head' }, [el('span', { text: '穿透分析 · 科技赛道透视' }), el('span', { class: 'sub', text: subTxt })]));

  const byFund = pen.byFund || [];
  const pending = pen.pending || [];
  if (!byFund.length && !pending.length) {
    panel.appendChild(el('div', { class: 'hint', text: '暂无科技（growth）基金持仓数据。' }));
    root.appendChild(panel);
    return;
  }
  // 关键：panel 必须先挂载进文档，旭日图容器 holder 的 isConnected 在 await loadEcharts() 后才会为 true；
  // 若像旧版最后才 root.appendChild(panel)，holder 从未入文档 → isConnected=false → init 被跳过 → 图空但卡片正常。
  root.appendChild(panel);
  const sb = pen.sunburst;
  const themeColor = {};
  if (sb && Array.isArray(sb.children)) sb.children.forEach((t, i) => { themeColor[t.name] = THEME_COLORS[i % THEME_COLORS.length]; });

  // ---------- 上半：旭日图 ----------
  if (sb && Array.isArray(sb.children) && sb.children.length) {
    const sec = el('div', { style: 'margin-top:10px' });
    sec.appendChild(el('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:4px 10px' }, [
      el('span', { style: 'font-size:13px;font-weight:500', text: '赛道健康度' }),
      el('span', { style: 'font-size:12px;color:var(--text-muted)', text: '内圈=赛道 · 外圈=基金贡献 · 悬停看详情' }),
    ]));
    const lg = el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--text-muted);margin:8px 0 2px' });
    sb.children.forEach(t => {
      lg.appendChild(el('span', { style: 'display:flex;align-items:center;gap:5px' }, [
        el('span', { style: `width:9px;height:9px;border-radius:2px;background:${themeColor[t.name] || FALLBACK_COLOR}` }),
        el('span', { text: t.name }),
      ]));
    });
    sec.appendChild(lg);
    const holder = el('div', { style: 'position:relative;width:100%;height:430px' });
    // echarts 是 1MB、按需加载：await 期间这 430px 会是一块空白 → 先给细线占位。
    // 绝对定位铺满 holder 再居中，避免细线孤零零挂在 430px 顶部。
    holder.innerHTML = '<div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center">'
      + loadingHTML('正在渲染赛道透视…', true) + '</div>';
    sec.appendChild(holder);
    panel.appendChild(sec);

    const echarts = await loadEcharts();
    if (holder.isConnected) {
      holder.innerHTML = ''; // 清掉占位再 init，否则占位节点会留在图上
      // 重复渲染（切页 / 自动更新）时先销毁上一个实例，防 ECharts 实例泄漏。
      // 注：不能只判 holder._chart——holder 每次重建、该属性恒为空，判了等于没销毁。
      if (_lastSunburstChart) { try { _lastSunburstChart.dispose(); } catch (e) {} _lastSunburstChart = null; }
      const chart = echarts.init(holder, null, { renderer: 'canvas' });
      _lastSunburstChart = chart; holder._chart = chart;
      // ===== 自控放大 + 视觉终改（2026-09-05）：禁 nodeClick 默认缩放；基金色随赛道色系浅化 =====
      // 数据归一：每节点显式 kind/value/color；基金浅化系数按"该基金在此赛道内份额排名"取阶梯
      const themes = (sb.children || []).map(t => {
        const tColor = themeColor[t.name] || FALLBACK_COLOR;
        const tFunds = (t.children || []).slice().sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
        const funds = tFunds.map((f, rank) => ({
          kind: 'fund', name: f.name, theme: t.name, value: Number(f.value) || 0,
          itemStyle: { color: lighten(tColor, Math.min(0.35 + 0.12 * rank, 0.9)) } }));
        const total = funds.reduce((s, f) => s + f.value, 0);
        return { kind: 'theme', name: t.name, value: total, total, color: tColor, itemStyle: { color: tColor }, funds };
      });
      const themeByName = {};
      themes.forEach(t => { themeByName[t.name] = t; });

      // 两态视图：root label 一律 show:false（中心文字由 HTML 覆盖层承载，不依赖引擎排版）
      const buildFullView = () => ({
        kind: 'root', name: sb.root || '科技仓位', value: themes.reduce((s, t) => s + t.value, 0),
        itemStyle: { color: ROOT_DISC }, label: { show: false },
        children: themes.map(t => ({ kind: 'theme', name: t.name, value: t.value, itemStyle: { color: t.color }, children: t.funds })),
      });
      // 放大态：以赛道为根重挂；fund 节点不挂 label（sunburst 的 outside 标签只读 series.label，
      // data-item 级 label/labelLine 不生效；标签交由 renderChart() 的 series.label 在放大态统一打开）
      const buildZoomView = (themeName) => {
        const t = themeByName[themeName];
        if (!t || !t.funds.length) return null; // 空赛道守卫：不进放大
        return {
          kind: 'root', name: t.name, value: t.total, itemStyle: { color: ROOT_DISC }, label: { show: false },
          children: t.funds.map(f => ({ ...f })),
        };
      };

      // tooltip 纯函数（按节点 kind + 当前 zoom 态出文案，杜绝 undefined/NaN）
      const tip = (d, zoom) => {
        if (!d) return '';
        const safe = n => Number.isFinite(+n) ? (+n).toFixed(2) : '0.00';
        if (d.kind === 'root') {
          return zoom
            ? `${d.name}（赛道）<br/>占科技仓位 ${safe(d.value)}% · 点击返回`
            : `${sb.root || '科技仓位'}（已披露合计）`;
        }
        if (d.kind === 'theme') return `${d.name}（赛道）<br/>占科技仓位 <b>${safe(d.value)}%</b>`;
        const t = themeByName[d.theme];
        const rel = zoom && t;
        return `${d.name}（基金）<br/>占${rel ? '该赛道' : '科技仓位'} <b>${safe(rel ? (d.value / t.total) * 100 : d.value)}%</b>`;
      };

      let zoomName = null; // 唯一状态：null=全量；非空=放大中的赛道名
      // 返回胶囊（仅放大态可见，hover/点击都在 ECharts canvas 之上）
      const backBtn = el('div', {
        style: 'position:absolute;top:8px;left:8px;z-index:10;display:none;cursor:pointer;font-size:12px;padding:4px 10px;border-radius:999px;background:rgba(10,16,32,0.88);color:#9AA3C0;border:1px solid rgba(255,255,255,0.12);user-select:none',
        text: '◂ 返回全部赛道'
      });
      // 中心文字覆盖层（全量=「科技仓」；放大=赛道名+占科技仓位% 两行静音灰小字）。
      // pointer-events:none：不挡"点中心返回"（root 点击仍命中 ECharts canvas）；引擎 root label 已关。
      const centerLine1 = el('div', { style: 'font-size:13px;color:#9AA3C0;line-height:1.35;white-space:nowrap' });
      const centerLine2 = el('div', { style: 'font-size:11px;color:#5A6379;line-height:1.35;white-space:nowrap' });
      const centerOv = el('div', { style: 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center;pointer-events:none;z-index:5' }, [centerLine1, centerLine2]);
      const clearCards = () => { panel.querySelectorAll('.fund-card').forEach(c => { c.style.opacity = ''; c.style.borderColor = ''; c.style.boxShadow = ''; }); };
      const syncBack = () => { backBtn.style.display = zoomName ? '' : 'none'; };
      const syncCenter = () => {
        const t = zoomName && themeByName[zoomName];
        // B3 定稿：放大态第 1 行还原为浅亮 #C8CDDD（赛道名），全量态「科技仓」保持静音灰 #9AA3C0 不变
        centerLine1.style.color = t ? '#C8CDDD' : '#9AA3C0';
        if (t) {
          centerLine1.textContent = t.name;
          centerLine2.textContent = `占科技仓位 ${t.total.toFixed(1)}%`;
        } else {
          centerLine1.textContent = sb.root || '科技仓';
          centerLine2.textContent = '';
        }
      };
      const renderChart = () => {
        const rootNode = (zoomName && buildZoomView(zoomName)) || buildFullView();
        const zoomed = !!zoomName;
        // 卡片位置稳定：holder 固定 430px（不再随 zoom 切换高度），放大/返回只换圆盘内容，下方基金卡零跳动。
        // 全量态 94% 顶满 430 大圆居中；放大态 74%（R≈159、环带 80px）。backBtn/centerOv absolute 相对 holder 自动跟随。
        // 系列级配置两态切换：full view 一切关；zoom view 打开 series.label(leave) + labelLine + labelLayout，
        const series = {
          type: 'sunburst', data: [rootNode], nodeClick: false,
          itemStyle: { borderColor: 'rgba(10,16,32,0.9)', borderWidth: 1 },
          emphasis: { focus: 'ancestor' },
        };
        if (zoomed) {
          // B3 定稿（几何依据）：holder 放大态高 430、圆心 cy=215；radius 74% → R≈159px、环带 ~80px。
          // 此前外部版收半径到 52% 反使环带仅 43px，标签挤成一圈被 hideOverlap 吞 2 只基金名（"字看不见"元凶）。
          // rotate:0 保留：水平排布不纵向溢出（radial 会让 14 字长中文名沿半径冲出画布顶/底被裁）。
          // distance 28 让标签离图、labelLine 26/30 两段折线"斜出+水平"折角清晰（顶部薄扇区斜线段实测 33px）。
          series.radius = [0, '74%'];
          series.label = {
            show: true, position: 'outside', fontSize: 12, color: '#C8CDDD',
            rotate: 0,
            distance: 28,
            // 只为叶子（fund，无 children）渲染文本：root/中间节点没有 outside 含义，由 formatter 返回空串跳过
            formatter: p => (p.data && p.data.children && p.data.children.length) ? '' : (p.name || ''),
          };
          series.labelLine = { show: true, length: 26, length2: 30, lineStyle: { color: '#8A8F98', width: 1 } };
          // 全显示：shiftY 上下错位替代 hideOverlap 吞字（算力芯片顶部天弘C/易方达错位后上下紧贴，用户已认可）
          series.labelLayout = { hideOverlap: false, moveOverlap: 'shiftY' };
        } else {
          series.radius = [0, '94%'];
          series.label = { show: false };
          series.labelLine = { show: false };
          series.labelLayout = undefined;
        }
        chart.setOption({
          backgroundColor: 'transparent',
          tooltip: {
            trigger: 'item', confine: true,
            backgroundColor: 'rgba(10,16,32,0.92)', borderColor: 'rgba(255,255,255,0.12)',
            textStyle: { color: '#EDEFF7', fontSize: 12 },
            formatter: p => tip(p && p.data, zoomName),
          },
          series: [series],
        }, true); // notMerge：整树替换，防旧树/旧 label 残留
        syncCenter(); // 中心覆盖层随 zoomName 切换文案
      };
      backBtn.addEventListener('click', () => {
        if (!zoomName) return;
        zoomName = null; clearCards(); syncBack(); renderChart();
      });
      holder.appendChild(backBtn);
      holder.appendChild(centerOv);
      renderChart(); // 首屏全量态

      // 点击：fund=只高亮卡；root=放大态返回/全量态复位；theme=放大到该赛道 + 高亮含它的卡
      chart.on('click', p => {
        const d = p && p.data; if (!d) return;
        const cards = panel.querySelectorAll('.fund-card');
        const light = (hit) => cards.forEach(c => {
          const h = hit(c);
          c.style.opacity = h ? '1' : '0.35';
          c.style.borderColor = h ? '#E3B94C' : '';
          c.style.boxShadow = h ? '0 0 0 1px rgba(227,185,76,.45)' : '';
        });
        if (d.kind === 'fund') { light(c => c.dataset.name === d.name); return; }
        if (d.kind === 'root') { // 中心：放大态→返回全量；全量态→复位卡片
          if (zoomName) { zoomName = null; clearCards(); syncBack(); setTimeout(renderChart, 0); }
          else { clearCards(); }
          return;
        }
        // theme 仅全量态出现（放大后无 theme 层）→ 放大 + 高亮
        if (!themeByName[d.name] || !themeByName[d.name].funds.length) return;
        zoomName = d.name; syncBack();
        light(c => (c.dataset.themes || '').split(',').includes(d.name));
        setTimeout(renderChart, 0); // 事件派发后再重绘，防 setOption 重入错位
      });
    }
  }

  // ---------- 下半：基金画像卡 ----------
  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(205px,1fr));gap:10px;margin-top:14px' });
  byFund.forEach(f => {
    const card = el('div', { class: 'card fund-card', style: 'padding:12px 14px;min-width:0;transition:opacity .15s' });
    card.dataset.name = f.name;
    card.dataset.themes = (f.themes || []).map(t => t.theme).join(',');
    card.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px' }, [
      el('span', { style: 'font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: f.name }),
      el('span', { style: 'font-size:11px;color:var(--text-muted);flex:none', text: `占组合 ${f.weightPct}%` }),
    ]));
    const chips = el('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;margin:8px 0 10px' });
    (f.topTags || []).forEach(t => {
      const c = themeColor[t] || FALLBACK_COLOR;
      chips.appendChild(el('span', { style: `font-size:11px;padding:1px 8px;border-radius:999px;background:rgba(${hexRgb(c)},0.14);color:${c}`, text: t }));
    });
    card.appendChild(chips);
    const bar = el('div', { style: 'height:10px;border-radius:3px;overflow:hidden;display:flex;background:rgba(255,255,255,0.07)' });
    (f.themes || []).forEach(t => {
      if (!(t.pct > 0)) return;
      const c = themeColor[t.theme] || FALLBACK_COLOR;
      bar.appendChild(el('div', { style: `width:${t.pct}%;background:${c}` }));
    });
    card.appendChild(bar);
    const mainThemes = (f.themes || []).filter(t => t.pct >= 1).slice(0, 4);
    if (mainThemes.length) {
      card.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.7', text: mainThemes.map(t => `${t.theme} ${t.pct}%`).join(' · ') }));
    }
    let foot = `季报披露 ${f.stockCount || 0} 只重仓 · 合计占净值 ${f.disclosedPct || 0}%`;
    const notes = [];
    if (f.siblings && f.siblings.length) notes.push(`与 ${f.siblings.join(' / ')} 同持仓`);
    if (f.proxyCode) notes.push(`经 ${f.proxyCode} 代理`);
    if (notes.length) foot += '（' + notes.join(' · ') + '）';
    card.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:4px', text: foot }));
    grid.appendChild(card);
  });
  panel.appendChild(grid);

  // ---------- 待计入占位卡：已添加但暂无市值（未买入/在途待确认）的 growth 基金 ----------
  // 引擎把 currentValue<=0 的科技基金列入 pen.pending；可见但不伪造赛道数据（无重仓可穿）。
  if (pending.length) {
    const pgrid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(205px,1fr));gap:10px;margin-top:14px' });
    pending.forEach(p => {
      const txt = p.state === '在途确认中'
        ? `在途 ${fmtMoney(p.pendingAmount || 0)}，份额确认后自动计入赛道`
        : (p.state === '确认待估值' ? '份额已确认，待净值更新后计入' : '已添加，待记首笔买入后计入');
      const card = el('div', { class: 'card', style: 'padding:12px 14px;min-width:0;opacity:.85' });
      card.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px' }, [
        el('span', { style: 'font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: p.name }),
        el('span', { style: 'font-size:11px;color:var(--text-muted);flex:none', text: '待计入' }),
      ]));
      card.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.7', text: txt }));
      pgrid.appendChild(card);
    });
    panel.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:14px', text: '待计入（暂无重仓可穿，记入买入、份额确认后自动进入上方赛道透视）' }));
    panel.appendChild(pgrid);
  }

  // ---------- 未映射：补词典向导（词条人确认后写入 theme_map.json，绝不丢数据）----------
  // 词典/行业查询各自独立容错：词典失败 → 退化一行 hint（原行为）；行业失败 → 该行 chip '无行业'、select 留空手选。
  const unm = pen.unmapped || [];
  if (unm.length) {
    let themeMeta = null;
    try { themeMeta = await api.getThemeMap(); } catch (e) { themeMeta = null; }
    if (!themeMeta || !Array.isArray(themeMeta.themeNames) || !themeMeta.themeNames.length) {
      panel.appendChild(el('div', { class: 'hint', style: 'margin-top:10px', text: `${unm.length} 只股票未映射赛道：${unm.map(u => `${u.name}（${(u.funds || []).join('/')}）`).join('、')}。可在 data/config/theme_map.json 补充映射。` }));
    } else {
      await appendThemeWizard(panel, unm, themeMeta);
    }
  }

  // ---------- 覆盖度注记（防把"已披露内部分布"误读为全部仓位）----------
  if (pen.disclosedCoveragePct != null) {
    panel.appendChild(el('div', { class: 'hint', style: 'margin-top:8px', text: `注：基金季报仅披露前十大重仓，以上赛道/图表基于已披露部分，合计覆盖科技仓位约 ${pen.disclosedCoveragePct}%。` }));
  }
}

// 补词典向导：unmapped 每行 = 股票名 + 行业 chip（东财 f127）+ 赛道下拉（industryThemes 预选，可改）。
// 「写入 N 条映射」只收集下拉非空行 → POST → 成功 1.2s 后整页 reload（app init 必调 /api/refresh → 新词典自动生效闭环）。
async function appendThemeWizard(panel, unm, themeMeta) {
  const names = themeMeta.themeNames || [];
  const indThemes = (themeMeta.industryThemes) || {};
  const box = el('div', { class: 'card', style: 'margin-top:10px;padding:12px 14px' });
  box.appendChild(el('div', { style: 'font-size:13px;font-weight:500', text: `补词典向导：${unm.length} 只股票未映射赛道` }));
  box.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin:4px 0 8px', text: '下拉已按东财行业预选（可改，未知行业留空手选）；点「写入映射表」由你确认后才落盘。' }));
  // 行业批量查询：只对 6 位 A 股码发起；海外股/无码 → 该行无 chip 留空手选
  const aCodes = unm.map(u => String(u.code || '')).filter(c => /^\d{6}$/.test(c));
  let indMap = {};
  if (aCodes.length) {
    try { const r = await api.getStockIndustry(aCodes); indMap = (r && r.map) || {}; }
    catch (e) { indMap = {}; } // 行业查询失败 → 全部行留空手选（不阻塞其他功能）
  }
  const rowsWrap = el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin:6px 0 10px' });
  const selects = [];
  unm.forEach(u => {
    const code = String(u.code || '');
    const isA = /^\d{6}$/.test(code);
    const ind = isA ? (indMap[code] || null) : null;
    const sel = el('select', { class: 'input', style: 'flex:1;min-width:130px' }, [
      el('option', { value: '', text: '手动选择' }),
      ...names.map(n => el('option', { value: n, text: n })),
    ]);
    const pre = (ind && indThemes[ind]) || '';
    if (pre) sel.value = pre;
    selects.push({ stock: u.name, sel });
    const chipTxt = !isA ? '海外股' : (ind ? ind : '无行业');
    const row = el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px' }, [
      el('span', { style: 'flex:0 0 auto;min-width:0', text: u.name }),
      el('span', {
        style: 'font-size:11px;padding:0 7px;border-radius:999px;background:rgba(255,255,255,0.07);color:var(--text-muted);flex:none',
        text: chipTxt, title: isA ? '东财行业' : '非 A 股代码，走词典匹配或手动选'
      }),
      sel,
    ]);
    rowsWrap.appendChild(row);
  });
  box.appendChild(rowsWrap);
  const btn = el('button', { class: 'btn btn-primary', style: 'font-size:12px', text: `写入 ${selects.length} 条映射` });
  btn.addEventListener('click', async () => {
    const addArr = selects.filter(x => x.sel.value).map(x => ({ name: x.stock, theme: x.sel.value }));
    if (!addArr.length) { btn.textContent = '请至少为 1 条选择赛道'; return; }
    btn.disabled = true;
    btn.textContent = '写入中…';
    try {
      const r = await api.postThemeMap(addArr);
      const addedN = (r && r.added || []).length;
      const skipN = (r && r.skipped || []).length;
      btn.textContent = `✓ 已写入 ${addedN} 条` + (skipN ? `（${skipN} 条已存在跳过）` : '');
      setTimeout(() => location.reload(), 1200); // reload → bootstrap 必调 /api/refresh → 新词典自动生效
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '写入失败：' + ((e && e.message) || String(e));
    }
  });
  box.appendChild(btn);
  panel.appendChild(box);
}

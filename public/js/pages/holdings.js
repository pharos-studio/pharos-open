// 持仓页：基金列表（今日涨跌 / 持仓金额 / 累计收益）+ 添加基金 + 日限编辑 + 展开买入记录（含删除）
// 手机端（≤760px）改卡片式竖排，纯纵向滚、无横滑/无缩放（方案 A）
// 2026-09-03：＋「记一笔买入」录入（先记金额后补份额，QDII T+2 自动补填）+ 在途金额展示
// 2026-09-04：确认记录在持仓页加「编辑」入口（改日期/金额/份额/净值/备注，提交带 editKey 覆盖已有记录）
// 2026-09-08：合并——设置页的「添加基金」表单迁入本页（唯一持仓入口）；加每日限购显示/编辑；买入记录加删除；移除关注池
// 2026-09-18：编辑表单取消勾选框 —— 改日期/时段即自动重算；删除「手动校正」与在途「补填」手动入口（均由系统/数据层负责）
import * as store from '../store.js';
import * as api from '../api.js';
import { fmtMoney, signPct, cls, el, tableWrap, todayStr, catName, catNameWithCaliber, limitLabel } from '../util.js';

let _root = null;    // 当前渲染容器（录入/编辑成功后重绘用）
let _expanded = null; // 记住展开买入记录的基金 code（整页重绘后仍保持展开）
let _mobile = false;  // 渲染期判定的客户端形态（桌面/手机），决定录入/编辑表单用 <tr> 还是 <div> 包裹

// 展示线兜底常量：仅当 state.categories.engines 缺失时降级用
// （文案须与 data/config/categories.json 的 engines 一致，正常路径永远读下发段）
// 2026-09-19：bond/cash 是**待建设**类别——能选、能记市值，但不给买卖结论。
const CATS_FALLBACK = [
  { key: 'broad', name: '宽基' },
  { key: 'dividend', name: '红利·低波' },
  { key: 'growth', name: '主题·行业（高波动）' },
  { key: 'cycle', name: '商品·对冲' },
  { key: 'bond', name: '债券' },
  { key: 'cash', name: '现金' },
];
// 每条展示线的「适用于哪类基金」提示（选类别时显示，避免用户把医药基金放进宽基）
const CAT_HINTS = {
  broad: '适用：跟踪 A股/海外宽基指数的指数基金。★必须填对跟踪指数，否则估值锚缺失、判定会降级',
  dividend: '适用：**仅 A 股红利 / 低波类**。海外红利没有免费估值源，挂这条线会走常量兜底',
  growth: '适用：任何**高波动**资产 —— 医药/消费/新能源/军工/半导体/主动偏股都算，不只科技',
  cycle: '适用：任何**商品**类 —— 黄金/白银/原油/豆粕。本线只看自身净值，不绑黄金',
  bond: '★ 债券的决策算法**待建设**：现在只记录市值与占比，不给买卖结论',
  cash: '★ 现金/货币的决策算法**待建设**：现在只记录市值与占比，不给买卖结论',
};
// 盘中估算指数选项：value=指数代码（写入 estimateIndex），label 与 data/state/holdings.json 存量 estimateLabel 逐字对齐
const EST_OPTIONS = [
  { value: 'sh000300', label: '沪深300' },
  { value: 'sh000015', label: '上证红利(近似)' },
  { value: 'sz159834', label: '南方上海金ETF(159834)' },
];

/* —— 添加基金自动带出（2026-09-08 L1+L2+L3）—— */
// 模块级：名单同会话只拉一次；_lastAutoName 防自动值覆盖用户手改的名称
let _fundListPromise = null;
let _lastAutoName = '';
let _trackIdxListPromise = null;

// 跟踪指数白名单（来自后端 lib/trackIndex.js 的唯一真相源）：懒加载一次，失败静默降级为纯手填
function ensureTrackIndexList() {
  if (!_trackIdxListPromise) {
    _trackIdxListPromise = api.getTrackIndex()
      .then(d => (d && d.ok && Array.isArray(d.list)) ? d.list : null)
      .catch(() => null);
  }
  return _trackIdxListPromise;
}

// 市场判定：类型文本含 QDII/海外 → QDII（与 backend fetchers.marketOfType 同规则）
function marketOfType(typeText) { return /QDII|海外/.test(typeText || '') ? 'QDII' : 'A'; }
// 类别预选（可改、不锁定；仅建议）。
// ★★ 2026-09-19 关键修复：兜底从 `return 'growth'` 改为 **return null（不猜）**。
//   旧实现在名称匹配不到时一律归成「主题·行业」线，于是用户加一只债基/消费基金会被
//   套上"60日回撤抄底"算法算出一个看起来正常的错结论 —— 不报错，最危险。
//   现在改为：拿不到确定的判断就不预选，由界面提示用户自己选（后端 /api/fund-lookup 会
//   用东财的 FTYPE 给出确定建议，那条路径优先）。
function suggestCategory(nameText) {
  const s = String(nameText || '');
  if (/货币|现金宝|活期/.test(s)) return 'cash';
  if (/债券|纯债|信用债|利率债|可转债|双利|增利/.test(s)) return 'bond';
  if (/红利|低波/.test(s)) return 'dividend';
  if (/黄金|上海金|白银|原油|豆粕|商品/.test(s)) return 'cycle';
  if (/纳斯达克|纳指|标普\d*00|标普500|日经|恒生|道琼斯|德国DAX|法国CAC/.test(s)) return 'broad';
  if (/沪深300|中证500|中证800|中证A500|中证1000|上证50|创业板指|深证|中证100/.test(s)) return 'broad';
  return null; // ★ 不猜 —— 由 /api/fund-lookup 的 FTYPE 建议或用户手选
}
// 指数映射提示表：**仅作最后兜底**。正常路径是后端 /api/fund-lookup 用东财档案的
// INDEXCODE 精确给出 trackIndex（见 backend/lib/trackIndex.js 的 INDEX_CODE_TO_TRACK）。
// 这张表只在档案抓不到、而用户又先填了名称时有帮助；匹配不到留空，不阻塞添加。
const INDEX_HINTS = [
  { re: /纳斯达克|纳指/, trackIndex: 'NDX' },
  { re: /沪深300/, trackIndex: 'SH000300', est: 'sh000300', estLabel: '沪深300' },
  { re: /红利低波|标普红利/, trackIndex: 'CSI930955', est: 'sh000015', estLabel: '上证红利(近似)' },
  { re: /上证红利/, est: 'sh000015', estLabel: '上证红利(近似)' },
  { re: /上海金|黄金ETF|金ETF/, est: 'sz159834', estLabel: '南方上海金ETF(159834)' },
];
// 联想名单：懒加载一次，失败静默降级为纯 6 位查询流
function ensureFundList() {
  if (!_fundListPromise) {
    _fundListPromise = api.getFundList()
      .then(d => (d && d.ok && Array.isArray(d.list)) ? d.list : null)
      .catch(() => null);
  }
  return _fundListPromise;
}

function purchasesByCode(state) {
  const map = {};
  const raw = (state && state.holdings && state.holdings.funds) || {};
  const funds = Array.isArray(raw) ? raw : Object.values(raw); // 磁盘为数组；历史代码兼容对象形态
  funds.forEach(f => { if (f && f.code) map[f.code] = f.purchases || []; });
  return map;
}

// 录入/编辑/删除后：刷新 STATE（买入记录源）+ LIVE（市值/在途/月投联动）→ 重绘当前页（保持展开的基金）
async function refreshPage() {
  try {
    await Promise.all([store.reloadState(), store.reloadLive()]);
  } catch (e) {
    alert('数据刷新失败：' + e.message);
  }
  if (_root) await render(_root);
}

/* ---------- 通用：15:00 前/后 时段开关（默认「前」= T） ---------- */
// 返回 span 元素，.getSession() 读当前值（'T' / 'T+1' / null）。init 缺省按用户要求默认「前」。
// opts（2026-09-16 新增，两个都是可选的 —— 现有调用点不传 → 行为与改动前逐字一致）：
//   allowUnknown: true → 多出第三态「未知（老记录）」，用于 session 为 null 的历史记录。
//                        老记录若被静默赋成 'T'，成交日会被悄悄提前一天 —— 必须显式让用户选。
//   onChange(val)      → 每次真实变更时回调（用于触发买入预览重算）。
// 注意：所有变更都收敛到唯一的 set() 入口，避免「改了内部变量却漏了回调/paint」。
function sessionToggle(init, opts) {
  const o = opts || {};
  const allowUnknown = o.allowUnknown === true;
  const val0 = (init === 'T' || init === 'T+1') ? init : (allowUnknown ? null : 'T');
  let val = val0;
  const wrap = el('span', { class: 'seg', style: 'display:inline-flex;gap:0;margin-top:3px' });
  const mkBtn = (text) => el('button', { class: 'btn seg-opt', type: 'button', text, style: 'padding:1px 7px;font-size:11px;line-height:1.5' });
  const b1 = mkBtn('15:00前');
  const b2 = mkBtn('15:00后');
  const bU = allowUnknown ? mkBtn('未知') : null;
  const paint = () => {
    // 选中态 = 鎏金底 + 深墨字（与 .btn-primary 同一配色，白字在鎏金上对比度不足）
    const on = 'var(--accent,#D9A441)';
    b1.style.background = val === 'T' ? on : '';
    b2.style.background = val === 'T+1' ? on : '';
    b1.style.color = val === 'T' ? '#1A1206' : '';
    b2.style.color = val === 'T+1' ? '#1A1206' : '';
    if (bU) { // 第三态用弱化灰底：它不是「选择」，而是「尚未填过」的事实
      bU.style.background = val === null ? 'rgba(154,163,192,.22)' : '';
      bU.style.color = val === null ? 'var(--text,#E8ECF7)' : 'var(--text-muted,#9AA3C0)';
    }
  };
  const set = (v) => {
    if (val === v) return;
    val = v; paint();
    if (typeof o.onChange === 'function') o.onChange(val);
  };
  b1.addEventListener('click', () => set('T'));
  b2.addEventListener('click', () => set('T+1'));
  if (bU) bU.addEventListener('click', () => set(null));
  paint();
  wrap.appendChild(b1);
  wrap.appendChild(b2);
  if (bU) wrap.appendChild(bU);
  wrap.getSession = () => val;
  return wrap;
}

// 行容器：桌面返回 <tr>（与子表同构、5 列对齐）；手机返回 <div>（卡片竖排）。
// cellFns: { date, shares, amount, nav, ops } 各返回一个已构建好的子节点
function buyRowShell(cellFns) {
  if (_mobile) {
    return el('div', { class: 'buy-edit', style: 'margin:6px 0;padding:6px;border:1px dashed rgba(255,255,255,.22);border-radius:6px;display:flex;flex-direction:column;gap:6px' }, [
      cellFns.date, cellFns.shares, cellFns.amount, cellFns.nav, cellFns.ops,
    ]);
  }
  const tr = el('tr', {});
  tr.appendChild(el('td', { style: 'vertical-align:top' }, [cellFns.date]));
  tr.appendChild(el('td', { class: 'tnum', style: 'vertical-align:top' }, [cellFns.shares]));
  tr.appendChild(el('td', { style: 'vertical-align:top' }, [cellFns.amount]));
  tr.appendChild(el('td', { style: 'vertical-align:top' }, [cellFns.nav]));
  tr.appendChild(el('td', { style: 'vertical-align:top' }, [cellFns.ops]));
  return tr;
}

/* ---------- 通用：买入预览控制器（防抖 + 竞态丢弃） ---------- */
// 改日期/时段/金额 → 防抖 → GET /api/purchase-preview → 交给 paint() 渲染。
// ★ 竞态处理：seq 单调递增；响应回来时若 seq 已变（说明用户又改过），整条丢弃 ——
//   否则「先发后到」的旧响应会覆盖新结果，用户看到的是上一版数字（静默错，最难查）。
// dispose() 必须在表单被 replaceWith/refreshPage 销毁前调用，否则会往脱离文档的节点写字、白耗请求。
function createPreview({ code, getDate, getSession, getAmount, paint }) {
  let seq = 0, timer = null, last = null, dead = false;
  async function run() {
    if (dead) return;
    const date = getDate();
    const session = getSession();
    const amount = Number(getAmount());
    if (!date || !isFinite(amount) || amount <= 0) { last = null; paint(null, null); return; }
    const my = ++seq;
    paint('loading', null);
    try {
      const r = await api.getPurchasePreview(code, date, session, amount);
      if (dead || my !== seq) return;
      last = r; paint(r, null);
    } catch (e) {
      if (dead || my !== seq) return;
      last = null; paint(null, e);
    }
  }
  return {
    schedule(delay) { clearTimeout(timer); timer = setTimeout(run, delay == null ? 420 : delay); },
    get() { return last; },
    dispose() { dead = true; seq++; clearTimeout(timer); },
  };
}

// 单档预览的一行摘要（前/后对比行共用）；桌面与手机共用同一份格式化，避免两套渲染漂移
// ★ 日期一律以 nominalDate（名义日）为基准：pending 时定价日是 null，拿它 slice 会直接崩。
//   发生顺延时写成 `09-12→09-14`，让「非交易日被顺延了」一眼可见。
function pvFmtOne(v) {
  if (!v) return '—';
  const nom = v.nominalDate ? v.nominalDate.slice(5) : '—';
  const pd = v.pricingDate;
  if (v.status === 'ok') {
    const day = v.shifted ? (nom + '→' + pd.slice(5)) : pd.slice(5);
    return day + ' · ' + v.nav.toFixed(4) + ' · ' + v.shares.toFixed(2) + '份';
  }
  if (v.status === 'pending') return nom + (v.rollDays != null ? ' · 顺延 ' + v.rollDays + ' 天超限' : ' · 净值未公布');
  return nom + ' · 净值暂不可用';
}

// 「这笔按哪天净值成交、份额哪天确认到账」小字。
// ★ pricingDate（定价日）= 份额由它的净值算出；settleDate（确认日）= 份额登记到账，**不参与计算**。
//   只认真实落盘值（p.pricingDate / 兼容旧名 p.navDate）或后端旁挂 navMeta 给的推定值。
// navMeta 条目带 inferred=true 表示「老记录按冻结旧口径推定」，用弱化样式呈现，不冒充真实解析结果。
function navDateInfo(p, code, navMeta) {
  let hit = null;
  if (p && (p.pricingDate || p.navDate)) {
    hit = { pricingDate: p.pricingDate || p.navDate, settleDate: p.settleDate || null, inferred: false };
  } else {
    const bag = navMeta && navMeta[code];
    if (bag) {
      const amt = Math.round(Number(p.amount) * 100) / 100;
      hit = bag[p.date + '|' + amt] || null;
    }
  }
  if (!hit || !hit.pricingDate) return null;
  let text = (hit.inferred ? '推定净值 ' : '成交净值 ') + hit.pricingDate.slice(5);
  if (hit.settleDate) text += ' · 份额 ' + hit.settleDate.slice(5) + (hit.settleInferred ? ' 预计到账' : ' 确认');
  return { text, inferred: !!hit.inferred };
}

/* ---------- 通用：记一笔表单（桌面/手机共用） ---------- */
function addForm(code) {
  // pvSchedule 占位：sessionToggle 的 onChange 需要在 pv 建好之前就能引用（TDZ 规避）
  let pvSchedule = () => {};
  const sessT = sessionToggle('T', { onChange: () => pvSchedule(0) }); // 默认「15:00前」
  const dateI = el('input', { class: 'input', type: 'date', value: todayStr(), style: 'width:auto' });
  const amtI = el('input', { class: 'input', type: 'number', min: '0.01', step: '0.01', placeholder: '金额 ¥ 必填', style: 'width:110px' });
  // —— 净值/份额：完全由系统按「成交日净值」算出，不提供人工入口（真实值回填走券商核对后的数据修正） ——
  // 反馈文案：挂在「操作」列按钮下方（右对齐），与按钮同列
  const msg = el('div', { class: 'hint', style: 'margin-top:2px;text-align:right;max-width:170px;line-height:1.35' });
  // —— 实时预览节点：改日期/时段/金额后自动刷新，不必先保存才知道差别 ——
  const navMain = el('span', { class: 'pv-new tnum', text: '—' });
  const navSub = el('div', { class: 'hint pv-sub', text: '成交日自动取' });
  const shMain = el('span', { class: 'pv-new tnum', text: '—' });
  const shSub = el('div', { class: 'hint pv-sub', text: '按成交日净值自动算' });
  const bothT = el('div', { class: 'pv-both' });
  const bothP = el('div', { class: 'pv-both' });
  const btn = el('button', { class: 'btn btn-primary', text: '保存这笔', style: 'padding:3px 10px;font-size:12px' });
  btn.addEventListener('click', async () => {
    const amount = Number(amtI.value);
    if (!amtI.value.trim() || !isFinite(amount) || amount <= 0) { msg.textContent = '金额必填且 > 0'; return; }
    if (!dateI.value.trim()) { msg.textContent = '日期必填'; return; }
    const payload = { code, date: dateI.value, amount, session: sessT.getSession() };
    // 预览已算出的净值直接带上（navAuto 标志让服务端用权威 feeRate 自己重算份额）。
    // pending/error 时**什么都不带** → 落成「在途」，由 backfill 在净值公布后自动补份额。
    let autoFilled = false;
    const pvres = pv.get();
    const v = pvres && pvres.variants ? pvres.variants[sessT.getSession() || 'T'] : null;
    if (v && v.status === 'ok' && v.nav != null) {
      payload.nav = v.nav; payload.pricingDate = v.pricingDate; payload.navAuto = true;
      autoFilled = true;
    }
    btn.disabled = true;
    msg.textContent = '保存中…';
    try {
      await api.addPurchase(payload);
      pv.dispose();
      msg.textContent = '✓ 已记录' + (autoFilled ? '' : '（在途，成交日净值出来后自动补份额）');
      setTimeout(refreshPage, 500);
    } catch (e) {
      msg.textContent = '✗ ' + e.message;
      btn.disabled = false;
    }
  });
  const cancelBtn = el('button', { class: 'btn', text: '取消', style: 'padding:3px 10px;font-size:12px' });
  cancelBtn.addEventListener('click', () => { pv.dispose(); refreshPage(); });
  // 5 列对齐容器：日期(+时段+前/后对比) / 份额(实时) / 金额 / 净值(实时) / 操作
  const dateCell = el('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [dateI, sessT, bothT, bothP]);
  const sharesCell = el('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [shMain, shSub]);
  const amountCell = amtI;
  const navCell = el('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [navMain, navSub]);
  // 操作列：与表头「操作」及普通数据行的 编辑/删除 同口径——贴右对齐（此前 flex 默认靠左，视觉上"跑偏"）
  const opsCell = el('div', { style: 'display:flex;flex-direction:column;align-items:flex-end;gap:4px' }, [
    el('div', { style: 'display:flex;gap:4px;align-items:center;flex-wrap:wrap;justify-content:flex-end' }, [btn, cancelBtn]),
    msg,
  ]);

  const pv = createPreview({
    code,
    getDate: () => dateI.value,
    getSession: () => sessT.getSession(),
    getAmount: () => amtI.value,
    paint: (r, err) => {
      const sel = sessT.getSession() || 'T';
      if (r === 'loading') { navMain.textContent = '…'; shMain.textContent = '…'; return; }
      if (!r || !r.variants) {
        navMain.textContent = '—'; shMain.textContent = '—';
        navSub.textContent = err ? ('净值查询失败：' + err.message) : '成交日自动取';
        bothT.textContent = ''; bothP.textContent = '';
        return;
      }
      const v = r.variants[sel];
      const pd = v.pricingDate;
      navMain.textContent = v.nav != null ? v.nav.toFixed(4) : '—';
      shMain.textContent = v.shares != null ? v.shares.toFixed(4) : (v.status === 'pending' ? '待确认' : '—');
      // 顺延时把「名义日 → 真实成交日」说出来：否则用户只会看到一个陌生日期，以为系统算错了。
      // 再补上「份额哪天确认到账」—— 这正是「当天买按当天净值成交、份额隔天才登记到账」的业务节奏。
      navSub.textContent = v.status === 'ok'
        ? ('成交净值 ' + pd.slice(5) + (v.shifted ? '（' + v.nominalDate.slice(5) + ' 非交易日，顺延 ' + v.rollDays + ' 天）' : '')
           + (v.settleDate ? ' · 份额 ' + v.settleDate.slice(5) + (v.settleEstimated ? ' 预计到账' : ' 确认') : ''))
        : v.message;
      // 前/后两档同时列出 —— 用户不必来回点按钮才知道有没有区别
      if (r.converged) {
        // 两档收敛 ⇒ 下单日不是交易日（那天根本没有 15:00 这个分界），前后必然同结果。
        // 开关**保留**（不隐藏不置灰），只把两行合并成一句主动说明 —— 把「看不出区别」讲清楚。
        bothT.textContent = '非交易日下单，15:00 前后无差别：' + r.variants.T.pricingDate.slice(5) + ' 的净值';
        bothT.className = 'pv-both on';
        bothP.textContent = '';
        bothP.className = 'pv-both';
      } else {
        bothT.textContent = '前 ' + pvFmtOne(r.variants.T);
        bothP.textContent = '后 ' + pvFmtOne(r.variants['T+1']);
        bothT.className = 'pv-both ' + (sel === 'T' ? 'on' : 'off');
        bothP.className = 'pv-both ' + (sel === 'T+1' ? 'on' : 'off');
      }
    },
  });
  pvSchedule = (d) => pv.schedule(d);
  dateI.addEventListener('change', () => pv.schedule(0));   // 日期是离散选择 → 立刻算，不用等防抖
  amtI.addEventListener('input', () => pv.schedule(450));   // 键盘连续输入 → 防抖，避免一个字一次请求
  pv.schedule(0); // 打开表单即给一版预览

  return buyRowShell({ date: dateCell, shares: sharesCell, amount: amountCell, nav: navCell, ops: opsCell });
}

/* ---------- 通用：编辑表单（预填原值，提交带 editKey 覆盖已存在记录） ---------- */
// 2026-09-16 重写要点：
//   ① 老记录（无 session）时段第三态显「未知」→ 直接保存不会静默把成交日提前一天；
//   ② 净值/份额从「一发即死的静态文本」改为「原 / 新」两行实时对比（2026-09-18 由 inline 箭头改为方案 B）。
// 2026-09-18 重写要点：
//   ① ★ 重算不再依赖勾选框 —— 定价日只由「日期 + 时段」决定，二者任一变更即自动重算（pricingKeyChanged）；
//   ② ★ 删除「手动校正净值/份额」入口（避免误覆盖券商真实值）与「在途补填」；真实值修正走数据层；
//   ③ ★ 净值/份额两列统一为「原 / 新」两行带标签（CSS .pv-kv），左边缘严格对齐。
function editForm(code, p) {
  let pvSchedule = () => {};
  const noSession = (p.session !== 'T' && p.session !== 'T+1'); // 2026-09 之前的老记录
  const sessT = sessionToggle(p.session, { allowUnknown: noSession, onChange: () => pvSchedule(0) });
  const dateI = el('input', { class: 'input', type: 'date', value: p.date || '', style: 'width:auto' });
  const amtI = el('input', { class: 'input', type: 'number', min: '0.01', step: '0.01', value: p.amount != null ? String(p.amount) : '', placeholder: '金额 ¥ 必填', style: 'width:110px' });
  const msg = el('div', { class: 'hint', style: 'margin-top:2px;text-align:right;max-width:170px;line-height:1.35' });
  // —— 只读展示 + 实时对比：「原 / 新」两行带标签（方案 B），两列结构一致、左边缘对齐 ——
  const shOld = el('span', { class: 'pv-old tnum', text: p.shares != null ? Number(p.shares).toFixed(4) : '—' });
  const shNew = el('span', { class: 'pv-new tnum', text: '—' });
  const navOld = el('span', { class: 'pv-old tnum', text: p.nav != null ? Number(p.nav).toFixed(4) : '—' });
  const navNew = el('span', { class: 'pv-new tnum', text: '—' });
  const navSub = el('div', { class: 'hint pv-sub', text: '成交日自动取' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '保存修改', style: 'padding:3px 10px;font-size:12px' });
  const cancelBtn = el('button', { class: 'btn', text: '取消', style: 'padding:3px 10px;font-size:12px' });
  // 改了日期/时段 → 保存即按新定价日重算；未改 → 不提示（避免噪音）
  const movedKey = () => (dateI.value !== p.date || sessT.getSession() !== (noSession ? null : p.session));
  const refreshWarn = () => {
    if (msg.textContent === '保存中…' || msg.textContent.startsWith('✓') || msg.textContent.startsWith('✗')) return;
    msg.textContent = movedKey() ? '将按新成交日重算净值/份额' : '';
  };
  const doSave = async () => {
    const amount = Number(amtI.value);
    if (!amtI.value.trim() || !isFinite(amount) || amount <= 0) { msg.textContent = '金额必填且 > 0'; return; }
    if (!dateI.value.trim()) { msg.textContent = '日期必填'; return; }
    const payload = { code, date: dateI.value, amount, session: sessT.getSession(), editKey: { date: p.date, amount: p.amount } };
    // 重算：定价日只由「日期 + 时段」决定 —— 二者任一变更即自动重算，无需任何勾选。
    // 只信预览结果；服务端会用权威 feeRate 自己重算份额（客户端份额不被信任）。
    if (movedKey()) {
      const pvres = pv.get();
      const v = pvres && pvres.variants ? pvres.variants[sessT.getSession() || 'T'] : null;
      if (!v || v.status === 'error') {
        // 预览拿不到净值 → 拒绝重算。绝不在信息不足时清空真实的净值/份额（那才是真正的数据事故）
        msg.textContent = '净值查询未成功，已取消重算（请稍后重试）';
        return;
      }
      if (v.status === 'pending') {
        // 新成交日的净值确实还没公布（或顺延超限）—— 这是合法意图，但要用户明确知道后果
        const why = (v.rollDays != null)
          ? ('名义成交日 ' + v.nominalDate + ' 之后顺延 ' + v.rollDays + ' 天都没有新净值（超过 ' + '上限）。')
          : ('名义成交日 ' + v.nominalDate + ' 之后的净值尚未公布。');
        if (!confirm(why + '\n保存后这笔会变成「待确认」，原净值/份额会被清空，等系统在净值公布后自动补填。\n\n继续？')) return;
      } else {
        payload.nav = v.nav; payload.pricingDate = v.pricingDate;
      }
      payload.recalc = true;
      payload.navAuto = true;
    }
    saveBtn.disabled = true;
    msg.textContent = '保存中…';
    try {
      const r = await api.updatePurchase(payload);
      pv.dispose();
      msg.textContent = '✓ 已更新' + (r && r.warn ? '（' + r.warn + '）' : '');
      setTimeout(refreshPage, 500);
    } catch (e) {
      msg.textContent = '✗ ' + e.message;
      saveBtn.disabled = false;
    }
  };
  saveBtn.addEventListener('click', doSave);
  cancelBtn.addEventListener('click', () => { pv.dispose(); refreshPage(); });
  // 5 列对齐容器：日期(+时段) / 份额(原·新) / 金额 / 净值(原·新 + 成交日说明) / 操作
  const dateCell = el('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [dateI, sessT]);
  const sharesCell = el('div', { class: 'pv-kv' }, [
    el('span', { class: 'k', text: '原' }), shOld,
    el('span', { class: 'k', text: '新' }), shNew,
  ]);
  const amountCell = amtI;
  const navCell = el('div', { style: 'display:flex;flex-direction:column;gap:2px' }, [
    el('div', { class: 'pv-kv' }, [
      el('span', { class: 'k', text: '原' }), navOld,
      el('span', { class: 'k', text: '新' }), navNew,
    ]),
    navSub,
  ]);
  // 操作列：贴右对齐 + 反馈文案挂按钮下方（同 记一笔）
  const opsCell = el('div', { style: 'display:flex;flex-direction:column;align-items:flex-end;gap:4px' }, [
    el('div', { style: 'display:flex;gap:4px;align-items:center;flex-wrap:wrap;justify-content:flex-end' }, [saveBtn, cancelBtn]),
    msg,
  ]);

  const pv = createPreview({
    code,
    getDate: () => dateI.value,
    getSession: () => sessT.getSession(),
    getAmount: () => amtI.value,
    paint: (r, err) => {
      const sel = sessT.getSession() || 'T';
      const dash = (e) => { e.textContent = '—'; e.className = 'hint'; };
      const hold = (e) => { e.textContent = '待确认'; e.className = 'hint'; };
      if (r === 'loading') {
        navNew.textContent = '…'; navNew.className = 'pv-new tnum';
        shNew.textContent = '…'; shNew.className = 'pv-new tnum';
        return;
      }
      if (!r || !r.variants) {
        // 拿不到预览 → 两列「新」行都退回占位，「新」位保留以维持两列左边缘对齐
        dash(navNew); dash(shNew);
        navSub.textContent = err ? ('净值查询失败：' + err.message) : '成交日自动取';
        refreshWarn();
        return;
      }
      const v = r.variants[sel];
      const pd = v.pricingDate;
      // 净值「新」行
      if (v.status === 'ok') {
        navNew.textContent = v.nav.toFixed(4);
        navNew.className = 'pv-new tnum';
        navSub.textContent = '成交净值 ' + pd.slice(5)
          + (v.shifted ? '（' + v.nominalDate.slice(5) + ' 非交易日，顺延 ' + v.rollDays + ' 天）' : '')
          + (v.settleDate ? ' · 份额 ' + v.settleDate.slice(5) + (v.settleEstimated ? ' 预计到账' : ' 确认') : '');
      } else {
        if (v.status === 'pending') hold(navNew); else dash(navNew);
        navSub.textContent = v.message;
      }
      // 份额「新」行（与原值一致时不制造噪音，但仍占「新」位保持两列左边缘对齐）
      if (v.status !== 'ok' || v.shares == null) {
        if (v.status === 'pending') hold(shNew); else dash(shNew);
      } else if (p.shares != null && Math.abs(v.shares - Number(p.shares)) < 1e-9) {
        shNew.textContent = '与原值一致';
        shNew.className = 'hint pv-sub';
      } else {
        const d = (p.shares != null) ? (v.shares - Number(p.shares)) : null;
        shNew.textContent = v.shares.toFixed(4) + (d != null ? '（' + (d > 0 ? '+' : '') + d.toFixed(4) + '）' : '');
        shNew.className = 'pv-new tnum';
      }
      refreshWarn();
    },
  });
  pvSchedule = (d) => pv.schedule(d);
  dateI.addEventListener('change', () => { refreshWarn(); pv.schedule(0); });
  amtI.addEventListener('input', () => pv.schedule(450));
  pv.schedule(0); // 打开表单即算一版：用户一眼看到「改不改有区别」

  return buyRowShell({ date: dateCell, shares: sharesCell, amount: amountCell, nav: navCell, ops: opsCell });
}

/* ---------- 每日限购：显示 + 可编辑（数据来自 config.dailyLimits，不抓取） ---------- */
// 桌面表格单元格：上方显示标签（暂停/不限/¥X/日），下方数字输入框（0=暂停，留空=不限）
function limitCell(state, code) {
  const lim = limitLabel(state.config, code);
  const td = el('td', {});
  const cur = state.config.dailyLimits && state.config.dailyLimits[code] != null ? state.config.dailyLimits[code] : '';
  const input = el('input', {
    class: 'input', type: 'number', min: '0', step: '1', style: 'width:80px',
    title: '每日限购（元/日，0=暂停申购，留空=不限）', value: cur,
  });
  input.addEventListener('change', async () => {
    const raw = input.value.trim();
    if (!state.config.dailyLimits) state.config.dailyLimits = {};
    if (raw === '') delete state.config.dailyLimits[code];
    else { const n = parseFloat(raw); state.config.dailyLimits[code] = (isFinite(n) && n >= 0) ? n : 0; }
    try { await api.save({ config: state.config }); await refreshPage(); }
    catch (e) { alert('日限保存失败：' + e.message); }
  });
  td.appendChild(el('div', { class: 'hint', text: lim.text, style: lim.cls ? 'color:var(--up)' : '' }));
  td.appendChild(input);
  return td;
}

// 手机卡片中的日限编辑行
function limitRow(state, code) {
  const lim = limitLabel(state.config, code);
  const cur = state.config.dailyLimits && state.config.dailyLimits[code] != null ? state.config.dailyLimits[code] : '';
  const input = el('input', {
    class: 'input', type: 'number', min: '0', step: '1', style: 'width:80px',
    title: '每日限购（元/日，0=暂停申购，留空=不限）', value: cur,
  });
  input.addEventListener('change', async () => {
    const raw = input.value.trim();
    if (!state.config.dailyLimits) state.config.dailyLimits = {};
    if (raw === '') delete state.config.dailyLimits[code];
    else { const n = parseFloat(raw); state.config.dailyLimits[code] = (isFinite(n) && n >= 0) ? n : 0; }
    try { await api.save({ config: state.config }); await refreshPage(); }
    catch (e) { alert('日限保存失败：' + e.message); }
  });
  return el('div', { class: 'fc-limit', style: 'margin-top:6px;display:flex;align-items:center;gap:6px' }, [
    el('span', { class: 'hint', text: '日限：' + lim.text, style: lim.cls ? 'color:var(--up)' : '' }),
    input,
  ]);
}

/* ---------- 桌面：展开子表（含在途「待确认」标与删除） ---------- */
function buyTable(f, list, navMeta) {
  const sub = el('table', { class: 'tbl' });
  sub.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: '日期' }), el('th', { text: '份额' }), el('th', { text: '金额' }), el('th', { text: '净值' }), el('th', { text: '操作' }),
  ])]));
  const sb = el('tbody', {}); // 外层声明，供「记一笔」按钮插入首行
  const addBtn = el('button', { class: 'btn', text: '＋ 记一笔', style: 'padding:4px 12px;font-size:12px' });
  let addTr = null; // 记一笔表单行（桌面为 <tr>），切换显隐
  addBtn.addEventListener('click', () => {
    if (addTr && addTr.parentNode) {
      addTr.remove();
      addTr = null;
      addBtn.textContent = '＋ 记一笔';
    } else {
      addTr = addForm(f.code); // 桌面返回 <tr>，直接进 tbody 与子表 5 列对齐
      sb.insertBefore(addTr, sb.firstChild);
      addBtn.textContent = '收起表单';
    }
  });
  const wrap = el('div', { style: 'padding:2px' });
  const delFundBtn = el('button', { class: 'btn', text: '删除该基金', style: 'padding:4px 12px;font-size:12px' });
  delFundBtn.addEventListener('click', () => removeFund(f.code));
  wrap.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin:4px 0' }, [
    el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
      el('span', { class: 'hint', text: list.length ? `${list.length} 笔` : '无买入记录' }),
      delFundBtn,
    ]),
    addBtn,
  ]));
  if (list.length) {
    list.forEach(p => {
      const pending = p.shares == null;
      const tr = el('tr', {});
      // 日期格：主行为下单日，下方小字为「这笔按哪天的净值成交」（需求：一眼看出每笔的定价日）
      const dateTd = el('td', {}, [el('div', { text: p.date || '—' })]);
      const nd = navDateInfo(p, f.code, navMeta);
      if (nd) dateTd.appendChild(el('div', { class: 'pv-sub', text: nd.text }));
      else if (pending) dateTd.appendChild(el('div', { class: 'pv-sub', text: '待确认' }));
      tr.appendChild(dateTd);
      tr.appendChild(el('td', { class: 'tnum', text: pending ? '—' : Number(p.shares).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) }));
      const amtTd = el('td', { class: 'tnum' }, [el('span', { text: fmtMoney(p.amount) })]);
      if (pending) amtTd.appendChild(el('span', { class: 'badge badge-muted', style: 'margin-left:6px', text: '待确认' }));
      tr.appendChild(amtTd);
      tr.appendChild(el('td', { class: 'tnum', text: p.nav != null ? p.nav.toFixed(4) : '—' }));
      const opTd = el('td', {});
      const editBtn = el('button', { class: 'btn', text: '编辑', style: 'padding:2px 10px;font-size:12px;margin-left:4px' });
      editBtn.addEventListener('click', () => {
        tr.replaceWith(editForm(f.code, p)); // 桌面返回 <tr>（与子表同构、5 列对齐）
      });
      opTd.appendChild(editBtn);
      // 删除：二次确认防误删
      const delBtn = el('button', { class: 'btn', text: '删除', style: 'padding:2px 10px;font-size:12px;margin-left:4px' });
      delBtn.addEventListener('click', async () => {
        if (!confirm('确定删除这笔买入记录？删除后不可恢复。')) return;
        try {
          await api.deletePurchase({ code: f.code, action: 'delete', editKey: { date: p.date, amount: p.amount } });
          await refreshPage();
        } catch (e) { alert('删除失败：' + e.message); }
      });
      opTd.appendChild(delBtn);
      tr.appendChild(opTd);
      sb.appendChild(tr);
    });
  } else {
    sb.appendChild(el('tr', {}, [el('td', { colspan: '5', class: 'hint', style: 'padding:6px 4px', text: '还没买过，点「＋ 记一笔」录第一笔。' })]));
  }
  sub.appendChild(sb);
  wrap.appendChild(tableWrap(sub));
  return wrap;
}

/* ---------- 桌面：整页渲染 ---------- */
// 2026-09-12：调序——「持仓基金」在上、「添加基金」面板移到下方
function renderDesktop(root, live, state) {
  const funds = (live.funds || []).slice().sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0));
  const buys = purchasesByCode(state);
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-head' }, [el('span', { text: '持仓基金' }), el('span', { class: 'sub', text: `${funds.length} 只` })]));
  if (!funds.length) {
    panel.appendChild(el('div', { class: 'hint', text: '还没有基金。在下方表单添加第一只——填好代码后，名称、类别、跟踪指数都会自动带出来。' }));
    root.appendChild(panel);
    root.appendChild(addFundPanel()); // 空仓时也把添加表单放下方
    return;
  }
  const table = el('table', { class: 'tbl' });
  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: '基金' }), el('th', { text: '今日' }), el('th', { text: '持仓金额' }), el('th', { text: '累计收益' }), el('th', { text: '日限' }), el('th', { text: '' }),
  ])]));
  const tbody = el('tbody', {});
  funds.forEach(f => {
    const tr = el('tr', {});
    tr.appendChild(el('td', {}, [el('div', { class: 'name-cell' }, [
      el('span', { class: 'nm', text: f.name }),
      el('span', { class: 'meta', text: `${f.code} · ${catNameWithCaliber(state, f.category, f.caliber)}` }),
    ])]));
    const dayCell = el('td', { class: cls(f.dayChange) });
    dayCell.textContent = f.dayChange != null ? signPct(f.dayChange) : '—';
    if (f.latestNav != null) dayCell.appendChild(el('div', { class: 'meta', text: '净值 ' + f.latestNav + (f.latestDate ? ' · ' + f.latestDate.slice(5) : '') }));
    tr.appendChild(dayCell);
    const va = el('td', { class: 'tnum' }, [el('span', { text: fmtMoney(f.currentValue) })]);
    if (f.pendingAmount > 0) va.appendChild(el('div', { class: 'meta', text: '含在途 ' + fmtMoney(f.pendingAmount) }));
    tr.appendChild(va);
    const pc = el('td', { class: cls(f.profit) });
    pc.appendChild(el('div', { class: 'tnum', text: fmtMoney(f.profit) }));
    pc.appendChild(el('div', { class: 'meta ' + cls(f.profitPct), text: signPct(f.profitPct) }));
    tr.appendChild(pc);
    tr.appendChild(limitCell(state, f.code)); // 日限显示 + 编辑
    const btn = el('td', {}, [el('span', { class: 'expand-btn', text: '买入记录 ▾' })]);
    tr.appendChild(btn);
    tbody.appendChild(tr);

    const list = buys[f.code] || [];
    const open0 = _expanded === f.code;
    const detail = el('tr', { style: open0 ? '' : 'display:none' });
    const dtd = el('td', { colspan: '6', style: 'background:rgba(0,0,0,0.18)' });
    dtd.appendChild(buyTable(f, list, state && state.navMeta && state.navMeta[f.code]));
    detail.appendChild(dtd);
    tbody.appendChild(detail);

    btn.addEventListener('click', () => {
      const open = detail.style.display !== 'none';
      detail.style.display = open ? 'none' : '';
      btn.querySelector('.expand-btn').textContent = open ? '买入记录 ▾' : '收起 ▴';
      _expanded = open ? null : f.code;
    });
  });
  table.appendChild(tbody);
  panel.appendChild(tableWrap(table, true));
  root.appendChild(panel);
  root.appendChild(addFundPanel()); // 2026-09-12 调序：添加表单移到持仓列表下方
}

/* ---------- 手机端卡片 ---------- */
function metricCell(label, mainText, mainCls, subText, subCls) {
  const cell = el('div', { class: 'fc-metric' });
  cell.appendChild(el('div', { class: 'fc-label', text: label }));
  const v = el('div', { class: 'fc-value ' + (mainCls || '') });
  v.textContent = mainText;
  cell.appendChild(v);
  if (subText != null) {
    const s = el('div', { class: 'fc-sub ' + (subCls || '') });
    s.textContent = subText;
    cell.appendChild(s);
  }
  return cell;
}

function buyRow(code, p, navMeta) {
  const pending = p.shares == null;
  const nd = navDateInfo(p, code, navMeta);
  const dateBox = el('div', { class: 'buy-date' }, [el('span', { text: p.date || '—' })]);
  if (nd) dateBox.appendChild(el('div', { class: 'pv-sub', text: nd.text }));
  const row = el('div', { class: 'buy-row', style: 'align-items:center;gap:6px' }, [
    dateBox,
    el('span', { class: 'buy-amt' }, [
      el('span', { text: fmtMoney(p.amount) }),
      pending ? el('span', { class: 'badge badge-muted', style: 'margin-left:4px', text: '待确认' }) : null,
    ]),
    el('span', { class: 'buy-nav', text: p.nav != null ? '净值 ' + p.nav.toFixed(4) : (pending ? '份额 —' : '') }),
  ]);
  const editBtn = el('button', { class: 'btn', text: '编辑', style: 'padding:2px 8px;font-size:11px;margin-left:4px' });
  editBtn.addEventListener('click', () => { row.replaceWith(editForm(code, p)); });
  row.appendChild(editBtn);
  // 删除：二次确认防误删
  const delBtn = el('button', { class: 'btn', text: '删除', style: 'padding:2px 8px;font-size:11px;margin-left:4px' });
  delBtn.addEventListener('click', async () => {
    if (!confirm('确定删除这笔买入记录？删除后不可恢复。')) return;
    try {
      await api.deletePurchase({ code, action: 'delete', editKey: { date: p.date, amount: p.amount } });
      await refreshPage();
    } catch (e) { alert('删除失败：' + e.message); }
  });
  row.appendChild(delBtn);
  return row;
}

function purchaseList(code, list, navMeta) {
  if (!list.length) return el('div', { class: 'hint', text: '无买入记录。' });
  const wrap = el('div', { class: 'buy-list' });
  list.forEach(p => wrap.appendChild(buyRow(code, p, navMeta)));
  return wrap;
}

function fundCard(f, list, state) {
  const card = el('div', { class: 'fund-card' });
  card.appendChild(el('div', { class: 'fc-head' }, [
    el('div', { class: 'fc-name', text: f.name }),
    el('div', { class: 'fc-meta', text: `${f.code} · ${catNameWithCaliber(state, f.category, f.caliber)}` }),
  ]));
  const metrics = el('div', { class: 'fc-metrics' });
  metrics.appendChild(metricCell(
    '今日',
    f.dayChange != null ? signPct(f.dayChange) : '—',
    cls(f.dayChange),
    f.latestNav != null ? '净值 ' + f.latestNav + (f.latestDate ? ' · ' + f.latestDate.slice(5) : '') : null,
    ''
  ));
  metrics.appendChild(metricCell('持仓', fmtMoney(f.currentValue), '', f.pendingAmount > 0 ? '含在途 ' + fmtMoney(f.pendingAmount) : null, ''));
  metrics.appendChild(metricCell(
    '累计',
    f.profit != null ? fmtMoney(f.profit) : '—',
    cls(f.profit),
    f.profitPct != null ? signPct(f.profitPct) : null,
    cls(f.profitPct)
  ));
  card.appendChild(metrics);
  card.appendChild(limitRow(state, f.code)); // 日限显示 + 编辑

  const delFundBtn = el('div', { class: 'fc-expand', text: '删除该基金', style: 'color:var(--up);margin-top:8px' });
  delFundBtn.addEventListener('click', () => removeFund(f.code));
  card.appendChild(delFundBtn);

  const btn = el('div', { class: 'fc-expand', text: '买入记录 ▾' });
  const detail = el('div', { class: 'fc-detail', style: (_expanded === f.code) ? '' : 'display:none' });
  const addBtn = el('button', { class: 'btn', text: '＋ 记一笔', style: 'padding:4px 12px;font-size:12px;width:auto;margin-bottom:8px' });
  const formHolder = el('div', { style: 'display:none' });
  formHolder.appendChild(addForm(f.code));
  addBtn.addEventListener('click', () => {
    const open = formHolder.style.display !== 'none';
    formHolder.style.display = open ? 'none' : '';
    addBtn.textContent = open ? '＋ 记一笔' : '收起表单';
  });
  detail.appendChild(el('div', {}, [addBtn, formHolder]));
  detail.appendChild(purchaseList(f.code, list, state && state.navMeta && state.navMeta[f.code]));
  btn.addEventListener('click', () => {
    const open = detail.style.display !== 'none';
    detail.style.display = open ? 'none' : '';
    btn.textContent = open ? '买入记录 ▾' : '收起 ▴';
    _expanded = open ? null : f.code;
  });
  card.appendChild(btn);
  card.appendChild(detail);
  return card;
}

function renderMobile(root, live, state) {
  // 2026-09-12：调序——「持仓基金」在上、「添加基金」面板移到下方
  const funds = (live.funds || []).slice().sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0));
  const buys = purchasesByCode(state);
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-head' }, [el('span', { text: '持仓基金' }), el('span', { class: 'sub', text: `${funds.length} 只` })]));
  if (!funds.length) {
    panel.appendChild(el('div', { class: 'hint', text: '还没有基金。在下方表单添加第一只——填好代码后，名称、类别、跟踪指数都会自动带出来。' }));
    root.appendChild(panel);
    root.appendChild(addFundPanel()); // 空仓时也把添加表单放下方
    return;
  }
  const stack = el('div', { class: 'stack' });
  funds.forEach(f => stack.appendChild(fundCard(f, buys[f.code] || [], state)));
  panel.appendChild(stack);
  root.appendChild(panel);
  root.appendChild(addFundPanel()); // 2026-09-12 调序：添加表单移到持仓列表下方
}

/* ---------- 添加基金：表单 + 持久化（从设置页迁入，唯一持仓入口） ---------- */
// 读 funds（磁盘为数组；历史对象形态兼容）
function readFunds(state) {
  const raw = (state && state.holdings && state.holdings.funds) || [];
  return Array.isArray(raw) ? raw : Object.values(raw);
}

// 持久化：只回写 holdings + config（不再含 watchlist），成功刷新本页
async function persist(state) {
  try {
    await api.save({ holdings: state.holdings, config: state.config });
    await refreshPage();
    return true;
  } catch (e) {
    alert('保存失败：' + e.message + '\n（写入需要正确的 API Key，且后端已启动）');
    return false;
  }
}

// 添加基金：market/估算由表单决定（删硬编码；QDII 走 T+2 无盘中估算）
// caliber（口径，2026-09-12）：仅宽基(broad)需要 —— cn=A股口径 / us=海外口径；其他类别不落该字段。
// trackIndex（2026-09-12 一键添加）：INDEX_HINTS 命中时自动带入（决策估值/PE历史用），缺省不落字段（走价格分位兜底）。
async function addFund(code, name, category, market, estIndex, estLabel, caliber, trackIndex) {
  const state = store.getState();
  const funds = readFunds(state);
  if (funds.some(f => f.code === code)) { alert('该基金已存在'); return; }
  const newFund = Object.assign({
    code, name, category, market,
    caliber: (category === 'broad' && (caliber === 'cn' || caliber === 'us')) ? caliber : undefined,
    feeRate: 0, estimateIndex: estIndex || null, estimateLabel: estLabel || null,
    purchases: [],
  }, trackIndex ? { trackIndex } : {});
  state.holdings = Object.assign({}, state.holdings, { funds: funds.concat([newFund]) });
  const ok = await persist(state);
  if (ok) alert('已添加。新基金无买入记录，展开点「＋记一笔」录首笔买入后才有市值。');
}

// 删除基金：从 funds 数组移除后整体回写（经 /api/save 的 holdings 通道，无需新端点）
async function removeFund(code) {
  if (!confirm('确定删除该基金及其全部买入记录？删除后不可恢复。')) return;
  const state = store.getState();
  state.holdings = Object.assign({}, state.holdings, { funds: readFunds(state).filter(f => f.code !== code) });
  await persist(state);
}

/* ---------- 批量添加（2026-09-12）：粘贴多行「代码 [日期] [金额]」→ 解析预览 → 确认写入 ---------- */
// 行格式：6位代码 + 可选日期(YYYY-MM-DD 或 YYYY/MM/DD) + 可选金额（¥/元/逗号均可容忍），日期与金额顺序无关。
// 日期缺省 = 今天；金额缺省 = 只建档案不记买入。过去日期同样可用（backfill 引擎按该记录推 T+1/T+2 拉净值）。
// 解析链与单只添加同源：本地名单 → /api/fund-lookup 兜底 → suggestCategory + INDEX_HINTS。
async function parseBulkRows(text) {
  const rows = await ensureFundList();
  const out = [];
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(\d{6})(?:[\s,，:：]+(.*))?$/);
    if (!m) { out.push({ raw: line, err: '格式须为「6位代码 [日期] [金额]」' }); continue; }
    const code = m[1];
    let date = null, amount = null, badToken = null, badDate = null;
    if (m[2] != null && m[2] !== '') {
      for (const rawTok of m[2].split(/[\s,，]+/)) {
        const tok = rawTok.trim();
        if (!tok) continue;
        if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(tok)) {
          const seg = tok.split(/[-/]/).map(Number);
          const dt = new Date(seg[0], seg[1] - 1, seg[2]);
          if (dt.getFullYear() !== seg[0] || dt.getMonth() + 1 !== seg[1] || dt.getDate() !== seg[2]) { badDate = tok; break; }
          date = seg[0] + '-' + String(seg[1]).padStart(2, '0') + '-' + String(seg[2]).padStart(2, '0'); continue;
        }
        const a = Number(tok.replace(/[¥￥元]/g, ''));
        if (isFinite(a) && a > 0) { amount = a; continue; }
        badToken = tok; break;
      }
    }
    if (badDate) { out.push({ code, err: '日期无效：「' + badDate + '」（用 YYYY-MM-DD，月份 1-12）' }); continue; }
    if (badToken) { out.push({ code, err: '无法识别的字段：「' + badToken + '」（日期用 YYYY-MM-DD，金额只留数字）' }); continue; }
    if (amount != null && amount <= 0) { out.push({ code, err: '金额须 > 0' }); continue; }
    const local = rows && rows.find(r => r[0] === code);
    let name = local ? local[1] : '', type = local ? local[2] : '';
    if (!local) {
      try { const d = await api.getFundLookup(code); if (d && d.ok && d.found && d.name) { name = d.name; type = d.type || ''; } } catch (e) {}
    }
    if (!name) { out.push({ code, err: '未找到该基金（检查代码）' }); continue; }
    const hint = INDEX_HINTS.find(h => h.re.test(name));
    out.push({
      code, name, market: marketOfType(type), category: suggestCategory(name), date, amount,
      trackIndex: (hint && hint.trackIndex) || null,
      est: (hint && hint.est) || null,
      exists: readFunds(store.getState()).some(f => f.code === code),
    });
  }
  return out;
}

// 确认写入：新建基金走一次 /api/save 整份回写（幂等）；带金额的行循环 /api/purchase（逐条独立，
// 单条失败在汇总里报告不回滚——本地工具，失败可修正后重试）。返回结果汇报行数组。
async function commitBulkRows(items) {
  const state = store.getState();
  const report = [];
  const toAdd = items.filter(r => !r.err && !r.exists);
  if (toAdd.length) {
    const built = toAdd.map(r => Object.assign({
      code: r.code, name: r.name, category: r.category, market: r.market,
      caliber: (r.category === 'broad') ? (r.bulkCal || (r.market === 'QDII' ? 'us' : 'cn')) : undefined,
      feeRate: 0,
      estimateIndex: r.est || null,
      estimateLabel: r.est ? ((EST_OPTIONS.find(o => o.value === r.est) || {}).label || null) : null,
      purchases: [],
    }, r.trackIndex ? { trackIndex: r.trackIndex } : {}));
    state.holdings = Object.assign({}, state.holdings, { funds: readFunds(state).concat(built) });
    try {
      await api.save({ holdings: state.holdings, config: state.config });
      report.push('✓ 新建基金 ' + built.length + ' 只：' + built.map(f => f.code).join('、'));
    } catch (e) { return ['✗ 保存失败：' + e.message + '（未写入任何买入记录，修正 API Key 后可重试）']; }
  } else {
    report.push('（无新建基金，仅处理买入记录）');
  }
  const buyRows = items.filter(x => !x.err && x.amount > 0);
  for (const r of buyRows) {
    const d = r.date || todayStr();
    // 批量录入的时段假定：默认「15:00 前」= 下单当天净值（多数人盘中下单）。
    // 注意：批量路径与单笔路径口径一致（都是 session:'T'）；批量行如需「后」请录入后逐笔编辑。
    try { await api.addPurchase({ code: r.code, date: d, amount: r.amount, session: 'T' }); report.push('✓ 买入 ' + r.code + ' ' + d + ' ¥' + r.amount + '（默认 15:00 前，份额待净值出来后自动回填）'); }
    catch (e) { report.push('✗ 买入 ' + r.code + '：' + e.message); }
  }
  if (!buyRows.length) report.push('（无买入记录需要写入）');
  await refreshPage();
  return report;
}

// 批量预览表格：错误行标红不阻塞；类别下拉可改（broad 行带口径下拉）；「已存在」行只补买入
function renderBulkPreview(container, items) {
  container.innerHTML = '';
  const tbl = el('table', { class: 'tbl' });
  tbl.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: '代码' }), el('th', { text: '名称' }), el('th', { text: '市场' }),
    el('th', { text: '类别' }), el('th', { text: '口径' }), el('th', { text: '买入日期' }), el('th', { text: '买入金额' }), el('th', { text: '状态' }),
  ])]));
  const tb = el('tbody', {});
  items.forEach(r => {
    const tr = el('tr', r.err ? { style: 'background:rgba(192,57,43,.14)' } : {});
    if (r.err) {
      tr.appendChild(el('td', { text: r.code || r.raw || '—' }));
      tr.appendChild(el('td', { colspan: '6', text: '✗ ' + r.err }));
      tr.appendChild(el('td', { text: '错误' }));
      tb.appendChild(tr);
      return;
    }
    const catSel = el('select', {}, CATS_FALLBACK.map(k => el('option', { value: k.key, text: k.name })));
    catSel.value = r.category;
    const calSel = el('select', {}, [el('option', { value: 'cn', text: 'cn' }), el('option', { value: 'us', text: 'us' })]);
    r.bulkCal = (r.category === 'broad' && r.market === 'QDII') ? 'us' : 'cn';
    calSel.value = r.bulkCal;
    const syncCal = () => {
      if (r.category === 'broad') { calSel.style.display = ''; r.bulkCal = calSel.value; }
      else calSel.style.display = 'none';
    };
    catSel.addEventListener('change', () => { r.category = catSel.value; syncCal(); });
    calSel.addEventListener('change', () => { r.bulkCal = calSel.value; });
    syncCal();
    tr.appendChild(el('td', { text: r.code }));
    tr.appendChild(el('td', { text: r.name }));
    tr.appendChild(el('td', { text: r.market }));
    tr.appendChild(el('td', {}, [catSel]));
    tr.appendChild(el('td', {}, [calSel]));
    tr.appendChild(el('td', { text: r.date || (todayStr() + '（默认）') }));
    tr.appendChild(el('td', { text: r.amount > 0 ? '¥' + r.amount : '—' }));
    tr.appendChild(el('td', { text: r.exists ? '已存在（只补买入）' : (r.amount > 0 ? '新建+买入' : '新建') }));
    tb.appendChild(tr);
  });
  tbl.appendChild(tb);
  container.appendChild(tableWrap(tbl));
}

function labeled(label, input) {
  return el('div', { class: 'field' }, [el('label', { text: label }), input]);
}

// 添加基金面板：代码(联想+自动带出)/名称/类别(四引擎)/市场/盘中估算 + 防错（2026-09-08 L1+L2+L3）
// 桌面/手机两处 render 共用本函数；单一 150ms 防抖按输入长度分流：1~5 联想 / 6 查询带出
function addFundPanel() {
  const state = store.getState();
  // 类别下拉的选项源 = categories.json 的 **categories（展示线）**，不是 engines。
  // ★ 两者含义不同：engines 是「可绑定的算法」（只有 4 条），categories 是「能挂到哪个类别」
  //   （含债券/现金这两个待建设类别）。用 engines 当选项源会让用户**选不到**债券/现金。
  const engines = ((state.categories && state.categories.categories && state.categories.categories.length)
    ? state.categories.categories
    : ((state.categories && state.categories.engines && state.categories.engines.length)
      ? state.categories.engines : CATS_FALLBACK));
  const code = el('input', { class: 'input', placeholder: '基金代码（6 位数字）', autocomplete: 'off', spellcheck: 'false' });
  const name = el('input', { class: 'input', placeholder: '基金名称（自动带出，可改）' });
  const cat = el('select', {}, [
    el('option', { value: '', text: '请选择类别' }),
    ...engines.map(c => el('option', { value: c.key, text: c.name })),
  ]);
  // 适用提示：明确告诉用户「这类基金该不该挂这条线」，避免把医药基金放进宽基、把债基放进主题线
  const catHint = el('div', { class: 'hint', style: 'margin-top:4px', text: '' });
  const market = el('select', {}, [
    el('option', { value: 'A', text: 'A股' }),
    el('option', { value: 'QDII', text: 'QDII' }),
  ]);
  // 口径（caliber）：仅「宽基」需要 —— 决定用哪把尺子量便宜（cn=A股 PE分位×中债ERP / us=滚动分位∨PE回撤×美债ERP）
  const calibers = (state.categories && state.categories.calibers && state.categories.calibers.length)
    ? state.categories.calibers : [{ key: 'cn', name: 'A股口径' }, { key: 'us', name: '海外口径' }];
  const cal = el('select', {}, calibers.map(c => el('option', { value: c.key, text: c.name })));
  cal.value = 'cn';
  const calField = labeled('口径（仅宽基）', cal);
  calField.style.display = 'none';           // 默认隐藏，类别选到「宽基」才出现
  const syncCaliberVisibility = () => {
    const isBroad = cat.value === 'broad';
    calField.style.display = isBroad ? '' : 'none';
    if (isBroad && market.value === 'QDII' && cal.value === 'cn') cal.value = 'us'; // QDII 默认海外口径（可改）
  };
  // 类别适用提示：选到哪条线，就把「这条线适用什么基金」直接显示出来。
  // 这是「用户加自己的基金」最容易出错的一步 —— 选错类别会套错算法且不会报错。
  const syncCatHint = () => {
    // 自建分类（custom:xxx）本身没有提示，要折算到它绑定的内置算法去看适用说明
    const st0 = store.getState();
    const cust = (st0.categories && Array.isArray(st0.categories.customCategories)) ? st0.categories.customCategories : [];
    const hit = cust.find(x => x && x.key === cat.value);
    const baseKey = hit ? hit.category : cat.value;
    const t = CAT_HINTS[baseKey] || '';
    catHint.textContent = (hit ? '自建分类（绑定算法：' + baseKey + '）—— ' : '') + t;
    catHint.style.color = /待建设/.test(t) ? '#8a6d3b' : '';
  };
  cat.addEventListener('change', () => { syncCaliberVisibility(); syncCatHint(); });
  syncCatHint();
  const est = el('select', {}, [
    el('option', { value: '', text: '不估算' }),
    ...EST_OPTIONS.map(o => el('option', { value: o.value, text: o.label })),
  ]);
  const estHint = el('div', { class: 'hint', style: 'margin-top:4px', text: 'A股·T+1·盘中按所选指数近似估算' });
  // 市场联动：QDII → 估算禁用并重置；A股 → 恢复可选
  market.addEventListener('change', () => {
    if (market.value === 'QDII') {
      est.value = '';
      est.disabled = true;
      estHint.textContent = 'QDII·T+2·无盘中估算（净值为准）';
    } else {
      est.disabled = false;
      estHint.textContent = 'A股·T+1·盘中按所选指数近似估算';
    }
    syncCaliberVisibility();   // 市场变化时同步口径默认值（QDII + 宽基 → us）
  });
  const msg = el('div', { class: 'hint', style: 'margin-top:6px;min-height:18px;white-space:normal;line-height:1.45' });
  const addBtn = el('button', { class: 'btn btn-primary', text: '添加基金' });

  /* —— 联想下拉：代码框外层 relative 定位，候选行 mousedown 选中（先于 blur，防点击丢失）—— */
  const codeWrap = el('div', { style: 'position:relative' }, [code]);
  const listEl = el('div', { style: 'display:none;position:absolute;top:100%;left:0;right:0;z-index:30;background:#fff;border:1px solid #ccc;border-top:none;max-height:230px;overflow:auto;box-shadow:0 4px 10px rgba(0,0,0,.15)' });
  codeWrap.appendChild(listEl);
  let _items = [], _activeIdx = -1;

  function showMsg(text, color) { msg.textContent = text; msg.style.color = color || '#888'; }
  function isDuplicate(v) { return readFunds(store.getState()).some(f => f.code === v); }
  function closeList() { listEl.style.display = 'none'; listEl.innerHTML = ''; _items = []; _activeIdx = -1; }
  function renderList(items, activeIdx) {
    _items = items; _activeIdx = activeIdx;
    listEl.innerHTML = '';
    if (!items.length) { listEl.style.display = 'none'; return; }
    items.forEach((it, i) => {
      const mk = marketOfType(it[2]);
      const row = el('div', { style: 'padding:6px 10px;cursor:pointer;display:flex;gap:8px;align-items:center;border-bottom:1px solid #f0f0f0;' + (i === activeIdx ? 'background:#eef3fb;' : '') });
      row.append(
        el('span', { style: 'font-weight:600;min-width:72px', text: it[0] }),
        el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: it[1] }),
        el('span', { style: 'font-size:12px;color:#666;white-space:nowrap', text: it[2] || '' }),
        el('span', { style: 'font-size:11px;padding:1px 6px;border-radius:3px;white-space:nowrap;' + (mk === 'QDII' ? 'background:#fdeaea;color:#c0392b;' : 'background:#e8f5e9;color:#1e7e34;'), text: mk })
      );
      row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(it); });
      row.addEventListener('mouseenter', () => renderList(_items, i));
      listEl.appendChild(row);
    });
    listEl.style.display = 'block';
  }
  function pick(it) { closeList(); code.value = it[0]; fillMeta(it[0], it[1], it[2], 'list'); updateGuard(it[0]); }

  // 防错闸：重复 → 红字 + 禁用按钮；空输入清消息
  function updateGuard(v) {
    if (isDuplicate(v)) { showMsg('⚠ 该基金已在持仓，不能重复添加', '#c0392b'); addBtn.disabled = true; return; }
    addBtn.disabled = false;
    if (!v) showMsg('');
  }

  // L1 自动带出：名称(覆盖保护)/市场(触发估算联动)/类别 + 跟踪指数
  let autoTrack = null;      // 当前解析出的 trackIndex（后端档案精确给出，或 INDEX_HINTS 兜底），提交时随 addFund 落库
  let autoAnchorNote = '';   // 估值锚提示：跟踪了指数但我们没有估值源 → 判定会降级
  function fillMeta(c, n, t, source, meta) {
    if (name.value === '' || name.value === _lastAutoName) { name.value = n || ''; _lastAutoName = n || ''; }
    const mk = marketOfType(t);
    if (market.value !== mk) { market.value = mk; market.dispatchEvent(new Event('change')); }
    autoAnchorNote = '';
    // 类别：后端的建议是**确定值**（来自东财 FTYPE；红利类还会被跟踪指数身份覆盖），优先用它。
    // ★ 拿不到确定建议时**不预选、不猜** —— 旧实现一律兜成「主题·行业」，会把债基/消费基金
    //   套上"60日回撤抄底"算法算出一个看起来正常的错结论（不报错，最危险）。
    if (!cat.value) {
      const sug = (meta && meta.suggestedCategory) || suggestCategory(n || '');
      if (sug) {
        cat.value = sug;
        if (meta && meta.suggestedPending) showMsg('已识别为「' + sug + '」类 —— 该类别算法待建设，先只记市值、不出买卖信号', '#8a6d3b');
        else showMsg('已自动选好类别（可改）' + (meta && meta.suggestedBy === 'index' ? '：按跟踪指数判定' : ''), '#888');
      } else {
        showMsg('未能自动识别类别，请手动选择 —— 选错会套错算法，而且不会报错', '#c0392b');
      }
    }
    // 跟踪指数：后端档案 INDEXCODE 精确映射优先，INDEX_HINTS 仅作最后兜底
    autoTrack = (meta && meta.trackIndex) || null;
    const hint = INDEX_HINTS.find(h => h.re.test(n || ''));
    if (!autoTrack && hint) autoTrack = hint.trackIndex || null;
    if (hint && hint.est && !est.value && market.value === 'A') est.value = hint.est;
    if (meta && meta.indexName && !meta.trackIndex) {
      autoTrack = null;
      autoAnchorNote = '该基金跟踪「' + meta.indexName + '」，但我们没有它的指数估值源 → 判定会降级为价格分位（不会给加仓信号）';
      showMsg(autoAnchorNote, '#8a6d3b');
    } else if (autoTrack) {
      showMsg('已自动带入跟踪指数：' + autoTrack + '（估值锚可用）', '#888');
    }
    syncCaliberVisibility();   // 类别/预选变化后同步「口径」栏的显隐与默认值
    syncCatHint();
  }

  // 6 位精确查询：本地名单优先，miss → /api/fund-lookup（B 兜底）
  async function lookupExact(v) {
    const rows = await ensureFundList();
    if (code.value !== v) return;
    const local = rows && rows.find(r => r[0] === v);
    if (local) {
      // 本地名单只有 [code,name,type]，**没有**跟踪指数与确定类别 —— 那些要问后端档案。
      // 非阻塞补齐：失败不影响继续添加，用户仍可手选。
      fillMeta(v, local[1], local[2], 'list', null);
      api.getFundLookup(v).then(d => {
        if (code.value !== v || !d || !d.ok || !d.found) return;
        fillMeta(v, d.name || local[1], d.type || local[2], 'archive', d);
      }).catch(() => { /* 档案不可用时静默，不影响添加 */ });
      updateGuard(v); return;
    }
    let d = null;
    try { d = await api.getFundLookup(v); } catch (e) { d = null; }
    if (code.value !== v) return; // 过期响应丢弃
    if (d && d.ok && d.found && d.name) { fillMeta(v, d.name, d.type || '', (d.source || 'suggest'), d); }
    else { showMsg('未匹配到该代码，可手动填写', '#c0392b'); }
    updateGuard(v);
  }

  // 单一防抖输入流（审查修订 P0：联想与带出不再双定时器竞态）
  let timer = null;
  code.addEventListener('input', () => {
    clearTimeout(timer);
    const v = code.value.trim();
    closeList();
    updateGuard(v);
    if (v === '' || !/^\d+$/.test(v)) return;
    if (v.length < 6) {
      if (!addBtn.disabled) showMsg(''); // 清掉上一条成功提示，避免残留
      timer = setTimeout(async () => {
        if (code.value.trim() !== v) return;
        const rows = await ensureFundList();
        if (!rows || code.value.trim() !== v) return;
        const st = rows.filter(r => r[0].startsWith(v));
        const rest = st.length < 8 ? rows.filter(r => r[0].indexOf(v) !== 0 && (r[1] || '').includes(v)) : [];
        renderList(st.concat(rest).slice(0, 8), 0);
      }, 150);
    } else if (v.length === 6 && !isDuplicate(v)) {
      timer = setTimeout(() => { if (code.value.trim() === v) lookupExact(v); }, 150);
    }
  });
  code.addEventListener('keydown', (e) => {
    if (!_items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); renderList(_items, (_activeIdx + 1) % _items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); renderList(_items, (_activeIdx - 1 + _items.length) % _items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); if (_items[_activeIdx]) pick(_items[_activeIdx]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeList(); }
  });
  code.addEventListener('blur', () => setTimeout(closeList, 150)); // 兜底：mousedown 已先行选中

  const addBtnHandler = () => {
    if (!code.value.trim() || !name.value.trim()) { alert('请填写代码和名称'); return; }
    if (!cat.value) { alert('请选择类别'); return; } // 杜绝 core/空串落库
    if (isDuplicate(code.value.trim())) { alert('该基金已存在'); return; }
    const opt = EST_OPTIONS.find(o => o.value === est.value) || null;
    addFund(code.value.trim(), name.value.trim(), cat.value, market.value, opt ? opt.value : null, opt ? opt.label : null,
      cat.value === 'broad' ? cal.value : null, autoTrack);
  };
  addBtn.addEventListener('click', addBtnHandler);

  const p = el('div', { class: 'panel' });
  p.appendChild(el('div', { class: 'panel-head' }, [el('span', { text: '添加基金' })]));
  p.appendChild(el('div', { style: 'margin-top:8px;display:grid;gap:10px;grid-template-columns:1fr 1fr' }, [
    labeled('代码', codeWrap), labeled('名称', name),
    el('div', { class: 'field' }, [el('label', { text: '类别' }), cat, catHint]),
    labeled('市场', market), calField,
  ]));
  p.appendChild(msg);
  p.appendChild(labeled('盘中估算指数', est));
  p.appendChild(estHint);
  p.appendChild(el('div', { class: 'btn-row' }, [addBtn]));

  // —— 批量添加（2026-09-12）：粘贴多行「代码 [金额]」→ 解析预览 → 确认写入 ——
  const bulkTa = el('textarea', { class: 'input', rows: '5', placeholder: '每行一条：6位代码 [日期] [金额]（日期与金额可各自省略、顺序不限）\n例：\n016452 2026-09-01 1000\n270042\n161725 500元\n202015 1000（无日期=今天）' });
  const bulkMsg = el('div', { class: 'hint', style: 'margin-top:6px;white-space:pre-line;line-height:1.5' });
  const bulkPreview = el('div', {});
  const bulkParseBtn = el('button', { class: 'btn', text: '解析预览' });
  const bulkCommitBtn = el('button', { class: 'btn btn-primary', text: '确认写入', style: 'margin-left:6px' });
  bulkCommitBtn.style.display = 'none';
  let _bulkRows = [];
  bulkParseBtn.addEventListener('click', async () => {
    bulkMsg.textContent = '解析中…';
    bulkPreview.innerHTML = '';
    bulkCommitBtn.style.display = 'none';
    const items = await parseBulkRows(bulkTa.value);
    if (!items.length) { bulkMsg.textContent = '没有可解析的行。'; return; }
    _bulkRows = items;
    renderBulkPreview(bulkPreview, items);
    const errs = items.filter(x => x.err).length;
    bulkCommitBtn.style.display = '';
    bulkCommitBtn.disabled = errs === items.length; // 全错时禁写
    bulkMsg.textContent = errs
      ? ('⚠ ' + errs + ' 行有错（标红），修正后重新解析，或直接写入其余正确行。')
      : '解析完成，确认无误后点「确认写入」。';
  });
  bulkCommitBtn.addEventListener('click', async () => {
    bulkCommitBtn.disabled = true;
    bulkMsg.textContent = '写入中…';
    const report = await commitBulkRows(_bulkRows);
    bulkTa.value = '';
    bulkPreview.innerHTML = '';
    bulkCommitBtn.style.display = 'none';
    bulkMsg.textContent = report.join('\n');
  });
  p.appendChild(el('details', { style: 'margin-top:10px' }, [
    el('summary', { style: 'cursor:pointer;font-weight:600', text: '批量添加（粘贴多行「代码 金额」）' }),
    el('div', { style: 'margin-top:8px' }, [
      bulkTa,
      el('div', { class: 'btn-row', style: 'margin-top:6px' }, [bulkParseBtn, bulkCommitBtn]),
      bulkPreview,
      bulkMsg,
    ]),
  ]));
  return p;
}

/* ---------- 入口 ---------- */
export async function render(root) {
  _root = root;
  _mobile = window.matchMedia('(max-width: 760px)').matches;
  const live = store.getLive();
  const state = store.getState();
  root.innerHTML = '';
  if (window.matchMedia('(max-width: 760px)').matches) {
    renderMobile(root, live, state);
  } else {
    renderDesktop(root, live, state);
  }
}

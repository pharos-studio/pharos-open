'use strict';
/*
 * 基金费率同步引擎
 * ------------------------------------------------------------
 * 职责：把「申购费 / 认购费 / 赎回费档 / 运作费（管理费·托管费·销售服务费）」从数据源抓下来，
 * 写进 holdings.json 的**基金对象**（不是买入记录）：申购费折后价写进 feeRate 这个算法读的标量，
 * 全部分档原文写进 feeDetail 供展示与将来的成本比较。
 *
 * ── 为什么需要一个独立引擎 ──
 * 费率是**基金属性**，不是用户输入：用户在不同渠道买同一只基金，费率折扣可能不同，
 * 但基金本身的费率档位是公开事实。把它交给界面手填，必然出现「口径随手改、成本算错还查不出」。
 * 故本模块是 feeRate / feeDetail 的**唯一写入方**：/api/save 写盘前会用磁盘值把前端回传的
 * 费率字段盖回去（见 server.js 的 pinFundFees），界面因此没有任何修改入口。
 *
 * ── 触发点（四处，都是幂等的）──
 *   1. 服务启动后延迟跑一次（不阻塞监听，见 scheduleFeeSync）
 *   2. 每 24 小时一次定时
 *   3. /api/save 检测到「新增基金」后立刻一次（只抓新代码，避免新基金等到下一个周期）
 *   4. /api/fees/refresh 手动强制一次
 *
 * ── 设计约束 ──
 *   · 有效期 30 天：费率调整必须公告、变化极少，过期前不重抓（省请求，也避免抖动）；
 *   · 单只失败不影响其他；抓不到时**保留原值**，绝不把已有费率抹成 0（0 是"免费"的语义）；
 *   · 写回是「读整份 → 改字段 → 写整份」，绝不新建文件、绝不替换 purchases，避免互相覆盖；
 *   · in-flight 锁 + dirty 重跑标记：并发调用不重复抓，且期间新增的基金不会漏到下一个周期。
 *
 * ★★ 与收益口径的关系（别踩的坑）：费率**不会**改写已确认的买入记录。
 *   analysis.js 的净投入对「已确认（有 shares + nav）」的记录直接取 shares × nav（券商真值），
 *   只有「在途（shares 未确认）」才用 amount ÷ (1 + effectiveRate) 预估。
 *   ⇒ 补齐费率不会凭空改写历史盈亏，只影响将来记新一笔时的份额推导与在途预估。
 */
const store = require('../lib/store');
const util = require('../lib/util');
const fetchers = require('../fetchers');

const RATE_TTL = 30 * 24 * 3600 * 1000;
const STATUS_TTL = 24 * 3600 * 1000;
const SRC_TAG = 'eastmoney';

let running = false;          // in-flight 锁
let pendingCodes = new Set(); // 跑动期间新来的「只抓这些」请求，跑完补一轮
let pendingAll = false;       // 跑动期间新来的「全量」请求

function freshEnough(detail) {
  return !!(detail && detail.updatedAt && (Date.now() - detail.updatedAt) < RATE_TTL);
}
function statusFresh(status) {
  return !!(status && status.updatedAt && (Date.now() - status.updatedAt) < STATUS_TTL);
}
function normalizePurchaseStatus(r, updatedAt) {
  const raw = r && r.sgState != null ? String(r.sgState) : null;
  let state = 'unknown';
  if (raw && /暂停|封闭|终止|不可申购|停止/.test(raw)) state = 'suspended';
  else if (raw && /限|额度/.test(raw)) state = 'limited';
  else if (raw && /开放|正常|可申购/.test(raw)) state = 'open';
  const rawMax = r && r.maxBuyRaw != null ? String(r.maxBuyRaw) : '';
  const numericMax = r && Number(r.maxBuy);
  const unlimited = /不限|无限|--/.test(rawMax) || (Number.isFinite(numericMax) && numericMax >= 100000000000);
  return {
    state, raw, maxBuy: state === 'suspended' || unlimited ? null : (r && r.maxBuy || null),
    unlimited: state === 'suspended' ? false : unlimited,
    updatedAt,
  };
}

function isFundCode(v) { return /^\d{6}$/.test(String(v == null ? '' : v).trim()); }

// 单轮：挑出「该抓的」基金 → 抓 → 写回。返回 { ok, checked, updated, failed, changed }。
async function runOnce(o) {
  const holdings = store.readJSON('holdings.json');
  if (!holdings || !Array.isArray(holdings.funds)) {
    return { ok: false, checked: 0, updated: 0, failed: 0, error: 'holdings.json 结构异常' };
  }
  const want = new Set((Array.isArray(o.codes) ? o.codes : []).map(String));
  const targets = holdings.funds.filter((f) => {
    if (!f || !isFundCode(f.code)) return false;
    if (want.size && !want.has(String(f.code))) return false;
    return o.force === true || !freshEnough(f.feeDetail) || !statusFresh(f.purchaseStatus);
  });
  if (!targets.length) return { ok: true, checked: 0, updated: 0, failed: 0, changed: false, codes: [] };

  // 并行抓（全局并发闸门在 lib/http 内，默认 6，不会打爆数据源）；单只失败只计失败数
  const got = await Promise.all(targets.map(async (f) => ({ f, r: await fetchers.fetchFundRates(f.code) })));

  const now = Date.now();
  const day = util.todayStr();
  const updatedCodes = [];
  let failed = 0;
  const patches = [];
  for (const it of got) {
    if (!it.r) { failed++; continue; }   // 抓不到 → 不写 feeDetail（下次重试），feeRate 保持原值
    patches.push({
      code: String(it.f.code), result: it.r,
      updateRate: o.force === true || !freshEnough(it.f.feeDetail),
      updateStatus: o.force === true || !statusFresh(it.f.purchaseStatus),
    });
    updatedCodes.push(it.f.code);
  }
  if (!updatedCodes.length) {
    return { ok: true, checked: targets.length, updated: 0, failed, changed: false };
  }
  const saved = await store.withFileLocks(['holdings.json'], async () => {
    const latest = store.readJSON('holdings.json');
    if (!latest || !Array.isArray(latest.funds)) return false;
    const byCode = new Map(latest.funds.filter(Boolean).map((f) => [String(f.code), f]));
    for (const patch of patches) {
      const f = byCode.get(patch.code);
      if (!f) continue;
      if (patch.updateRate) {
        const d = Object.assign({}, patch.result, { src: SRC_TAG, updatedAt: now, updated: day });
        f.feeDetail = d;
        if (patch.result.sub && patch.result.sub.rate != null) f.feeRate = patch.result.sub.rate;
      }
      if (patch.updateStatus) f.purchaseStatus = normalizePurchaseStatus(patch.result, now);
    }
    return store.writeJSONSafe('holdings.json', latest);
  });
  if (!saved) {
    return { ok: false, checked: targets.length, updated: 0, failed, error: 'write failed (file locked by OneDrive/杀软?)' };
  }
  return { ok: true, checked: targets.length, updated: updatedCodes.length, failed, changed: true, codes: updatedCodes };
}

// 对外入口。opts: { codes?: string[]（只处理这些）, force?: boolean（无视有效期） }
// ★ 并发语义：第二次调用不会打断也不排队等待，只把「要处理的代码」记下来，让在跑的那轮补做一遍 ——
//   这样新增基金无需等满一个 24 小时周期，也不会有两个 sync 同时写 holdings.json。
async function syncFundFees(opts) {
  const o = Object.assign({}, opts);
  if (running) {
    if (Array.isArray(o.codes)) for (const c of o.codes) pendingCodes.add(String(c));
    else pendingAll = true;
    return { ok: true, skipped: 'in-flight', checked: 0, updated: 0, failed: 0 };
  }
  running = true;
  const total = { ok: true, checked: 0, updated: 0, failed: 0, changed: false, codes: [] };
  try {
    const firstOpts = o;
    let nextOpts = { codes: o.codes };
    let round = 0;
    do {
      pendingCodes.clear();
      pendingAll = false;
      const r = await runOnce(round === 0 ? firstOpts : nextOpts);   // 第二轮起不再 force（首轮已刷完）
      round++;
      total.checked += r.checked;
      total.updated += r.updated;
      total.failed += r.failed;
      total.changed = total.changed || r.changed;
      if (r.codes && r.codes.length) total.codes = total.codes.concat(r.codes);
      if (!r.ok) {
        total.ok = false;
        total.error = r.error;
        break;   // 结构异常 / 写盘失败：不再空转第二轮
      }
      nextOpts = pendingAll ? {} : { codes: Array.from(pendingCodes) };
    } while (pendingAll || pendingCodes.size);
    return total;
  } catch (e) {
    return Object.assign(total, { ok: false, error: (e && e.message) || String(e) });
  } finally {
    running = false;
    pendingCodes.clear();
    pendingAll = false;
  }
}

module.exports = { syncFundFees, RATE_TTL, STATUS_TTL, normalizePurchaseStatus, statusFresh };

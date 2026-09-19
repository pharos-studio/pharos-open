'use strict';
/*
 * 跟踪指数与「基金 → 策略线」自动归类 —— 本项目唯一的「估值锚 / 类别推断」口径（唯一真相源）。
 *
 * ── 为什么要有这个文件 ──
 * 旧的类别推断散在前端（public/js/pages/holdings.js 的 suggestCategory / INDEX_HINTS），
 * 只认识作者当时手上那几只基金的名字，兜底一律 `return 'growth'`。后果是用户加一只债基或
 * 医药基金，会被静默归到「主题·行业」线并套错算法算出一个看起来正常的错结论（不报错）。
 * 现在改成：由东方财富的基金档案给出 **FTYPE（基金类型）**，这是可枚举的确定值，不再靠猜。
 *
 * ── 两个概念必须分清（这是本项目最容易踩的坑）──
 *   trackIndex        「这只基金跟踪什么指数」，一个**记录性**字段，任何基金都可以有。
 *   usesIndexAnchor() 「这条策略线**能不能**用指数估值锚」，与基金无关，只由策略线决定。
 * 为什么必须分开：商品线（cycle）刻意不读指数 PE——analysis.js 里 `!f.trackIndex` 曾被
 * 当作「无指数估值 → 走价格分位弱信号」的判据。如果自动抓取给黄金基金填上 trackIndex
 * （东财确实会给「上海金」这种指数代码），那个判据会被误触发，商品线的行为就变了。
 * 所以：能不能用锚永远由**策略线**决定，绝不由「有没有抓到指数」决定。
 *
 * ★ 本文件在「数据机（私有仓）」与「开源版（公开仓）」两仓逐字节相同。
 */

// ── 一、支持「指数估值锚」的内部指数键 ──
// 键 = 本项目内部口径，必须与 backend/fetchers.js 的 DANJUAN_INDEX / LEGU_INDEX 对齐：
// source='legulegu' 的键要在 LEGU_INDEX 里；source='danjuan' 的键要在 DANJUAN_INDEX 里。
// ★ 往这里加键之前，先确认对应数据源真的取得到值，否则会给用户一个「填了但没用」的假锚。
const TRACK_INDEX = {
  SH000300: { name: '沪深300', source: 'legulegu', line: 'broad', caliber: 'cn' },
  SH000922: { name: '中证红利', source: 'danjuan', line: 'dividend' },
  CSI930955: { name: '红利低波50', source: 'danjuan', line: 'dividend' },
  NDX: { name: '纳斯达克100', source: 'danjuan', line: 'broad', caliber: 'us' },
  SH000993: { name: '全指信息', source: 'danjuan', line: 'growth' },
};

// ── 二、东方财富 INDEXCODE → 内部指数键 ──
// 只登记「真的取得到估值」的指数。**清单外的指数一律返回 null**，让该基金落到
// 「缺估值锚·降级」的显式提示上 —— 宁可告诉用户算不准，也不假装能算。
// 反例（故意不登记，会走降级）：创业板指 399006、中证医药100 000978、上海金 SHAU…
const INDEX_CODE_TO_TRACK = {
  '000300': 'SH000300',    // 沪深300
  '000922': 'SH000922',    // 中证红利
  '000993': 'SH000993',    // 全指信息
  'NDX100': 'NDX',         // 纳斯达克100
  // ★ 代理映射：标普中国A股大盘红利低波50 本身没有免费估值源，项目用中证红利低波
  //   （蛋卷 CSIH30269）作因子代理取股息率。这是**人工确认过的代理**，不是精确对应。
  'SPCLLHCP': 'CSI930955',
};

// ── 三、FTYPE（基金类型）→ 策略线 ──
// FTYPE 来自东财基金档案，是可枚举的确定值，例：
//   「指数型-股票」「指数型-海外股票」「指数型-其他」「混合型-偏股」「债券型-混合一级」
//   「货币型-普通货币」「QDII-指数」……
// 顺序敏感：越具体越靠前（偏债混合必须在通用「混合型」之前）。
// pending=true 表示该线**还没有决策算法**，看板会显示「待建设」而不是给结论。
const FUND_TYPE_RULES = [
  { re: /^货币型/, category: 'cash', pending: true },
  { re: /^债券型/, category: 'bond', pending: true },
  { re: /^混合型-(偏债|平衡|债券)/, category: 'bond', pending: true },
  { re: /^(指数型-海外|QDII-指数|QDII.*指数)/, category: 'broad', caliber: 'us' },
  { re: /^QDII/, category: 'broad', caliber: 'us' },
  { re: /^指数型-其他/, category: 'cycle' },          // 上海金、商品类指数
  { re: /^指数型/, category: 'broad', caliber: 'cn' },
  { re: /^混合型-(偏股|灵活)/, category: 'growth' },
  { re: /^混合型/, category: 'growth' },
  { re: /^股票型/, category: 'growth' },
  { re: /^FOF/, category: 'growth' },
];

// ── 四、名称兜底（拿不到 FTYPE 时才用；永远只是提示，不直接落库）──
const NAME_HINTS = [
  { re: /货币|现金宝|活期/, category: 'cash' },
  { re: /债券|纯债|信用债|利率债|可转债|双利|增利/, category: 'bond' },
  { re: /红利|低波|股息/, category: 'dividend' },
  { re: /黄金|上海金|白银|原油|豆粕|商品/, category: 'cycle' },
  { re: /纳斯达克|纳指|标普500|日经|恒生|道琼斯|德国DAX|法国CAC|海外/, category: 'broad', caliber: 'us' },
  { re: /沪深300|中证500|中证800|中证A500|中证1000|中证2000|上证50|上证180|创业板|科创|深证|中证100|全指/, category: 'broad', caliber: 'cn' },
];

// ── 五、策略线 ↔ 指数锚 的能力表 ──
// needsTrackIndex：这条线**没有**指数锚就会算不动（看板必须显式提示降级）。
//   宽基靠「该指数自己的 PE 分位 × ERP」、红利靠「相对中证红利 000922 的股息率带」，两者都缺不了。
// usesIndexAnchor：这条线**可以**用指数锚（有就用，没有也能跑）。
//   主题·行业线优先用指数 PE 分位，没有就退回自身净值的 250 日价格分位。
//   ★ 商品 / 债券 / 现金 永远返回 false —— 它们是「不读指数 PE」的线，见文件头说明。
const NEEDS_TRACK_INDEX = { broad: true, dividend: true };
const USES_INDEX_ANCHOR = { broad: true, dividend: true, growth: true };

function needsTrackIndex(category) {
  return NEEDS_TRACK_INDEX[category] === true;
}
function usesIndexAnchor(category) {
  return USES_INDEX_ANCHOR[category] === true;
}

// ── 六、对外函数 ──

// 东财档案里的 INDEXCODE / INDEXNAME → 内部指数键。两个都试，先代码后名称。
// 返回内部键字符串，或 null（表示「这个指数我们没有估值源」）。
function resolveTrackIndex(indexCode, indexName) {
  const code = normalizeArchiveValue(indexCode);
  if (code && INDEX_CODE_TO_TRACK[code]) return INDEX_CODE_TO_TRACK[code];
  const name = normalizeArchiveValue(indexName);
  if (name) {
    const hit = Object.keys(TRACK_INDEX).find(k =>
      TRACK_INDEX[k].name === name || name.indexOf(TRACK_INDEX[k].name) >= 0);
    if (hit) return hit;
  }
  return null;
}

// 由 FTYPE（优先）或名称推断策略线。返回 { category, caliber, pending, by } 或 null（未识别）。
// ★ by='type' 是确定值，by='name' 只是启发式 —— 调用方对 by='name' 必须让用户确认。
//
// ★ 第三参 trackKey：已经解析出的跟踪指数。**指数的身份比基金类型更具体，要让它覆盖 FTYPE。**
//   为什么必须这样：FTYPE 只会说「指数型-股票」，它分不出「红利指数」和「宽基指数」——
//   实测富国中证红利(000922) / 红利低波50(SPCLLHCP) 都会被 FTYPE 归成宽基，套错算法；
//   而中证红利、红利低波、全指信息的指数身份是明确的，应该由它决定策略线。
function suggestLine(ftype, name, trackKey) {
  let base = null;
  const t = normalizeArchiveValue(ftype);
  if (t) {
    for (const r of FUND_TYPE_RULES) {
      if (r.re.test(t)) {
        base = { category: r.category, caliber: r.caliber || null, pending: r.pending === true, by: 'type' };
        break;
      }
    }
  }
  if (!base) {
    const n = String(name || '');
    if (n) {
      for (const r of NAME_HINTS) {
        if (r.re.test(n)) {
          base = { category: r.category, caliber: r.caliber || null,
                   pending: r.category === 'bond' || r.category === 'cash', by: 'name' };
          break;
        }
      }
    }
  }
  if (!base) return null;
  // 指数身份覆盖（只覆盖"更具体"的那几条线，避免误伤）
  const idx = trackKey && TRACK_INDEX[trackKey];
  if (idx && idx.line && idx.line !== base.category) {
    const OVERRIDABLE = { dividend: true, growth: true, cycle: true };
    const fromGenericBroad = base.category === 'broad';
    if (fromGenericBroad && OVERRIDABLE[idx.line]) {
      return { category: idx.line, caliber: idx.caliber || null,
               pending: false, by: 'index', trackIndex: trackKey };
    }
  }
  return base;
}

// 东财档案里缺值是字符串 "--"（不是 null），必须当空处理，否则会被当成合法指数名去匹配。
function normalizeArchiveValue(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === '--' || s === '-' || s === '暂无') return null;
  return s;
}

// 给 /api/track-index 用的白名单（前端下拉选项）
function listTrackIndexes() {
  return Object.keys(TRACK_INDEX).map(k => ({
    key: k,
    name: TRACK_INDEX[k].name,
    line: TRACK_INDEX[k].line,
    caliber: TRACK_INDEX[k].caliber || null,
  }));
}

module.exports = {
  TRACK_INDEX, INDEX_CODE_TO_TRACK, FUND_TYPE_RULES, NAME_HINTS,
  needsTrackIndex, usesIndexAnchor,
  resolveTrackIndex, suggestLine, normalizeArchiveValue, listTrackIndexes,
};

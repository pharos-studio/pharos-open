'use strict';
// 数据访问层：持有单一 DATA_DIR，所有本地 JSON 读写为本模块职责。
// 其他引擎/路由统一经本模块读写，避免 DATA_DIR 散落多处。
const fs = require('fs');
const path = require('path');
const schema = require('./schema');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// ---------- 分区表（2026-09-17 起）----------
// 调用方一律只传「裸文件名」，物理落在哪个子目录由本表决定 —— 调用点无需知道文件在哪。
// 以后调整目录结构只改这张表，不必全项目找路径。
// ★ 新增数据文件必须在此登记；未登记的会回退到 data/ 根并打印告警。
const LAYOUT = {
  // state/   运行状态：应用高频读写，是唯一「丢了找不回」的数据，务必备份
  'holdings.json': 'state',
  'history.json': 'state',
  'decision_history.json': 'state',
  'signals.json': 'state',
  'timing_state.json': 'state',
  'timing_samples.json': 'state',
  // 私有回归夹具：真实净值/份额/本金基线。只存在于数据机本地（.gitignore 已忽略，
  // 绝不入库、绝不被 publish.js 复制到公开仓）。公开仓没有它 → 相关断言自动 SKIP。
  'regression_cases.json': 'state',
  // config/  配置定义：人工维护，改前先备份
  'config.json': 'config',
  'categories.json': 'config',
  'theme_map.json': 'config',
  // cache/   派生缓存：删了下次自动重建，不入库
  'fundlist_cache.json': 'cache',
  'holdings_cache.json': 'cache',
  'stock_industry_cache.json': 'cache',
  // series/  自建时序序列：增量累积，删了要重新攒
  'yield_history.json': 'series',
  // example/ 脱敏模板：给「从零建一个新组合」的人起步用
  'holdings.example.json': 'example',
  'config.example.json': 'example',
};

// 裸文件名 → 绝对路径。带 `/` 或 `\` 的显式相对路径（如 'state/holdings.json'）直通，便于诊断。
function dataPath(file) {
  if (file.indexOf('/') >= 0 || file.indexOf('\\') >= 0) return path.join(DATA_DIR, file);
  const sub = LAYOUT[file];
  if (!sub) {
    console.warn('[store] 未登记的数据文件，回退到 data/ 根：', file);
    return path.join(DATA_DIR, file);
  }
  return path.join(DATA_DIR, sub, file);
}

// 写盘前确保分区目录存在（首次 clone、新增分区时必需）
function ensureParent(target) {
  try {
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) { /* 建目录失败交给后续写入如实报错，不吞掉真正的问题 */ }
}

// 非致命写入：同步目录(OneDrive/杀软)可能短暂锁文件，失败重试且不抛出
const nap = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
// 进程唯一后缀：多进程并发写同一文件时，避免共享 .tmp 互相覆盖
const _pidSuffix = '_' + process.pid + '_' + Date.now().toString(36) + '.tmp';

// 读：挂 schema 归一（只补业务缺省值；版本号不经此路径 —— 见 lib/schema.js 铁律 1/2）。
// 需要磁盘真值（迁移、字节级比对）时用 readJSONRaw。
function readJSON(file) {
  return schema.apply(file, JSON.parse(fs.readFileSync(dataPath(file), 'utf8')));
}
function readJSONRaw(file) {
  return JSON.parse(fs.readFileSync(dataPath(file), 'utf8'));
}
function writeJSON(file, obj) {
  schema.apply(file, obj); // 写路径也归一：第三方写入（/api/save、curl）不能洗掉约定字段
  const target = dataPath(file);
  ensureParent(target);
  fs.writeFileSync(target, JSON.stringify(obj, null, 2), 'utf8');
}
function writeJSONSafe(file, obj, retries = 4) {
  schema.apply(file, obj); // 写路径也归一（同 writeJSON）
  const target = dataPath(file);
  ensureParent(target);
  const tmp = target + _pidSuffix;
  for (let i = 0; i <= retries; i++) {
    try {
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
      fs.renameSync(tmp, target); // 原子替换，缩小锁窗口，规避 Windows 文件锁竞态
      return true;
    } catch (e) {
      if (i < retries) nap(120);
      else console.warn('[write] 写入失败(已放弃):', file, '-', e.code || e.message);
    }
  }
  return false;
}

// ---------- 快照 ----------
function readHistory() {
  try { return readJSON('history.json'); } catch (e) { return []; }
}
// H1: 从 history.json 最新快照取某基金市值兜底（快照含 funds:[{code,value,principal}]）
function lastSnapshotFundValue(code) {
  const h = readHistory();
  for (let i = h.length - 1; i >= 0; i--) {
    const f = (h[i].funds || []).find(x => x.code === code);
    if (f && f.value != null && f.value > 0) return { value: f.value, date: h[i].date };
  }
  return null;
}
async function appendSnapshot(snap) {
  const h = readHistory();
  const last = h[h.length - 1];
  if (last && last.date === snap.date) {
    h[h.length - 1] = snap;
  } else {
    h.push(snap);
  }
  // 历史快照非致命：写不进（如被 OneDrive 锁住）只少一条曲线，不拖累整个看板
  writeJSONSafe('history.json', h);
}

// ---------- 决策快照（供复盘「每日」tab 的周对比）----------
function readDecisionHistory() {
  try { return readJSON('decision_history.json'); } catch (e) { return []; }
}
// 每次 am 刷新写一条逐基金决策快照（含 factors/verdict），保留近 35 天
function writeDecisionHistory(entry) {
  const h = readDecisionHistory();
  const last = h[h.length - 1];
  if (last && last.date === entry.date) {
    h[h.length - 1] = entry;
  } else {
    h.push(entry);
  }
  if (h.length > 35) h.splice(0, h.length - 35); // trim 超长（非致命，写不进只少一条）
  writeJSONSafe('decision_history.json', h);
  return true;
}

module.exports = { DATA_DIR, LAYOUT, dataPath, readJSON, readJSONRaw, writeJSON, writeJSONSafe, readHistory, lastSnapshotFundValue, appendSnapshot, readDecisionHistory, writeDecisionHistory };

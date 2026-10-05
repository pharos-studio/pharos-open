'use strict';
/*
 * 买入时机复盘模块 — 战役状态机 + 校准统计（design v2.8，内部设计文档，未随开源发布）
 *
 * 职责（只读评价系统自己的判定事件 × 客观净值，不碰金额/不碰用户买入的校准语义）：
 *   ① 战役状态机：advice.js am 决策刷新时喂 decMap → 判 open(hold→add)/close(add→hold 断链>gapDays)，
 *      战役化采样（连续喊话只记跃迁首日，防 T+30 窗口重叠伪重复）
 *   ② buy 幂等补扫：holdings.json purchases → buy 样本（仅「跟单成效」副视图，不进校准统计）
 *   ③ T+30 回填：fetchNavHistory → navRef{T,T30} + positive30 + d*（时机轴）
 *   ④ stats()：开口账命中率 / 收回账过早率 / 类别×判定路径诊断细分 / 弱强信号候选 / d* 分布 / 跟单成效
 *
 * 节律诚实声明（用户拍板：维持访问驱动，不加定时器）：
 *   - 决策只在你访问建议页时才重算 → 开口日 = 首次被记录日（可能晚于真实 L2 首日，统计标 approx）；
 *   - 收回日 closeDate ≈ 末次加仓日 + gapDays（容忍窗满那天），真实改口日不可知时标 approx；
 *   - 这两类偏差是本模块接受的设计偏差，统计输出带 sampling.approxNote。
 *
 * 文件：data/state/timing_state.json（状态机游标，单行/基金）+ data/state/timing_samples.json（样本池）
 * 修正候选只产出展示（status:pending），批准权永远在用户；引擎从不自动改 config.signals。
 */
const store = require('../lib/store');
const util = require('../lib/util');
const config = require('../lib/config');
const fetchers = require('../fetchers');
const DIVIDEND_VERSION = require('../lib/dividendTrend').VERSION;
const HS300_VERSION = require('../lib/hs300Signal').VERSION;
const {isHs300Route}=require('../lib/hs300Identity');
const NASDAQ_VERSION=require('../lib/nasdaqSignal').VERSION;
const {isNasdaqRoute}=require('../lib/nasdaqIdentity');
const ACTIVE_EQUITY_VERSION=require('../lib/activeEquitySignal').VERSION;
const {isActiveEquityRoute}=require('../lib/activeEquityIdentity');
const GOLD_VERSION=require('../lib/goldSignal').VERSION;
const {isGoldRoute}=require('../lib/goldIdentity');

const STATE_FILE = 'timing_state.json';
const SAMPLES_FILE = 'timing_samples.json';

// 类别中文（diagnosis 展示用）—— 与 registry.js 的 REGISTRY.label 保持一致（2026-09-21 对齐）
const CAT_LABEL = { tech: '主题·行业（高波动）', cycle: '商品·对冲', dividend: '红利·低波', broad: '宽基', growth: '主题·行业（高波动）', unknown: '未知' };

// ---------- 内部 IO（默认落 data/；测试可 _forTest 替换为内存） ----------
const defaultEnv = {
  today: () => util.todayStr(),
  read: (f) => { try { return store.readJSON(f); } catch (e) { return null; } }, // 缺失返回 null
  write: (f, obj) => { try { return store.writeJSONSafe(f, obj); } catch (e) { return false; } }
};
let env = Object.assign({}, defaultEnv);

function loadState() {
  const s = env.read(STATE_FILE);
  if (s && s.version === 1 && s.funds && typeof s.funds === 'object') return s;
  return { version: 1, baselineDate: null, funds: {} };
}
function saveState(state) { return env.write(STATE_FILE, state); }
function loadSamples() {
  const s = env.read(SAMPLES_FILE);
  return Array.isArray(s) ? s : [];
}
function saveSamples(arr) { return env.write(SAMPLES_FILE, arr); }

// ---------- 小工具 ----------
// ★ 日历日加减必须用 UTC 锚点 + UTC getter：用本机时区 getter 会随进程时区漂移
//   （东八区恰好正确、UTC 下整体早一天）。同规则见 lib/tradeDate.js 顶部说明。
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
function gapDaysOf(cfg) {
  const t = (cfg && cfg.timing) || {};
  return t.gapDays != null ? t.gapDays : 3;
}
function params(cfg) {
  const t = (cfg && cfg.timing) || {};
  return {
    holdDays: t.holdDays != null ? t.holdDays : 30,
    previewDays: Array.isArray(t.previewDays) ? t.previewDays : [5, 10],
    gapDays: gapDaysOf(cfg),
    weakN: t.weakN != null ? t.weakN : 5,
    strongN: t.strongN != null ? t.strongN : 10,
    strongHitRate: t.strongHitRate != null ? t.strongHitRate : 0.65,
    historyStart: t.historyStart || '2026-09-01'
  };
}

// 按类别收 matrix 精简子集（判定路径，供诊断分组；捕获时冻结，不回放依赖现 config）
function pickPath(matrix) {
  const m = matrix || {};
  const type = m._type || 'unknown';
  if(m.strategyVersion===GOLD_VERSION)return {strategyVersion:GOLD_VERSION,route:m.route||null,marketState:m.marketState,pathStates:m.pathStates,conditions:JSON.parse(JSON.stringify(m.conditions||{})),buyOnly:true};
  if(m.strategyVersion===ACTIVE_EQUITY_VERSION)return {strategyVersion:ACTIVE_EQUITY_VERSION,route:m.route||null,marketState:m.marketState,
    pathStates:m.pathStates,conditions:JSON.parse(JSON.stringify(m.conditions||{})),buyOnly:true};
  if(m.strategyVersion===NASDAQ_VERSION)return {strategyVersion:NASDAQ_VERSION,route:m.route||null,marketState:m.marketState,
    pathStates:m.pathStates,conditions:JSON.parse(JSON.stringify(m.conditions||{}))};
  if(m.strategyVersion===HS300_VERSION) return {strategyVersion:HS300_VERSION,route:m.route||null,
    marketState:m.marketState,conditions:JSON.parse(JSON.stringify(m.conditions||{}))};
  if (type === 'dividendTrend') return {strategyVersion:DIVIDEND_VERSION,route:'trend',
    marketState:m.marketState,conditions:Object.assign({},m.conditions)};
  if (type === 'tech') {
    return {
      dipReady: !!m.dipReady, drawdown: m.drawdown != null ? +(+m.drawdown).toFixed(2) : null,
      goldenState: m.goldenState === true, stopFall: m.stopFall === true, gate: m.gate || 'pass'
    };
  }
  if (type === 'cycle') {
    return {
      pctZone: m.pctZone || 'na', trendWeak: m.trendWeak === true, stopFall: m.stopFall === true,
      surge: !!m.surge, gate: m.gate || 'pass'
    };
  }
  if (type === 'dividend') {
    return {
      yieldZone: m.yieldZone || 'na', maZone: m.maZone || 'na',
      ratio: m.ratio != null ? +m.ratio.toFixed(3) : null, gate: m.gate || 'pass'
    };
  }
  if (type === 'broad300') {
    return { caliber: 'hs300', marketState: m.marketState || 'insufficient',
      biasMa: m.biasMa || null, rsiPeriod: m.rsiPeriod || null };
  }
  if (type === 'broad') {
    // 宽基·海外（caliber=us）：字段与 A 股完全不同（两通道），必须自成一类，否则与 A 股样本混组、误导校准统计。
    // ★只在 us 分支加 caliber 键：A 股 path 保持原样 → groupKeyOf 生成的键不变，历史样本零影响。
    if (m._caliber === 'us') {
      return {
        caliber: 'us',
        cheapByPct: m.cheapByPct === true, cheapByDip: m.cheapByDip === true,
        peRollingPct: m.peRollingPct != null ? +(+m.peRollingPct).toFixed(1) : null,
        peDipLevel: m.peDipLevel != null ? +(+m.peDipLevel).toFixed(1) : null,
        erpZone: m.erpZone || 'na', trendWeak: m.trendWeak === true,
        stopFall: m.stopFall === true, gate: m.gate || 'pass'
      };
    }
    return {
      peZone: m.peZone || 'na', erpZone: m.erpZone || 'na', trendWeak: m.trendWeak === true,
      surge: !!m.surge, gate: m.gate || 'pass'
    };
  }
  return {};
}

// 判定路径 → 人类可读标签（诊断分组展示）
function pathLabelOf(category, p) {
  p = p || {};
  if(p.strategyVersion===GOLD_VERSION)return '黄金双路径 v1 · '+({A:'回撤修复',B:'趋势回踩',both:'双路径'})[p.route]+'（复权，费用未计；仅买入）';
  if(p.strategyVersion===NASDAQ_VERSION)return '纳指双通道 v1 · '+({draw:'回撤修复',trend:'趋势回踩',both:'双通道'})[p.route]+'（复权，费用未计）';
  if(p.strategyVersion===HS300_VERSION) return '沪深300双通道 v1 · '+({deep:'回撤修复',trend:'趋势回踩',both:'双通道'})[p.route]+'（复权，费用未计）';
  if (category === 'tech') {
    const chan = p.dipReady ? '深跌止跌' : '非深跌';
    const golden = p.goldenState ? '+金叉' : '+非金叉';
    const stop = p.stopFall ? '' : '·未止跌';
    return `${chan}${golden}${stop}${p.gate === 'block' ? '·总闸拦' : ''}`;
  }
  if (category === 'cycle') {
    const zoneTxt = { cheap: '便宜区', expensive: '贵区', neutral: '中性', na: '数据缺失' }[p.pctZone] || p.pctZone;
    const extra = p.trendWeak ? '·破半年线' : '';
    const stop = p.stopFall ? '+止跌' : '·未止跌';
    const surge = p.surge ? '·急涨拦' : '';
    return `${zoneTxt}${extra}${stop}${surge}${p.gate === 'block' ? '·总闸拦' : ''}`;
  }
  if (category === 'dividend') {
    if(p.strategyVersion===DIVIDEND_VERSION) return '红利趋势回踩 v1（复权，费用未计）';
    const zoneTxt = { cheap: '股息便宜', expensive: '股息贵', neutral: '股息中性', na: '数据缺失' }[p.yieldZone] || p.yieldZone;
    const ma = { below: '·跌破年线', above: '·年线上方', near: '·年线附近' }[p.maZone] || '';
    return `${zoneTxt}${ma}${p.gate === 'block' ? '·总闸拦' : ''}`;
  }
  if (category === 'broad') {
    if (p.caliber === 'hs300') return `沪深300·${({ waiting: '等待机会', observe: '机会观察', candidate: '候选可加仓', insufficient: '数据不足' })[p.marketState] || '数据不足'}`;
    // 海外口径：两通道表述（与 A 股「PE便宜/ERP低」不是一套语言，故不走下面的模板）
    // 旧样本无 caliber 键 → 不会命中本分支 → 历史标签零变化。
    if (p.caliber === 'us') {
      const ch1 = p.cheapByPct ? '滚动分位便宜' : '滚动分位不便宜';
      const ch2 = p.cheapByDip ? '+回撤到位' : '';
      const erp = p.erpZone === 'low' ? '·ERP低' : (p.erpZone === 'high' ? '·ERP高' : '');
      const extra = p.trendWeak ? '+破半年线' : '';
      const stop = p.stopFall === true ? '+止跌' : '';
      return `海外·${ch1}${ch2}${erp}${extra}${stop}${p.gate === 'block' ? '·总闸拦' : ''}`;
    }
    const zoneTxt = { cheap: 'PE便宜', expensive: 'PE贵', neutral: 'PE中性', na: 'PE缺失' }[p.peZone] || p.peZone;
    const erp = p.erpZone === 'low' ? '·ERP低' : (p.erpZone === 'high' ? '·ERP高' : '');
    const extra = p.trendWeak ? '+破半年线' : '';
    const stop = p.stopFall === true ? '+止跌' : '';
    return `${zoneTxt}${erp}${extra}${stop}${p.gate === 'block' ? '·总闸拦' : ''}`;
  }
  return JSON.stringify(p);
}
function groupKeyOf(category, p) {
  p = p || {};
  // ASCII 稳定键（跨 category 不会撞）
  const k = Object.keys(p).sort().map(kk => `${kk}=${typeof p[kk]==='object'?JSON.stringify(p[kk]):p[kk]}`).join('|');
  return `${category}|${k}`;
}

// ---------- ① 战役状态机 ----------
// decMap: { code: { action:'add'|'hold', name, category, matrix } }（am 会话收集）
// 返回 { opened, closed, extended } 计数（供冒烟/日志）
function onDecide(decMap, cfgOverride) {
  const cfg = cfgOverride || config.getConfig();
  const P = params(cfg);
  const today = env.today();
  const state = loadState();
  const samples = loadSamples();
  const beforeDividendSamples=samples.length;
  let changed = false;
  let opened = 0, closed = 0;

  const legacyCodes=Object.keys(decMap||{}).filter(code=>decMap[code]?.category!=='dividend'&&decMap[code]?.matrix?._type!=='dividend'&&decMap[code]?.matrix?._type!=='broad300'&&decMap[code]?.matrix?._type!=='nasdaq'&&decMap[code]?.matrix?._type!=='activeEquity'&&decMap[code]?.matrix?._type!=='goldDual'&&!isGoldRoute({code,name:decMap[code]?.name}));
  const redChanged=collectDividend(decMap,state,samples,today,P);
  const hsChanged=collectHs300(decMap,state,samples,today,P);
  const nasdaqChanged=collectNasdaq(decMap,state,samples,today,P);
  const activeChanged=collectActiveEquity(decMap,state,samples,today,P);
  const goldChanged=collectGold(decMap,state,samples,today,P);
  if (!legacyCodes.length && !redChanged && !hsChanged && !nasdaqChanged && !activeChanged && !goldChanged) return {opened:0,closed:0,baseline:false};
  const firstRun = legacyCodes.length>0 && !state.baselineDate;
  if (firstRun) state.baselineDate = today;

  for (const code of Object.keys(decMap || {})) {
    const d = decMap[code];
    if (!d || !d.matrix || !d.matrix._type) continue;
    // Disabled dividend rules cannot open/close campaigns, even from stale callers.
    if (d.unsupportedReason === 'rule_disabled' || d.category === 'dividend' || d.matrix._type === 'dividend' || d.matrix._type==='broad300'||d.matrix._type==='nasdaq'||d.matrix._type==='activeEquity'||d.matrix._type==='goldDual'||isGoldRoute({code,name:d.name})) continue;
    const action = d.action === 'add' ? 'add' : 'hold';
    const f = state.funds[code] || (state.funds[code] = { lastVerdict: null, campaignId: null, campaignOpenDate: null, lastAddDate: null, lastRun: null });
    if (f.lastRun === today) continue; // 同日重入免疫（同一天多次决策刷新不重复处理）
    const prevRun = f.lastRun;
    f.lastRun = today;
    changed = true;

    if (firstRun) {
      // 首采日只建基线（当天判定可能是上线前就持续的 add → 伪开口），不记样本
      f.lastVerdict = action;
      continue;
    }

    if (action === 'add') {
      if (!f.campaignId) {
        // ---- open：hold→add 跃迁，开新战役 ----
        const cid = `${code}#${today}`;
        const sample = {
          type: 'advice-open', code, name: d.name || code, category: d.category || 'unknown',
          eventDate: today,
          campaign: { id: cid, openDate: today },
          path: pickPath(d.matrix), backfill: 'pending', approx: false
        };
        samples.push(sample);
        f.campaignId = cid; f.campaignOpenDate = today; f.lastAddDate = today; f.lastVerdict = 'add';
        opened++;
      } else {
        // 续延（连续/断续 ≤gapDays 仍同战役）：只推末次 add 日，不记新样本
        f.lastAddDate = today; f.lastVerdict = 'add';
      }
    } else { // hold
      if (f.campaignId && f.lastAddDate) {
        const gap = util.daysBetween(f.lastAddDate, today);
        if (gap > P.gapDays) {
          // ---- close：add→hold 断链超过容忍窗 = 真收回 ----
          const closeDate = addDays(f.lastAddDate, P.gapDays); // 容忍窗满那天（近似真实改口日）
          const approx = !prevRun || util.daysBetween(prevRun, today) > 1; // 漏访 → 改口日更不可知
          const sample = {
            type: 'advice-close', code, name: d.name || code, category: d.category || 'unknown',
            eventDate: closeDate, approx: !!approx,
            campaign: { id: f.campaignId, openDate: f.campaignOpenDate, closeDate, days: util.daysBetween(f.campaignOpenDate, closeDate) },
            path: pickPath(d.matrix), // 收回依据（当天为什么喊停）；统计分组 join 战役 open path
            backfill: 'pending'
          };
          samples.push(sample);
          f.campaignId = null; f.campaignOpenDate = null; f.lastAddDate = null; f.lastVerdict = 'hold';
          closed++;
        }
        // gap ≤ gapDays：续延容忍，不动
      }
    }
  }

  saveState(state);
  saveSamples(samples);
  const redEvents=samples.slice(beforeDividendSamples).filter(s=>[DIVIDEND_VERSION,HS300_VERSION,NASDAQ_VERSION,ACTIVE_EQUITY_VERSION,GOLD_VERSION].includes(s.strategyVersion));
  return { opened:opened+redEvents.filter(s=>s.type==='advice-open').length,
    closed:closed+redEvents.filter(s=>s.type==='advice-close').length, baseline: firstRun };
}

// Version-owned state: legacy fund cursors are never reused or closed by rollout.
function collectHs300(decMap,state,samples,today,P) {
  let changed=false;
  for(const [code,d] of Object.entries(decMap||{})) {
    if(d.strategyVersion!==HS300_VERSION || d.matrix?.strategyVersion!==HS300_VERSION ||
      !['add','hold'].includes(d.action) || d.unsupported || d.blockedReason || d.matrix.dataError)continue;
    state.strategyFunds=state.strategyFunds||{};
    const ns=state.strategyFunds[HS300_VERSION]||(state.strategyFunds[HS300_VERSION]={});
    let f=ns[code];
    if(!f){ns[code]={baselineDate:today,lastRun:today,lastVerdict:d.action,campaignId:null};changed=true;continue;}
    if(f.lastRun===today)continue;
    const prev=f.lastRun;f.lastRun=today;changed=true;
    const sample=type=>({type,code,name:d.name||code,category:'broad',strategyVersion:HS300_VERSION,eventDate:today,
      approx:!prev||util.daysBetween(prev,today)>1,path:pickPath(d.matrix),metrics:d.matrix.metrics,
      signalNavDate:d.matrix.metrics?.navDate||null,orderDate:d.matrix.orderDate,backfill:'pending'});
    if(d.action==='add') {
      if(!f.campaignId&&f.lastVerdict==='hold') {
        const id=`${code}#${HS300_VERSION}#${today}`;
        samples.push({...sample('advice-open'),campaign:{id,openDate:today}});
        f.campaignId=id;f.campaignOpenDate=today;
      }
      f.lastVerdict='add';f.lastAddDate=today;
    }else {
      if(f.campaignId&&util.daysBetween(f.lastAddDate,today)>P.gapDays) {
        // The first observed valid hold closes today; never fabricate a transition during interruption.
        samples.push({...sample('advice-close'),campaign:{id:f.campaignId,openDate:f.campaignOpenDate,closeDate:today,
          days:util.daysBetween(f.campaignOpenDate,today)}});
        f.campaignId=null;f.campaignOpenDate=null;f.lastAddDate=null;
      }
      if(!f.campaignId)f.lastVerdict='hold';
    }
  }
  return changed;
}
function collectNasdaq(decMap,state,samples,today,P) {
  let changed=false;
  for(const [code,d] of Object.entries(decMap||{})) {
    if(d.strategyVersion!==NASDAQ_VERSION || d.matrix?.strategyVersion!==NASDAQ_VERSION ||
      !['add','hold'].includes(d.action) || d.unsupported || d.blockedReason || d.matrix.dataError||d.matrix.futureOrder)continue;
    state.strategyFunds=state.strategyFunds||{};
    const ns=state.strategyFunds[NASDAQ_VERSION]||(state.strategyFunds[NASDAQ_VERSION]={});
    let f=ns[code];
    if(!f){ns[code]={baselineDate:today,lastRun:today,lastVerdict:d.action,campaignId:null};changed=true;continue;}
    if(f.lastRun===today)continue;
    const prev=f.lastRun;f.lastRun=today;changed=true;
    const sample=type=>({type,code,name:d.name||code,category:'broad',strategyVersion:NASDAQ_VERSION,eventDate:today,
      approx:!prev||util.daysBetween(prev,today)>1,path:pickPath(d.matrix),metrics:d.matrix.metrics,
      signalNavDate:d.matrix.metrics?.navDate||null,orderDate:d.matrix.orderDate,computedAt:d.matrix.computedAt,
      sourceHash:d.matrix.sourceHash,actionHash:d.matrix.actionHash,peHash:d.matrix.peHash,inputVersion:d.matrix.inputVersion,backfill:'pending'});
    if(d.action==='add') {
      if(!f.campaignId&&f.lastVerdict==='hold') {
        const id=`${code}#${NASDAQ_VERSION}#${today}`;
        samples.push({...sample('advice-open'),campaign:{id,openDate:today}});
        f.campaignId=id;f.campaignOpenDate=today;
      }
      f.lastVerdict='add';f.lastAddDate=today;
    }else {
      if(f.campaignId&&util.daysBetween(f.lastAddDate,today)>P.gapDays) {
        // The first observed valid hold closes today; never fabricate a transition during interruption.
        samples.push({...sample('advice-close'),campaign:{id:f.campaignId,openDate:f.campaignOpenDate,closeDate:today,
          days:util.daysBetween(f.campaignOpenDate,today)}});
        f.campaignId=null;f.campaignOpenDate=null;f.lastAddDate=null;
      }
      if(!f.campaignId)f.lastVerdict='hold';
    }
  }
  return changed;
}
function collectGold(decMap,state,samples,today,P){
  // Caller snapshots can outlive rollback: the current gate owns collection.
  if(require('../data/goldIdentity.json').releaseEnabled!==true)return false;
  let changed=false;for(const [code,d] of Object.entries(decMap||{})){
    if(d.strategyVersion!==GOLD_VERSION||d.matrix?.strategyVersion!==GOLD_VERSION||!d.matrix.releaseEnabled||!['add','hold'].includes(d.action)||d.unsupported||d.blockedReason||d.matrix.dataError||d.matrix.futureOrder)continue;
    state.strategyFunds=state.strategyFunds||{};const ns=state.strategyFunds[GOLD_VERSION]||(state.strategyFunds[GOLD_VERSION]={});let f=ns[code];
    if(!f){ns[code]={baselineDate:today,lastRun:today,lastVerdict:d.action,campaignId:null};changed=true;continue;}if(f.lastRun===today)continue;const prev=f.lastRun;f.lastRun=today;changed=true;
    const sample=type=>({type,code,name:d.name||code,category:d.category||'cycle',strategyVersion:GOLD_VERSION,eventDate:today,approx:!prev||util.daysBetween(prev,today)>1,path:pickPath(d.matrix),metrics:d.matrix.metrics,signalNavDate:d.matrix.metrics?.navDate||null,orderDate:d.matrix.orderDate,computedAt:d.matrix.computedAt,sourceHash:d.matrix.sourceHash,actionHash:d.matrix.actionHash,inputVersion:d.matrix.inputVersion,backfill:'pending',buyOnly:true,returnBasis:'复权回填待核验；信号结束不构成赎回指令'});
    if(d.action==='add'){if(!f.campaignId&&f.lastVerdict==='hold'){const id=`${code}#${GOLD_VERSION}#${today}`;samples.push({...sample('advice-open'),campaign:{id,openDate:today}});f.campaignId=id;f.campaignOpenDate=today;}f.lastVerdict='add';f.lastAddDate=today;}
    else{if(f.campaignId&&util.daysBetween(f.lastAddDate,today)>P.gapDays){samples.push({...sample('advice-close'),campaign:{id:f.campaignId,openDate:f.campaignOpenDate,closeDate:today,days:util.daysBetween(f.campaignOpenDate,today)}});f.campaignId=null;f.campaignOpenDate=null;f.lastAddDate=null;}if(!f.campaignId)f.lastVerdict='hold';}
  }return changed;
}
function collectActiveEquity(decMap,state,samples,today,P){
  let changed=false;for(const [code,d] of Object.entries(decMap||{})){
    if(d.strategyVersion!==ACTIVE_EQUITY_VERSION||d.matrix?.strategyVersion!==ACTIVE_EQUITY_VERSION||!['add','hold'].includes(d.action)||d.unsupported||d.blockedReason||d.matrix.dataError||d.matrix.futureOrder)continue;
    state.strategyFunds=state.strategyFunds||{};const ns=state.strategyFunds[ACTIVE_EQUITY_VERSION]||(state.strategyFunds[ACTIVE_EQUITY_VERSION]={});let f=ns[code];
    if(!f){ns[code]={baselineDate:today,lastRun:today,lastVerdict:d.action,campaignId:null};changed=true;continue;}if(f.lastRun===today)continue;const prev=f.lastRun;f.lastRun=today;changed=true;
    const sample=type=>({type,code,name:d.name||code,category:d.category||'growth',strategyVersion:ACTIVE_EQUITY_VERSION,eventDate:today,approx:!prev||util.daysBetween(prev,today)>1,path:pickPath(d.matrix),metrics:d.matrix.metrics,signalNavDate:d.matrix.metrics?.navDate||null,orderDate:d.matrix.orderDate,computedAt:d.matrix.computedAt,sourceHash:d.matrix.sourceHash,actionHash:d.matrix.actionHash,inputVersion:d.matrix.inputVersion,backfill:'pending',buyOnly:true,returnBasis:'复权回填待核验；信号结束不构成赎回指令'});
    if(d.action==='add'){if(!f.campaignId&&f.lastVerdict==='hold'){const id=`${code}#${ACTIVE_EQUITY_VERSION}#${today}`;samples.push({...sample('advice-open'),campaign:{id,openDate:today}});f.campaignId=id;f.campaignOpenDate=today;}f.lastVerdict='add';f.lastAddDate=today;}
    else{if(f.campaignId&&util.daysBetween(f.lastAddDate,today)>P.gapDays){samples.push({...sample('advice-close'),campaign:{id:f.campaignId,openDate:f.campaignOpenDate,closeDate:today,days:util.daysBetween(f.campaignOpenDate,today)}});f.campaignId=null;f.campaignOpenDate=null;f.lastAddDate=null;}if(!f.campaignId)f.lastVerdict='hold';}
  }return changed;
}
function collectDividend(decMap,state,samples,today,P) {
  let changed=false;
  for (const [code,d] of Object.entries(decMap||{})) {
    if (d?.strategyVersion!==DIVIDEND_VERSION || d.unsupported || !['add','hold'].includes(d.action) ||
      !['candidate','waiting'].includes(d.matrix?.marketState)) continue;
    state.strategyFunds=state.strategyFunds||{};
    const ns=state.strategyFunds[DIVIDEND_VERSION]||(state.strategyFunds[DIVIDEND_VERSION]={});
    let f=ns[code];
    if(!f) { ns[code]={baselineDate:today,lastRun:today,lastVerdict:d.action,campaignId:null};changed=true;continue; }
    if(f.lastRun===today) continue;
    const prev=f.lastRun;f.lastRun=today;changed=true;
    if(d.action==='add') {
      if(!f.campaignId && f.lastVerdict==='hold') {
        const id=`${code}#${DIVIDEND_VERSION}#${today}`;
        samples.push({type:'advice-open',code,name:d.name||code,category:'dividend',strategyVersion:DIVIDEND_VERSION,
          eventDate:today,approx:!prev||util.daysBetween(prev,today)>1,
          campaign:{id,openDate:today,closeDate:null},path:pickPath(d.matrix),metrics:d.matrix.metrics,
          signalNavDate:d.matrix.metrics?.navDate||null,orderDate:d.matrix.orderDate,
          executable:d.executable===true,blockedReason:d.blockedReason||null,backfill:'pending'});
        f.campaignId=id;f.campaignOpenDate=today;
      }
      f.lastVerdict='add';f.lastAddDate=today;
    } else {
      if(f.campaignId && util.daysBetween(f.lastAddDate,today)>P.gapDays) {
        const closeDate=addDays(f.lastAddDate,P.gapDays);
        samples.push({type:'advice-close',code,name:d.name||code,category:'dividend',strategyVersion:DIVIDEND_VERSION,
          eventDate:closeDate,approx:!prev||util.daysBetween(prev,today)>1,
          campaign:{id:f.campaignId,openDate:f.campaignOpenDate,closeDate,days:util.daysBetween(f.campaignOpenDate,closeDate)},
          path:pickPath(d.matrix),metrics:d.matrix.metrics,backfill:'pending'});
        f.campaignId=null;f.campaignOpenDate=null;f.lastAddDate=null;
      }
      if(!f.campaignId) f.lastVerdict='hold';
    }
  }
  return changed;
}

// ---------- ② buy 幂等补扫（仅执行记录，不进校准） ----------
// 读 holdings.json purchases；(code,date,amount) 去重幂等；落在战役窗口内 → attach campaignId
function buyScan(cfgOverride) {
  const cfg = cfgOverride || config.getConfig();
  const P = params(cfg);
  const today = env.today();
  const samples = loadSamples();
  const before = samples.length;
  const versionState=loadState().strategyFunds?.[DIVIDEND_VERSION]||{};
  const hsState=loadState().strategyFunds?.[HS300_VERSION]||{};
  const nasdaqState=loadState().strategyFunds?.[NASDAQ_VERSION]||{};
  const activeState=loadState().strategyFunds?.[ACTIVE_EQUITY_VERSION]||{};
  const goldState=loadState().strategyFunds?.[GOLD_VERSION]||{};
  const goldEnabled=require('../data/goldIdentity.json').releaseEnabled===true;

  const holdings = env.read('holdings.json'); // 默认读 data/；测试 _forTest 注入内存
  if (!holdings || !Array.isArray(holdings.funds)) return 0;

  // 现役战役窗口：open 样本 id → openDate；close 样本 → closeDate
  const campaignWin = {}; // id -> { openDate, closeDate|null, openEvent }
  const openIdx = {};     // code -> [campaign open sample]
  samples.filter(s => s.type === 'advice-open').forEach(s => {
    const id = s.campaign && s.campaign.id;
    if (!id) return;
    campaignWin[id] = { openDate: s.campaign.openDate, closeDate: null };
    (openIdx[s.code] = openIdx[s.code] || []).push(s);
  });
  samples.filter(s => s.type === 'advice-close').forEach(s => {
    const id = s.campaign && s.campaign.id;
    if (id && campaignWin[id]) campaignWin[id].closeDate = s.campaign.closeDate || s.eventDate;
  });

  const known = new Set(samples.filter(s => s.type === 'buy').map(s => `${s.code}|${s.eventDate}|${s.amt}`));
  let added = 0,pricingCompleted=0;

  for (const fund of holdings.funds) {
    const code = fund.code;
    if(isGoldRoute(fund)&&!goldEnabled)continue;
    const purchases = Array.isArray(fund.purchases) ? fund.purchases : [];
    for (const p of purchases) {
      if (!p || !p.date || !p.amount) continue;
      if(isNasdaqRoute(fund)&&p.date>today)continue;
      if(isActiveEquityRoute(fund)&&p.date>today)continue;
      if(isGoldRoute(fund)&&p.date>today)continue;
      const key = `${code}|${p.date}|${Math.round(p.amount * 100) / 100}`;
      if (known.has(key)) {
        // Only this version's still-pending, incomplete record can receive later confirmed pricing once.
        const s=samples.find(s=>s.type==='buy'&&`${s.code}|${s.eventDate}|${s.amt}`===key);
        if(s?.strategyVersion===GOLD_VERSION&&!goldEnabled)continue;
        if([NASDAQ_VERSION,GOLD_VERSION].includes(s?.strategyVersion)&&s.backfill==='pending'&&!s.pricingDate&&
          Number.isFinite(p.shares)&&p.shares>0&&Number.isFinite(p.nav)&&p.nav>0&&require('../lib/nasdaqSignal').validDate(p.pricingDate)){
          s.pricingDate=p.pricingDate;s.pricingSession=['T','T+1'].includes(p.session)?p.session:null;s.purchaseConfirmed=true;
          s.pricingCompletedAt=today;s.pricingEvidence={source:'confirmed purchase record',signature:key,sharesSource:p.sharesSource||'record',pricingDate:p.pricingDate};
          pricingCompleted++;
        }
        continue;
      }
      known.add(key);
      // 匹配战役窗口
      let cid = null;
      const hs=isHs300Route(fund);
      const nasdaq=isNasdaqRoute(fund);
      const active=isActiveEquityRoute(fund);
      const gold=isGoldRoute(fund);
      // Preserve pre-rollout purchases; do not create or attach legacy gold records.
      if(gold&&(!goldState[code]||p.date<=goldState[code].baselineDate))continue;
      // Admission to active equity never imports old growth purchases into a new ledger.
      if(active&&(!activeState[code]||p.date<=activeState[code].baselineDate))continue;
      const newVersion=gold?GOLD_VERSION:active&&activeState[code]&&p.date>activeState[code].baselineDate?ACTIVE_EQUITY_VERSION:
        nasdaq&&nasdaqState[code]&&p.date>nasdaqState[code].baselineDate?NASDAQ_VERSION:
        hs&&hsState[code]&&p.date>=hsState[code].baselineDate?HS300_VERSION:
        fund.category==='dividend'&&versionState[code]&&p.date>=versionState[code].baselineDate ? DIVIDEND_VERSION:null;
      const cams = (openIdx[code] || []).filter(os=>gold?os.strategyVersion===GOLD_VERSION:os.strategyVersion!==GOLD_VERSION&&(active?newVersion===ACTIVE_EQUITY_VERSION&&os.strategyVersion===ACTIVE_EQUITY_VERSION:os.strategyVersion!==ACTIVE_EQUITY_VERSION&&(nasdaq?newVersion===NASDAQ_VERSION&&os.strategyVersion===NASDAQ_VERSION:os.strategyVersion!==NASDAQ_VERSION&&(hs?newVersion===HS300_VERSION&&os.strategyVersion===HS300_VERSION:
        os.strategyVersion!==HS300_VERSION&&(fund.category!=='dividend'||newVersion&&os.strategyVersion===newVersion)))));
      for (const os of cams) {
        const w = campaignWin[os.campaign.id];
        if (!w) continue;
        const within = p.date >= w.openDate && (!w.closeDate || p.date <= w.closeDate);
        if (within) { cid = os.campaign.id; break; }
      }
      const isHistory = p.date < P.historyStart;
      samples.push({
        type: 'buy', code, name: fund.name || code, category: fund.category || 'unknown',
        eventDate: p.date, amt: Math.round(p.amount * 100) / 100,
        ...(newVersion?{strategyVersion:newVersion}:{}),
        ...([NASDAQ_VERSION,GOLD_VERSION].includes(newVersion)?{pricingDate:require('../lib/nasdaqSignal').validDate(p.pricingDate)?p.pricingDate:null,
          pricingSession:['T','T+1'].includes(p.session)?p.session:null,orderDate:p.date,
          purchaseConfirmed:Number.isFinite(p.shares)&&p.shares>0&&Number.isFinite(p.nav)&&p.nav>0}:{}),
        campaign: cid ? { id: cid } : null,
        backfill: isHistory ? 'skip' : 'pending', // 历史定投（<historyStart）：不抓长历史重算 T+30
        history: isHistory ? true : false
      });
      added++;
    }
  }
  // 回溯补附：启动补扫可能早于首次战役建立（buy 以 campaign=null 落库）→ 战役窗口出现后再补附；
  // 幂等键只管"不重复建样本"，补附是对已有样本的安全更新（真战役外者保持 null）
  let relinked = 0;
  for (const s of samples) {
    if (s.type !== 'buy' || s.campaign || s.history) continue;
    if(s.strategyVersion===GOLD_VERSION&&!goldEnabled)continue;
    if(s.category==='dividend' && s.strategyVersion!==DIVIDEND_VERSION) continue;
    if((goldState[s.code]||isGoldRoute(holdings.funds.find(f=>f.code===s.code)))&&s.strategyVersion!==GOLD_VERSION)continue;
    if((activeState[s.code]||isActiveEquityRoute(holdings.funds.find(f=>f.code===s.code)))&&s.strategyVersion!==ACTIVE_EQUITY_VERSION)continue;
    if((nasdaqState[s.code]||isNasdaqRoute(holdings.funds.find(f=>f.code===s.code)))&&s.strategyVersion!==NASDAQ_VERSION)continue;
    if((hsState[s.code] || isHs300Route(holdings.funds.find(f=>f.code===s.code))) && s.strategyVersion!==HS300_VERSION)continue;
    const cams = (openIdx[s.code] || []).filter(os=>s.strategyVersion===GOLD_VERSION?os.strategyVersion===GOLD_VERSION:os.strategyVersion!==GOLD_VERSION&&(s.strategyVersion===ACTIVE_EQUITY_VERSION?os.strategyVersion===ACTIVE_EQUITY_VERSION:os.strategyVersion!==ACTIVE_EQUITY_VERSION&&(s.strategyVersion===NASDAQ_VERSION?os.strategyVersion===NASDAQ_VERSION:os.strategyVersion!==NASDAQ_VERSION&&(s.strategyVersion===HS300_VERSION?os.strategyVersion===HS300_VERSION:
      os.strategyVersion!==HS300_VERSION&&(s.category!=='dividend'||os.strategyVersion===s.strategyVersion)))));
    let cid = null;
    for (const os of cams) {
      const w = campaignWin[os.campaign.id];
      if (!w) continue;
      const within = s.eventDate >= w.openDate && (!w.closeDate || s.eventDate <= w.closeDate);
      if (within) { cid = os.campaign.id; break; }
    }
    if (cid) { s.campaign = { id: cid }; relinked++; }
  }
  if (added || relinked || pricingCompleted) saveSamples(samples);
  return added;
}

// ---------- ③ T+30 回填（异步；与采集分离，绝不阻塞决策刷新） ----------
// 触发点：/api/timing 懒触发（in-flight 锁防并发）。fetchNavHistory 1h 缓存复用。
let backfillRunning = false;
async function runBackfill(cfgOverride) {
  if (backfillRunning) return { skipped: 'busy' };
  backfillRunning = true;
  const cfg = cfgOverride || config.getConfig();
  const P = params(cfg);
  const today = env.today();
  const samples = loadSamples();
  try {
    const goldBackfill=await require('../services/goldRecap').backfill(samples,{holdDays:P.holdDays,previewDays:P.previewDays});
    if(goldBackfill.changed)saveSamples(samples);
    // 待回填样本（skip 的历史 buy 不参与）
    // Runtime sampling/return coverage is still unverified: preserve new pending and old records exactly.
    const activeCodes=new Set(Object.keys(loadState().strategyFunds?.[ACTIVE_EQUITY_VERSION]||{}));
    const goldCodes=new Set(Object.keys(loadState().strategyFunds?.[GOLD_VERSION]||{}));
    for(const f of env.read('holdings.json')?.funds||[])if(isGoldRoute(f))goldCodes.add(f.code);
    for(const f of env.read('holdings.json')?.funds||[])if(isActiveEquityRoute(f))activeCodes.add(f.code);
    const pending = samples.filter(s => s.strategyVersion!==GOLD_VERSION&&!goldCodes.has(s.code)&&!isGoldRoute({code:s.code})&&s.strategyVersion!==ACTIVE_EQUITY_VERSION&&!activeCodes.has(s.code)&&!isActiveEquityRoute({code:s.code})&&(s.backfill === 'pending' || [HS300_VERSION,NASDAQ_VERSION].includes(s.strategyVersion)&&s.backfill==='partial'));
    if (!pending.length) return { done: goldBackfill.done };
    // 过早（事件日距今太近，还拿不到 T+30）→ 留待下次；粗判也要等 ≥10 自然日才有意义
    const due = pending.filter(s => util.daysBetween(s.eventDate, today) >= 10);
    if (!due.length) return { done: goldBackfill.done, wait: true };

    // 每 code 一次拉取（360 交易日窗口足够覆盖模块启动后的全部事件；cache 复用）
    const seriesByCode = {},nasdaqEvidence={};
    for (const s of due) {
      const versioned=[DIVIDEND_VERSION,HS300_VERSION,NASDAQ_VERSION].includes(s.strategyVersion);
      const key=versioned?s.code+'#'+s.strategyVersion:s.code;
      if(seriesByCode[key]) continue;
      if(versioned) {
        try {
          const nasdaq=s.strategyVersion===NASDAQ_VERSION;
          if(nasdaq){const resolved=await require('../services/nasdaqIdentity').resolve(s.code);if(resolved.error)continue;nasdaqEvidence[key]=resolved.evidence;}
          const data=await require(nasdaq?'../services/nasdaqData':s.strategyVersion===HS300_VERSION?'../services/hs300Data':'../services/dividendData').fetchFull(s.code);
          const adj=nasdaq?require('../lib/nasdaqNav').adjust(data.history.filter(r=>r.date<=today),data.actions,s.code):require('../lib/fundAdjustedNav').reinvestedNav(data.history,data.actions);
          seriesByCode[key]=adj.rows?adj.rows.filter(r=>![HS300_VERSION,NASDAQ_VERSION].includes(s.strategyVersion)||r.date<=today).map(r=>({date:r.date,nav:r.close})).reverse():null;
        } catch(_) {seriesByCode[key]=null;}
      } else {
        const r = await fetchers.fetchNavHistory(s.code, 360);
        seriesByCode[key] = r && !r.failed ? r.history : null;
      }
    }

    let changed = false;
    for (const s of due) {
      const versioned=[DIVIDEND_VERSION,HS300_VERSION,NASDAQ_VERSION].includes(s.strategyVersion);
      const hist = seriesByCode[versioned?s.code+'#'+s.strategyVersion:s.code];
      if (!hist || !hist.length) continue;
      const nasdaq=s.strategyVersion===NASDAQ_VERSION;
      const referenceDate=nasdaq&&s.type==='buy'?s.pricingDate:versioned&&s.orderDate?s.orderDate:s.eventDate;
      if(nasdaq&&s.type==='buy'&&s.purchaseConfirmed!==true)continue;
      if(nasdaq&&!require('../lib/nasdaqSignal').validDate(referenceDate))continue;
      const i0 = hist.findIndex(h => [HS300_VERSION,NASDAQ_VERSION].includes(s.strategyVersion)?h.date===referenceDate:h.date<=referenceDate); // 新版本不得以此前净值冒充申请日
      if (i0 < 0) continue;
      const T = hist[i0];
      if(nasdaq){const end=hist[Math.max(0,i0-P.holdDays)].date;
        if(require('../services/nasdaqData').coverageGap(hist,nasdaqEvidence[s.code+'#'+s.strategyVersion],referenceDate,end))continue;}
      // 粗判（previewDays）
      const pv = {};
      for (const dd of P.previewDays) {
        const idx = i0 - dd;
        pv['d' + dd] = idx >= 0 && idx < hist.length ? (hist[idx].nav > T.nav) : null;
      }
      const i30 = i0 - P.holdDays;
      if (i30 >= 0 && i30 < hist.length) {
        const T30 = hist[i30];
        const positive30 = T30.nav > T.nav; // 朴素裁判：T+30 正收益
        s.navRef = { T: { date: T.date, nav: +(+T.nav).toFixed(4) }, T30: { date: T30.date, nav: +(+T30.nav).toFixed(4) } };
        s.positive30 = positive30;
        if(versioned) s.returnBasis='dividend-reinvested; fees excluded; 30 NAV observations';
        if (s.type === 'advice-open') {
          // d*：d=0..10 中，从 T+d 买入持有到 T+30 收益最大的 d
          let best = 0, bestGain = -Infinity;
          const cap = Math.min(10, i0); // i0 可能不足 10 个前置交易日
          for (let d = 0; d <= cap; d++) {
            const buyNav = hist[i0 - d].nav;
            if (!buyNav || buyNav <= 0) continue;
            const gain = T30.nav / buyNav;
            if (gain > bestGain) { bestGain = gain; best = d; }
          }
          s.dStar = best;
        }
        s.backfill = 'done';
        s.backfilledAt = today;
        changed = true;
      } else if (Object.values(pv).some(v => v === true || v === false)) {
        // T+30 未到：先落粗判（partial）
        Object.assign(s, pv);
        s.navRef = { T: { date: T.date, nav: +(+T.nav).toFixed(4) }, T30: null };
        s.positive30 = null;
        s.backfill = 'partial';
        s.backfilledAt = today;
        changed = true;
      }
    }
    if (changed) saveSamples(samples);
    return { done: samples.filter(s => s.backfill === 'done').length };
  } finally {
    backfillRunning = false;
  }
}

// ---------- ④ stats()：两账 + 诊断细分 + 候选 + d* + 跟单成效 ----------
function stats(cfgOverride) {
  const cfg = cfgOverride || config.getConfig();
  const P = params(cfg);
  const today = env.today();
  const allSamples = loadSamples();
  // The pre-existing ledgers retain their exact population; new HS300 has its own statistics.
  const samples = allSamples.filter(s=>![HS300_VERSION,NASDAQ_VERSION,ACTIVE_EQUITY_VERSION,GOLD_VERSION].includes(s.strategyVersion));
  const state = loadState();

  const openS = samples.filter(s => s.type === 'advice-open');
  const closeS = samples.filter(s => s.type === 'advice-close');
  const buyS = samples.filter(s => s.type === 'buy');

  // 按「类别 × 判定路径」分组统计（open 按自身 path；close 按战役 open 的 path join）
  const openByCamp = {}; // id -> open sample
  openS.forEach(s => { if (s.campaign && s.campaign.id) openByCamp[s.campaign.id] = s; });

  const groupRows = {}; // kind|groupKey -> { kind, category, groupKey, pathLabel, total, n, hits }
  const bump = (kind, s, p, category) => {
    const key = groupKeyOf(category, p);
    const gk = `${kind}|${key}`;
    const g = groupRows[gk] || (groupRows[gk] = { kind, category, groupKey: key, pathLabel: pathLabelOf(category, p), total: 0, n: 0, hits: 0, dStars: [] });
    g.total++; // 采集总数
    if (s.positive30 == null) return g; // 未回填（无客观判定）不计入命中率
    g.n++;    // 已回填（可判）数
    if (s.positive30 === true) g.hits++;
    if (kind === 'open' && s.dStar != null) g.dStars.push(s.dStar);
    return g;
  };
  openS.forEach(s => bump('open', s, s.path, s.category));
  closeS.forEach(s => {
    const open = s.campaign && openByCamp[s.campaign.id];
    const p = open && open.path ? open.path : s.path; // 统计分组 join 战役 open path
    bump('close', s, p, s.category);
  });

  const rate = (n, hits) => (n ? +(hits / n * 100).toFixed(1) : null);
  const openTotal = { total: openS.length, n: 0, hits: 0 };
  const closeTotal = { total: closeS.length, n: 0, hits: 0 }; // hits=续涨=收回过早
  openS.forEach(s => { if (s.positive30 != null) { openTotal.n++; if (s.positive30 === true) openTotal.hits++; } });
  closeS.forEach(s => { if (s.positive30 != null) { closeTotal.n++; if (s.positive30 === true) closeTotal.hits++; } });

  const openGroups = Object.values(groupRows).filter(g => g.kind === 'open')
    .map(g => ({ ...g, hitRate: rate(g.n, g.hits), categoryLabel: CAT_LABEL[g.category] || g.category }))
    .sort((a, b) => b.total - a.total);
  const closeGroups = Object.values(groupRows).filter(g => g.kind === 'close')
    .map(g => ({ ...g, earlyRate: rate(g.n, g.hits), categoryLabel: CAT_LABEL[g.category] || g.category })) // hits=续涨
    .sort((a, b) => b.total - a.total);

  // 规则候选（准生证：弱信号 weakN 展示 / 强证据 strongN + 命中率越线才产候选；pending 展示，批准权在用户）
  const candidates = [];
  for (const g of openGroups) {
    if (g.n < P.weakN) continue;
    const bad = g.hitRate != null && g.hitRate < P.strongHitRate * 100;
    if (g.n >= P.strongN && bad) {
      candidates.push({
        kind: 'open', category: g.category, categoryLabel: CAT_LABEL[g.category] || g.category,
        pathLabel: g.pathLabel, n: g.n, rate: g.hitRate,
        problem: `「${g.pathLabel}」开口 ${g.n} 次命中率 ${g.hitRate}% < ${P.strongHitRate * 100}% 强证据线`,
        suggest: suggestFix(g.category, 'open', g.pathLabel),
        status: 'pending', landing: landingOf(g.category, g.pathLabel, 'open')
      });
    }
  }
  for (const g of closeGroups) {
    if (g.n < P.weakN) continue;
    const bad = g.earlyRate != null && g.earlyRate > P.strongHitRate * 100;
    if (g.n >= P.strongN && bad) {
      candidates.push({
        kind: 'close', category: g.category, categoryLabel: CAT_LABEL[g.category] || g.category,
        pathLabel: g.pathLabel, n: g.n, rate: g.earlyRate,
        problem: `「${g.pathLabel}」收回 ${g.n} 次后续涨 ${g.earlyRate}% > ${P.strongHitRate * 100}%（收回疑似过早，漏行情）`,
        suggest: suggestFix(g.category, 'close', g.pathLabel),
        status: 'pending', landing: landingOf(g.category, g.pathLabel, 'close')
      });
    }
  }

  // d* 分布（只统计已回填 done 的开口样本）
  const ds = openS.filter(s => s.dStar != null).map(s => s.dStar);
  const dstar = ds.length ? {
    n: ds.length,
    zero: ds.filter(x => x === 0).length,
    early: ds.filter(x => x > 0).length,
    meanDelay: +(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(2),
    maxDelay: Math.max(...ds)
  } : { n: 0, zero: 0, early: 0, meanDelay: null, maxDelay: null };

  // 逐次判定明细 + 跟单成效（buy join 战役 open）
  const rowsOpen = openS.map(s => ({
    date: s.eventDate, code: s.code, name: s.name, category: s.category,
    pathLabel: pathLabelOf(s.category, s.path), approx: !!s.approx,
    backfill: s.backfill, positive30: s.positive30, dStar: s.dStar != null ? s.dStar : null,
    navT: s.navRef && s.navRef.T ? s.navRef.T.nav : null, navT30: s.navRef && s.navRef.T30 ? s.navRef.T30.nav : null
  })).sort((a, b) => a.date < b.date ? 1 : -1);
  const rowsClose = closeS.map(s => {
    const open = s.campaign && openByCamp[s.campaign.id];
    return {
      date: s.eventDate, code: s.code, name: s.name, category: s.category, approx: !!s.approx,
      days: s.campaign && s.campaign.days != null ? s.campaign.days : null,
      openPathLabel: open && open.path ? pathLabelOf(open.category, open.path) : (pathLabelOf(s.category, s.path) + '(未知open)'),
      backfill: s.backfill, positive30: s.positive30
    };
  }).sort((a, b) => a.date < b.date ? 1 : -1);
  const rowsBuy = buyS.map(s => {
    const open = s.campaign && openByCamp[s.campaign.id];
    return {
      date: s.eventDate, code: s.code, name: s.name, amt: s.amt,
      campaign: s.campaign && s.campaign.id ? s.campaign.id : null,
      deviation: (s.campaign && s.campaign.id && open) ? util.daysBetween(open.eventDate, s.eventDate) : null,
      history: !!s.history, backfill: s.backfill, positive30: s.positive30
    };
  }).sort((a, b) => a.date < b.date ? 1 : -1);

  const backfilledDone = samples.filter(s => s.backfill === 'done').length;
  const backfilledPartial = samples.filter(s => s.backfill === 'partial').length;
  const pendingN = samples.filter(s => s.backfill === 'pending').length;

  return {
    generatedAt: today,
    strategyVersions: ['legacy',DIVIDEND_VERSION,HS300_VERSION,NASDAQ_VERSION,ACTIVE_EQUITY_VERSION,GOLD_VERSION].map(version=>{
      const rows=allSamples.filter(s=>(s.strategyVersion||'legacy')===version);
      return {version,open:rows.filter(s=>s.type==='advice-open').length,close:rows.filter(s=>s.type==='advice-close').length,
        returnBasis:version===ACTIVE_EQUITY_VERSION?'复权回填待核验；仅买入判断':version===GOLD_VERSION?'基金自身分红再投资复权；费用未计；30个日频净值观察日；缺证据保持待回填':version!=='legacy'?'分红再投资复权；费用未计；30个净值观察日':'历史口径保留'};
    }),
    versionLedgers:{[HS300_VERSION]:versionLedger(allSamples.filter(s=>s.strategyVersion===HS300_VERSION),state.strategyFunds?.[HS300_VERSION]||{}),
      [NASDAQ_VERSION]:versionLedger(allSamples.filter(s=>s.strategyVersion===NASDAQ_VERSION),state.strategyFunds?.[NASDAQ_VERSION]||{},NASDAQ_VERSION),
      [ACTIVE_EQUITY_VERSION]:versionLedger(allSamples.filter(s=>s.strategyVersion===ACTIVE_EQUITY_VERSION),state.strategyFunds?.[ACTIVE_EQUITY_VERSION]||{},ACTIVE_EQUITY_VERSION),
      [GOLD_VERSION]:versionLedger(allSamples.filter(s=>s.strategyVersion===GOLD_VERSION),state.strategyFunds?.[GOLD_VERSION]||{},GOLD_VERSION)},
    params: P,
    sampling: {
      mode: '访问驱动（无定时器）：开口日=首次被记录日、收回日≈末次加仓日+gapDays；漏访样本标 approx，统计口径含此偏差',
      baselineDate: state.baselineDate, approxCount: samples.filter(s => s.approx).length
    },
    progress: {
      open: openS.length, close: closeS.length, buy: buyS.length,
      backfilledDone, backfilledPartial, pending: pendingN,
      firstT30Estimate: openS.length ? addDays(openS[openS.length - 1].eventDate, 50) : null
    },
    openLedger: { total: openTotal.total, n: openTotal.n, hits: openTotal.hits, hitRate: rate(openTotal.n, openTotal.hits), groups: openGroups },
    closeLedger: { total: closeTotal.total, n: closeTotal.n, hits: closeTotal.hits, earlyRate: rate(closeTotal.n, closeTotal.hits), groups: closeGroups },
    candidates,
    dstar,
    rows: { open: rowsOpen, close: rowsClose, buy: rowsBuy }
  };
}

function versionLedger(samples,cursors,version=HS300_VERSION) {
  const ledger=type=>{
    const rows=samples.filter(s=>s.type===type),done=rows.filter(s=>typeof s.positive30==='boolean');
    return {total:rows.length,n:done.length,hits:done.filter(s=>s.positive30).length,
      hitRate:done.length?+(done.filter(s=>s.positive30).length/done.length*100).toFixed(1):null,
      rows:rows.map(s=>({date:s.eventDate,code:s.code,name:s.name,campaign:s.campaign,path:s.path,approx:!!s.approx,
        positive30:s.positive30??null,backfill:s.backfill,navRef:s.navRef||null,orderDate:s.orderDate||null,
        ...(version===NASDAQ_VERSION?{pricingDate:s.pricingDate||null,pricingSession:s.pricingSession||null,
          purchaseConfirmed:s.purchaseConfirmed??null,computedAt:s.computedAt||null,inputVersion:s.inputVersion||null,
          sourceHash:s.sourceHash||null,actionHash:s.actionHash||null,peHash:s.peHash||null}:{}),
        returnBasis:s.returnBasis||'分红再投资复权；费用未计；30个净值观察日'}))};
  };
  return {version,baselineDates:Object.fromEntries(Object.entries(cursors).map(([code,c])=>[code,c.baselineDate])),
    open:ledger('advice-open'),close:ledger('advice-close'),buy:ledger('buy'),
    sampling:'访问驱动；仅有效且未被交易约束拦截的市场判断更新；中断不补造信号；approx 表示漏访近似采样'};
}

// ---------- 修正建议（仅文案/落点标注；真正的阈值修订 = 你批准后我改 config.signals） ----------
function suggestFix(category, kind, label) {
  if (category === 'tech') {
    return kind === 'open'
      ? '深跌/金叉通道开口偏松的路径 → 候选：收紧对应通道触发（如 dipPct 阈值加深 / 要求止跌确认更严），或该通道改人工留意'
      : '科技收回偏早 → 候选：该路径收回等待止跌确认更稳（跌破 MA20 才收），或放宽收回阈值';
  }
  if (category === 'cycle') {
    return kind === 'open'
      ? '黄金路径 add 疑似偏松（尤其中性+止跌 36 分态）→ 候选：中性带需叠加条件（如回撤再加深）才 add'
      : '黄金收回偏早 → 候选：中性带收回可等趋势确认（跌破 MA20/半年线）再收';
  }
  if (category === 'dividend') {
    return kind === 'open'
      ? '红利开口偏松 → 候选：cheapPct/cheapYield 阈值收紧，或中性跌破年线通道加止跌条件'
      : '红利收回偏早 → 候选：MA250 偏离阈值加深后再收';
  }
  return kind === 'open'
    ? '该路径开口偏松 → 候选：对应判定阈值收紧（peGatePct/cheapPct/erpLow 等）'
    : '该路径收回偏早 → 候选：对应趋势/阈值条件加深后再收';
}
function landingOf(category, label, kind) {
  // 阈值类 = config.signals.* 可落地；结构类 = kernel if-else 需人工改码。v1 只自动产展示，批准后由人改。
  if (category === 'tech') return '阈值类（config.signals.tech）或结构类（kernel 通道判定）——批准后按具体候选定落点';
  if (category === 'cycle' && label.indexOf('中性') >= 0) return '结构类（kernel L129-133 中性带判定 if-else，需人工改码）';
  if (category === 'dividend') return '阈值类（config.signals.dividendYield / fundThresholds）';
  if (category === 'broad') return '阈值类（config.signals.broad / peGate）';
  return '需人工判定落点';
}

// ---------- 测试/冒烟辅助：注入内存 IO 与固定日期，不碰真实 data/ ----------
function _forTest(override) {
  if (!override) { env = Object.assign({}, defaultEnv); return; }
  Object.keys(override).forEach(k => { env[k] = override[k]; });
}

module.exports = { onDecide, buyScan, runBackfill, stats, _forTest, pickPath, pathLabelOf, groupKeyOf, loadSamples };

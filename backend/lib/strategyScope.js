'use strict';
// Strategy participation is independent of the editable accounting category.
// Keep old formula modules and history; only new strategy output is stopped.
const VERSION = 'long-term-accumulation-v1';
const activeLedger = require('../data/activeEquityIdentity.json');
const track = require('./trackIndex');
const THEME = /医药|中药|医疗|生物|创新药|白酒|食品|饮料|消费|新能源|能源|原材料|新材料|资源|有色|油气|石油|天然气|基建|基础设施|建筑|工程|家电|家用电器|黄金产业|黄金股票|金矿|光伏|风电|电池|锂电|储能|半导体|芯片|军工|国防|航空|航天|航运|信息|计算机|云计算|大数据|软件|通信|5G|传媒|游戏|互联网|科技|人工智能|机器人|证券|银行|金融|地产|房地产|汽车|农业|畜牧|养殖|煤炭|钢铁|建材|化工|环保|电力|公用事业|旅游|文娱|教育|物流|运输|港股通创新|恒生医|恒生生物/i;
const COMMODITY = /黄金|上海金|白银|原油|豆粕|商品|有色|金属|能源|原材料|资源|石油|天然气|油气/;
function reasonOf(f) {
  if (!f) return null;
  const entry = activeLedger.funds.find(e => e.code === f.code);
  if (entry?.route === true || entry?.active === true || f._activeEquityData) return 'active_equity';
  if (f.strategyScope === 'record_only' && ['active_equity','theme_sector'].includes(f.scopeReason)) return f.scopeReason;
  const type = String(f.fundType || ''), name = String(f.name || ''), index = String(f.indexName || '');
  if (/债券|货币|偏债|平衡/.test(type)) return null;
  // Dedicated verified identities and broad index names must not be mistaken for
  // active stock funds merely because their type contains the word “股票”.
  const dedicated = require('./nasdaqIdentity').CODES.has(f.code) || require('./hs300Identity').REVIEWED[f.code]
    || require('../data/goldIdentity.json').funds.some(e => e.code === f.code);
  if (dedicated) return null;
  const indexStyle = /指数|ETF|联接/i.test(type + ' ' + name);
  if (!/债券|货币|偏债|平衡|FOF/i.test(type) && !indexStyle &&
      (f.managementType === 'active' || /股票|混合|主动|active-equity|equity|hybrid|mixed/i.test(type) || /混合|股票|主动/.test(name))) return 'active_equity';
  const subject = index || name;
  const stockIndex = /股票|权益|equity|stock/i.test(type) || /股票|权益/.test(index);
  const physicalCommodity = !stockIndex && COMMODITY.test(subject) &&
    (/指数型-其他|商品|期货/.test(type) || /价格|现货|期货|实物/.test(index));
  // Product identity wins over generic industry/theme wording: a metals futures
  // index is not an equity-sector index, and a sector-neutral basket stays broad.
  if (physicalCommodity) return null;
  const broadCoverage = /行业中性|行业均衡|全行业|多行业/.test(index);
  if (broadCoverage) return null;
  // Sector equities do not become physical commodities merely because their
  // companies produce gold, oil or metals. Editable category/proxy is irrelevant.
  if (stockIndex && (THEME.test(subject) || COMMODITY.test(subject))) return 'theme_sector';
  const factorTheme = /红利|股息|低波|央企|国企|价值|质量|动量|成长|基本面|等权|治理|ESG/i.test(index);
  const explicitSector = /行业|产业/.test(index) || /主题/.test(index) && !factorTheme;
  if (stockIndex && explicitSector) return 'theme_sector';
  if (index && THEME.test(index)) return 'theme_sector';
  if (/红利|股息/.test(index)) return null;
  if (/^(NDX|NDX100|NASDAQ100)$/i.test(String(f.indexCode || '')) || /纳斯达克\s*100|NASDAQ[ -]*100/i.test(index || name)) return null;
  const idx = track.TRACK_INDEX?.[f.trackIndex];
  if (idx?.line === 'growth' || f.trackIndex === 'SH000993') return 'theme_sector';
  if (idx?.line === 'dividend' || idx?.line === 'broad' ||
      /^(?:中证|沪深|上证|深证)?\s*(?:A500|A50|300|500|800|1000|2000|50|180|100)(?:指数|全收益|净收益|$)|沪深\s*300|纳斯达克\s*100|NASDAQ[ -]*100|标普\s*500|S&P\s*500|日经\s*225|恒生指数|道琼斯工业|德国DAX|法国CAC|创业板指|创业板50|科创50|科创100/i.test(index)) return null;
  // Index metadata is more specific than the marketing name. Name-only
  // inference requires an index/sector marker; an isolated company word is not identity.
  if (index ? THEME.test(index) : /指数|ETF|联接|行业|主题/.test(type+' '+name) && THEME.test(name)) return 'theme_sector';
  // A legacy growth category with no reliable narrower identity remains record
  // only. Other categories do not acquire new assumptions or new algorithms.
  if (f.category === 'growth') return 'theme_sector';
  return null;
}
function isRecordOnly(f) { return f?.marketState === 'record_only' || f?.strategyScope === 'record_only' || !!reasonOf(f); }
function fields(f, reason = reasonOf(f)) {
  return { strategyScope:'record_only', scopeReason:reason || 'theme_sector', strategyVersion:VERSION,
    marketState:'record_only', marketStateLabel:'仅记账', displayKind:'record_only',
    action:null, marketVerdict:null, verdict:null, score:null, marketScore:null, valueScore:null, momentumScore:null,
    scoreLabel:null, compositeLabel:'仅记账', positionScore:null, positionLabel:null, weights:null, degraded:[],
    unsupported:false, unsupportedReason:null, blockedReason:null, eligible:false, executable:false,
    suspended:false, statusFresh:false };
}
function decision(f, reason) {
  const out = fields(f, reason);
  return {...out, reasons:['仅记录持仓与收益，不生成新的策略信号；历史记录保留。'],
    matrix:{_type:'recordOnly',strategyVersion:VERSION,marketState:'record_only',marketStateLabel:'仅记账',dataError:null}};
}
function guard(builder) { return function(f, ...args) { return isRecordOnly(f) ? decision(f) : builder(f, ...args); }; }
module.exports = { VERSION, reasonOf, isRecordOnly, fields, decision, guard };

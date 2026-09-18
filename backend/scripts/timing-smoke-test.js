'use strict';
// 冒烟测试：timing.js 状态机纯逻辑（内存 IO + 固定日期，不碰真实 data/）
const timing = require('../engines/timing');

const mem = {}; // file -> obj
let NOW = '2026-09-04';
const T = { today: () => NOW, read: f => (mem[f] ? JSON.parse(JSON.stringify(mem[f])) : null), write: (f, o) => { mem[f] = JSON.parse(JSON.stringify(o)); return true; } };
timing._forTest(T);
const cfg = { timing: { historyStart: '2026-09-01' } };

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name); }
}
function mk(code, action, extra) {
  const base = { _type: 'tech', dipReady: true, goldenState: false, stopFall: true, drawdown: -18, gate: 'pass' };
  const m = Object.assign(base, (extra && extra.matrix) || {});
  return { code, action, name: code + '基', category: extra && extra.category ? extra.category : 'tech', matrix: m };
}

console.log('== 首采日基线（不记样本）==');
let r = timing.onDecide({ '016664': mk('016664', 'add') }, cfg);
ok('首采日返回 baseline=true', r.baseline === true && r.opened === 0);
ok('无样本产生', timing.loadSamples().length === 0);

console.log('== 次日 open（hold→add 开战役）==');
NOW = '2026-09-07';
r = timing.onDecide({ '016664': mk('016664', 'add') }, cfg);
const s1 = timing.loadSamples();
ok('次日 add → 开 1 条 advice-open', r.opened === 1 && s1.length === 1 && s1[0].type === 'advice-open');
ok('campaign id = code#date', s1[0].campaign.id === '016664#2026-09-07');

console.log('== 同日重入免疫 ==');
r = timing.onDecide({ '016664': mk('016664', 'add') }, cfg);
ok('同日二次调用不重复开样本', timing.loadSamples().length === 1 && r.opened === 0);

console.log('== 容忍窗（hold 1-3 天不 close；恢复 add 续延）==');
NOW = '2026-09-08';
timing.onDecide({ '016664': mk('016664', 'hold') }, cfg); // gap=1
NOW = '2026-09-09';
timing.onDecide({ '016664': mk('016664', 'add') }, cfg); // 续延（容忍内恢复）
NOW = '2026-09-10';
timing.onDecide({ '016664': mk('016664', 'hold') }, cfg); // gap(lastAdd 09-09)=1
NOW = '2026-09-11';
timing.onDecide({ '016664': mk('016664', 'hold') }, cfg); // gap=2
NOW = '2026-09-12';
timing.onDecide({ '016664': mk('016664', 'hold') }, cfg); // gap=3 ≤3 仍容忍
ok('容忍窗内 hold 不产生 close，样本仍 1', timing.loadSamples().length === 1);

console.log('== 断链 >3 天 → close（每日连续访问，无漏访 → 不标 approx）==');
NOW = '2026-09-13';
r = timing.onDecide({ '016664': mk('016664', 'hold') }, cfg); // gap=4 >3 → close
ok('断链 >3 天 → close 记 1 条', r.closed === 1);
const s2 = timing.loadSamples();
ok('样本变 2 条（open+close 成对共享 id）', s2.length === 2 && s2[1].type === 'advice-close');
ok('closeDate = lastAdd(09-09)+3 = 09-12', s2[1].eventDate === '2026-09-12');
ok('close 战役 days = open 09-07 → close 09-12', s2[1].campaign.days === 5 && s2[1].campaign.id === s2[0].campaign.id);
ok('每日访问（无漏访）→ close 不标 approx', s2[1].approx === false);
ok('close path = 收回日 matrix 子集（无 _type）', s2[1].path._type === undefined && s2[1].path.gate === 'pass');

console.log('== 战役结束后再 add → 开新战役 ==');
NOW = '2026-09-20';
r = timing.onDecide({ '016664': mk('016664', 'add') }, cfg);
ok('开新战役', r.opened === 1 && timing.loadSamples().length === 3);
ok('新战役 id 用新日期', timing.loadSamples()[2].campaign.id === '016664#2026-09-20');

console.log('== 多基金互不干扰 ==');
NOW = '2026-09-21';
r = timing.onDecide({ '016664': mk('016664', 'hold'), '008163': mk('008163', 'add', { category: 'dividend', matrix: { _type: 'dividend', yieldZone: 'cheap', maZone: 'below', gate: 'pass' } }) }, cfg);
const s3 = timing.loadSamples();
ok('008163 独立开战役', s3.some(x => x.code === '008163' && x.type === 'advice-open'));

console.log('== buyScan 幂等 + 战役匹配 + 历史跳过 ==');
mem['holdings.json'] = {
  funds: [
    { code: '016664', name: 'A基', category: 'growth',
      purchases: [
        { date: '2026-09-25', amount: 100 },   // 落在活跃战役 09-20 内
        { date: '2026-09-15', amount: 200 },   // 战役窗口外（早于 09-20 open）
        { date: '2026-08-20', amount: 300 }    // 历史（<2026-09-01）
      ] },
    { code: '008163', name: 'B基', category: 'dividend', purchases: [{ date: '2026-09-21', amount: 50 }] }
  ]
};
const added = timing.buyScan(cfg);
const buys = timing.loadSamples().filter(x => x.type === 'buy');
ok('新增 4 条 buy', added === 4 && buys.length === 4);
const bIn = buys.find(b => b.code === '016664' && b.eventDate === '2026-09-25');
ok('战役内 buy attach campaignId', !!bIn && bIn.campaign.id === '016664#2026-09-20');
ok('战役外 buy campaign=null', buys.find(b => b.code === '016664' && b.eventDate === '2026-09-15').campaign === null);
const bHis = buys.find(b => b.code === '016664' && b.eventDate === '2026-08-20');
ok('历史 buy 标 skip+history', bHis.backfill === 'skip' && bHis.history === true);
ok('buyScan 幂等（重复跑不加）', timing.buyScan(cfg) === 0 && timing.loadSamples().filter(x => x.type === 'buy').length === 4);

console.log('== stats 结构 ==');
const st = timing.stats(cfg);
ok('progress 计数正确', st.progress.open === 3 && st.progress.close === 1 && st.progress.buy === 4);
ok('openLedger 未回填时 rate=null、total=3', st.openLedger.total === 3 && st.openLedger.n === 0 && st.openLedger.hitRate === null);
ok('closeLedger 未回填时 earlyRate=null、total=1', st.closeLedger.total === 1 && st.closeLedger.n === 0 && st.closeLedger.earlyRate === null);
ok('候选空（未回填，命中率不可判）', Array.isArray(st.candidates) && st.candidates.length === 0);
ok('rows.buy 战役内偏差 = 09-25 − 09-20 = 5', st.rows.buy.some(b => b.code === '016664' && b.date === '2026-09-25' && b.deviation === 5));
ok('rows.close 含 open path join 标签', st.rows.close.length === 1 && st.rows.close[0].openPathLabel.indexOf('深跌') >= 0);
ok('sampling note 带访问驱动声明', st.sampling.mode.indexOf('访问驱动') >= 0);

console.log('== 漏访场景（独立基金 018391，放在最后防干扰计数）==');
const cyc = (code, action) => mk(code, action, { category: 'cycle', matrix: { _type: 'cycle', pctZone: 'neutral', trendWeak: true, stopFall: true, surge: false, gate: 'pass' } });
NOW = '2026-09-01';
timing.onDecide({ '018391': cyc('018391', 'hold') }, cfg); // 基线（已 baselineDate → 正常流程）
NOW = '2026-09-02';
timing.onDecide({ '018391': cyc('018391', 'add') }, cfg); // open 09-02
NOW = '2026-09-09';
r = timing.onDecide({ '018391': cyc('018391', 'hold') }, cfg); // 漏访 6 天 → gap=7>3 close
const sc = timing.loadSamples().filter(x => x.code === '018391');
ok('漏访 close 记 1 条且 approx=true', sc.length === 2 && sc[1].type === 'advice-close' && sc[1].approx === true);
ok('closeDate = lastAdd 09-02 + 3 = 09-05', sc[1].eventDate === '2026-09-05');
ok('cycle path 子集带 pctZone', sc[0].path.pctZone === 'neutral' && sc[0].path.trendWeak === true);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

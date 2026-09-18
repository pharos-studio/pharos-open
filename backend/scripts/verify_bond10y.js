'use strict';
/*
 * P0 数据源回归守卫（联网，不写任何文件）。
 * 验证两个海外宽基依赖的数据源：
 *   ① fetchBond10Y()          —— 东财同一接口同时返回 中债10年 / 美债10年，且两者明显不等
 *   ② fetchIndexPeHistory()   —— 蛋卷 pe_history?day=all 能取到长序列（滚动分位 / PE回撤 的数据源）
 * 用途：数据源可达性原先被判为「前置阻塞项」（2026-09-12 已人工验证通过），
 *       脚本落地后降级为回归守卫——防止东财/蛋卷改字段或接口导致静默取空。
 * 用法：node backend/scripts/verify_bond10y.js
 */
const f = require('../fetchers');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
  ok ? pass++ : fail++;
}

(async () => {
  console.log('--- ① 10年期国债收益率（中债 + 美债，同一请求）---');
  const b = await f.fetchBond10Y();
  console.log('    fetchBond10Y() =', JSON.stringify(b));
  t('可取到中债', !!(b && b.cn > 0), b ? `cn=${b.cn}${b.cnAsOf ? ' (' + b.cnAsOf + ')' : ''}` : 'null');
  t('可取到美债', !!(b && b.us > 0), b ? `us=${b.us}${b.usAsOf ? ' (' + b.usAsOf + ')' : ''}` : 'null');
  t('中债量级在 0.5%~4%', !!(b && b.cn > 0.005 && b.cn < 0.04), b ? `cn=${b.cn}` : '');
  t('美债量级在 0.3%~6%', !!(b && b.us > 0.003 && b.us < 0.06), b ? `us=${b.us}` : '');
  t(
    '两者明显不等（★禁止互为兜底）',
    !!(b && b.cn > 0 && b.us > 0 && Math.abs(b.us - b.cn) > 0.005),
    b ? `|us-cn|=${(Math.abs(b.us - b.cn) * 100).toFixed(2)}pp` : ''
  );
  const cnOnly = await f.fetchCNBond10Y();
  t('fetchCNBond10Y() 兼容包装仍只返回中债标量', typeof cnOnly === 'number' && cnOnly > 0, `cn=${cnOnly}`);

  console.log('\n--- ② 指数 PE 历史序列（蛋卷 pe_history?day=all）---');
  const rows = await f.fetchIndexPeHistory('NDX');
  t('NDX 可取到序列', Array.isArray(rows) && rows.length > 100, rows ? `${rows.length} 点` : 'null');
  if (Array.isArray(rows) && rows.length) {
    const first = rows[0], last = rows[rows.length - 1];
    console.log(`    范围 ${first.date} ~ ${last.date}，最新 PE=${last.pe}`);
    t('点数 >= 400（约 10 年周频）', rows.length >= 400, `${rows.length}`);
    t('日期升序', first.date < last.date);
    t('PE 全为正值且在合理区间', rows.every(r => r.pe > 0 && r.pe < 200));
    t('末值像当期 NDX PE（15~60）', last.pe > 15 && last.pe < 60, `pe=${last.pe}`);
  }
  t('未知指数返回 null（不抛错）', (await f.fetchIndexPeHistory('NOSUCHINDEX')) === null);

  console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL', e && e.message || e); process.exit(1); });

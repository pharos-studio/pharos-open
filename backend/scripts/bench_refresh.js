'use strict';
/*
 * 冷/热耗时基准（**只读**，不写任何数据文件）。
 * 直接调 buildAnalysis —— 即 /api/refresh 的重活：9 只基金 × 净值分页并行 + 估值 + 国债 + 盘中指数。
 *   冷 = 本进程首次调用（进程内缓存 valuationCache / navHistoryCache / danjuanEvaCache / bond10yCache 全空）
 *   热 = 紧接着再调一次（上述缓存全部命中，应接近 0 网络）
 * 用法：
 *   node backend/scripts/bench_refresh.js            # 只看耗时
 *   node backend/scripts/bench_refresh.js --json     # 结果 JSON 打到 stdout（供跨版本对拍）
 * 退出码：0 = 正常；2 = 冷/热两次结果不一致（缓存改变了结果，属 bug）
 */
const analysis = require('../engines/analysis');
const { MAX_CONCURRENT } = require('../lib/http');

(async () => {
  const wantJson = process.argv.includes('--json');
  console.error('[bench] 并发闸门 MAX_CONCURRENT = ' + MAX_CONCURRENT);

  const t0 = Date.now();
  const a = await analysis.buildAnalysis();
  const cold = Date.now() - t0;

  const t1 = Date.now();
  const b = await analysis.buildAnalysis();
  const warm = Date.now() - t1;

  console.error('[bench] 冷启动 ' + cold + ' ms   /   热缓存 ' + warm + ' ms   （' + a.funds.length + ' 只基金）');
  console.error('[bench] totals = ' + JSON.stringify(a.totals));

  const same = JSON.stringify(a) === JSON.stringify(b);
  console.error('[bench] 冷/热两次结果完全一致: ' + (same ? '是' : '否 ★'));
  if (!same) { console.error('[bench] 缓存改变了结果 —— 这是 bug'); process.exit(2); }
  if (wantJson) process.stdout.write(JSON.stringify(a));
})().catch((e) => { console.error('[bench] 失败:', e); process.exit(1); });

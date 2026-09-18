'use strict';
// HTTP 基础：UA + fetchText（超时 15s）+ 全局并发闸门。网络请求统一经此，便于将来换代理/加日志。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const LEGU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

// ---------- 全局并发闸门 ----------
// 背景：后端原先「按基金串行 await」，同一时刻只有 1 个在途请求；抓取并行化后瞬时并发可达数十，
// 东财/蛋卷会限流甚至临时封 IP —— 那比串行更慢。闸门让「并行化」变成「受控并发」。
// 放在 fetchText 内部 → 自动覆盖全部调用方（fetchers.js 是解构导入 fetchText，拿到的即带闸门的函数）。
// 串行调用方（并发度恒为 1）永远感知不到闸门存在。回测脚本一次请求数百页也受此约束，不会打爆数据源。
// 可用环境变量 FUND_HTTP_CONCURRENCY 调整（默认 6）；非法值一律回落 6 ——
// ★绝不能算出 NaN：`inflight < NaN` 恒为 false，会让所有请求永久排队（死锁）。
const _mc = Math.floor(Number(process.env.FUND_HTTP_CONCURRENCY));
const MAX_CONCURRENT = (_mc >= 1 && _mc <= 64) ? _mc : 6;
let inflight = 0;
const waiters = [];
function acquire() {
  if (inflight < MAX_CONCURRENT) { inflight++; return Promise.resolve(); }
  return new Promise((resolve) => waiters.push(resolve));
}
function release() {
  // 名额直接移交下一个等待者（inflight 不变）；无等待者才真正归还。
  const next = waiters.shift();
  if (next) next(); else inflight--;
}

async function fetchText(url, headers = {}) {
  await acquire(); // ★ 必须在 try 之外：若放进 try，acquire 自身异常时 finally 会归还从未占用的名额
  // 超时计时从「真正发出请求」起算，排队等待不计入 15s（保持与串行版一致的语义）
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return await res.text();
  } finally {
    clearTimeout(t);
    release();
  }
}

module.exports = { UA, LEGU_UA, fetchText, MAX_CONCURRENT };

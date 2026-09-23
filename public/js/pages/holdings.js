// 持仓页入口壳：实现已拆分到 ./holdings/ 子目录（13 个模块）。
// 保留本文件是为了 (a) app.js 的 import 路径稳定、(b) 既有 PWA 缓存 URL 稳定。
// ★ 不要在这里加任何实现；新增/修改逻辑请改 ./holdings/ 下对应模块（见 docs/前端设计系统.md §6）。
// 历史改造记录已随实现迁至 ./holdings/index.js 顶部。
export { render } from './holdings/index.js';

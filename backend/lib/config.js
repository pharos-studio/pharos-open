'use strict';
// 配置加载：data/config/config.json 为唯一真相源；apiKey 优先取环境变量 FUND_API_KEY。
// 每次读取（不缓存），保证 /api/save 写入后即时生效。
const store = require('./store');

function getConfig() {
  try { return store.readJSON('config.json'); } catch (e) { return {}; }
}
function getApiKey() {
  const env = process.env.FUND_API_KEY;
  if (env) return env;
  const cfg = getConfig();
  return (cfg && cfg.apiKey) || null;
}

module.exports = { getConfig, getApiKey };

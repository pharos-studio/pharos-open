'use strict';
// 历史资料门禁抽检（需另行联网授权）。旧公式只核对历史资料；实时入口始终仅记账。
//
// ★ 为什么单独成文件、归入联网分组：
//   这段刻意用**真实台账**（已核验的基金专属日历与四道门）配**真实净值**，
//   而净值快照缓存在被 gitignore 的目录里 ⇒ CI 的全新 checkout 既没有缓存、runner 又连不上东财。
//   留在离线链里会让 CI 稳定误报失败（实测症状：输入仍报错：fetch failed）。
//   文件里其余三组断言是纯离线的（买入三态、开放日例外口径、买入范围与冷却键），仍留在离线链。
const {realGates}=require('./verify_active_equity_api');

if(require.main===module)realGates().then(()=>{
  console.log('主动权益历史资料门禁与旧公式核对；实时入口均保持仅记账 通过');
}).catch(e=>{console.error(e);process.exitCode=1;});

module.exports={realGates};

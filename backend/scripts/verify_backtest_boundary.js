'use strict';
// Static dependency checks never import CLI runners: several intentionally execute when run directly.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const BACKTEST = path.join(ROOT, 'backend/backtest');
function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? jsFiles(file) : file.endsWith('.js') ? [file] : [];
  });
}
function localDependencies(file) {
  const source = fs.readFileSync(file, 'utf8');
  const deps = [];
  // Ignore comments and string literals containing subprocess -e programs.
  // Scan actual require calls instead of treating quoted sample code as imports of this file.
  for(let i=0;i<source.length;) {
    if(source.slice(i,i+2)==='//') {i=source.indexOf('\n',i);if(i<0)break;continue;}
    if(source.slice(i,i+2)==='/*') {const end=source.indexOf('*/',i+2);i=end<0?source.length:end+2;continue;}
    if(source[i]==='/' && '=(:,[!&|?{};'.includes(source.slice(0,i).trimEnd().at(-1)||'\0')) {
      i++;let cls=false;
      while(i<source.length) {if(source[i]==='\\'){i+=2;continue;}if(source[i]==='[')cls=true;
        if(source[i]===']')cls=false;if(source[i++]==='/'&&!cls)break;}
      while(/[a-z]/i.test(source[i]||'0'))i++;continue;
    }
    if(['"',"'",'`'].includes(source[i])) {const quote=source[i++];while(i<source.length){if(source[i]==='\\'){i+=2;continue;}if(source[i++]===quote)break;}continue;}
    const match=source.slice(i).match(/^require\(\s*(['"])(\.[^'"]+)\1\s*\)/);
    if(match && (i===0 || !/[\w$]/.test(source[i-1]))) {deps.push(createRequire(file).resolve(match[2]));i+=match[0].length;}
    else i++;
  }
  return deps;
}
function checkRuntime(roots, dependencies) {
  const visited = new Set();
  function visit(file) {
    assert(!file.startsWith(BACKTEST + path.sep), '正式链路引用回测目录：' + path.relative(ROOT, file));
    assert(!file.startsWith(path.join(ROOT,'docs/_local')+path.sep),'正式链路引用本地研究：'+path.relative(ROOT,file));
    if (visited.has(file)) return;
    visited.add(file);
    for (const next of dependencies(file)) visit(next);
  }
  roots.forEach(visit);
  return visited.size;
}
const roots = [path.join(ROOT, 'backend/server.js'), path.join(ROOT, 'backend/fetchers.js'),
  ...jsFiles(path.join(ROOT, 'backend/engines')), ...jsFiles(path.join(ROOT, 'backend/lib')), ...jsFiles(path.join(ROOT,'backend/services'))];
const visited = checkRuntime(roots, file => file.endsWith('.js') ? localDependencies(file) : []);
// Both direct and transitive mistakes must fail, rather than just checking the folder names once.
const fakeRoot = path.join(ROOT, 'backend/fake.js'), fakeLib = path.join(ROOT, 'backend/lib/fake.js');
const forbidden = path.join(BACKTEST, 'fake.js');
assert.throws(() => checkRuntime([fakeRoot], file => file === fakeRoot ? [forbidden] : []), /引用回测/);
assert.throws(() => checkRuntime([fakeRoot], file => file === fakeRoot ? [fakeLib] : file === fakeLib ? [forbidden] : []), /引用回测/);
const localResearch=path.join(ROOT,'docs/_local/tasks/synthetic.js');
assert.throws(()=>checkRuntime([fakeRoot],file=>file===fakeRoot?[localResearch]:[]),/本地研究/);
assert.throws(()=>checkRuntime([fakeRoot],file=>file===fakeRoot?[fakeLib]:file===fakeLib?[localResearch]:[]),/本地研究/);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
for (const [name, command] of Object.entries(pkg.scripts)) {
  for (const match of command.matchAll(/\bnode\s+(backend\/[^\s&]+\.js)/g)) {
    assert(!match[1].startsWith('backend/backtest/'), '公开 npm 命令引用研究：'+name);
    checkRuntime([path.join(ROOT,match[1])],file=>file.endsWith('.js')?localDependencies(file):[]);
    assert(fs.existsSync(path.join(ROOT, match[1])), name + ' 入口不存在：' + match[1]);
  }
}
assert(!jsFiles(__dirname).some(file => /^(backtest_|calibrate_)/.test(path.basename(file))), '研究入口仍混在维护脚本目录');
const field = 'dividend' + 'Shadow';
for (const file of ['backend/engines/analysis.js', 'backend/engines/advice.js',
  'public/js/pages/decision.js', 'public/js/pages/review.js']) {
  assert(!fs.readFileSync(path.join(ROOT, file), 'utf8').includes(field), '残留影子字段：' + file);
}
const allocation = require('../engines/alloc/allocation');
assert(!Object.hasOwn(allocation, 'legacyPositionScore'), '正式模块仍导出历史评分');
for (const file of jsFiles(path.join(ROOT, 'backend/engines/strategies'))) {
  assert(!localDependencies(file).some(dep => /[\\/]engines[\\/](kernel|decisions)\.js$/.test(dep)), '策略反向引用兼容层：' + file);
}
assert(!localDependencies(path.join(ROOT, 'backend/engines/registry.js')).some(dep => dep.endsWith('/decisions.js')), '注册表绕经兼容层');
const pure = ['backend/engines/scoring.js', 'backend/engines/tradeConstraints.js', 'backend/engines/decisionPipeline.js',
  ...jsFiles(path.join(ROOT, 'backend/engines/strategies')).map(file => path.relative(ROOT, file))];
const pureImport = spawnSync(process.execPath, ['-r', path.join(__dirname, 'check_offline.js'), '-e',
  "const cfg=require('./backend/lib/config'),store=require('./backend/lib/store');cfg.getConfig=()=>{throw Error('pure layer read config')};" +
  "for(const key of ['readJSON','writeJSON','writeJSONSafe','appendSnapshot','updateJSONSafe'])store[key]=()=>{throw Error('pure layer used storage')};" +
  pure.map(file => 'require(' + JSON.stringify('./' + file) + ');').join('')],
  { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
assert.equal(pureImport.status, 0, pureImport.stderr);
console.log('后端目录边界：' + visited + ' 个正式依赖已检查；路径、历史隔离和无联网导入通过');

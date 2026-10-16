'use strict';
// Deliberately independent of git-ignore: only these public source roots may enter an APK.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_OUT = path.join(ROOT, 'mobile/android/build/assets');
function filesIn(dir, suffix) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e => {
    const p = dir + '/' + e.name;
    return e.isDirectory() ? filesIn(p, suffix) : suffix.some(s => p.endsWith(s)) ? [p] : [];
  });
}
function build(out = DEFAULT_OUT) {
  const modules = ['backend/server.js', 'backend/fetchers.js',
    ...['backend/lib', 'backend/engines', 'backend/services'].flatMap(p => filesIn(p, ['.js'])),
    ...filesIn('backend/data', ['.json'])].sort();
  const defaults = ['data/example/holdings.example.json', 'data/example/config.example.json',
    'data/example/categories.example.json', 'data/config/theme_map.json'];
  const publicFiles = ['public/index.html', 'public/style.css', 'public/icon.svg',
    'public/manifest.webmanifest', ...filesIn('public/js', ['.js']), 'public/vendor/echarts.min.js'];
  const runtimeFiles = ['runtime.js', 'bootstrap.js'];
  const manifest = [];
  const read = p => {
    const s = fs.readFileSync(path.join(ROOT, p));
    manifest.push({ path: p, bytes: s.length, sha256: crypto.createHash('sha256').update(s).digest('hex') });
    return s.toString('utf8');
  };
  fs.mkdirSync(out, { recursive: true });
  let bundle = "'use strict';\nwindow.__PHAROS_MODULES = Object.create(null);\n";
  for (const p of modules) {
    const source = read(p);
    bundle += p.endsWith('.json')
      ? `window.__PHAROS_MODULES[${JSON.stringify('/' + p)}] = ${JSON.stringify(JSON.parse(source))};\n`
      : `window.__PHAROS_MODULES[${JSON.stringify('/' + p)}] = function(require,module,exports,__filename,__dirname){\n${source}\n};\n`;
  }
  const initial = Object.fromEntries(defaults.map(p => [p, JSON.parse(read(p))]));
  bundle += `window.__PHAROS_DEFAULTS = ${JSON.stringify(initial)};\n`;
  fs.writeFileSync(path.join(out, 'backend-bundle.js'), bundle);
  for (const p of publicFiles) {
    let source = read(p);
    const dest = path.join(out, p.slice(7));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (p === 'public/index.html') {
      // Move the desktop's fixed inline preference script to a local asset for strict CSP.
      const inline = source.match(/<script>\s*([\s\S]*?)<\/script>/);
      if (inline) {
        fs.writeFileSync(path.join(out, 'ui-start.js'), inline[1]);
        source = source.replace(inline[0], '<script src="ui-start.js"></script>');
      }
      source = source.replace('<script type="module" src="js/app.js"></script>',
        '<script src="runtime.js"></script>\n<script src="backend-bundle.js"></script>\n<script src="bootstrap.js"></script>\n<script type="module" src="js/app.js"></script>');
    }
    fs.writeFileSync(dest, source);
  }
  for (const name of runtimeFiles) fs.writeFileSync(path.join(out, name), read('mobile/android/web/' + name));
  for (const name of ['mobile/android/AndroidManifest.xml', 'mobile/android/src/org/pharos/local/MainActivity.java', 'mobile/android/tools/build.cjs', 'mobile/android/tools/build-assets.cjs']) read(name);
  fs.writeFileSync(path.join(out, 'source-manifest.json'), JSON.stringify({ version: 1, files: manifest }, null, 2));
  return { out, modules: modules.length, files: manifest.length, manifest };
}
if (require.main === module) { const result = build(process.argv[2] && path.resolve(process.argv[2])); console.log(JSON.stringify({ out: result.out, modules: result.modules, files: result.files })); }
module.exports = { build, ROOT };

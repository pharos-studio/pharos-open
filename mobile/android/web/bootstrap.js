(function () {
  'use strict';
  const m = window.PharosMobile;
  m.ready = (async () => {
    const fs = m.fs, defaults = window.__PHAROS_DEFAULTS;
    for (const dir of ['/data', '/data/state', '/data/config', '/data/cache', '/data/series']) fs.mkdirSync(dir);
    const seeds = { '/data/state/holdings.json': 'data/example/holdings.example.json', '/data/config/config.json': 'data/example/config.example.json', '/data/config/categories.json': 'data/example/categories.example.json', '/data/config/theme_map.json': 'data/config/theme_map.json' };
    for (const [p, key] of Object.entries(seeds)) if (!fs.existsSync(p)) {
      const v = JSON.parse(JSON.stringify(defaults[key]));
      if (p.endsWith('/holdings.json')) { v.funds = []; v._schemaVersion = 2; }
      if (p.endsWith('/config.json')) { delete v.apiKey; if (v.llm) delete v.llm.apiKey; }
      fs.writeFileSync(p, JSON.stringify(v));
    }
    const store = m.load('/backend/lib/store.js'), schema = m.load('/backend/lib/schema.js');
    const full = store.dataPath('config.json'), migration = schema.migrateIfNeeded('config.json', store.readJSONRaw('config.json'), { fullPath: full });
    if (migration.changed && !store.writeJSONSafe('config.json', migration.obj)) throw Error('配置迁移保存失败');
    m.load('/backend/server.js');
    const timing = m.load('/backend/engines/timing.js'), backfill = timing.runBackfill;
    timing.runBackfill = (...args) => m.track(backfill(...args));
    const share = await m.load('/backend/engines/shareMigration.js').ensureMigration();
    if (share.status === 'complete') await m.load('/backend/lib/fundProfile.js').migrateExisting();
    const built = m.load('/backend/lib/categories.js').ensureBuiltins(store.readJSONRaw('categories.json'));
    if (built.changed) { schema.backupFile(store.dataPath('categories.json')); if (!store.writeJSONSafe('categories.json', built.obj)) throw Error('分类保存失败'); }
    if (share.status === 'complete') m.load('/backend/engines/timing.js').buyScan();
    setTimeout(() => m.foreground(), 3000);
  })();
})();

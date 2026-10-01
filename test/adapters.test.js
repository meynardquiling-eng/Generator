// The real db delivers frozen documents. Run the service through the page's own
// store adapter over a db double that freezes everything it returns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadCore } = require('./helpers/loadCore');
const { FakeBridge, FakeLlm, FakeClock, FIXTURE_SECTIONS } = require('./helpers/fakes');

function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
}

function frozenDb() {
  const data = {};
  const snap = (d) => ({ exists: !!d, data: () => (d ? deepFreeze(JSON.parse(JSON.stringify(d))) : undefined) });
  function query(path, filters) {
    return {
      where: (f, op, v) => query(path, filters.concat([[f, v]])),
      limit: () => query(path, filters),
      get: async () => ({ docs: Object.values(data[path] || {}).filter(d => filters.every(([f, v]) => d[f] === v)).map(snap) }),
      doc: (id) => ({
        get: async () => snap((data[path] || {})[id]),
        set: async (o) => { (data[path] = data[path] || {})[id] = JSON.parse(JSON.stringify(o)); },
        delete: async () => { delete (data[path] || {})[id]; },
        acquire: async () => ({ acquired: true })
      })
    };
  }
  return { collection: (p) => query(p, []), data };
}

test('service works through the db adapter when documents are frozen', async () => {
  const core = loadCore();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/artifact/adapters.js'), 'utf8'), core);
  const db = frozenDb();
  const store = core.makeDbStore(db);
  await store.put('sources', 'kl-000', { chunkId: 'kl-000', sections: FIXTURE_SECTIONS });
  await store.put('settings', 'main', { bridgeFolderId: 'f', collectVerifiedEmail: true, csqChannels: [] });
  const bridge = new FakeBridge();
  bridge.sourceExport = { generatedAt: 'g', docId: 'd', sections: FIXTURE_SECTIONS };
  const svc = core.createDrillService({ store, bridge, llm: new FakeLlm(), clock: new FakeClock(), actor: 't', sleepMs: 1 });

  await svc.importSources();
  assert.ok(db.data.settings.main.sourcesMeta, 'import records sourcesMeta');
  assert.equal(db.data.settings.main.bridgeFolderId, 'f');

  const d = await svc.createDrill({ drillType: 'APPROVE_DENY', scenarioCount: 1 });
  await svc.generateNextScenario(d.drillId);
  await svc.approveDrill(d.drillId);
  assert.equal(db.data.drills[d.drillId].status, 'APPROVED');
  await svc.createForm(d.drillId);
  bridge.run();
  await svc.refreshFormStatus(d.drillId);
  assert.equal(db.data.drills[d.drillId].status, 'FORM_CREATED');
});

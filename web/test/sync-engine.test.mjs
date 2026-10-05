// The browser sync engine (public/sync-engine.js) driven end-to-end against the real request
// handler + store, with the real v5 logic producing the localStorage writes.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { createStore } from '../lib/store.mjs';
import { createSyncEngine } from '../public/sync-engine.js';
import { STORAGE_KEY, META_KEY, BACKUP_KEY } from '../public/bridge-core.js';
import { createFakeNocoBase } from './helpers/fake-nocobase.mjs';
import { loadV5, createMemoryStorage, createWorkspaceVia, publishVia } from './helpers/v5-harness.mjs';

const quiet = { info() {}, warn() {} };

async function startServer(fake) {
  const store = createStore({ loadClient: async () => ({ createClient: () => fake.client }), log: quiet, healthTtlMs: 0, failTtlMs: 0 });
  const server = http.createServer(createApp({ store, log: quiet }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, store, api: `http://127.0.0.1:${server.address().port}/cfg` };
}

/** v5 running against `storage`, with the engine notified the way the setItem interceptor does. */
function appWith(storage, engine) {
  const wrapped = Object.create(storage);
  wrapped.getItem = (k) => storage.getItem(k);
  wrapped.setItem = (k, v) => { storage.setItem(k, v); if (k === STORAGE_KEY) engine.noteWrite(); };
  const h = loadV5({ storage: wrapped });
  return h.create();
}

const engines = [];
after(() => { for (const e of engines) e.stop(); });

function engineFor(api, storage, extra = {}) {
  const statuses = [];
  const engine = createSyncEngine(Object.assign({
    fetch: (...a) => fetch(...a), storage, api, wait: 15, maxWait: 60, healthEveryMs: 30, log: quiet,
    onStatus: (s) => statuses.push(s.status)
  }, extra));
  engines.push(engine);
  return { engine, statuses };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function settle(engine, store) { await sleep(40); await engine.idle(); if (store) await store.projectionsIdle(); }

describe('sync engine against the server (nocobase mode)', () => {
  let fake, srv;
  before(async () => { fake = createFakeNocoBase(); srv = await startServer(fake); });
  after(() => srv.server.close());

  test('first run: browser state is migrated to the server, publishes backfilled as releases', async () => {
    // a browser that used the configurator before the server existed
    const storage = createMemoryStorage();
    const h = loadV5({ storage });
    const c = h.create();
    createWorkspaceVia(c, { name: 'Third Wave', slug: 'third-wave', start: 'template' });
    publishVia(c, 'offline go-live');
    const raw = storage.getItem(STORAGE_KEY);

    const { engine } = engineFor(srv.api, storage);
    const d = await engine.hydrate();
    assert.equal(d.action, 'push');
    await settle(engine, srv.store);
    const res = await fetch(srv.api + '/state');
    assert.equal(await res.text(), raw, 'server now holds the exact browser blob');
    const meta = JSON.parse(storage.getItem(META_KEY));
    assert.equal(meta.dirty, false);
    assert.equal(meta.base, res.headers.get('etag'));
    const rel = await (await fetch(srv.api + '/releases?ws=third-wave')).json();
    assert.deepEqual(rel.map(r => [r.version, r.reason]), [[1, 'offline go-live']]);
    assert.equal(engine.status().status, 'saved');
  });

  test('a fresh browser pulls server state before the app mounts', async () => {
    const storage = createMemoryStorage();
    const { engine } = engineFor(srv.api, storage);
    assert.equal((await engine.hydrate()).action, 'pull');
    const serverText = await (await fetch(srv.api + '/state')).text();
    assert.equal(storage.getItem(STORAGE_KEY), serverText);
    // and the real v5 constructor picks it up
    const c = loadV5({ storage }).create();
    assert.deepEqual(c.wsList().filter(w => w.custom).map(w => [w.slug, w.version]), [['third-wave', 'v1']]);
  });

  test('edits are debounced into one PUT; a publish posts a release with the typed reason', async () => {
    const storage = createMemoryStorage();
    const { engine } = engineFor(srv.api, storage);
    await engine.hydrate();
    const c = appWith(storage, engine);
    c.loadTenant('ws_third_wave');
    fake.calls.length = 0;
    for (let i = 0; i < 5; i++) c.moveNode('mod:bd', 100 + i, 300); // burst of writes
    await settle(engine);
    const updatesForBurst = fake.calls.filter(x => x === 'update').length;
    assert.equal(updatesForBurst, 1, 'one cfg_workspaces update for the whole burst');

    publishVia(c, 'Second release — moved BD');
    await settle(engine, srv.store);
    const rel = await (await fetch(srv.api + '/releases?ws=third-wave')).json();
    assert.deepEqual(rel.map(r => [r.version, r.reason, r.published_by]), [[1, 'offline go-live', 'platform:ops@matrix.io'], [2, 'Second release — moved BD', 'platform:ops@matrix.io']]);
    assert.equal(rel[1].manifest.workspace.live_version, 'v2');
    const ws = fake.rows('cfg_workspaces').find(w => w.slug === 'third-wave');
    assert.deepEqual([ws.live_version, ws.draft_version], [2, 3]);
    assert.equal(await (await fetch(srv.api + '/state')).text(), storage.getItem(STORAGE_KEY));
    assert.equal(JSON.parse(storage.getItem(META_KEY)).dirty, false);
  });

  test('two tabs: the second writer gets a conflict instead of silently overwriting', async () => {
    const s1 = createMemoryStorage(), s2 = createMemoryStorage();
    const t1 = engineFor(srv.api, s1), t2 = engineFor(srv.api, s2);
    await t1.engine.hydrate(); await t2.engine.hydrate();
    const c1 = appWith(s1, t1.engine), c2 = appWith(s2, t2.engine);
    c1.loadTenant('ws_third_wave'); c2.loadTenant('ws_third_wave');
    await settle(t1.engine); await settle(t2.engine);
    c1.patchModule('bd', { name: 'Tab one' });
    await settle(t1.engine);
    c2.patchModule('bd', { name: 'Tab two' });
    await settle(t2.engine);
    assert.equal(t2.engine.status().status, 'conflict');
    assert.equal(t2.engine.status().paused, true);
    const server = JSON.parse(await (await fetch(srv.api + '/state')).text());
    assert.equal(server.data.ws_third_wave.modules.find(m => m.key === 'bd').name, 'Tab one');
    // reloading tab two: dirty copy on a stale base → server wins, browser copy backed up
    const reload = engineFor(srv.api, s2);
    assert.equal((await reload.engine.hydrate()).action, 'conflict');
    assert.match(s2.getItem(BACKUP_KEY), /Tab two/);
    assert.match(s2.getItem(STORAGE_KEY), /Tab one/);
  });

  test('offline edits made while NocoBase was down are pushed when it comes back', async () => {
    const storage = createMemoryStorage();
    const { engine } = engineFor(srv.api, storage);
    await engine.hydrate();
    const c = appWith(storage, engine);
    c.loadTenant('ws_third_wave');
    await settle(engine);
    fake.state.up = false;
    await sleep(20);
    c.patchModule('legal', { name: 'Legal (edited offline)' });
    await settle(engine);
    assert.ok(['local', 'error'].includes(engine.status().status), engine.status().status);
    assert.equal(JSON.parse(storage.getItem(META_KEY)).dirty, true);
    fake.state.up = true;
    for (let i = 0; i < 100 && engine.status().status !== 'saved'; i++) await sleep(20); // retry / health re-check
    await settle(engine);
    assert.equal(engine.status().status, 'saved');
    const server = JSON.parse(await (await fetch(srv.api + '/state')).text());
    assert.equal(server.data.ws_third_wave.modules.find(m => m.key === 'legal').name, 'Legal (edited offline)');
  });
});

describe('sync engine in local mode', () => {
  test('server reachable but NocoBase down: app keeps working on localStorage only', async () => {
    const fake = createFakeNocoBase();
    fake.state.up = false;
    const srv = await startServer(fake);
    try {
      const storage = createMemoryStorage();
      const { engine } = engineFor(srv.api, storage, { healthEveryMs: 60000 });
      assert.equal((await engine.hydrate()).action, 'local');
      const c = appWith(storage, engine);
      createWorkspaceVia(c, { name: 'Offline', slug: 'offline', start: 'empty' });
      await settle(engine);
      assert.equal(engine.status().status, 'local');
      assert.match(storage.getItem(STORAGE_KEY), /"slug":"offline"/);
      assert.equal(fake.calls.filter(x => x === 'create' || x === 'update').length, 0);
    } finally { srv.server.close(); }
  });

  test('web server unreachable: hydrate resolves quickly in local mode', async () => {
    const storage = createMemoryStorage({ [STORAGE_KEY]: '{"customWs":[],"data":{}}' });
    const { engine } = engineFor('http://127.0.0.1:9/cfg', storage, { healthEveryMs: 60000 });
    const t0 = Date.now();
    const d = await engine.hydrate();
    assert.equal(d.action, 'local');
    assert.ok(Date.now() - t0 < 4000);
    assert.equal(storage.getItem(STORAGE_KEY), '{"customWs":[],"data":{}}', 'browser state untouched');
  });
});

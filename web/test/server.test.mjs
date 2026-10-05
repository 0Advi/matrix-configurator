// Server routes.
//  - local mode: the real server.mjs spawned on a random port with NocoBase unreachable
//  - nocobase mode: the same request handler in-process, backed by lib/store.mjs driving a
//    test-only in-memory client (test/helpers/fake-nocobase.mjs)
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { createStore, etagOf } from '../lib/store.mjs';
import { createFakeNocoBase } from './helpers/fake-nocobase.mjs';
import { loadV5, createWorkspaceVia, publishVia, builtinWorkspaces } from './helpers/v5-harness.mjs';

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));

function req(base, path, { method = 'GET', headers = {}, body, rawPath = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const r = http.request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}
const JSON_CT = { 'Content-Type': 'application/json' };

// ------------------------------------------------------------------------ local mode
describe('server.mjs in local mode (NocoBase unreachable)', () => {
  let child, base;
  before(async () => {
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        WEB_PORT: '0',
        WEB_HOST: '127.0.0.1',
        CFG_ENV_FILE: '/nonexistent/.env',
        NOCOBASE_URL: 'http://127.0.0.1:9', // discard port: connection refused
        NOCOBASE_TOKEN: '', NOCOBASE_ROOT_EMAIL: '', NOCOBASE_ROOT_PASSWORD: '',
        CFG_SEED_BUILTINS: '0',
        CFG_MAX_BODY_BYTES: '4096'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    base = await new Promise((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
      child.stdout.on('data', (d) => {
        out += d;
        const m = /listening on (http:\/\/[^\s]+)/.exec(out);
        if (m) { clearTimeout(t); resolve(m[1]); }
      });
      child.stderr.on('data', (d) => { out += d; });
      child.on('exit', (code) => reject(new Error('server exited ' + code + ': ' + out)));
    });
  });
  after(() => { child.kill('SIGTERM'); });

  test('health reports local mode', async () => {
    const r = await req(base, '/cfg/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.mode, 'local');
    assert.equal(r.json.nocobase, false);
  });

  test('state and release routes answer 503 {mode: local}', async () => {
    for (const [method, path, body] of [
      ['GET', '/cfg/state'],
      ['PUT', '/cfg/state', { customWs: [], data: {} }],
      ['POST', '/cfg/releases', { workspace_slug: 'x', version: 1 }],
      ['GET', '/cfg/releases?ws=x']
    ]) {
      const r = await req(base, path, { method, headers: body ? JSON_CT : {}, body });
      assert.equal(r.status, 503, method + ' ' + path);
      assert.equal(r.json.mode, 'local');
    }
  });

  test('request validation: content type, body size, unknown routes, methods', async () => {
    assert.equal((await req(base, '/cfg/state', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await req(base, '/cfg/state', { method: 'PUT', headers: JSON_CT, body: 'x'.repeat(5000) })).status, 413);
    assert.equal((await req(base, '/cfg/state', { method: 'PUT', headers: JSON_CT, body: '{oops' })).status, 400);
    assert.equal((await req(base, '/cfg/nope')).status, 404);
    assert.equal((await req(base, '/cfg/state', { method: 'DELETE' })).status, 405);
    assert.equal((await req(base, '/index.html', { method: 'POST' })).status, 405);
  });

  test('API rejects non-loopback Host headers (DNS rebinding)', async () => {
    const r = await req(base, '/cfg/health', { headers: { Host: 'evil.example:4300' } });
    assert.equal(r.status, 403);
    assert.equal((await req(base, '/cfg/health', { headers: { Host: 'localhost:4300' } })).status, 200);
  });

  test('static files are served with correct content types', async () => {
    const expect = {
      '/': 'text/html; charset=utf-8',
      '/index.html': 'text/html; charset=utf-8',
      '/configurator.dc.html': 'text/html; charset=utf-8',
      '/support.js': 'text/javascript; charset=utf-8',
      '/boot.js': 'text/javascript; charset=utf-8',
      '/main.js': 'text/javascript; charset=utf-8',
      '/storage-bridge.js': 'text/javascript; charset=utf-8',
      '/sync-engine.js': 'text/javascript; charset=utf-8',
      '/bridge-core.js': 'text/javascript; charset=utf-8',
      '/vendor/react@18.3.1/umd/react.production.min.js': 'text/javascript; charset=utf-8',
      '/vendor/react-dom@18.3.1/umd/react-dom.production.min.js': 'text/javascript; charset=utf-8',
      '/vendor/@babel/standalone@7.29.0/babel.min.js': 'text/javascript; charset=utf-8',
      '/vendor/fonts/ibm-plex.css': 'text/css; charset=utf-8',
      '/vendor/fonts/files/ibm-plex-sans-latin-400-normal.woff2': 'font/woff2',
      '/vendor/fonts/files/ibm-plex-mono-latin-600-normal.woff2': 'font/woff2'
    };
    for (const [path, ct] of Object.entries(expect)) {
      const r = await req(base, path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers['content-type'], ct, path);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    }
    const head = await req(base, '/support.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    const etag = (await req(base, '/support.js')).headers.etag;
    assert.equal((await req(base, '/support.js', { headers: { 'If-None-Match': etag } })).status, 304);
    assert.match((await req(base, '/vendor/fonts/ibm-plex.css')).headers['cache-control'], /immutable/);
  });

  test('HTML gets a same-origin CSP; direct navigation to the dc file goes to the app', async () => {
    const csp = (await req(base, '/')).headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' 'unsafe-eval'(;|$)/);
    assert.match(csp, /font-src 'self'(;|$)/);
    assert.match(csp, /connect-src 'self'(;|$)/);
    assert.equal(/unpkg|googleapis|gstatic|https:/.test(csp), false);
    const nav = await req(base, '/configurator.dc.html', { headers: { 'Sec-Fetch-Dest': 'document' } });
    assert.equal(nav.status, 302);
    assert.equal(nav.headers.location, '/');
    const fetched = await req(base, '/configurator.dc.html', { headers: { 'Sec-Fetch-Dest': 'empty' } });
    assert.equal(fetched.status, 200);
    assert.match(fetched.text, /<x-dc>/);
  });

  test('no directory traversal, dotfiles or listings', async () => {
    for (const p of ['/../server.mjs', '/%2e%2e/server.mjs', '/vendor/../../server.mjs', '/%2e%2e%2f%2e%2e%2f.env', '/..%2f..%2f.env',
      '/.env', '/vendor/', '/vendor', '/%00', '/%E0%A4%A', '/..\\server.mjs', '/test/server.test.mjs', '/lib/store.mjs']) {
      const r = await req(base, p);
      assert.equal(r.status, 404, p + ' -> ' + r.status);
    }
  });

  test('served HTML/JS has no runtime CDN references outside documented, unreachable defaults', async () => {
    for (const p of ['/', '/main.js', '/storage-bridge.js', '/sync-engine.js', '/bridge-core.js']) {
      const r = await req(base, p);
      assert.equal(/unpkg\.com|fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/.test(r.text), false, p);
    }
    // boot.js mentions the unpkg URLs only as keys of the vendor redirect map
    const boot = (await req(base, '/boot.js')).text;
    for (const m of boot.matchAll(/https:\/\/unpkg\.com\/[^'"]+/g)) {
      assert.match(boot, new RegExp(`'${m[0].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}': '/vendor/`));
    }
  });
});

// ------------------------------------------------------------------------ nocobase mode
async function startInProcess(fake, opts = {}) {
  const store = createStore({
    loadClient: async () => ({ createClient: () => fake.client }),
    log: { info() {}, warn() {} },
    healthTtlMs: 0, failTtlMs: 0,
    builtinSeeds: opts.seeds || null
  });
  const server = http.createServer(createApp({ store, log: { info() {}, warn() {} }, ...opts.app }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, store, base: `http://127.0.0.1:${server.address().port}` };
}

function realBlob() {
  const h = loadV5();
  const c = h.create();
  createWorkspaceVia(c, { name: 'Third Wave', slug: 'third-wave', start: 'template' });
  publishVia(c, 'go live');
  createWorkspaceVia(c, { name: 'Chaayos', slug: 'chaayos', start: 'empty' });
  return { raw: h.storage.getItem('wsconfig_v5_custom'), c, h };
}

describe('server in nocobase mode (in-memory client)', () => {
  let fake, srv;
  before(async () => { fake = createFakeNocoBase(); srv = await startInProcess(fake); });
  after(() => srv.server.close());

  test('health reports nocobase mode', async () => {
    const r = await req(srv.base, '/cfg/health');
    assert.deepEqual([r.json.mode, r.json.nocobase, r.json.client], ['nocobase', true, 'loaded']);
  });

  test('empty server: GET /cfg/state is {} with an ETag', async () => {
    const r = await req(srv.base, '/cfg/state');
    assert.equal(r.status, 200);
    assert.equal(r.text, '{}');
    assert.equal(r.headers.etag, etagOf({}));
  });

  test('PUT a real v5 blob → workspaces + projections; GET returns it byte-for-byte', async () => {
    const { raw } = realBlob();
    const empty = await req(srv.base, '/cfg/state');
    const put = await req(srv.base, '/cfg/state', { method: 'PUT', headers: { ...JSON_CT, 'If-Match': empty.headers.etag }, body: raw });
    assert.equal(put.status, 200, put.text);
    assert.deepEqual(put.json.changed.sort(), ['chaayos', 'third-wave']);
    const get = await req(srv.base, '/cfg/state');
    assert.equal(get.text, raw);
    assert.equal(get.headers.etag, put.headers.etag);

    const ws = fake.rows('cfg_workspaces');
    assert.deepEqual(ws.map(w => [w.slug, w.is_custom, w.live_version, w.draft_version, w.initials]).sort(),
      [['chaayos', true, 0, 1, 'CH'], ['third-wave', true, 1, 2, 'TH']]);

    await srv.store.projectionsIdle();
    const mods = fake.rows('cfg_modules').filter(m => m.workspace_slug === 'third-wave');
    assert.equal(mods.length, 9);
    assert.ok(mods.every(m => m.status === 'live'), 'published modules are live');
    assert.equal(fake.rows('cfg_stages').filter(s => s.workspace_slug === 'third-wave').length, 25);
    assert.equal(fake.rows('cfg_gates').filter(g => g.workspace_slug === 'third-wave').length, 9);
    assert.equal(fake.rows('cfg_modules').filter(m => m.workspace_slug === 'chaayos').length, 0);
  });

  test('unchanged workspaces are not rewritten; stale If-Match is a 409', async () => {
    const cur = await req(srv.base, '/cfg/state');
    fake.calls.length = 0;
    const same = await req(srv.base, '/cfg/state', { method: 'PUT', headers: { ...JSON_CT, 'If-Match': cur.headers.etag }, body: cur.text });
    assert.equal(same.status, 200);
    assert.deepEqual(same.json.changed, []);
    assert.equal(fake.calls.filter(c => c === 'update' || c === 'create').length, 0);

    const stale = await req(srv.base, '/cfg/state', { method: 'PUT', headers: { ...JSON_CT, 'If-Match': '"stale"' }, body: cur.text });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.etag, cur.headers.etag);
  });

  test('a workspace dropped from the blob is deleted with its projections', async () => {
    const cur = JSON.parse((await req(srv.base, '/cfg/state')).text);
    const next = { customWs: cur.customWs.filter(w => w.slug !== 'chaayos'), data: { ws_third_wave: cur.data.ws_third_wave } };
    const r = await req(srv.base, '/cfg/state', { method: 'PUT', headers: JSON_CT, body: next });
    assert.deepEqual(r.json.deleted, ['chaayos']);
    await srv.store.projectionsIdle();
    assert.deepEqual(fake.rows('cfg_workspaces').map(w => w.slug), ['third-wave']);
  });

  test('releases: append, idempotent per (slug, version), list, validation', async () => {
    const rel = { workspace_slug: 'third-wave', version: 1, reason: 'go live', manifest: { workspace: { slug: 'third-wave' } }, published_by: 'platform:ops@matrix.io', lines: ['ignored'] };
    const a = await req(srv.base, '/cfg/releases', { method: 'POST', headers: JSON_CT, body: rel });
    assert.equal(a.status, 201);
    assert.equal('lines' in a.json.release, false, 'only contract fields are stored');
    const b = await req(srv.base, '/cfg/releases', { method: 'POST', headers: JSON_CT, body: rel });
    assert.equal(b.status, 200);
    assert.equal(b.json.duplicate, true);
    const list = await req(srv.base, '/cfg/releases?ws=third-wave');
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].reason, 'go live');
    assert.equal((await req(srv.base, '/cfg/releases')).status, 400);
    assert.equal((await req(srv.base, '/cfg/releases', { method: 'POST', headers: JSON_CT, body: { workspace_slug: 'x', version: 0 } })).status, 400);
    assert.equal((await req(srv.base, '/cfg/releases', { method: 'POST', headers: JSON_CT, body: { version: 1 } })).status, 400);
  });

  test('invalid blobs are rejected with 400', async () => {
    for (const body of [[], { customWs: 'no' }, { customWs: [{ id: 'a' }] }]) {
      const r = await req(srv.base, '/cfg/state', { method: 'PUT', headers: JSON_CT, body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });

  test('NocoBase going down flips to local mode (503), coming back flips to nocobase', async () => {
    // /cfg/health is stale-while-revalidate: it answers from cache and re-checks in the
    // background, so the flip shows up on a following request.
    const eventuallyMode = async (want) => {
      for (let i = 0; i < 50; i++) {
        if ((await req(srv.base, '/cfg/health')).json.mode === want) return true;
        await new Promise(r => setTimeout(r, 10));
      }
      return false;
    };
    fake.state.up = false;
    try {
      assert.ok(await eventuallyMode('local'));
      assert.equal((await req(srv.base, '/cfg/state')).status, 503);
    } finally {
      fake.state.up = true;
    }
    assert.ok(await eventuallyMode('nocobase'));
    assert.equal((await req(srv.base, '/cfg/state')).status, 200);
  });

  test('upstream errors surface as 502 and a projection failure never fails the save', async () => {
    fake.state.failNext = { op: 'list', error: new Error('boom') };
    const r = await req(srv.base, '/cfg/state');
    assert.equal(r.status, 502);
    const cur = await req(srv.base, '/cfg/state');
    const blob = JSON.parse(cur.text);
    blob.data.ws_third_wave.modules[0].name = 'BD renamed';
    fake.state.failNext = { op: 'destroy', error: new Error('projection boom') }; // first replaceWhere
    const put = await req(srv.base, '/cfg/state', { method: 'PUT', headers: JSON_CT, body: blob });
    assert.equal(put.status, 200);
    await srv.store.projectionsIdle();
    const h = await req(srv.base, '/cfg/health');
    assert.match(h.json.projection.lastError.message, /projection boom/);
    assert.equal(JSON.parse((await req(srv.base, '/cfg/state')).text).data.ws_third_wave.modules[0].name, 'BD renamed');
  });
});

describe('CFG_MODE=local', () => {
  test('forces local mode even when NocoBase would be reachable', async () => {
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: WEB_DIR,
      env: { ...process.env, WEB_PORT: '0', WEB_HOST: '127.0.0.1', CFG_ENV_FILE: '/nonexistent/.env', CFG_MODE: 'local', CFG_SEED_BUILTINS: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      const base = await new Promise((resolve, reject) => {
        let out = '';
        const t = setTimeout(() => reject(new Error('no start: ' + out)), 10000);
        child.stdout.on('data', (d) => { out += d; const m = /listening on (http:\/\/[^\s]+)/.exec(out); if (m) { clearTimeout(t); resolve(m[1]); } });
      });
      const h = (await req(base, '/cfg/health')).json;
      assert.deepEqual([h.mode, h.client], ['local', 'disabled']);
    } finally { child.kill('SIGTERM'); }
  });
});

describe('built-in demo workspaces are seeded as read-only reference rows', () => {
  test('seeded rows + projections exist but never appear in GET /cfg/state', async () => {
    const fake = createFakeNocoBase();
    const srv = await startInProcess(fake, { seeds: () => builtinWorkspaces() });
    try {
      await req(srv.base, '/cfg/health');
      for (let i = 0; i < 50 && fake.rows('cfg_workspaces').length < 3; i++) await new Promise(r => setTimeout(r, 20));
      await srv.store.projectionsIdle();
      assert.deepEqual(fake.rows('cfg_workspaces').map(w => [w.slug, w.is_custom]).sort(), [['bluetokai', false], ['burgerking', false], ['starbucks', false]]);
      assert.equal(fake.rows('cfg_modules').filter(m => m.workspace_slug === 'bluetokai').length, 9);
      assert.equal((await req(srv.base, '/cfg/state')).text, '{}');
    } finally { srv.server.close(); }
  });
});

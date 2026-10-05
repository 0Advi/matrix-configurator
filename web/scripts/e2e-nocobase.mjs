#!/usr/bin/env node
// Live end-to-end check: web server (must be running) + real NocoBase.
//
//   node scripts/e2e-nocobase.mjs            # WEB_URL defaults to http://127.0.0.1:4300
//
// 1. /cfg/health must report mode 'nocobase'.
// 2. Refuses to run if the server already holds custom workspaces (never clobbers real data).
// 3. Generates a REAL v5 state blob by driving the shipped v5 logic in Node (create workspace
//    from template, publish with a reason, create an empty workspace), seeds it into a fake
//    browser localStorage and runs the browser sync engine against the server: the
//    first-run migration path (decideHydration → 'push').
// 4. Verifies through nocobase/lib/client.mjs: cfg_workspaces rows, cfg_modules/gates/stages
//    projections (vs lib/projection.mjs), byte-identical GET /cfg/state, the backfilled release,
//    a direct POST + duplicate POST of a release, GET /cfg/releases, and a 409 on a stale If-Match.
// 5. Cleans up everything it created (workspaces via PUT {}, its own release rows).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from '../lib/env.mjs';
import { loadV5, createMemoryStorage } from '../lib/v5-model.mjs';
import { projectWorkspace } from '../lib/projection.mjs';
import { createSyncEngine } from '../public/sync-engine.js';
import { STORAGE_KEY } from '../public/bridge-core.js';

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.dirname(WEB_DIR);
loadEnvFile(process.env.CFG_ENV_FILE || path.join(ROOT, '.env'));
const WEB = (process.env.WEB_URL || `http://127.0.0.1:${process.env.WEB_PORT || 4300}`).replace(/\/$/, '');
const SLUGS = ['e2e-migration', 'e2e-empty'];

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const json = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return t; } };

const health = await (await fetch(WEB + '/cfg/health')).json();
ok(health.mode === 'nocobase', `/cfg/health → mode=${health.mode} nocobase=${health.nocobase} client=${health.client}`);
if (health.mode !== 'nocobase') process.exit(1);

const before = await fetch(WEB + '/cfg/state');
const beforeText = await before.text();
if (beforeText !== '{}') {
  console.error('Server already holds custom workspaces; refusing to run (this test needs an empty state). Current slugs:',
    (JSON.parse(beforeText).customWs || []).map(w => w.slug).join(', '));
  process.exit(2);
}

const { createClient } = await import(pathToFileURL(path.join(ROOT, 'nocobase/lib/client.mjs')).href);
const nb = createClient();

// ---- a real v5 blob, as a browser that used the app before NocoBase existed would have it
const storage = createMemoryStorage();
const v5 = loadV5({ storage });
const c = v5.create();
c.setState({ newWs: { name: 'E2E Migration', slug: 'e2e-migration', start: 'template', slugTouched: true } });
c.createWorkspace();
c.setState({ publishReason: 'E2E: first go-live (migrated from browser)' });
c.publishVals().onConfirmPublish();
c.setState({ newWs: { name: 'E2E Empty', slug: 'e2e-empty', start: 'empty', slugTouched: true } });
c.createWorkspace();
const blobText = storage.getItem(STORAGE_KEY);
const blob = JSON.parse(blobText);

let cleanupEtag = null;
try {
  const engine = createSyncEngine({ fetch, storage, api: WEB + '/cfg', log: { info() {}, warn: console.warn } });
  const d = await engine.hydrate();
  ok(d.action === 'push', `bridge hydration decision on an empty server = ${d.action} (${d.reason})`);
  for (let i = 0; i < 100 && engine.status().status !== 'saved'; i++) await new Promise(r => setTimeout(r, 50));
  await engine.idle();
  ok(engine.status().status === 'saved', `bridge status after migration = ${engine.status().status}`);
  engine.stop();

  const get = await fetch(WEB + '/cfg/state');
  const getText = await get.text();
  cleanupEtag = get.headers.get('etag');
  ok(getText === blobText, `GET /cfg/state is byte-identical to the browser blob (${getText.length} bytes)`);

  const rows = (await nb.listWorkspaces()).filter(r => SLUGS.includes(r.slug));
  const m = rows.find(r => r.slug === 'e2e-migration'), e = rows.find(r => r.slug === 'e2e-empty');
  ok(rows.length === 2, `cfg_workspaces has both rows: ${rows.map(r => r.slug).join(', ')}`);
  ok(m && m.is_custom === true && m.live_version === 1 && m.draft_version === 2 && m.initials === 'E2', `e2e-migration row: is_custom=${m && m.is_custom} live=${m && m.live_version} draft=${m && m.draft_version} initials=${m && m.initials}`);
  ok(m && JSON.stringify(m.state.data) === JSON.stringify(blob.data.ws_e2e_migration), 'cfg_workspaces.state.data equals the v5 stash (key order preserved)');
  ok(e && e.live_version === 0 && e.draft_version === 1, 'e2e-empty row versions 0/1');

  // projections are asynchronous: wait for the server's queue to drain
  for (let i = 0; i < 200; i++) {
    const h = await (await fetch(WEB + '/cfg/health')).json();
    if (!h.projection.pending) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 300));
  const expect = projectWorkspace('e2e-migration', blob.data.ws_e2e_migration);
  for (const coll of ['cfg_modules', 'cfg_gates', 'cfg_stages']) {
    const got = await nb.list(coll, { filter: { workspace_slug: 'e2e-migration' } });
    const want = expect[coll.replace('cfg_', '')];
    ok(got.length === want.length, `${coll}: ${got.length} rows for e2e-migration (expected ${want.length})`);
  }
  const design = await nb.list('cfg_gates', { filter: { workspace_slug: 'e2e-migration', to_key: 'design' } });
  ok(design.map(g => g.from_key).sort().join() === 'finance_ca,legal', 'cfg_gates: design waits on legal + finance_ca');
  const bdStages = await nb.list('cfg_stages', { filter: { workspace_slug: 'e2e-migration', module_key: 'bd' }, sort: ['position'] });
  ok(bdStages.map(s => `${s.position}:${s.terminal}`).join() === '1:false,2:false,3:false,4:true', 'cfg_stages: BD positions/terminal flags');
  const mods = await nb.list('cfg_modules', { filter: { workspace_slug: 'e2e-migration' } });
  ok(mods.every(r => r.status === 'live'), 'cfg_modules: every module live after the publish');
  ok((await nb.list('cfg_modules', { filter: { workspace_slug: 'e2e-empty' } })).length === 0, 'cfg_modules: empty workspace has no modules');

  const rel = await json(await fetch(WEB + '/cfg/releases?ws=e2e-migration'));
  ok(Array.isArray(rel) && rel.length === 1 && rel[0].version === 1 && rel[0].reason === 'E2E: first go-live (migrated from browser)' && rel[0].published_by === 'platform:ops@matrix.io',
    `release backfilled from v5 history: v${rel[0] && rel[0].version} "${rel[0] && rel[0].reason}" by ${rel[0] && rel[0].published_by}`);
  ok(rel[0] && rel[0].manifest && rel[0].manifest.workspace.live_version === 'v1' && rel[0].manifest.modules.length === 9, 'release manifest mirrors v5 manifest() (v1, 9 modules)');

  const post = { workspace_slug: 'e2e-empty', version: 1, reason: 'E2E: direct POST', manifest: { workspace: { slug: 'e2e-empty' } }, published_by: 'e2e' };
  const p1 = await fetch(WEB + '/cfg/releases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post) });
  const p2 = await fetch(WEB + '/cfg/releases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post) });
  ok(p1.status === 201 && p2.status === 200 && (await json(p2)).duplicate === true, `POST /cfg/releases → ${p1.status}, repeat → ${p2.status} duplicate`);
  const list = await json(await fetch(WEB + '/cfg/releases?ws=e2e-empty'));
  ok(list.length === 1 && list[0].reason === 'E2E: direct POST', 'GET /cfg/releases?ws=e2e-empty → 1 row');

  const stale = await fetch(WEB + '/cfg/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': '"stale"' }, body: blobText });
  ok(stale.status === 409, `PUT with a stale If-Match → ${stale.status}`);
} finally {
  // ---- cleanup: only what this script created
  try {
    const cur = await fetch(WEB + '/cfg/state');
    const curBlob = JSON.parse(await cur.text());
    const foreign = (curBlob.customWs || []).filter(w => !SLUGS.includes(w.slug));
    if (foreign.length) {
      console.warn('Not resetting state: other workspaces appeared meanwhile:', foreign.map(w => w.slug).join(', '));
    } else {
      const r = await fetch(WEB + '/cfg/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': cur.headers.get('etag') }, body: '{}' });
      ok(r.status === 200, 'cleanup: PUT {} removed the e2e workspaces');
    }
    await nb.destroy('cfg_releases', { workspace_slug: { $in: SLUGS } });
    const left = await nb.list('cfg_releases', { filter: { workspace_slug: { $in: SLUGS } } });
    ok(left.length === 0, 'cleanup: e2e release rows removed');
  } catch (err) {
    ok(false, 'cleanup failed: ' + err.message);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll E2E checks passed');
process.exit(failures ? 1 : 0);

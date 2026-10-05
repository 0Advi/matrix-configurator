#!/usr/bin/env node
// Smoke test: exercises every client method against the live NocoBase instance using throwaway
// slugs (`__smoke__*`) and removes everything it created. Exits non-zero on any failure.
//
//   node nocobase/scripts/smoke.mjs

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { createClient } from '../lib/client.mjs';
import { loadEnv } from '../lib/env.mjs';

loadEnv();
const nb = createClient();
const S1 = '__smoke__';
const S2 = '__smoke_2__';
const SLUGS = [S1, S2];
let passed = 0;
let failed = 0;

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err?.stack?.split('\n').slice(0, 3).join('\n       ') || err}`);
  }
}

async function cleanup() {
  await nb.destroy('cfg_workspaces', { slug: { $in: SLUGS } });
  for (const c of ['cfg_releases', 'cfg_modules', 'cfg_gates', 'cfg_stages']) {
    await nb.destroy(c, { workspace_slug: { $in: SLUGS } });
  }
}

// Deliberately awkward document: key order that is not alphabetical, unicode, nesting, nulls,
// empty containers, numbers that are not integers.
const STATE = {
  zeta: 1,
  alpha: { list: [1, 'two', null, { deep: true }], text: 'ünïcødé ✓ "quoted" \\ back' },
  mid: 2.75,
  empty: {},
  none: null,
  arr: [],
};

console.log(`[smoke] NocoBase at ${nb.baseUrl}`);

await step('health() → true (deep) and never throws on a dead URL', async () => {
  strictEqual(await nb.health(), true);
  strictEqual(await nb.health({ deep: false }), true);
  strictEqual(await createClient({ baseUrl: 'http://127.0.0.1:9' }).health(), false);
});

await step('pre-clean leftovers from earlier runs', cleanup);

let ws;
await step('upsertWorkspace() creates; json round-trips with key order intact', async () => {
  ws = await nb.upsertWorkspace({ slug: S1, name: 'Smoke', initials: 'SM', is_custom: true, live_version: 0, draft_version: 1, state: STATE });
  ok(ws?.id, 'row has id');
  strictEqual(ws.slug, S1);
  strictEqual(ws.is_custom, true);
  strictEqual(ws.draft_version, 1);
  strictEqual(JSON.stringify(ws.state), JSON.stringify(STATE));
});

await step('upsertWorkspace() updates the same slug (no duplicate)', async () => {
  const again = await nb.upsertWorkspace({ slug: S1, name: 'Smoke v2', draft_version: 2, state: { b: 1, a: [2] } });
  strictEqual(again.id, ws.id);
  strictEqual(again.name, 'Smoke v2');
  strictEqual(again.initials, 'SM', 'untouched fields kept');
  deepStrictEqual(again.state, { b: 1, a: [2] });
  strictEqual(Object.keys(again.state).join(), 'b,a');
});

await step('get() by filter, by primary key, and null when missing', async () => {
  const byFilter = await nb.get('cfg_workspaces', { slug: S1 });
  strictEqual(byFilter.id, ws.id);
  const byPk = await nb.get('cfg_workspaces', ws.id);
  strictEqual(byPk.slug, S1);
  strictEqual(await nb.get('cfg_workspaces', { slug: '__smoke_missing__' }), null);
});

await step('create() + update() + destroy() on a generic collection', async () => {
  const row = await nb.create('cfg_gates', { workspace_slug: S1, from_key: 'a', to_key: 'b', condition: { op: 'all', rules: [] } });
  ok(row.id);
  const upd = await nb.update('cfg_gates', row.id, { to_key: 'c', condition: { op: 'any' } });
  strictEqual(upd.to_key, 'c');
  deepStrictEqual(upd.condition, { op: 'any' });
  strictEqual(await nb.update('cfg_gates', 1, { to_key: 'x' }), null, 'update of a missing pk returns null');
  await nb.destroy('cfg_gates', row.id);
  strictEqual(await nb.get('cfg_gates', row.id), null);
});

await step('list() follows pagination (7 rows, pageSize 2) and honours sort/filter/limit', async () => {
  await nb.create(
    'cfg_stages',
    Array.from({ length: 7 }, (_, i) => ({ workspace_slug: S1, module_key: 'm1', position: i, name: `s${i}`, terminal: i === 6, data: { i } })),
  );
  const all = await nb.list('cfg_stages', { filter: { workspace_slug: S1 }, sort: ['-position'], pageSize: 2 });
  deepStrictEqual(all.map((r) => r.position), [6, 5, 4, 3, 2, 1, 0]);
  const some = await nb.list('cfg_stages', { filter: { workspace_slug: S1, position: { $lt: 3 } }, sort: 'position', pageSize: 2 });
  deepStrictEqual(some.map((r) => r.position), [0, 1, 2]);
  strictEqual((await nb.list('cfg_stages', { filter: { workspace_slug: S1 }, pageSize: 2, limit: 3 })).length, 3);
});

await step('replaceWhere() swaps exactly the matching rows', async () => {
  await nb.create('cfg_modules', { workspace_slug: S2, module_key: 'keep', name: 'other workspace' });
  await nb.replaceWhere('cfg_modules', { workspace_slug: S1 }, [
    { workspace_slug: S1, module_key: 'old', name: 'Old' },
  ]);
  const created = await nb.replaceWhere('cfg_modules', { workspace_slug: S1 }, [
    { workspace_slug: S1, module_key: 'm1', name: 'One', glyph: '◆', kind: 'flow', status: 'live', route: '/one', data: { x: 1 } },
    { workspace_slug: S1, module_key: 'm2', name: 'Two', data: [1, 2] },
  ]);
  strictEqual(created.length, 2);
  const mine = await nb.list('cfg_modules', { filter: { workspace_slug: S1 }, sort: ['module_key'] });
  deepStrictEqual(mine.map((r) => r.module_key), ['m1', 'm2']);
  deepStrictEqual(mine[1].data, [1, 2]);
  strictEqual((await nb.list('cfg_modules', { filter: { workspace_slug: S2 } })).length, 1, 'other workspace untouched');
  deepStrictEqual(await nb.replaceWhere('cfg_modules', { workspace_slug: S2 }, []), []);
  strictEqual((await nb.list('cfg_modules', { filter: { workspace_slug: S2 } })).length, 0);
});

await step('appendRelease() + listReleases() (ordered by version)', async () => {
  await nb.appendRelease({ workspace_slug: S1, version: 2, reason: 'second', manifest: { modules: ['m1', 'm2'] }, published_by: 'smoke' });
  await nb.appendRelease({ workspace_slug: S1, version: 1, reason: 'first', manifest: { modules: ['m1'] }, published_by: 'smoke' });
  await nb.appendRelease({ workspace_slug: S2, version: 1, reason: 'other', manifest: {}, published_by: 'smoke' });
  const rels = await nb.listReleases(S1);
  deepStrictEqual(rels.map((r) => r.version), [1, 2]);
  deepStrictEqual(rels[1].manifest, { modules: ['m1', 'm2'] });
  strictEqual(rels[0].published_by, 'smoke');
  ok((await nb.listReleases()).length >= 3, 'listReleases() without slug returns all');
});

await step('listWorkspaces() includes the smoke workspaces', async () => {
  await nb.upsertWorkspace({ slug: S2, name: 'Smoke 2', state: {} });
  const slugs = (await nb.listWorkspaces()).map((w) => w.slug);
  ok(slugs.includes(S1) && slugs.includes(S2));
});

await step('deleteWorkspace() removes workspace + projections, keeps releases', async () => {
  await nb.deleteWorkspace(S1);
  strictEqual(await nb.get('cfg_workspaces', { slug: S1 }), null);
  for (const c of ['cfg_modules', 'cfg_gates', 'cfg_stages']) {
    strictEqual((await nb.list(c, { filter: { workspace_slug: S1 } })).length, 0, `${c} cleared`);
  }
  strictEqual((await nb.listReleases(S1)).length, 2, 'ledger kept');
});

await step('guards: destroy/replaceWhere refuse an empty filter', async () => {
  let threw = 0;
  await nb.destroy('cfg_workspaces', {}).catch(() => threw++);
  await nb.replaceWhere('cfg_modules', {}, []).catch(() => threw++);
  strictEqual(threw, 2);
});

await step('auth: session sign-in works, and a bad token falls back to sign-in on 401', async () => {
  const session = createClient({ token: '' });
  ok(Array.isArray(await session.list('cfg_workspaces', { pageSize: 1, limit: 1 })));
  strictEqual(session.authMode, 'session');
  const bad = createClient({ token: 'not-a-valid-token' });
  ok(Array.isArray(await bad.list('cfg_workspaces', { pageSize: 1, limit: 1 })));
  strictEqual(bad.authMode, 'session');
  const concurrent = createClient({ token: 'not-a-valid-token' });
  const results = await Promise.all(Array.from({ length: 6 }, () => concurrent.list('cfg_workspaces', { pageSize: 1, limit: 1 })));
  strictEqual(results.length, 6, 'concurrent 401s recover via one shared sign-in');
  const noCreds = createClient({ token: 'not-a-valid-token', email: '', password: '' });
  let status;
  await noCreds.list('cfg_workspaces').catch((e) => (status = e.status));
  strictEqual(status, 401);
});

await step('cleanup', async () => {
  await cleanup();
  for (const c of ['cfg_workspaces']) strictEqual((await nb.list(c, { filter: { slug: { $in: SLUGS } } })).length, 0);
  for (const c of ['cfg_releases', 'cfg_modules', 'cfg_gates', 'cfg_stages']) {
    strictEqual((await nb.list(c, { filter: { workspace_slug: { $in: SLUGS } } })).length, 0, `${c} clean`);
  }
});

console.log(`[smoke] ${passed} passed, ${failed} failed (auth mode: ${nb.authMode})`);
if (failed) {
  await cleanup().catch(() => {});
  process.exit(1);
}

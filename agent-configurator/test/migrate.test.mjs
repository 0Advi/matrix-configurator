// migrate_running / migration_status against the fake platform API's G3 migrations endpoints
// (docs/G3-API.md §1): dry run by default, execute only with confirm + reason, an execute is never
// re-sent, app errors are mapped, protected workspaces, app-only refs — and no secret in any output.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runOp, listOps } from '../lib/ops.mjs';
import { createMemoryStore } from '../lib/store.mjs';
import { createAppClient } from '../lib/app-api.mjs';
import { loadConfig } from '../lib/config.mjs';
import { startFakeApp, envFor, userBlob } from '../testkit/fakes.mjs';

let app, ctx;
const outputs = [];
const REF = 'ws_fake_smoke';

function makeCtx(extraEnv = {}) {
  const env = envFor(null, app, extraEnv);
  const config = loadConfig(env);
  // no real backoff in unit tests (the retry policy itself is what is under test)
  const client = createAppClient({ apiUrl: config.apiUrl, credentials: config.adminCredentials, sleep: () => Promise.resolve() });
  return createContext({ config, store: createMemoryStore(userBlob()), app: client });
}
async function run(op, args, c = ctx) {
  try { const r = await runOp(c, op, args); outputs.push(JSON.stringify(r)); return r; }
  catch (e) { outputs.push(JSON.stringify({ code: e.code, message: e.message, details: e.details })); throw e; }
}
async function fails(op, args, code, c = ctx) {
  try { await run(op, args, c); } catch (e) { assert.equal(e.code, code, e.message); return e; }
  assert.fail(op + ' should fail');
}
const seedWs = (ref, extra = {}) => app.st.workspaces.set(ref, { ref, status: 'active', tenant_id: 't-' + ref, company: 'Fake', code: 'FAKE-' + ref.toUpperCase(), seat_limit: 5, admin_email: 'owner@fake.test', releases: [{}, {}, {}], ...extra });

before(async () => {
  app = await startFakeApp();
  seedWs(REF);
  ctx = makeCtx();
});
after(() => app.close());

describe('migrate_running', () => {
  test('is a destructive op; migration_status is read-only', () => {
    const ops = Object.fromEntries(listOps().map(o => [o.name, o]));
    assert.equal(ops.migrate_running.destructive, true);
    assert.equal(ops.migrate_running.readOnly, false);
    assert.equal(ops.migration_status.readOnly, true);
    assert.equal(ops.migration_status.destructive, false);
  });

  test('default is a dry run: sends dry_run:true, reports counts and one line per case, moves nothing', async () => {
    const n = app.st.migrationBodies.length;
    const r = await run('migrate_running', { workspace: REF });
    assert.deepEqual(app.st.migrationBodies.slice(n), [{ dry_run: true }]);
    assert.equal(r.dry_run, true);
    assert.equal(r.executed, undefined);
    assert.match(r.note, /nothing was moved/);
    assert.deepEqual(r.workspace, { id: REF, in_draft_store: false });
    assert.deepEqual(r.counts, { cases: 3, sites: 3, compatible: 1, blocked: 1, would_migrate: 1, not_in_flight: 1 });
    assert.match(r.headline, /^Dry run every older release \(v1, v2\) → v3: 1 running case\(s\) would migrate, 1 blocked, on 2 site\(s\); 1 finished case\(s\) stay\. Nothing was moved\.$/);
    assert.equal(r.cases.length, 3);
    assert.equal(r.cases[0], 'Site One [BT-FAKE-1] · vendor_onboarding · v1 · completed · finished — stays on v1');
    assert.match(r.cases[1], /^Site Two \[BT-FAKE-2\] · vendor_onboarding · v1→v3 · in_progress · stage 3 “Sign-off” \(at supervisor\) → 3 “Sign-off” · WOULD MIGRATE · 2 approval\(s\) carried · fields: 1 dropped · warnings: fields_dropped$/);
    assert.match(r.cases[2], /· stage 3 “Sign-off” \(at supervisor\) → none · BLOCKED — stage_missing: Current stage 3 “Sign-off” has no counterpart in v3\.$/);
    assert.ok(r.next.some(x => /confirm:true and a reason/.test(x)));
    assert.ok(r.next.some(x => /stage_map/.test(x)), 'blocked cases get a hint');
    assert.equal(r.raw.dry_run, true);
    assert.equal(r.raw.items.length, 3, 'raw result passed through');
    assert.equal(app.st.migrations.length, 0, 'nothing executed');
  });

  test('a reason without confirm stays a dry run', async () => {
    const r = await run('migrate_running', { workspace: REF, reason: 'hot-fix' });
    assert.equal(r.dry_run, true);
    assert.equal(app.st.migrationBodies.at(-1).dry_run, true);
    assert.equal(app.st.migrations.length, 0);
  });

  test('confirm without a (≥3 char) reason is refused before anything is sent', async () => {
    const n = app.st.migrationBodies.length;
    await fails('migrate_running', { workspace: REF, confirm: true }, 'invalid_input');
    await fails('migrate_running', { workspace: REF, confirm: true, reason: '  x ' }, 'invalid_input');
    await fails('migrate_running', { workspace: REF, confirm: true, reason: 'x'.repeat(501) }, 'invalid_input');
    assert.equal(app.st.migrationBodies.length, n, 'nothing sent');
    assert.equal(app.st.migrations.length, 0);
  });

  test('bad arguments are refused by the schema', async () => {
    await fails('migrate_running', { workspace: REF, from_release_version: 'latest' }, 'invalid_input');
    await fails('migrate_running', { workspace: REF, scope: { modules: ['x'] } }, 'invalid_input');
    await fails('migrate_running', { workspace: REF, stage_map: { vendor_onboarding: { 3: 'two' } } }, 'invalid_input');
    await fails('migrate_running', { workspace: REF, dry_run: false }, 'invalid_input');
  });

  test('confirm + reason executes once and passes scope / from / to / stage_map / restart through', async () => {
    const n = app.st.migrationBodies.length;
    const args = { workspace: REF, from_release_version: 1, to_release_version: 3, scope: { module_keys: ['vendor_onboarding'] }, stage_map: { vendor_onboarding: { 3: 3, 4: null } }, restart_stage_on_chain_change: true, reason: '  Hot-fix: sign-off renamed  ', confirm: true };
    const r = await run('migrate_running', args);
    assert.deepEqual(app.st.migrationBodies.slice(n), [{ from_release_version: 1, to_release_version: 3, scope: { module_keys: ['vendor_onboarding'] }, reason: 'Hot-fix: sign-off renamed', dry_run: false, stage_map: { vendor_onboarding: { 3: 3, 4: null } }, restart_stage_on_chain_change: true }]);
    assert.equal(r.executed, true);
    assert.equal(r.dry_run, undefined);
    assert.equal(r.migration_id, app.st.migrations[0].id);
    assert.deepEqual(r.counts, { cases: 3, sites: 3, compatible: 1, blocked: 1, migrated: 1, skipped: 1, failed: 0, not_in_flight: 1 });
    assert.equal(r.headline, `Migration ${r.migration_id}: 1 case(s) migrated, 1 skipped, 0 failed (v1 → v3, 2 site(s)).`);
    assert.match(r.cases[1], /· MIGRATED · 2 approval\(s\) carried/);
    assert.match(r.cases[2], /· SKIPPED — stage_missing: /);
    assert.ok(r.next.some(x => x.includes(`migration_status {workspace, migration_id: "${r.migration_id}"}`)));
    assert.equal(app.st.migrations.length, 1);
  });

  test('nothing to migrate is said plainly', async () => {
    const r = await run('migrate_running', { workspace: REF, scope: { module_keys: ['other_module'] } });
    assert.deepEqual(r.cases, []);
    assert.match(r.headline, /^Nothing to migrate: no running custom-module cases on every older release \(v1, v2\) in scope \(target v3\)\.$/);
  });

  test('an execute is never re-sent: 502 → sent once', async () => {
    const n = app.st.migrationBodies.length, m = app.st.migrations.length;
    app.st.migrateFail = { status: 502, times: 5 };
    const e = await fails('migrate_running', { workspace: REF, reason: 'hot-fix', confirm: true }, 'app_error');
    app.st.migrateFail = null;
    assert.equal(app.st.migrationBodies.length - n, 1, 'execute sent exactly once');
    assert.match(e.message, /NOT re-sent/);
    assert.match(e.message, /migration_status/);
    assert.equal(app.st.migrations.length, m);
  });

  test('an execute is never re-sent: connection reset after sending → sent once, reported unavailable', async () => {
    const n = app.st.migrationBodies.length;
    app.st.migrateFail = { status: 'reset', times: 5 };
    const e = await fails('migrate_running', { workspace: REF, reason: 'hot-fix', confirm: true }, 'unavailable');
    app.st.migrateFail = null;
    assert.equal(app.st.migrationBodies.length - n, 1, 'execute sent exactly once');
    assert.match(e.message, /migration_status/);
  });

  test('a dry run writes nothing, so it IS retried on 502 / connection reset', async () => {
    let n = app.st.migrationBodies.length;
    app.st.migrateFail = { status: 502, times: 2 };
    const r = await run('migrate_running', { workspace: REF });
    assert.equal(r.dry_run, true);
    assert.equal(app.st.migrationBodies.length - n, 3, 'two 502s then success');
    n = app.st.migrationBodies.length;
    app.st.migrateFail = { status: 'reset', times: 1 };
    assert.equal((await run('migrate_running', { workspace: REF })).dry_run, true);
    assert.equal(app.st.migrationBodies.length - n, 2);
    app.st.migrateFail = null;
  });

  test('app refusals are mapped to op errors', async () => {
    await fails('migrate_running', { workspace: 'ws_not_provisioned' }, 'not_found');
    const e = await fails('migrate_running', { workspace: REF, to_release_version: 9 }, 'invalid_input');
    assert.equal(e.details.code, 'unknown_release');
    assert.equal((await fails('migrate_running', { workspace: REF, from_release_version: 3 }, 'invalid_input')).details.code, 'same_release');
    seedWs('ws_fake_suspended', { status: 'suspended' });
    assert.equal((await fails('migrate_running', { workspace: 'ws_fake_suspended' }, 'refused')).details.code, 'workspace_not_active');
    await fails('migrate_running', { workspace: 'not a ref!' }, 'not_found');
  });

  test('a draft-store workspace resolves by slug; protected ids may be dry-run but never executed', async () => {
    seedWs('ws_aditya_test');
    const c = makeCtx({ CFG_PROTECTED_WORKSPACES: 'ws_aditya_test' });
    const dry = await run('migrate_running', { workspace: 'aditya-test' }, c);
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.workspace, { id: 'ws_aditya_test', slug: 'aditya-test', name: 'ADITYA TEST' });
    const n = app.st.migrationBodies.length;
    await fails('migrate_running', { workspace: 'aditya-test', reason: 'hot-fix', confirm: true }, 'refused', c);
    assert.equal(app.st.migrationBodies.length, n, 'nothing sent for a protected workspace');
  });
});

describe('migration_status', () => {
  test('lists executed runs (newest first) and shows one with its journal; pre-state only on request', async () => {
    const l = await run('migration_status', { workspace: REF });
    assert.equal(l.count, 1);
    const id = app.st.migrations[0].id;
    assert.match(l.migrations[0], new RegExp(`^${id} · done · v1 → v3 · .* · “Hot-fix: sign-off renamed” · not_in_flight 1, migrated 1, skipped 1$`));
    const d = await run('migration_status', { workspace: REF, migration_id: id });
    assert.equal(d.status, 'done');
    assert.deepEqual(d.journal, [
      'site 00000000-0000-4000-8000-000000000102 · pin v1 → v3',
      'case 00000000-0000-4000-8000-000000000002 · vendor_onboarding · v1 → v3 · stage 3 “Sign-off” → 3 “Sign-off”',
    ]);
    assert.equal(JSON.stringify(d).includes('PRE-STATE-MARKER'), false, 'pre-migration state hidden by default');
    const full = await run('migration_status', { workspace: REF, migration_id: id, include_pre_state: true });
    assert.equal(full.raw.items[1].before_state.values.old_note, 'PRE-STATE-MARKER');
    await fails('migration_status', { workspace: REF, migration_id: '99999999-9999-4999-8999-999999999999' }, 'not_found');
    await fails('migration_status', { workspace: REF, migration_id: 'nope' }, 'invalid_input');
  });

  test('an empty history says so', async () => {
    seedWs('ws_fake_quiet');
    const r = await run('migration_status', { workspace: 'ws_fake_quiet' });
    assert.equal(r.count, 0);
    assert.match(r.note, /dry runs are never stored/);
  });
});

test('no secret ever appears in an output', () => {
  const all = outputs.join('\n');
  assert.ok(outputs.length > 20);
  assert.equal(all.includes(app.creds.password), false, 'password never output');
  for (const t of app.st.tokens) assert.equal(all.includes(t), false, 'token never output');
});

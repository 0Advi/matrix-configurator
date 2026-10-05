// Publish end to end against the REAL configurator server handler (fake NocoBase underneath) and a
// fake Matrix platform API: provisioning on first publish, v5 bookkeeping, app release, design-time
// ledger, rollback on refusal, resend, rate limits, token expiry — and no secret ever leaks.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runOp } from '../lib/ops.mjs';
import { manifestOf, resolveWorkspace } from '../lib/model.mjs';
import { startCfgServer, startFakeApp, envFor, userBlob, userFingerprint } from '../testkit/fakes.mjs';

let cfg, app, ctx, fp0;
const outputs = [];
async function run(op, args, c = ctx) {
  try { const r = await runOp(c, op, args); outputs.push(JSON.stringify(r)); return r; }
  catch (e) { outputs.push(JSON.stringify({ code: e.code, message: e.message, details: e.details })); throw e; }
}
async function fails(op, args, code, c = ctx) {
  try { await run(op, args, c); } catch (e) { assert.equal(e.code, code, e.message); return e; }
  assert.fail(op + ' should fail');
}
async function draft(ref = 'ws_agent_coffee') { const { blob } = await cfg.state(); return resolveWorkspace(blob, ref); }

before(async () => {
  cfg = await startCfgServer(userBlob());
  app = await startFakeApp();
  ctx = createContext({ env: envFor(cfg, app), today: () => new Date('2026-10-05T10:00:00Z') });
  fp0 = userFingerprint((await cfg.state()).blob);
  await run('create_workspace', { name: 'Agent Coffee' });
  await run('add_builtin_module', { workspace: 'agent-coffee', key: 'bd' });
  await run('add_builtin_module', { workspace: 'agent-coffee', key: 'legal' });
  await run('add_custom_module', { workspace: 'agent-coffee', name: 'Supplier Audit', starts_after: ['bd'], stages: [
    { name: 'Audit visit', approvers: ['executive', 'supervisor'], outcome: 'submitted', fields: [{ label: 'Hygiene OK', kind: 'yesno', required: true, affects_outcome: true }] },
    { name: 'Supervisor sign-off', approvers: ['supervisor'], outcome: 'approved' }] });
});
after(async () => { await cfg.close(); await app.close(); });

describe('publish', () => {
  test('requires a reason; dry run shows the plan incl. provisioning', async () => {
    await fails('publish', { workspace: 'agent-coffee' }, 'invalid_input');
    const r = await run('publish', { workspace: 'agent-coffee', reason: 'first go-live' });
    assert.equal(r.dry_run, true);
    assert.equal(r.version.to, 'v1');
    assert.equal(r.app_validation.ok, true);
    assert.deepEqual(r.provisioning, { will_provision: true, missing: 'provision.admin_email' });
    assert.equal((await draft()).stash.liveV, 0, 'dry run wrote nothing');
  });

  test('confirm without provisioning details → needs_provisioning, nothing changes', async () => {
    await fails('publish', { workspace: 'agent-coffee', reason: 'first go-live', confirm: true }, 'needs_provisioning');
    assert.equal(app.st.workspaces.size, 0);
    assert.equal((await draft()).stash.liveV, 0);
  });

  test('first publish provisions, publishes v1 and returns the one-time setup code once', async () => {
    const r = await run('publish', { workspace: 'agent-coffee', reason: 'first go-live', confirm: true, provision: { admin_email: 'owner@agent-coffee.test', admin_name: 'Asha Owner', seat_limit: 12 } });
    assert.equal(r.published, true);
    assert.equal(r.configurator_version, 'v1');
    assert.equal(r.next_draft, 'v2');
    assert.equal(r.configurator_says, 'Published v1 by agent:test-agent — Live is now v1.');
    assert.equal(r.app_release.version, 1);
    assert.equal(r.app_release.source_ref, 'configurator:ws_agent_coffee@v1');
    assert.match(r.provisioned.workspace_code, /^FAKE-/);
    assert.equal(r.provisioned.setup_code, app.st.workspaces.get('ws_agent_coffee').setup);
    assert.match(r.provisioned.setup_code_warning, /ONE-TIME SECRET/);
    assert.equal(r.provisioned.login_url, 'http://localhost:5173/#/login/' + r.provisioned.workspace_code);
    // draft store: v5 bookkeeping
    const { cw, stash } = await draft();
    assert.equal(stash.liveV, 1); assert.equal(stash.draftV, 2);
    assert.equal(stash.history[0].reason, 'first go-live');
    assert.equal(stash.history[0].meta, '05 Oct 2026 · agent:test-agent');
    assert.ok(stash.modules.every(m => m.status === 'live'));
    // app got exactly v5's post-publish manifest
    const rel = app.st.workspaces.get('ws_agent_coffee').releases[0];
    assert.deepEqual(rel.manifest, manifestOf(cw, stash));
    assert.equal(rel.reason, 'first go-live');
    // design-time ledger (cfg_releases), like the browser bridge
    const ledger = cfg.fake.rows('cfg_releases');
    assert.deepEqual(ledger.map(x => [x.workspace_slug, x.version, x.published_by]), [['agent-coffee', 1, 'agent:test-agent']]);
  });

  test('nothing to publish when the draft matches live', async () => {
    const e = await fails('publish', { workspace: 'agent-coffee', reason: 'again', confirm: true }, 'invalid_input');
    assert.match(e.message, /Draft matches live v1/);
  });

  test('second publish: no provisioning, no setup code, workspace code repeated', async () => {
    await run('disable_module', { workspace: 'agent-coffee', module: 'legal' });
    const r = await run('publish', { workspace: 'agent-coffee', reason: 'legal off', confirm: true });
    assert.equal(r.app_release.version, 2);
    assert.equal(r.provisioned, undefined);
    assert.match(r.workspace_code, /^FAKE-/);
    assert.ok(r.changes.some(c => /Legal & Compliance: turned off/.test(c)));
    assert.equal(app.st.workspaces.get('ws_agent_coffee').modules.find(m => m.key === 'legal').enabled, false);
  });

  test('app refusal rolls the draft back', async () => {
    await run('enable_module', { workspace: 'agent-coffee', module: 'legal' });
    app.st.publishStatus = 422;
    const e = await fails('publish', { workspace: 'agent-coffee', reason: 'legal back', confirm: true }, 'refused');
    assert.equal(e.details.rolled_back_draft, true);
    const { stash } = await draft();
    assert.equal(stash.liveV, 2, 'still v2 live');
    assert.equal(stash.modules.find(m => m.key === 'legal').enabled, true, 'draft edit kept');
  });

  test('app dry-run errors block the publish', async () => {
    app.st.validateErrors = [{ severity: 'error', code: 'gate_invalid', message: 'forced', module: 'supplier_audit' }];
    const e = await fails('publish', { workspace: 'agent-coffee', reason: 'legal back', confirm: true }, 'refused');
    assert.equal(e.details.app_validation.errors, 1);
    const v = await run('validate', { workspace: 'agent-coffee' });
    assert.equal(v.verdict, 'blocked');
    app.st.validateErrors = [];
  });

  test('broken-flow findings block unless accept_findings', async () => {
    await run('set_gate', { workspace: 'agent-coffee', module: 'supplier_audit', starts_after: ['legal'] });
    await run('disable_module', { workspace: 'agent-coffee', module: 'legal', also_disable_dependents: true });
    await run('enable_module', { workspace: 'agent-coffee', module: 'legal' });
    await run('enable_module', { workspace: 'agent-coffee', module: 'supplier_audit' });
    const p = await run('set_gate', { workspace: 'agent-coffee', module: 'supplier_audit', conditions: [{ source: 'legal', outcome: 'skipped' }], allow_new_findings: true });
    assert.equal(p.new_findings[0].tag, 'unreachable');
    const e = await fails('publish', { workspace: 'agent-coffee', reason: 'x', confirm: true }, 'refused');
    assert.match(e.message, /broken-flow finding/);
    assert.equal((await draft()).stash.liveV, 2);
    await run('set_gate', { workspace: 'agent-coffee', module: 'supplier_audit', starts_after: ['bd'] });
  });

  test('token expiry → one re-login; resend_live re-syncs a lost hand-off', async () => {
    const logins = app.st.logins;
    app.st.expireTokens = true;
    const r = await run('publish', { workspace: 'agent-coffee', reason: 'legal back on', confirm: true });
    assert.equal(r.app_release.version, 3);
    assert.equal(app.st.logins, logins + 1);
    app.st.workspaces.get('ws_agent_coffee').releases.pop();   // simulate a lost hand-off of v3
    let s = await run('release_status', { workspace: 'agent-coffee' });
    assert.equal(s.in_sync, false);
    const dry = await run('publish', { workspace: 'agent-coffee', resend_live: true });
    assert.equal(dry.dry_run, true);
    const re = await run('publish', { workspace: 'agent-coffee', resend_live: true, confirm: true });
    assert.equal(re.resent, true);
    s = await run('release_status', { workspace: 'agent-coffee' });
    assert.equal(s.in_sync, true);
    assert.equal(s.app.business_admin.claimed, false);
    assert.ok(s.app.modules.some(m => m.key === 'supplier_audit' && m.route === '/m/supplier_audit'));
  });

  test('rate-limited sign-in is reported, not retried in a loop', async () => {
    const c2 = createContext({ env: envFor(cfg, app) });
    app.st.loginStatus = 429;
    const before = app.st.logins;
    const v = await run('validate', { workspace: 'agent-coffee' }, c2);
    assert.equal(v.app.code, 'rate_limited');
    assert.match(v.app.skipped, /Wait up to 300s/);
    assert.equal(app.st.logins - before, 1);
    await run('update_module', { workspace: 'agent-coffee', module: 'supplier_audit', name: 'Supplier Audits' }, c2);
    await fails('publish', { workspace: 'agent-coffee', reason: 'x', confirm: true }, 'rate_limited', c2);
    assert.equal((await draft()).stash.liveV, 3, 'nothing published while rate limited');
    app.st.loginStatus = null;
  });

  test('list_workspaces include_app joins both sides', async () => {
    const l = await run('list_workspaces', { include_app: true });
    const w = l.workspaces.find(x => x.id === 'ws_agent_coffee');
    assert.equal(w.app.status, 'active');
    assert.equal(w.live, 'v3');
  });

  test('no secret ever appears in an output; the setup code only once; user workspaces untouched', async () => {
    const all = outputs.join('\n');
    assert.equal(all.includes(app.creds.password), false, 'password never output');
    for (const t of app.st.tokens) assert.equal(all.includes(t), false, 'token never output');
    const setup = app.st.workspaces.get('ws_agent_coffee').setup;
    assert.equal(all.split(setup).length - 1, 1, 'setup code shown exactly once');
    assert.deepEqual(userFingerprint((await cfg.state()).blob), fp0);
  });
});

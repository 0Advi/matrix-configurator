// Every op on real v5 data (Blue Tokai template, production Matrix-bd flow, wizard templates),
// against an in-memory store with the server's ETag semantics and a fake platform API.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runOp, listOps } from '../lib/ops.mjs';
import { createMemoryStore } from '../lib/store.mjs';
import { findingsOf, classify, schemaErrors, resolveWorkspace } from '../lib/model.mjs';
import { startFakeApp, envFor, userBlob, userFingerprint } from '../testkit/fakes.mjs';

let app;
before(async () => { app = await startFakeApp(); });
after(() => app.close());

function ctxWith(store, extra = {}) {
  return createContext({ store, env: envFor(null, app, extra), today: () => new Date('2026-10-05T10:00:00Z') });
}
async function ok(ctx, op, args) { return runOp(ctx, op, args); }
async function fails(ctx, op, args, code) {
  try { await runOp(ctx, op, args); } catch (e) { if (code) assert.equal(e.code, code, e.message); return e; }
  assert.fail(`${op} should have failed`);
}
async function stashOf(store, ref) { const { blob } = await store.read(); return resolveWorkspace(blob, ref).stash; }
async function assertClean(store, ref) {
  const s = await stashOf(store, ref);
  assert.deepEqual(schemaErrors(s), [], 'schema-valid');
  assert.deepEqual(classify(findingsOf(s)).errors, [], 'no v5 error findings');
}

describe('read-only ops', () => {
  test('catalogue lists built-ins, templates and vocabularies', async () => {
    const r = await ok(ctxWith(createMemoryStore()), 'catalogue', {});
    assert.deepEqual(r.builtin_modules.map(b => b.key), ['bd', 'legal', 'finance_ca', 'design', 'project', 'nso', 'pex', 'launch_approval', 'financial_closure']);
    assert.equal(r.builtin_modules.find(b => b.key === 'pex').app_key, 'project_excellence');
    assert.ok(r.custom_module_templates.vendor.stages.length === 2);
    assert.ok(r.vocabularies.outcomes.includes('approved'));
    assert.ok(r.vocabularies.field_kinds.every(k => k.hint_format));
  });
  test('ops registry: every op has a description and an object input schema', () => {
    const ops = listOps();
    assert.ok(ops.length >= 28);
    for (const o of ops) { assert.ok(o.description.length > 60, o.name); assert.equal(o.inputSchema.type, 'object'); assert.equal(o.inputSchema.additionalProperties, false); }
  });
  test('unknown op and bad arguments are refused with invalid_input', async () => {
    const ctx = ctxWith(createMemoryStore());
    await fails(ctx, 'nope', {}, 'invalid_input');
    const e = await fails(ctx, 'create_workspace', { name: 'X', bogus: 1 }, 'invalid_input');
    assert.match(e.message, /unexpected property bogus/);
    await fails(ctx, 'set_gate', { workspace: 'x', module: 'y', match: 'some' }, 'invalid_input');
  });
  test('demo workspaces are explained, not found', async () => {
    const e = await fails(ctxWith(createMemoryStore()), 'show_workspace', { workspace: 'bluetokai' }, 'not_found');
    assert.match(e.message, /never persists/);
  });
});

describe('workspace lifecycle on the Blue Tokai template', () => {
  const store = createMemoryStore(userBlob());
  let ctx, fp0;
  before(async () => { ctx = ctxWith(store); fp0 = userFingerprint((await store.read()).blob); });

  test('create_workspace (template bluetokai) = v5 "Copy the Blue Tokai template"', async () => {
    const r = await ok(ctx, 'create_workspace', { name: 'Agent Coffee', template: 'bluetokai' });
    assert.equal(r.workspace.id, 'ws_agent_coffee');
    assert.equal(r.workspace.created, '05 Oct 2026');
    assert.equal(r.modules.length, 9);
    await assertClean(store, 'agent-coffee');
    await fails(ctx, 'create_workspace', { name: 'Agent Coffee' }, 'invalid_input');           // slug taken
    await fails(ctx, 'create_workspace', { name: 'Admin' }, 'invalid_input');                  // reserved
    await fails(ctx, 'create_workspace', { name: 'x', slug: 'Bad Slug' }, 'invalid_input');
  });

  test('list_workspaces + show_workspace', async () => {
    const l = await ok(ctx, 'list_workspaces', {});
    assert.deepEqual(l.workspaces.map(w => w.id), ['ws_aditya_test', 'ws_chai_point_retail', 'ws_agent_coffee']);
    const s = await ok(ctx, 'show_workspace', { workspace: 'Agent Coffee', include_manifest: true });
    assert.equal(s.modules.length, 9);
    assert.equal(s.manifest.workspace.id, 'ws_agent_coffee');
    assert.match(s.modules.find(m => m.key === 'legal').gate_sentence, /BD is done/);
  });

  test('disable_module refuses while enabled modules wait on it, cascades on request', async () => {
    const e = await fails(ctx, 'disable_module', { workspace: 'agent-coffee', module: 'design' }, 'refused');
    assert.match(e.message, /stuck with no way forward/);
    const r = await ok(ctx, 'disable_module', { workspace: 'agent-coffee', module: 'nso', also_disable_dependents: true });
    assert.deepEqual(r.changes.length, 3); // nso, launch_approval, financial_closure
    const s = await stashOf(store, 'agent-coffee');
    assert.deepEqual(s.modules.filter(m => !m.enabled).map(m => m.key).sort(), ['financial_closure', 'launch_approval', 'nso']);
    await assertClean(store, 'agent-coffee');
    const en = await ok(ctx, 'enable_module', { workspace: 'agent-coffee', module: 'nso' });
    assert.match(en.changes[0], /turned on/);
  });

  test('add_custom_module through the v5 wizard: stages, approvers, fields, gate', async () => {
    const r = await ok(ctx, 'add_custom_module', {
      workspace: 'agent-coffee', name: 'Roastery Audit', starts_after: ['legal'],
      stages: [
        { name: 'Audit visit', approvers: ['executive', 'supervisor'], outcome: 'submitted', fields: [
          { label: 'Visit date', kind: 'date', required: true },
          { label: 'Hygiene OK', kind: 'yesno', required: true, affects_outcome: true },
          { label: 'Score', kind: 'number', validation: 'min 0 · max 100' }] },
        { name: 'Supervisor sign-off', approvers: ['supervisor'], outcome: 'approved' }],
    });
    assert.equal(r.module.key, 'roastery_audit');
    assert.equal(r.module.route, '/m/roastery_audit');
    assert.deepEqual(r.module.gate.conditions, [{ source: 'legal', outcome: 'approved' }]);
    assert.ok(r.notes.some(n => /score: hint .* minimum 0, maximum 100/.test(n)));
    const s = await stashOf(store, 'agent-coffee');
    const m = s.modules.find(x => x.key === 'roastery_audit');
    assert.equal(m.nav[0].items.length, 4, 'wizSave nav: overview, queue, review, history');
    assert.deepEqual(m.pages.map(p => p[0]), ['overview', 'queue', 'history', 'review']);
    await assertClean(store, 'agent-coffee');
    // key rules: v5 reserved word, built-in key in the app, collision
    await fails(ctx, 'add_custom_module', { workspace: 'agent-coffee', name: 'Reports' }, 'invalid_input');
    await fails(ctx, 'add_custom_module', { workspace: 'agent-coffee', name: 'X', key: 'project_excellence' }, 'invalid_input');
    await fails(ctx, 'add_custom_module', { workspace: 'agent-coffee', name: 'Roastery Audit' }, 'invalid_input');
    // gate on an outcome the source can never reach → refused
    await fails(ctx, 'add_custom_module', { workspace: 'agent-coffee', name: 'Yard check', gate: { conditions: [{ source: 'legal', outcome: 'skipped' }] } }, 'refused');
  });

  test('wizard templates (vendor) and custom roll-up', async () => {
    const r = await ok(ctx, 'add_custom_module', { workspace: 'agent-coffee', name: 'Vendor Onboarding', template: 'vendor', rollup: { strategy: 'count_at_least', n: 2, of: 3 } });
    assert.equal(r.module.stages.length, 2);
    assert.equal(r.module.rollup.strategy, 'count_at_least');
    const p = await ok(ctx, 'set_outcome', { workspace: 'agent-coffee', module: 'vendor_onboarding', rollup: { strategy: 'custom' } });
    assert.ok(p.notes.some(n => /Pending engineering/.test(n)));
    const s = await stashOf(store, 'agent-coffee');
    assert.equal(s.modules.find(m => m.key === 'vendor_onboarding').pendingEng, true);
    await ok(ctx, 'set_outcome', { workspace: 'agent-coffee', module: 'vendor_onboarding', rollup: { strategy: 'all_positive' }, exit_signal: 'approved' });
    await assertClean(store, 'agent-coffee');
  });

  test('set_gate: any/all, cycle refused, dead gate refused, clear', async () => {
    const r = await ok(ctx, 'set_gate', { workspace: 'agent-coffee', module: 'roastery_audit', match: 'any', conditions: [{ source: 'legal' }, { source: 'finance_ca' }] });
    assert.match(r.changes[0], /OR/);
    const cyc = await fails(ctx, 'set_gate', { workspace: 'agent-coffee', module: 'legal', starts_after: ['roastery_audit'] }, 'refused');
    assert.match(cyc.message, /Gate cycle/);
    await ok(ctx, 'disable_module', { workspace: 'agent-coffee', module: 'vendor_onboarding' });
    const dead = await fails(ctx, 'set_gate', { workspace: 'agent-coffee', module: 'roastery_audit', starts_after: ['vendor_onboarding'] }, 'refused');
    assert.match(dead.message, /turned off/);
    // a deliberate partial step is allowed and reported
    const partial = await ok(ctx, 'set_gate', { workspace: 'agent-coffee', module: 'roastery_audit', starts_after: ['vendor_onboarding'], allow_new_findings: true });
    assert.equal(partial.new_findings[0].tag, 'dead gate');
    await ok(ctx, 'set_gate', { workspace: 'agent-coffee', module: 'roastery_audit', conditions: [{ source: 'legal', outcome: 'approved' }], refusal: 'Waiting for legal.' });
    let s = await stashOf(store, 'agent-coffee');
    assert.deepEqual(s.modules.find(m => m.key === 'roastery_audit').gate, { match: 'any', conds: [{ src: 'legal', out: 'approved' }], refusal: 'Waiting for legal.', touched: true });
    await ok(ctx, 'set_gate', { workspace: 'agent-coffee', module: 'vendor_onboarding', clear: true });
    s = await stashOf(store, 'agent-coffee');
    assert.equal(s.modules.find(m => m.key === 'vendor_onboarding').gate, null);
    await assertClean(store, 'agent-coffee');
  });

  test('stages: add / update / set_approvers / remove (dry run first)', async () => {
    await ok(ctx, 'add_stage', { workspace: 'agent-coffee', module: 'roastery_audit', stage: { name: 'Admin sign-off', approvers: ['supervisor', 'business_admin'] }, position: 3 });
    await fails(ctx, 'add_stage', { workspace: 'agent-coffee', module: 'roastery_audit', stage: { name: 'audit visit' } }, 'invalid_input'); // duplicate name
    await fails(ctx, 'add_stage', { workspace: 'agent-coffee', module: 'legal', stage: { name: 'X' } }, 'invalid_input');                   // built-in locked
    await ok(ctx, 'update_stage', { workspace: 'agent-coffee', module: 'roastery_audit', stage: 'Admin sign-off', changes: { outcome: 'done', position: 1 } });
    await ok(ctx, 'set_approvers', { workspace: 'agent-coffee', module: 'roastery_audit', stage: 1, approvers: ['business_admin'] });
    let s = await stashOf(store, 'agent-coffee');
    let m = s.modules.find(x => x.key === 'roastery_audit');
    assert.deepEqual(m.stages.map(x => [x.name, x.outcome, x.approvers.join('+')]), [['Admin sign-off', 'done', 'business_admin'], ['Audit visit', 'submitted', 'executive+supervisor'], ['Supervisor sign-off', 'approved', 'supervisor']]);
    const dry = await ok(ctx, 'remove_stage', { workspace: 'agent-coffee', module: 'roastery_audit', stage: 1 });
    assert.equal(dry.dry_run, true);
    s = await stashOf(store, 'agent-coffee');
    assert.equal(s.modules.find(x => x.key === 'roastery_audit').stages.length, 3, 'dry run wrote nothing');
    await ok(ctx, 'remove_stage', { workspace: 'agent-coffee', module: 'roastery_audit', stage: 1, confirm: true });
    s = await stashOf(store, 'agent-coffee');
    assert.equal(s.modules.find(x => x.key === 'roastery_audit').stages.length, 2);
    await assertClean(store, 'agent-coffee');
  });

  test('fields: add / update / remove, hint parity notes, duplicate keys', async () => {
    const a = await ok(ctx, 'add_field', { workspace: 'agent-coffee', module: 'roastery_audit', stage: 'Audit visit', field: { label: 'Roast profile', kind: 'choice', validation: 'light · medium · dark', affects_outcome: true } });
    assert.match(a.notes[0], /options: light \| medium \| dark/);
    const b = await ok(ctx, 'add_field', { workspace: 'agent-coffee', module: 'roastery_audit', stage: 2, field: { label: 'Comment', validation: 'free words' } });
    assert.match(b.notes[0], /not machine-readable/);
    await fails(ctx, 'add_field', { workspace: 'agent-coffee', module: 'roastery_audit', stage: 'Audit visit', field: { label: 'Roast Profile' } }, 'invalid_input');
    await ok(ctx, 'update_field', { workspace: 'agent-coffee', module: 'roastery_audit', stage: 'Audit visit', field: 'roast_profile', changes: { required: true, label: 'Roast level' } });
    await ok(ctx, 'remove_field', { workspace: 'agent-coffee', module: 'roastery_audit', stage: 2, field: 'comment', confirm: true });
    const s = await stashOf(store, 'agent-coffee');
    const f = s.modules.find(x => x.key === 'roastery_audit').stages[0].fields.find(x => x.key === 'roast_profile');
    assert.deepEqual([f.label, f.required, f.affects, f.kind], ['Roast level', true, true, 'choice']);
    assert.match(f.id, /^f_\d+$/);
    await assertClean(store, 'agent-coffee');
  });

  test('set_tiers: supervisor-only strips executives; set_permission respects the ceiling', async () => {
    await fails(ctx, 'set_tiers', { workspace: 'agent-coffee', module: 'vendor_onboarding', supervisor_only: true }, 'invalid_input'); // a stage is executive-only
    const r = await ok(ctx, 'set_tiers', { workspace: 'agent-coffee', module: 'roastery_audit', supervisor_only: true, delegation: false });
    assert.match(r.changes[0], /supervisor-only/);
    let s = await stashOf(store, 'agent-coffee');
    let m = s.modules.find(x => x.key === 'roastery_audit');
    assert.equal(m.tiers.executive, false);
    assert.ok(m.stages.every(st => !st.approvers.includes('executive')));
    assert.ok(m.nav.every(sec => sec.items.every(it => !it.roles.includes('executive'))));
    await ok(ctx, 'set_tiers', { workspace: 'agent-coffee', module: 'roastery_audit', supervisor_only: false });
    s = await stashOf(store, 'agent-coffee');
    m = s.modules.find(x => x.key === 'roastery_audit');
    assert.equal(m.tiers.executive, true);
    await fails(ctx, 'set_permission', { workspace: 'agent-coffee', action: 'archive', roles: ['executive'] }, 'invalid_input');
    await ok(ctx, 'set_permission', { workspace: 'agent-coffee', action: 'reject', roles: ['supervisor'] });
    await assertClean(store, 'agent-coffee');
  });

  test('update_module renames and regenerates untouched refusals', async () => {
    await ok(ctx, 'update_module', { workspace: 'agent-coffee', module: 'legal', name: 'Legal & Licences' });
    const s = await stashOf(store, 'agent-coffee');
    assert.equal(s.modules.find(m => m.key === 'legal').recon, true);
    assert.match(s.modules.find(m => m.key === 'design').gate.refusal, /Legal & Licences/);
  });

  test('remove_module: refuse / inherit_gate (operaton-plat rewiring)', async () => {
    await fails(ctx, 'remove_module', { workspace: 'agent-coffee', module: 'legal', confirm: true }, 'refused');
    await ok(ctx, 'add_custom_module', { workspace: 'agent-coffee', name: 'Middle', starts_after: ['bd'] });
    await ok(ctx, 'add_custom_module', { workspace: 'agent-coffee', name: 'Tail', starts_after: ['middle'] });
    await ok(ctx, 'remove_module', { workspace: 'agent-coffee', module: 'middle', dependents: 'inherit_gate', confirm: true });
    const s = await stashOf(store, 'agent-coffee');
    assert.deepEqual(s.modules.find(m => m.key === 'tail').gate.conds, [{ src: 'bd', out: 'approved' }]);
    await ok(ctx, 'remove_module', { workspace: 'agent-coffee', module: 'tail', confirm: true });
    await assertClean(store, 'agent-coffee');
  });

  test('validate (local + app dry run) and diff', async () => {
    const v = await ok(ctx, 'validate', { workspace: 'agent-coffee' });
    assert.equal(v.verdict, 'ready');
    assert.equal(v.app.ok, true);
    const d = await ok(ctx, 'diff', { workspace: 'agent-coffee' });
    assert.equal(d.draft_matches_live, false);
    assert.ok(d.changes.some(c => c.tag === 'created' && /Roastery Audit/.test(c.text)));
  });

  test('the user\'s workspaces were never touched', async () => {
    assert.deepEqual(userFingerprint((await store.read()).blob), fp0);
  });

  test('delete_workspace: dry run, then confirm', async () => {
    const d = await ok(ctx, 'delete_workspace', { workspace: 'agent-coffee' });
    assert.equal(d.dry_run, true);
    await ok(ctx, 'delete_workspace', { workspace: 'agent-coffee', confirm: true });
    const { blob } = await store.read();
    assert.deepEqual(blob.customWs.map(w => w.id), ['ws_aditya_test', 'ws_chai_point_retail']);
    assert.deepEqual(userFingerprint(blob), fp0);
  });
});

describe('other templates and the empty start', () => {
  test('empty start + built-ins in flow order keep the usual gates', async () => {
    const store = createMemoryStore();
    const ctx = ctxWith(store);
    await ok(ctx, 'create_workspace', { name: 'Zero Co' });
    await ok(ctx, 'add_builtin_module', { workspace: 'zero-co', key: 'legal' });
    let s = await stashOf(store, 'zero-co');
    assert.equal(s.modules[0].gate, null, 'v5: gate dropped when its source is missing');
    await ok(ctx, 'add_builtin_module', { workspace: 'zero-co', key: 'bd' });
    await fails(ctx, 'add_builtin_module', { workspace: 'zero-co', key: 'bd' }, 'invalid_input');
    await ok(ctx, 'add_builtin_module', { workspace: 'zero-co', key: 'finance_ca' });
    s = await stashOf(store, 'zero-co');
    assert.deepEqual(s.modules.find(m => m.key === 'finance_ca').gate.conds, [{ src: 'bd', out: 'done' }]);
    await assertClean(store, 'zero-co');
  });
  test('matrix-bd template loads the production flow as a draft', async () => {
    const store = createMemoryStore();
    const ctx = ctxWith(store);
    const r = await ok(ctx, 'create_workspace', { name: 'Prod Copy', template: 'matrix-bd' });
    assert.equal(r.modules.length, 9);
    const s = await stashOf(store, 'prod-copy');
    assert.equal(s.liveV, 0);
    assert.ok(s.modules.reduce((a, m) => a + m.stages.length, 0) > 30);
    await assertClean(store, 'prod-copy');
  });
  test('migrate_running needs a workspace (full coverage in migrate.test.mjs)', async () => {
    await fails(ctxWith(createMemoryStore()), 'migrate_running', {}, 'invalid_input');
  });
});

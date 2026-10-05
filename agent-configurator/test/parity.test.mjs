// Parity: every draft an op writes is checked against the REAL v5 class (load-dc.mjs) — the class's
// own findings(), diffList() and manifest() must equal what the agent computes with
// validation.mjs, the draft must match workspace.schema.json, and (unless the step is an explicit
// partial step) it must carry zero broken-flow findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runOp } from '../lib/ops.mjs';
import { createMemoryStore } from '../lib/store.mjs';
import { v5Evaluate } from '../lib/v5.mjs';
import { V, stateOf, manifestOf, schemaErrors, classify, findingsOf, manifestSchemaErrors, resolveWorkspace } from '../lib/model.mjs';
import { userBlob } from '../testkit/fakes.mjs';

const W = 'ws_parity_cafe';
const STEPS = [
  ['create_workspace', { name: 'Parity Cafe', template: 'bluetokai' }],
  ['disable_module', { workspace: W, module: 'pex' }],
  ['add_custom_module', { workspace: W, name: 'Kitchen Audit', template: 'vendor', starts_after: ['design'] }],
  ['add_custom_module', { workspace: W, name: 'Menu Board', supervisor_only: true, gate: { match: 'any', conditions: [{ source: 'legal' }, { source: 'finance_ca', outcome: 'approved' }] }, stages: [{ name: 'Draft board', approvers: ['supervisor'], outcome: 'submitted', fields: [{ label: 'Board PDF', kind: 'file', validation: 'pdf · max 10MB', required: true }] }, { name: 'Brand approval', approvers: ['supervisor', 'business_admin'], fields: [{ label: 'On brand', kind: 'yesno', affects_outcome: true }] }], rollup: { strategy: 'any_negative' }, exit_signal: 'done' }],
  ['set_gate', { workspace: W, module: 'nso', starts_after: ['kitchen_audit', 'project'] }],
  ['add_stage', { workspace: W, module: 'kitchen_audit', stage: { name: 'Re-inspection', approvers: ['executive', 'supervisor'], outcome: 'approved', fields: [{ label: 'Passed', kind: 'yesno', affects_outcome: true }] } }],
  ['update_stage', { workspace: W, module: 'kitchen_audit', stage: 1, changes: { name: 'Vendor details' } }],
  ['add_field', { workspace: W, module: 'menu_board', stage: 2, field: { label: 'Reviewer', kind: 'person', validation: 'business_admin' } }],
  ['update_field', { workspace: W, module: 'kitchen_audit', stage: 'Vendor details', field: 'gst_number', changes: { required: false } }],
  ['set_tiers', { workspace: W, module: 'kitchen_audit', business_admin_signoff: false, delegation: false }],
  ['set_outcome', { workspace: W, module: 'kitchen_audit', rollup: { strategy: 'count_at_least', n: 2, of: 4 } }],
  ['set_permission', { workspace: W, action: 'archive', roles: [] }],
  ['update_module', { workspace: W, module: 'design', name: 'Store Design' }],
  ['set_gate', { workspace: W, module: 'launch_approval', starts_after: ['pex'], allow_new_findings: true }], // deliberate partial step: dead gate
  ['set_gate', { workspace: W, module: 'launch_approval', starts_after: ['nso'] }],
  ['remove_field', { workspace: W, module: 'menu_board', stage: 2, field: 'reviewer', confirm: true }],
  ['remove_stage', { workspace: W, module: 'kitchen_audit', stage: 'Re-inspection', confirm: true }],
  ['remove_module', { workspace: W, module: 'menu_board', confirm: true }],
  ['enable_module', { workspace: W, module: 'pex' }],
];

test('ops-produced drafts are identical to what the v5 class computes, step by step', async () => {
  const store = createMemoryStore(userBlob());
  const ctx = createContext({ store, env: { MATRIX_APP_ENV_FILE: '/nonexistent', CFG_URL: 'http://127.0.0.1:1' } });
  let partialSteps = 0;
  for (const [op, args] of STEPS) {
    const r = await runOp(ctx, op, args);
    assert.equal(r.saved, true, `${op} saved`);
    const { blob } = await store.read();
    const { cw, stash } = resolveWorkspace(blob, W);
    assert.deepEqual(schemaErrors(stash), [], `${op}: workspace.schema.json`);
    const ref = v5Evaluate(blob, W);
    assert.deepEqual(V.findings(stateOf(stash)), JSON.parse(JSON.stringify(ref.findings)), `${op}: findings parity`);
    assert.deepEqual(V.diffList(stateOf(stash)), JSON.parse(JSON.stringify(ref.diff)), `${op}: diff parity`);
    const man = manifestOf(cw, stash);
    assert.deepEqual(man, JSON.parse(JSON.stringify(ref.manifest)), `${op}: manifest parity`);
    assert.deepEqual(manifestSchemaErrors(man), [], `${op}: manifest.schema.json`);
    const errs = classify(findingsOf(stash)).errors;
    if (args.allow_new_findings) { partialSteps++; assert.ok(errs.length > 0, 'partial step reports its finding'); assert.ok(r.new_findings.length); }
    else assert.deepEqual(errs, [], `${op}: zero v5 error findings`);
  }
  assert.equal(partialSteps, 1);
});

test('publish bookkeeping equals v5\'s own "Publish vN" (live snapshot, versions, history)', async () => {
  // drive the same publish through the class directly and through v5Publish, compare stashes
  const { v5Publish, openSession } = await import('../lib/v5.mjs');
  const store = createMemoryStore();
  const ctx = createContext({ store, env: { MATRIX_APP_ENV_FILE: '/nonexistent' } });
  await runOp(ctx, 'create_workspace', { name: 'Pub Check', template: 'bluetokai' });
  await runOp(ctx, 'add_custom_module', { workspace: 'pub-check', name: 'Extra Step' });
  const { blob } = await store.read();
  const ours = v5Publish(blob, 'ws_pub_check', 'go live', null);
  const s = openSession(blob, 'ws_pub_check');
  s.c.setState({ publishReason: 'go live' });
  s.c.publishVals().onConfirmPublish();
  assert.deepEqual(ours.stash, s.stash());
  assert.equal(ours.stash.liveV, 1);
  assert.equal(ours.stash.draftV, 2);
  assert.deepEqual(ours.stash.live.modules.map(m => m.key), ours.stash.modules.map(m => m.key));
  assert.equal(V.diffList(stateOf(ours.stash)).length, 0, 'draft matches live after publish');
});

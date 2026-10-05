// The draft store as the visual configurator sees it: the REAL web/server.mjs handler + store
// (fake NocoBase underneath). Proves: agent drafts are the browser's blob; a concurrent human save
// is never clobbered (409 → re-read + report); the user's own workspaces are byte-identical after
// any sequence of agent writes (merge-around invariant); protected ids are read-only; local mode
// is refused.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createContext, runOp, assertMergeAround } from '../lib/ops.mjs';
import { createHttpStore } from '../lib/store.mjs';
import { blobSchemaErrors } from '../lib/model.mjs';
import { createApp } from '../../web/server.mjs';
import { createStore } from '../../web/lib/store.mjs';
import { startCfgServer, envFor, userBlob, userFingerprint, USER_WS_IDS } from '../testkit/fakes.mjs';

let cfg, fp0, order0;
before(async () => {
  cfg = await startCfgServer(userBlob());
  const { blob } = await cfg.state();
  fp0 = userFingerprint(blob);
  order0 = blob.customWs.map(w => w.id);
});
after(() => cfg.close());

const ctxFor = (extra = {}, store) => createContext({ env: envFor(cfg, null, extra), ...(store ? { store } : {}) });

describe('same drafts as the visual configurator', () => {
  test('an agent-created workspace is in GET /cfg/state as a v5 blob, after the user\'s', async () => {
    await runOp(ctxFor(), 'create_workspace', { name: 'Agent Coffee', template: 'bluetokai' });
    const { blob } = await cfg.state();
    assert.deepEqual(blob.customWs.map(w => w.id), [...order0, 'ws_agent_coffee']);
    assert.deepEqual(blobSchemaErrors(blob), [], 'whole blob matches workspace.schema.json#storageBlob');
    // NocoBase rows + projections were written by the real server code
    assert.ok(cfg.fake.rows('cfg_workspaces').some(r => r.slug === 'agent-coffee' && r.is_custom));
  });

  test('a human edit made in the browser is what the agent reads next', async () => {
    const { blob, etag } = await cfg.state();
    blob.data.ws_agent_coffee.modules = blob.data.ws_agent_coffee.modules.map(m => m.key === 'nso' ? Object.assign({}, m, { name: 'Store Opening' }) : m);
    assert.equal((await cfg.put(blob, etag)).status, 200);
    const s = await runOp(ctxFor(), 'show_workspace', { workspace: 'agent-coffee' });
    assert.equal(s.modules.find(m => m.key === 'nso').name, 'Store Opening');
  });

  test('a concurrent human save is never clobbered: 409 → conflict + fresh state, nothing written', async () => {
    // a store whose PUT is preceded by a human save (the browser tab saving between our read and write)
    const base = createHttpStore({ baseUrl: cfg.base });
    let humanSaved = false;
    const racy = Object.assign({}, base, {
      async write(blob, etag) {
        const cur = await cfg.state();
        cur.blob.data.ws_agent_coffee.modules = cur.blob.data.ws_agent_coffee.modules.map(m => m.key === 'bd' ? Object.assign({}, m, { name: 'Site Hunting' }) : m);
        assert.equal((await cfg.put(cur.blob, cur.etag)).status, 200);
        humanSaved = true;
        return base.write(blob, etag);
      },
    });
    await assert.rejects(runOp(ctxFor({}, racy), 'disable_module', { workspace: 'agent-coffee', module: 'pex' }), e => {
      assert.equal(e.code, 'conflict');
      assert.match(e.message, /Nothing was written/);
      assert.ok(e.details.current.modules.includes('pex'));
      return true;
    });
    assert.ok(humanSaved);
    const { blob } = await cfg.state();
    const mods = blob.data.ws_agent_coffee.modules;
    assert.equal(mods.find(m => m.key === 'bd').name, 'Site Hunting', 'human edit kept');
    assert.equal(mods.find(m => m.key === 'pex').enabled, true, 'agent edit not applied');
  });

  test('the browser tab with a stale ETag gets the 409 (its pill shows "Sync conflict")', async () => {
    const stale = await cfg.state();
    await runOp(ctxFor(), 'update_module', { workspace: 'agent-coffee', module: 'design', name: 'Store Design' });
    assert.equal((await cfg.put(stale.blob, stale.etag)).status, 409);
  });
});

describe("pre-existing workspaces (the user's aditya-test, F4b's chai-point-retail)", () => {
  test('stay byte-identical (and in order) across every kind of agent write', async () => {
    const ctx = ctxFor();
    const W = 'agent-coffee';
    await runOp(ctx, 'add_custom_module', { workspace: W, name: 'Roastery Audit', starts_after: ['legal'], stages: [{ name: 'Visit', approvers: ['executive', 'supervisor'], fields: [{ label: 'OK', kind: 'yesno', affects_outcome: true }] }] });
    await runOp(ctx, 'add_stage', { workspace: W, module: 'roastery_audit', stage: { name: 'Sign-off' } });
    await runOp(ctx, 'add_field', { workspace: W, module: 'roastery_audit', stage: 2, field: { label: 'Notes' } });
    await runOp(ctx, 'set_gate', { workspace: W, module: 'roastery_audit', match: 'any', conditions: [{ source: 'legal' }, { source: 'bd' }] });
    await runOp(ctx, 'set_tiers', { workspace: W, module: 'roastery_audit', delegation: false });
    await runOp(ctx, 'set_outcome', { workspace: W, module: 'roastery_audit', exit_signal: 'done' });
    await runOp(ctx, 'disable_module', { workspace: W, module: 'nso', also_disable_dependents: true });
    await runOp(ctx, 'remove_module', { workspace: W, module: 'roastery_audit', confirm: true });
    await runOp(ctx, 'create_workspace', { name: 'Second Agent Ws' });
    await runOp(ctx, 'delete_workspace', { workspace: 'second-agent-ws', confirm: true });
    const { blob } = await cfg.state();
    assert.deepEqual(userFingerprint(blob), fp0);
    assert.deepEqual(blob.customWs.map(w => w.id).filter(id => USER_WS_IDS.includes(id)), USER_WS_IDS);
  });

  test('CFG_PROTECTED_WORKSPACES makes them read-only for the agent', async () => {
    const ctx = ctxFor({ CFG_PROTECTED_WORKSPACES: USER_WS_IDS.join(',') });
    for (const [op, args] of [
      ['disable_module', { workspace: 'ws_aditya_test', module: 'nso', also_disable_dependents: true }],
      ['add_builtin_module', { workspace: 'ws_chai_point_retail', key: 'bd' }],
      ['delete_workspace', { workspace: 'ws_aditya_test', confirm: true }],
      ['delete_workspace', { workspace: 'ws_aditya_test' }],
      ['publish', { workspace: 'ws_chai_point_retail', reason: 'x', confirm: true }],
    ]) {
      await assert.rejects(runOp(ctx, op, args), e => e.code === 'refused' && /protected/.test(e.message), op);
    }
    const s = await runOp(ctx, 'show_workspace', { workspace: 'ws_chai_point_retail' });
    assert.ok(s.modules.some(m => m.key === 'vendor_onboarding'), 'reading is fine');
    assert.deepEqual(userFingerprint((await cfg.state()).blob), fp0);
  });

  test('the merge-around invariant refuses any write that would touch another workspace', () => {
    const blob = userBlob();
    const next = JSON.parse(JSON.stringify(blob));
    next.data.ws_aditya_test.modules[0].name = 'tampered';
    assert.throws(() => assertMergeAround(blob, next, 'ws_new'), /merge-around/);
    const dropped = { customWs: blob.customWs.slice(1), data: blob.data };
    assert.throws(() => assertMergeAround(blob, dropped, 'ws_new'), /merge-around/);
    const reordered = { customWs: blob.customWs.slice().reverse(), data: blob.data };
    assert.throws(() => assertMergeAround(blob, reordered, 'ws_new'), /merge-around/);
    assert.doesNotThrow(() => assertMergeAround(blob, blob, 'ws_new'));
  });
});

test('local mode (NocoBase down) is refused instead of writing to one browser', async () => {
  const store = createStore({ loadClient: () => Promise.reject(new Error('down')), log: { info() {}, warn() {} }, healthTtlMs: 0, failTtlMs: 0, builtinSeeds: null });
  const server = http.createServer(createApp({ store, log: { info() {}, warn() {} } }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const ctx = createContext({ env: { CFG_URL: `http://127.0.0.1:${server.address().port}`, MATRIX_APP_ENV_FILE: '/nonexistent' } });
    await assert.rejects(runOp(ctx, 'list_workspaces', {}), e => e.code === 'unavailable' && /LOCAL mode/.test(e.message));
  } finally { await new Promise(r => server.close(r)); }
});

test('an unreachable configurator server is reported, never started', async () => {
  const ctx = createContext({ env: { CFG_URL: 'http://127.0.0.1:1', MATRIX_APP_ENV_FILE: '/nonexistent' } });
  await assert.rejects(runOp(ctx, 'create_workspace', { name: 'X1' }), e => e.code === 'unavailable' && /does not start services/.test(e.message));
});

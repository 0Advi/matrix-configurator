// Projection tests run against the REAL v5 logic and seed data (evaluated in Node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectWorkspace, blobToWorkspaceRows, rowsToBlob, normalizeBlob, validateBlob,
  moduleRoute, moduleStatus, initialsOf, STATE_FORMAT
} from '../lib/projection.mjs';
import { loadV5, builtinWorkspaces, createWorkspaceVia, publishVia, readBlob } from './helpers/v5-harness.mjs';

const builtins = builtinWorkspaces();
const bySlug = Object.fromEntries(builtins.map(b => [b.workspace.slug, b]));

test('v5 ships three built-in demo workspaces', () => {
  assert.deepEqual(builtins.map(b => b.workspace.slug), ['bluetokai', 'starbucks', 'burgerking']);
  assert.deepEqual(builtins.map(b => b.initials), ['BT', 'SB', 'BK']);
  assert.equal(bySlug.bluetokai.stash.liveV, 7);
  assert.equal(bySlug.bluetokai.stash.draftV, 8);
  assert.equal(bySlug.starbucks.stash.liveV, 0);
});

test('Blue Tokai seed projects to 9 modules with the right gates and stages', () => {
  const { stash } = bySlug.bluetokai;
  const p = projectWorkspace('bluetokai', stash);
  assert.equal(p.modules.length, 9);
  assert.equal(p.stages.length, stash.modules.reduce((n, m) => n + m.stages.length, 0));
  assert.equal(p.gates.length, stash.modules.reduce((n, m) => n + (m.gate ? m.gate.conds.length : 0), 0));

  const design = p.gates.filter(g => g.to_key === 'design');
  assert.deepEqual(design.map(g => g.from_key).sort(), ['finance_ca', 'legal']);
  for (const g of design) {
    assert.equal(g.condition.outcome, 'approved');
    assert.equal(g.condition.match, 'all');
    assert.equal(g.condition.of, 2);
    assert.match(g.condition.refusal, /Design is locked/);
  }
  assert.equal(p.gates.filter(g => g.to_key === 'bd').length, 0, 'BD has no entry gate');

  const bd = p.modules.find(m => m.module_key === 'bd');
  assert.deepEqual(
    { name: bd.name, glyph: bd.glyph, kind: bd.kind, status: bd.status, route: bd.route },
    { name: 'BD', glyph: '⇄', kind: 'builtin', status: 'live', route: '/bd' }
  );
  assert.equal(p.modules.find(m => m.module_key === 'finance_ca').route, '/finance-ca');
  assert.equal(bd.data.stage_count, 4);
  assert.equal(bd.data.in_live, true);
  assert.equal('stages' in bd.data, false, 'stages live in cfg_stages, not in module data');

  const bdStages = p.stages.filter(s => s.module_key === 'bd');
  assert.deepEqual(bdStages.map(s => s.position), [1, 2, 3, 4]);
  assert.deepEqual(bdStages.map(s => s.terminal), [false, false, false, true]);
  assert.equal(bdStages[0].name, 'Draft capture');
  assert.equal(bdStages[0].outcome, 'submitted');
  assert.deepEqual(bdStages[0].data.approvers, ['executive']);
  assert.equal(bdStages[0].data.fields[0].key, 'site_name');
  assert.equal(bdStages[0].data.sites, 23);
});

test('every projected row carries exactly the contract fields with the right types', () => {
  for (const b of builtins) {
    const p = projectWorkspace(b.workspace.slug, b.stash);
    for (const r of p.modules) {
      assert.deepEqual(Object.keys(r).sort(), ['data', 'glyph', 'kind', 'module_key', 'name', 'route', 'status', 'workspace_slug']);
      for (const k of ['workspace_slug', 'module_key', 'name', 'glyph', 'kind', 'status', 'route']) assert.equal(typeof r[k], 'string', k);
      assert.ok(r.name.length <= 255);
    }
    for (const r of p.gates) {
      assert.deepEqual(Object.keys(r).sort(), ['condition', 'from_key', 'to_key', 'workspace_slug']);
      assert.equal(typeof r.condition, 'object');
    }
    for (const r of p.stages) {
      assert.deepEqual(Object.keys(r).sort(), ['data', 'module_key', 'name', 'outcome', 'position', 'terminal', 'workspace_slug']);
      assert.ok(Number.isInteger(r.position) && r.position >= 1);
      assert.equal(typeof r.terminal, 'boolean');
    }
    // exactly one terminal stage per module that has stages
    const perModule = new Map();
    for (const s of p.stages) perModule.set(s.module_key, (perModule.get(s.module_key) || 0) + (s.terminal ? 1 : 0));
    for (const n of perModule.values()) assert.equal(n, 1);
  }
});

test('Starbucks seed: switched-off built-ins are "disabled", custom modules route under /m/', () => {
  const p = projectWorkspace('starbucks', bySlug.starbucks.stash);
  const disabled = p.modules.filter(m => m.status === 'disabled');
  assert.equal(disabled.length, 2);
  const custom = p.modules.filter(m => m.kind === 'custom');
  assert.equal(custom.length, 4);
  for (const m of custom) assert.equal(m.route, '/m/' + m.module_key);
  assert.ok(p.modules.every(m => m.workspace_slug === 'starbucks'));
});

test('moduleStatus / moduleRoute / initialsOf follow v5 rules', () => {
  assert.equal(moduleStatus({ enabled: true, status: 'draft' }), 'draft');
  assert.equal(moduleStatus({ enabled: true, status: 'live', pendingEng: true }), 'pending_engineering');
  assert.equal(moduleStatus({ enabled: false, status: 'live' }), 'disabled');
  assert.equal(moduleRoute({ kind: 'custom', key: 'vendor_onboarding' }), '/m/vendor_onboarding');
  assert.equal(moduleRoute({ kind: 'builtin', key: 'launch_approval' }), '/launch-approval');
  assert.equal(initialsOf('Third Wave'), 'TH'); // v5 picker: name.slice(0, 2).toUpperCase()
});

test('a real v5 blob round-trips through cfg_workspaces rows byte-for-byte', () => {
  const h = loadV5();
  const c = h.create();
  const a = createWorkspaceVia(c, { name: 'Third Wave', slug: 'third-wave', start: 'template' });
  publishVia(c, 'First go-live');
  createWorkspaceVia(c, { name: 'Chaayos', slug: 'chaayos', start: 'empty' });
  const raw = h.storage.getItem('wsconfig_v5_custom');
  const blob = JSON.parse(raw);
  assert.equal(blob.customWs.length, 2);
  assert.ok(blob.data[a], 'stash for the first workspace');

  const rows = blobToWorkspaceRows(blob);
  assert.deepEqual(rows.map(r => [r.slug, r.name, r.initials, r.is_custom, r.live_version, r.draft_version]), [
    ['third-wave', 'Third Wave', 'TH', true, 1, 2],
    ['chaayos', 'Chaayos', 'CH', true, 0, 1]
  ]);
  assert.equal(rows[0].state.format, STATE_FORMAT);
  // simulate storage (JSON text) and reversed row order from the backend
  const stored = JSON.parse(JSON.stringify(rows)).reverse();
  assert.equal(JSON.stringify(rowsToBlob(stored)), raw);
  assert.equal(JSON.stringify(normalizeBlob(blob)), raw);
});

test('rowsToBlob ignores built-in rows and returns {} when there is no custom workspace', () => {
  const rows = builtins.map(b => ({ slug: b.workspace.slug, is_custom: false, state: { workspace: b.workspace, data: b.stash } }));
  assert.deepEqual(rowsToBlob(rows), {});
  assert.deepEqual(rowsToBlob([]), {});
});

test('wizard-created custom module projects as pending engineering under /m/<key>', () => {
  const h = loadV5();
  const c = h.create();
  createWorkspaceVia(c, { name: 'Wiz', slug: 'wiz', start: 'empty' });
  c.openWizard('vendor');
  c.wp({ rollup: Object.assign({}, c.state.wizard.rollup, { strategy: 'custom' }) });
  c.wizSave();
  const stash = readBlob(h.storage).data.ws_wiz;
  const p = projectWorkspace('wiz', stash);
  assert.equal(p.modules.length, 1);
  assert.deepEqual(
    { key: p.modules[0].module_key, kind: p.modules[0].kind, status: p.modules[0].status, route: p.modules[0].route, in_live: p.modules[0].data.in_live },
    { key: 'vendor_onboarding', kind: 'custom', status: 'pending_engineering', route: '/m/vendor_onboarding', in_live: false }
  );
  assert.deepEqual(p.stages.map(s => s.name), ['Vendor capture', 'Compliance check']);
  assert.equal(p.gates.length, 0);
});

test('validateBlob rejects malformed state', () => {
  assert.ok(validateBlob({}));
  assert.ok(validateBlob({ customWs: [], data: {} }));
  assert.throws(() => validateBlob([]), /JSON object/);
  assert.throws(() => validateBlob({ customWs: 'x' }), /customWs/);
  assert.throws(() => validateBlob({ customWs: [{ id: 'a' }] }), /slug/);
  assert.throws(() => validateBlob({ customWs: [{ id: 'a', slug: 's' }, { id: 'b', slug: 's' }] }), /duplicate/);
  assert.throws(() => validateBlob({ customWs: [], data: [] }), /data/);
});

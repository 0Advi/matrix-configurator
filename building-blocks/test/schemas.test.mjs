// Schema checks: manifest.schema.json and workspace.schema.json accept every
// real artefact the v5 design produces (seeded workspaces, wizard templates,
// a real createWorkspace() storage blob) and reject representative bad input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/mini-schema.mjs';
import { loadComponent, plain } from '../lib/load-dc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const manifestSchema = read('from-design/manifest.schema.json');
const workspaceSchema = read('from-design/workspace.schema.json');
const seeds = read('from-design/seed-workspaces.json');
const moduleDraft = { $ref: '#/$defs/moduleDraftManifest' };
const blob = { $ref: '#/$defs/storageBlob' };
const ok = (schema, value, root, label) => { const e = validate(schema, value, root); assert.deepEqual(e, [], label + '\n' + e.slice(0, 5).join('\n')); };
const bad = (schema, value, root, label) => assert.ok(validate(schema, value, root).length > 0, label + ' should be rejected');

for (const [id, ws] of Object.entries(seeds.workspaces)) {
  test(`seed ${id}: manifest validates against manifest.schema.json`, () => ok(manifestSchema, ws.manifest, manifestSchema, id));
  test(`seed ${id}: document validates against workspace.schema.json`, () => ok(workspaceSchema, ws.document, workspaceSchema, id));
}

test('storage blob from createWorkspace() validates as $defs.storageBlob', () => ok(blob, seeds.storageBlobExample.value, workspaceSchema, 'blob'));

for (const [tpl, w] of Object.entries(seeds.wizardTemplates)) {
  test(`wizard template ${tpl}: wizManifest validates as $defs.moduleDraftManifest`, () => ok(moduleDraft, w.manifest, manifestSchema, tpl));
}

test('freshly evaluated manifests (not just the stored JSON) validate too — including live mode and a saved custom module', () => {
  const { Component } = loadComponent(5);
  for (const ws of ['bluetokai', 'starbucks', 'burgerking']) {
    const c = new Component({ startWorkspace: ws });
    ok(manifestSchema, plain(c.manifest()), manifestSchema, ws + ' draft');
    c.setState({ mode: 'live' });
    ok(manifestSchema, plain(c.manifest()), manifestSchema, ws + ' live-mode');
    c.setState({ mode: 'draft' });
    c.openWizard('vendor');
    c.setState({ wizard: Object.assign({}, c.state.wizard, { gate: { match: 'any', conds: [{ src: 'bd', out: 'done' }], refusal: '' }, rollup: { strategy: 'count_at_least', n: '2', of: 3, field: 'x', limit: '1' } }) });
    ok(moduleDraft, plain(c.wizManifest(c.state.wizard)), manifestSchema, ws + ' wizard');
    c.wizSave();
    ok(manifestSchema, plain(c.manifest()), manifestSchema, ws + ' after wizSave');
    ok(workspaceSchema, plain(c.stashOf(c.state)), workspaceSchema, ws + ' stash after wizSave');
  }
});

test('schemas reject representative bad input', () => {
  const m = structuredClone(seeds.workspaces.bluetokai.manifest);
  const withMod = f => { const x = structuredClone(m); f(x.modules[0]); return x; };
  bad(manifestSchema, withMod(x => { x.key = 'Bad-Key'; }), manifestSchema, 'module key pattern');
  bad(manifestSchema, withMod(x => { x.stages[0].outcome = 'finished'; }), manifestSchema, 'unknown outcome');
  bad(manifestSchema, withMod(x => { x.stages[0].approvers = ['observer']; }), manifestSchema, 'observer approver');
  bad(manifestSchema, withMod(x => { x.stages[0].fields[0].kind = 'currency'; }), manifestSchema, 'unknown field kind');
  bad(manifestSchema, withMod(x => { x.entry_gate = { match: 'all', conditions: [], refusal_message: '' }; }), manifestSchema, 'empty gate');
  bad(manifestSchema, withMod(x => { x.tiers.supervisor = false; }), manifestSchema, 'supervisor tier is mandatory');
  bad(manifestSchema, Object.assign(structuredClone(m), { extra: 1 }), manifestSchema, 'unknown top-level key');
  const d = structuredClone(seeds.workspaces.bluetokai.document);
  d.modules[0].band = 'nowhere';
  bad(workspaceSchema, d, workspaceSchema, 'unknown band');
  bad(blob, { customWs: [{ id: 'ws_x', name: 'X', slug: 'X', start: 'empty', created: 'today' }], data: {} }, workspaceSchema, 'bad custom slug');
});

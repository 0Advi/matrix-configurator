// Structural checks for the Matrix-bd blocks. These run WITHOUT access to the
// Matrix-bd repo: they check the extracted JSON against itself, against the v5
// schemas, and against the machine-extracted route/vocabulary catalogues.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/mini-schema.mjs';
import { toV5Manifest, toV5WorkspaceDocument, stripAnnotations } from '../from-matrix-bd/flow-adapter.mjs';
import * as V from '../from-design/validation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const flow = read('from-matrix-bd/matrix-bd-flow.json');
const vocab = read('from-matrix-bd/modules-and-vocabularies.json');
const routes = read('from-matrix-bd/route-guards.json');
const rbac = read('from-matrix-bd/rbac.json');
const approvals = read('from-matrix-bd/approvals.json');
const rent = read('from-matrix-bd/rent-terms.json');
const zm = read('from-matrix-bd/zm-tokens.json');
const manifestSchema = read('from-design/manifest.schema.json');
const workspaceSchema = read('from-design/workspace.schema.json');
const SHA = '3d4f277beb22c5be02c2abacea61b6afaee7cdeb';

test('every JSON file in building-blocks parses', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = walk(ROOT).filter(f => f.endsWith('.json'));
  assert.ok(files.length >= 12, 'expected at least 12 JSON files, got ' + files.length);
  for (const f of files) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(f, 'utf8')), f);
});

test('all Matrix-bd blocks are pinned to the same commit', () => {
  for (const [name, doc] of Object.entries({ flow, vocab, routes, rbac, approvals, rent, zm })) assert.equal(doc.provenance.sha, SHA, name);
});

test('matrix-bd-flow → v5 manifest validates against manifest.schema.json', () => {
  assert.deepEqual(validate(manifestSchema, toV5Manifest(flow), manifestSchema), []);
});

test('matrix-bd-flow → v5 workspace document validates and the v5 validator finds nothing wrong', () => {
  const doc = toV5WorkspaceDocument(flow);
  assert.deepEqual(validate(workspaceSchema, doc, workspaceSchema), []);
  const st = { modules: doc.modules, perms: doc.perms, signals: [], live: doc.live, mode: 'draft', spine: [], liveV: doc.liveV, draftV: doc.draftV };
  assert.deepEqual(V.findings(st), [], 'no gate cycles, dead gates, unreachable outcomes, missing approvers or key collisions');
  for (const m of doc.modules) assert.equal(V.gateCycle(st, m.key, m.gate), null, m.key);
  assert.equal(V.flowOrder(doc.modules).length, doc.modules.length);
  assert.deepEqual(V.diffList(st), [], 'draft equals live after import');
});

test('matrix-bd-flow: every module and stage carries provenance', () => {
  for (const m of flow.modules) {
    assert.ok(m['x-matrix'] && m['x-matrix'].sources.length, m.key + ' sources');
    assert.ok(m['x-matrix'].state, m.key + ' state');
    for (const s of m.stages) {
      assert.ok(s['x-matrix'] && s['x-matrix'].realState, `${m.key}/${s.name} realState`);
      assert.ok((s['x-matrix'].sources || []).length, `${m.key}/${s.name} sources`);
      assert.ok(s.approvers.length, `${m.key}/${s.name} approvers`);
    }
    for (const sec of m.navigation) for (const it of sec.items) assert.ok(it['x-matrix'].route.startsWith('/'), `${m.key} nav ${it.label}`);
  }
  // stripping annotations leaves no x- keys
  assert.ok(!JSON.stringify(stripAnnotations(flow.modules)).includes('"x-'));
});

// --- route cross-check: every route cited in the flow / approvals exists in the extracted route table
const norm = p => p.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '');
const table = routes.routes.map(r => ({ method: r.method, segs: norm(r.path).split('/') }));
function expand(spec) {
  const m = /^([A-Z|]+)\s+(\/api\/\S+)/.exec(spec.trim()); if (!m) return [];
  const methods = m[1].split('|');
  const segs = m[2].split('/');
  const last = segs.pop();
  return methods.flatMap(meth => last.split('|').map(alt => ({ method: meth, path: [...segs, alt].join('/') })));
}
function exists({ method, path: p }) {
  const segs = norm(p).split('/');
  return table.some(r => r.method === method && r.segs.length === segs.length && r.segs.every((s, i) => s === segs[i] || s === '{}' || segs[i] === '{}'));
}
test('every route cited in matrix-bd-flow.json and approvals.json exists in route-guards.json', () => {
  const cited = [];
  for (const m of flow.modules) for (const s of m.stages) for (const a of (s['x-matrix'].actors || [])) cited.push(a.route);
  for (const f of approvals.flows) for (const s of f.steps) if (s.route) cited.push(...s.route.split(/\s*;\s*/));
  for (const a of approvals.accessApprovals) cited.push(...String(a.routes).split(/\s*;\s*/).filter(x => /^[A-Z]/.test(x)));
  const bad = cited.flatMap(expand).filter(r => !exists(r));
  assert.ok(cited.length > 60, 'cited ' + cited.length);
  assert.deepEqual(bad, []);
});

test('route guards: module guards only name real membership modules; NSO is supervisor-only', () => {
  const modules = new Set(vocab.modules.membershipModules);
  for (const r of routes.routes) for (const m of r.modules) assert.ok(modules.has(m), r.path + ' ' + m);
  const nso = routes.routes.filter(r => r.path.startsWith('/api/nso'));
  assert.ok(nso.length >= 8);
  for (const r of nso) { assert.deepEqual(r.roles, ['supervisor'], r.path); assert.deepEqual(r.modules, ['nso'], r.path); }
  assert.deepEqual(routes.routes.filter(r => r.realRoleOnly).map(r => r.path).sort(), ['/api/business-admin/dept-codes', '/api/business-admin/observer-code']);
});

test('vocabularies: state machine and CHECK lists agree with the curated blocks', () => {
  const sm = vocab.siteStateMachine.transitions;
  assert.deepEqual(sm.loi_uploaded, ['legal_review', 'approved', 'rejected', 'archived']);
  assert.deepEqual(sm.legal_rejected, ['legal_review']);
  assert.deepEqual(vocab.siteStateMachine.terminal.sort(), ['archived', 'pushed_to_payments', 'rejected']);
  const eff = k => vocab.checkVocabularies[k].effective;
  assert.deepEqual(rent.group.fields.find(f => f.key === 'rent_type').options.map(o => o.id).sort(), [...eff('sites.rent_type')].sort());
  const launch = approvals.flows.find(f => f.id === 'launch_validation');
  assert.deepEqual(launch.statuses, eff('launch_approvals.status'));
  assert.deepEqual(approvals.flows.find(f => f.id === 'legal_change_request').statuses, eff('legal_change_requests.status'));
  assert.deepEqual(approvals.flows.find(f => f.id === 'nso').statuses.current_stage, eff('nso_reviews.current_stage'));
  assert.deepEqual(approvals.flows.find(f => f.id === 'pe_gfc_budget').statuses['budget.status'], eff('site_budgets.status'));
  assert.deepEqual(approvals.flows.find(f => f.id === 'finance_ca').statuses, vocab.mirrorColumns['sites.finance_status'].values);
  assert.deepEqual(rbac.roles.map(r => r.id).sort(), [...eff('users.role')].sort());
  assert.ok(eff('sites.status').includes('launched') && !vocab.siteStateMachine.statuses.includes('launched'), "DB admits 'launched' that the FSM does not");
});

test('flow facts that SEED-VS-REALITY.md relies on', () => {
  const s = flow.comparisonWithV5Seed.summary;
  assert.equal(s.modulesInBoth, 9);
  assert.deepEqual(s.modulesOnlyInReal, []);
  assert.deepEqual(s.gatesDiffer, ['nso', 'financial_closure']);
  assert.deepEqual(s.gatesDifferOnlyInOutcomeToken, ['financial_closure']);
  assert.equal(s.supervisorOnlyMatch, 9);
  const nso = flow.modules.find(m => m.key === 'nso');
  assert.deepEqual(nso.entry_gate.conditions, [{ source: 'finance_ca', outcome: 'approved' }]);
  assert.equal(nso.tiers.executive, false);
  const design = flow.modules.find(m => m.key === 'design');
  assert.ok(!design.stages.some(st => /BOQ/.test(st.name)), 'BOQ is retired from Design');
  assert.ok(flow['x-matrix'].stageLevelGates.length >= 6);
});

test('zm tokens: both themes carry the core palette', () => {
  for (const k of ['--zm-bg', '--zm-surface', '--zm-fg', '--zm-accent', '--zm-line']) {
    assert.ok(zm.themes.light.color[k], 'light ' + k);
    assert.ok(zm.themes.dark.color[k], 'dark ' + k);
  }
  assert.ok(zm.themes.light.type['--zm-font-body']);
});

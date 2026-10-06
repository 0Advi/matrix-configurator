// G2 completeness + consistency proof for docs/catalogue-crosscheck/crosscheck.json.
//
//   node --test docs/catalogue-crosscheck/test/        (from matrix-configurator/)
//
// No network: operaton-plat is read from the vendored snapshot (snapshot/, commit fc65499),
// our model from building-blocks/ and the sandbox migration, the real app only through the
// already-extracted route-guards.json. Proves that every module/task/stage/catalog row of each
// model is accounted for exactly once, that every cross-reference resolves, that the
// "unreachable outcome" finding (D19) is computed rather than asserted, and that the proposed
// patches apply cleanly to the files they target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CC = path.resolve(HERE, '..');                 // docs/catalogue-crosscheck
const ROOT = path.resolve(CC, '..', '..');           // matrix-configurator
const readText = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readJson = p => JSON.parse(readText(p));
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, p))).digest('hex');

const CCP = 'docs/catalogue-crosscheck';
const xc = readJson(`${CCP}/crosscheck.json`);
const source = readJson(`${CCP}/snapshot/SOURCE.json`);
const cat = readJson(`${CCP}/snapshot/catalogue.json`);
const build = readJson(`${CCP}/snapshot/build-manifest.json`);
const FLOW_PATH = 'building-blocks/from-matrix-bd/matrix-bd-flow.json';
const flow = readJson(FLOW_PATH);
const routes = readJson('building-blocks/from-matrix-bd/route-guards.json');
const MIG_PATH = 'app/backend/database/migrations/20261004_2_module_catalog_and_tenant_modules.sql';
const corr = readJson(`${CCP}/proposed-patches/02-module_catalog-corrections.json`);

// ---------------------------------------------------------------- helpers
const tasksOf = m => m.tasks.flatMap(s => (s.parallel ? s.parallel : [s]));
const opTaskKeys = () => [['@start', 'start'], ...cat.modules.flatMap(m => tasksOf(m).map(t => [m.key, t.id]))].map(([m, t]) => `${m}/${t}`);
const ALIAS = { pex: 'project_excellence' };
const toCatalogKey = k => ALIAS[k] || k;

/** module_catalog rows parsed from the seed INSERT (key, name, outcome_map, reached_map). */
function parseCatalog(sql) {
  const body = sql.split(/\nVALUES\n/)[1].split('ON CONFLICT')[0];
  const re = /\(\s*'([a-z_]+)',\s*'([^']*)',\s*(?:NULL|'[a-z_]+'),\s*'(?:module|scope)',\s*'[^']*',\s*(?:true|false),\s*(?:true|false),\s*(?:true|false),\s*\d+,\s*(?:NULL|'[^']*'),\s*(NULL|'\{.*?\}'),\s*(NULL|'\{.*?\}'),\s*(?:NULL|'[^']*')\)/gs;
  const rows = {};
  for (const m of body.matchAll(re)) {
    const j = s => (s === 'NULL' ? null : JSON.parse(s.slice(1, -1)));
    rows[m[1]] = { name: m[2], outcome_map: j(m[3]), reached_map: j(m[4]) };
  }
  return rows;
}

/** Status vocabularies of the built-ins' mirror columns (Matrix-bd CHECK constraints / service writes). */
const VOCAB = {
  bd: ['draft_submitted', 'shortlisted', 'details_submitted', 'approved', 'loi_uploaded', 'legal_review', 'legal_approved', 'legal_rejected', 'pushed_to_payments', 'rejected', 'archived'],
  legal: ['pending', 'in_review', 'positive', 'negative'],
  finance_ca: ['pending', 'awaiting_supervisor', 'awaiting_admin', 'approved'],
  design: ['pending', 'allocated', 'in_progress', 'gfc_pending', 'approved', 'rejected'],
  project_excellence: ['pending', 'allocated', 'budgeting', 'approved'],
  project: ['pending', 'allocated', 'budgeting', 'in_progress', 'done'],
  nso: ['pending', 'in_progress', 'complete'],
  launch_approval: ['pending_admin_review', 'under_exec_review', 'under_supervisor_review', 'pending_admin_final', 'ready_to_launch', 'launched'],
  financial_closure: ['pending', 'open', 'allocated', 'budgeting', 'closed'],
};
/** Mirrors public.site_module_outcomes.reached (migration 20261004_5) for one raw status. */
function reached(row, status, extra = []) {
  const om = row.outcome_map || {}, rm = row.reached_map || {};
  const out = new Set(rm[status] || []);
  if (!(status in rm) && status !== 'pending') out.add(om[status] ?? status);
  extra.forEach(x => out.add(x));
  return out;
}
/** Flow outcomes (stage outcomes + exit signal) per module that the catalog can never report. */
function unreachable(catalog, extraByModule = {}) {
  const res = {};
  for (const m of flow.modules) {
    const k = toCatalogKey(m.key), row = catalog[k];
    const offered = new Set([...m.stages.map(s => s.outcome), m.exit_signal]);
    const all = new Set();
    for (const s of VOCAB[k]) for (const o of reached(row, s)) all.add(o);
    for (const o of extraByModule[k] || []) all.add(o);
    const miss = [...offered].filter(o => !all.has(o)).sort();
    if (miss.length) res[m.key] = miss;
  }
  return res;
}

/** Minimal RFC 6902 applier (add / remove / replace / test). */
function applyPatch(doc, ops) {
  doc = structuredClone(doc);
  for (const op of ops) {
    const parts = op.path.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    const last = parts.pop();
    let parent = doc;
    for (const p of parts) parent = Array.isArray(parent) ? parent[+p] : parent[p];
    assert.ok(parent !== undefined, 'path parent missing: ' + op.path);
    const get = () => (Array.isArray(parent) ? parent[+last] : parent[last]);
    if (op.op === 'test') assert.deepEqual(get(), op.value, 'test failed at ' + op.path);
    else if (op.op === 'replace') { assert.notEqual(get(), undefined, op.path); if (Array.isArray(parent)) parent[+last] = op.value; else parent[last] = op.value; }
    else if (op.op === 'add') { if (Array.isArray(parent)) { if (last === '-') parent.push(op.value); else parent.splice(+last, 0, op.value); } else parent[last] = op.value; }
    else if (op.op === 'remove') { if (Array.isArray(parent)) parent.splice(+last, 1); else delete parent[last]; }
    else throw new Error('unsupported op ' + op.op);
  }
  return doc;
}

/**
 * Before the patch is applied: its `test` ops hold, so apply it (as G2 wrote the check).
 * After the lead applied it (user-approved, 2026-10-06): the target must already contain every
 * replaced/added value — the patch is fully in. These patches use only test/replace/add.
 */
function applyOrConfirmApplied(doc, ops) {
  const testsHold = ops.filter(o => o.op === 'test').every(o => { try { applyPatch(doc, [o]); return true; } catch { return false; } });
  if (testsHold) return applyPatch(doc, ops);
  for (const op of ops.filter(o => o.op === 'replace' || o.op === 'add')) {
    const parts = op.path.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    const last = parts.pop();
    let parent = doc;
    for (const p of parts) parent = Array.isArray(parent) ? parent[+p] : parent[p];
    assert.ok(parent !== undefined, 'applied-state: parent missing at ' + op.path);
    if (Array.isArray(parent)) assert.ok(parent.some(x => isDeepStrictEqual(x, op.value)), 'applied-state: value missing at ' + op.path);
    else assert.deepEqual(parent[last], op.value, 'applied-state: value differs at ' + op.path);
  }
  return doc;
}

const norm = p => p.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '');
const table = routes.routes.map(r => ({ method: r.method, segs: norm(r.path).split('/') }));
const routeExists = spec => {
  const m = /^([A-Z]+)\s+(\/api\/\S+)$/.exec(spec.trim());
  if (!m) return false;
  const segs = norm(m[2]).split('/');
  return table.some(r => r.method === m[1] && r.segs.length === segs.length && r.segs.every((s, i) => s === segs[i] || s === '{}' || segs[i] === '{}'));
};

function* walkStrings(x, keyPath = '') {
  if (typeof x === 'string') yield [keyPath, x];
  else if (Array.isArray(x)) for (let i = 0; i < x.length; i++) yield* walkStrings(x[i], `${keyPath}/${i}`);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) yield* walkStrings(v, `${keyPath}/${k}`);
}

// ---------------------------------------------------------------- snapshot
test('snapshot: pinned commit, byte-identical catalogue, no credentials', () => {
  assert.match(source.sha, /^[0-9a-f]{40}$/);
  assert.equal(source.sha, xc.provenance.operatonPlat.sha);
  assert.equal(build.sha, source.sha);
  assert.equal(sha256(`${CCP}/snapshot/catalogue.json`), source.files['catalogue.json'].sha256);
  assert.equal(source.files['catalogue.json'].sha256, source.upstreamSha256['catalogue.json'], 'vendored file differs from upstream');
  for (const f of fs.readdirSync(path.join(ROOT, CCP, 'snapshot'))) {
    const text = readText(`${CCP}/snapshot/${f}`);
    assert.ok(!/"password"\s*:/i.test(text), `${f} carries a password field`);
    assert.ok(!/Matrix-[0-9a-f]{6}/.test(text), `${f} carries the demo password`);
  }
  assert.equal(cat.modules.length, 10, 'operaton-plat has 10 modules');
});

test('snapshot: generated BPMN/forms agree with the catalogue (54 tasks, 55 forms, 11 processes)', () => {
  const ids = cat.modules.flatMap(m => tasksOf(m).map(t => t.id));
  assert.equal(ids.length, 54);
  assert.deepEqual([...build.forms].sort(), [...ids, 'start'].sort());
  assert.equal(Object.keys(build.bpmn).length, 11);
  for (const m of cat.modules) {
    const proc = build.bpmn[`matrix_site__${m.key}.bpmn`];
    assert.ok(proc, m.key);
    assert.deepEqual(proc.userTasks.map(t => t.id).sort(), tasksOf(m).map(t => t.id).sort(), m.key);
    for (const t of tasksOf(m)) {
      const b = proc.userTasks.find(u => u.id === t.id).binding;
      if (t.assignee === 'initiator') assert.deepEqual(b, { assignee: '${initiator}' }, `${t.id}: assignee replaces the role`);
    }
  }
  const main = build.bpmn['matrix_site.bpmn'];
  assert.ok(main.parallelGateways.includes('split_bd_loi') && main.parallelGateways.includes('join_design'));
  const flows = main.sequenceFlows.map(([a, b]) => `${a}>${b}`);
  assert.ok(flows.includes('call_project>call_nso'), 'operaton-plat runs NSO after Project (D01)');
  assert.ok(flows.includes('call_legal>join_design') && flows.includes('call_finance>join_design'), 'Design joins on the WHOLE Legal module (D02)');
});

// ---------------------------------------------------------------- completeness
test('every operaton-plat module is mapped exactly once', () => {
  const mapped = xc.modules.flatMap(m => m.operatonPlat);
  assert.deepEqual([...mapped].sort(), cat.modules.map(m => m.key).sort());
});

test('every operaton-plat task (incl. parallel ones and the start form) is mapped exactly once', () => {
  const got = xc.operatonTasks.map(t => `${t.module}/${t.task}`);
  assert.equal(new Set(got).size, got.length, 'duplicate task rows');
  assert.deepEqual([...got].sort(), opTaskKeys().sort());
  assert.equal(got.length, 55);
});

test('every module and stage of our flow is mapped exactly once (9 modules, 36 stages)', () => {
  const want = flow.modules.flatMap(m => m.stages.map(s => `${m.key}/${s.order}/${s.name}`));
  const got = xc.ourStages.map(s => `${s.module}/${s.order}/${s.name}`);
  assert.equal(new Set(got).size, got.length);
  assert.deepEqual([...got].sort(), [...want].sort());
  assert.equal(got.length, 36);
  const flowKeys = new Set(xc.modules.map(m => m.ours.flow).filter(Boolean));
  for (const m of flow.modules) assert.ok(flowKeys.has(m.key), 'module row for ' + m.key);
});

test('every module_catalog seed row is mapped exactly once (11 rows)', () => {
  const rows = parseCatalog(readText(MIG_PATH));
  assert.equal(Object.keys(rows).length, 11);
  assert.deepEqual(xc.catalogRows.map(r => r.key).sort(), Object.keys(rows).sort());
  for (const r of xc.catalogRows) if (r.flowKey) assert.ok(flow.modules.some(m => m.key === r.flowKey), r.key + ' → ' + r.flowKey);
  for (const m of xc.modules) if (m.ours.catalog) assert.ok(rows[m.ours.catalog], m.id + ' catalog ' + m.ours.catalog);
});

test('task ↔ stage cross-references are consistent both ways', () => {
  const stageKey = (m, o) => `${m}/${o}`;
  const stages = new Map(xc.ourStages.map(s => [stageKey(s.module, s.order), s]));
  for (const t of xc.operatonTasks) {
    if (!t.ours) { assert.equal(t.verdict, 'not-in-real', `${t.task} unmapped but verdict ${t.verdict}`); continue; }
    const s = stages.get(stageKey(t.ours.module, t.ours.stage));
    assert.ok(s, `${t.task} → missing stage ${t.ours.module}/${t.ours.stage}`);
    assert.ok(s.operatonTasks.includes(t.task), `${t.task} not listed on ${s.module}/${s.order}`);
  }
  for (const s of xc.ourStages) for (const id of s.operatonTasks) {
    const t = xc.operatonTasks.find(x => x.task === id);
    assert.ok(t && t.ours && t.ours.module === s.module && t.ours.stage === s.order, `${s.module}/${s.order} lists ${id}`);
  }
});

// ---------------------------------------------------------------- evidence + discrepancies
test('every evidence string is tagged [V]/[I] and points at a known source', () => {
  const ok = /^(Matrix-bd@3d4f277:|operaton-plat@fc65499:|matrix-configurator:|git log origin\/main ).+ \[(V|I)\]( \(.+\))?$/;
  let n = 0;
  for (const [k, s] of walkStrings(xc)) if (/\/evidence\/\d+$|^\/creatorRule\/.*\/ref$|\/usedBy\/\d+$/.test(k)) { n++; assert.match(s, ok, k); }
  assert.ok(n > 150, 'evidence strings: ' + n);
  assert.equal(xc.provenance.real.sha, routes.provenance.sha, 'real-app SHA matches the extracted route table');
});

test('discrepancies are well-formed and every reference resolves', () => {
  const ids = xc.discrepancies.map(d => d.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const d of xc.discrepancies) {
    assert.ok(['high', 'medium', 'low', 'info'].includes(d.severity), d.id);
    assert.ok(d.evidence.length && d.real && d.verdict, d.id);
    assert.ok(['V', 'I'].includes(d.tag), d.id);
  }
  const refs = [...xc.operatonTasks.flatMap(t => t.discrepancies), ...xc.ourStages.flatMap(s => s.discrepancies), ...xc.ordering.map(o => o.discrepancy).filter(Boolean)];
  for (const r of refs) assert.ok(ids.includes(r), 'dangling ' + r);
  for (const r of xc.catalogRows.flatMap(c => c.issues.flatMap(i => i.match(/D\d\d/g) || []))) assert.ok(ids.includes(r), 'dangling ' + r);
});

test('every real route cited for an operaton-plat task exists in route-guards.json', () => {
  const bad = xc.operatonTasks.flatMap(t => t.real.routes).filter(r => !routeExists(r));
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- the claims the report depends on
test('creator rule: the operaton-plat tasks with assignee=initiator are exactly the ones listed', () => {
  const init = cat.modules.flatMap(m => tasksOf(m)).filter(t => t.assignee === 'initiator').map(t => t.id).sort();
  assert.deepEqual(init, [...xc.creatorRule.operatonPlat.tasks].sort());
  const skip = cat.modules.flatMap(m => tasksOf(m)).filter(t => t.skip_if);
  assert.deepEqual(skip.map(t => t.id), ['bd_review_draft'], 'the obsolete supervisor-skip rule (D04)');
});

test('ordering claims: operaton-plat vs our gates', () => {
  const after = Object.fromEntries(cat.modules.map(m => [m.key, m.after]));
  assert.deepEqual(after.nso, ['project']);
  assert.deepEqual(after.design, ['legal', 'finance']);
  assert.deepEqual(after.legal, ['bd_loi']); assert.deepEqual(after.finance, ['bd_loi']);
  const gate = k => flow.modules.find(m => m.key === k).entry_gate.conditions;
  assert.deepEqual(gate('nso'), [{ source: 'finance_ca', outcome: 'approved' }]);
  assert.deepEqual(gate('design'), [{ source: 'legal', outcome: 'approved' }, { source: 'finance_ca', outcome: 'approved' }]);
  assert.deepEqual(gate('project'), [{ source: 'design', outcome: 'approved' }]);
});

test('D19 is computed: flow outcomes the current catalog can never report', () => {
  const rows = parseCatalog(readText(MIG_PATH));
  // site_module_outcomes adds 'done' to legal when licensing is complete
  assert.deepEqual(unreachable(rows, { legal: ['done'] }), {
    bd: ['allocated'], legal: ['submitted'], pex: ['done', 'submitted'], project: ['approved', 'submitted'], nso: ['submitted'], financial_closure: ['submitted'],
  });
  assert.ok(reached(rows.bd, 'loi_uploaded').has('done'), 'D18: today bd:done fires at LOI upload');
});

// ---------------------------------------------------------------- proposed patches
test('patch 02 (module_catalog): fixes D18, leaves only the documented unreachable outcomes', () => {
  assert.equal(sha256(MIG_PATH), corr.base.sha256, 'migration changed since the patch was written');
  const rows = parseCatalog(readText(MIG_PATH));
  for (const [k, ch] of Object.entries(corr.rows)) Object.assign(rows[k], Object.fromEntries(['name', 'outcome_map', 'reached_map'].filter(f => f in ch).map(f => [f, ch[f]])));
  assert.ok(!reached(rows.bd, 'loi_uploaded').has('done'), 'loi_uploaded no longer means BD done');
  assert.ok(reached(rows.bd, 'legal_review').has('done'));
  const left = unreachable(rows, { legal: ['done'] });
  const known = Object.fromEntries(Object.entries(corr.knownUnreachableAfterPatch).map(([k, v]) => [k === 'project_excellence' ? 'pex' : k, Object.keys(v).sort()]));
  assert.deepEqual(left, known);
  // with the optional view (02b) everything the flow offers becomes observable
  assert.deepEqual(unreachable(rows, { legal: ['done', 'submitted'], project_excellence: ['done'] }), {});
  // monotone: every reached list of a later status contains the earlier ones (bd chain)
  const chain = ['draft_submitted', 'shortlisted', 'details_submitted', 'approved', 'loi_uploaded', 'legal_review'];
  for (let i = 1; i < chain.length; i++) for (const o of reached(rows.bd, chain[i - 1])) assert.ok(reached(rows.bd, chain[i]).has(o), `${chain[i]} ⊇ ${chain[i - 1]}`);
  // the SQL and the seed diff carry exactly the JSON literals
  const sql = readText(`${CCP}/proposed-patches/02-module_catalog-corrections.sql`);
  const diff = readText(`${CCP}/proposed-patches/02-module_catalog-seed.diff`);
  for (const ch of Object.values(corr.rows)) for (const f of ['outcome_map', 'reached_map']) if (ch[f]) {
    const lit = JSON.stringify(ch[f]);
    assert.ok(sql.includes(`'${lit}'::jsonb`), 'sql ' + f); assert.ok(diff.includes(`+     '${lit}'`), 'diff ' + f);
  }
});

test('patch 01 (matrix-bd-flow.json): applies cleanly and fixes the stale facts', async () => {
  const ops = readJson(`${CCP}/proposed-patches/01-matrix-bd-flow.json-patch.json`);
  assert.ok(ops.every(o => o['x-g2']), 'every op names its finding');
  const patched = applyOrConfirmApplied(flow, ops);
  const st = (k, o) => patched.modules.find(m => m.key === k).stages.find(s => s.order === o);
  assert.ok(!/skips this review|starts at shortlisted/.test(st('bd', 1)['x-matrix'].note));
  assert.ok(st('pex', 3).fields.some(f => f.key === 'pex_initialization_date' && f.kind === 'date' && f.required));
  assert.deepEqual(st('project', 4).approvers, ['supervisor']);
  assert.equal(st('project', 4)['x-matrix'].coOwner.module, 'pex');
  assert.equal(patched.modules.find(m => m.key === 'finance_ca')['x-matrix'].gateTriple.event, 'loi_uploaded');
  assert.ok(st('launch_approval', 2)['x-matrix'].creatorRule.identity.includes('assigned_to'));
  assert.ok(patched['x-matrix'].stageLevelGates.some(g => g.module === 'financial_closure'));
  assert.ok(patched['x-matrix'].executiveScope.bd.rule.includes('submitted_by'));
  // still a valid v5 manifest
  const { validate } = await import(path.join(ROOT, 'building-blocks/lib/mini-schema.mjs'));
  const { toV5Manifest } = await import(path.join(ROOT, 'building-blocks/from-matrix-bd/flow-adapter.mjs'));
  const schema = readJson('building-blocks/from-design/manifest.schema.json');
  assert.deepEqual(validate(schema, toV5Manifest(patched), schema), []);
  // the generator diff touches the same facts
  const gen = readText(`${CCP}/proposed-patches/01-build-matrix-bd-flow.mjs.diff`);
  for (const s of ['pex_initialization_date', 'gateTriple', 'coOwner', 'creatorRule', 'executiveScope', 'no supervisor auto-shortlist']) assert.ok(gen.includes(s), 'generator diff lacks ' + s);
});

test('patch 03 (approvals.json): removes the stale supervisor-skip claim', () => {
  const approvals = readJson('building-blocks/from-matrix-bd/approvals.json');
  const out = applyOrConfirmApplied(approvals, readJson(`${CCP}/proposed-patches/03-approvals.json-patch.json`));
  assert.ok(!JSON.stringify(out).includes('skip review'));
});

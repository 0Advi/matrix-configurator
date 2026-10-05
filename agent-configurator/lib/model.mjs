// Pure helpers over v5's draft shapes. No I/O besides reading the building-block JSON files once.
//
//   blob  = localStorage['wsconfig_v5_custom'] = { customWs: [{id,name,slug,start,created}], data: {[id]: stash} }
//   stash = Component.stashOf(state) = { modules, perms, live: {modules, perms}, liveV, draftV, history }
//
// Validation, findings, diff and manifest come from building-blocks/from-design/validation.mjs —
// faithful ports of v5's methods (parity proven there, and re-checked in our tests against the
// class itself on every draft the ops produce).
import { readFileSync } from 'node:fs';
import * as V from '../../building-blocks/from-design/validation.mjs';
import { validate as schemaValidate } from '../../building-blocks/lib/mini-schema.mjs';
import { invalid, notFound } from './errors.mjs';
import { parseHint } from './hints.mjs';

const readJSON = rel => JSON.parse(readFileSync(new URL('../../building-blocks/' + rel, import.meta.url), 'utf8'));
export const WORKSPACE_SCHEMA = readJSON('from-design/workspace.schema.json');
export const MANIFEST_SCHEMA = readJSON('from-design/manifest.schema.json');
export const VOCAB = readJSON('from-design/vocabularies.json');
export { V };

/** v5 findings that make a flow broken (nothing can move) vs. advisory ones. */
export const ERROR_TAGS = Object.freeze(['key collision', 'gate cycle', 'dead gate', 'unreachable', 'no approver']);
export const WARNING_TAGS = Object.freeze(['pending eng', 'dead link', 'field kind']);

/** Built-in module keys the Matrix app knows (docs/F4-API.md §0) and the configurator alias. */
export const APP_BUILTIN_KEYS = Object.freeze(['bd', 'legal', 'finance_ca', 'design', 'project_excellence', 'project', 'nso', 'launch_approval', 'financial_closure']);
export const APP_BUILTIN_ALIASES = Object.freeze({ pex: 'project_excellence' });
/** Keys the app refuses as modules (retired built-in / delegation-only scope). */
export const APP_NOT_MODULES = Object.freeze(['payment', 'quality_audit']);

export const APPROVER_ROLES = Object.freeze(['supervisor', 'executive', 'business_admin']);
export const PERM_ROLES = Object.freeze(['supervisor', 'executive', 'business_admin', 'observer']);
export const FIELD_KIND_IDS = Object.freeze(V.FIELD_KINDS.slice());
export const OUTCOMES = Object.freeze(V.STAGE_OUTCOMES.slice());
export const ROLLUPS = Object.freeze(V.ROLLUP_STRATEGIES.slice());
export const BUILTIN_CATALOG = VOCAB.builtinModuleCatalog;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** v5's date style: "05 Oct 2026". */
export function v5Date(d = new Date()) { return String(d.getDate()).padStart(2, '0') + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }

export const clone = x => JSON.parse(JSON.stringify(x));

// ------------------------------------------------------------------ blob / workspace

export function resolveWorkspace(blob, ref) {
  if (typeof ref !== 'string' || !ref.trim()) throw invalid('`workspace` is required: the workspace id (ws_…), slug or exact name.');
  const r = ref.trim();
  const list = blob.customWs || [];
  const cw = list.find(w => w.id === r) || list.find(w => w.slug === r) || list.find(w => w.name.toLowerCase() === r.toLowerCase());
  if (!cw) {
    const demo = ['bluetokai', 'starbucks', 'burgerking'].includes(r);
    throw notFound(demo
      ? `"${r}" is one of v5's built-in demo workspaces, which v5 never persists (edits reset on reload). Create your own with create_workspace (template "bluetokai" copies Blue Tokai).`
      : `No workspace "${r}" in the draft store.`, { available: list.map(w => ({ id: w.id, slug: w.slug, name: w.name })) });
  }
  const stash = blob.data && blob.data[cw.id];
  if (!stash) throw notFound(`Workspace ${cw.id} has no draft data in the store (v5 drops entries it never loaded).`);
  return { cw, stash };
}

export function withStash(blob, id, stash, customWs) {
  const data = Object.assign({}, blob.data, { [id]: stash });
  return { customWs: customWs || blob.customWs, data };
}

export function withoutWorkspace(blob, id) {
  const data = Object.assign({}, blob.data);
  delete data[id];
  return { customWs: blob.customWs.filter(w => w.id !== id), data };
}

/** validation.mjs state for a stash (custom workspaces have no signals and no spine in v5). */
export function stateOf(stash, mode = 'draft') { return Object.assign({ signals: [], spine: [], mode }, stash); }

export function findModule(stash, key) {
  if (typeof key !== 'string' || !key) throw invalid('`module` (the module key) is required.');
  const m = stash.modules.find(x => x.key === key) || stash.modules.find(x => x.name.toLowerCase() === key.toLowerCase());
  if (!m) throw notFound(`No module "${key}" in this workspace.`, { modules: stash.modules.map(x => x.key) });
  return m;
}

export function requireCustom(m, what) {
  if (m.kind !== 'custom') {
    throw invalid(`${m.name} is a built-in module: its ${what} are defined by the platform and run on its own tables (v5 locks them; the app ignores built-in stages). Editable on built-ins: enable switch, name, gate, tier flags, navigation. To change ${what}, add a custom module instead.`);
  }
}

export function findStage(m, ref) {
  if (ref === undefined || ref === null || ref === '') throw invalid('`stage` is required: the stage number (1-based) or its exact name.');
  let i = -1;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) i = Number(ref) - 1;
  else i = m.stages.findIndex(s => s.name.toLowerCase() === String(ref).trim().toLowerCase());
  if (i < 0 || i >= m.stages.length) throw notFound(`No stage "${ref}" in ${m.key}.`, { stages: m.stages.map((s, n) => `${n + 1}. ${s.name}`) });
  return i;
}

export function findField(stage, ref) {
  let f = stage.fields.findIndex(x => x.key === ref);
  if (f < 0) f = stage.fields.findIndex(x => x.label.toLowerCase() === String(ref || '').toLowerCase());
  if (f < 0) throw notFound(`No field "${ref}" in stage "${stage.name}".`, { fields: stage.fields.map(x => x.key) });
  return f;
}

/** Id generator continuing v5's scheme (f_N, s_N, ns_N, ni_N) past every id already in `blob`. */
export function idFactory(start) {
  let n = start;
  return prefix => prefix + '_' + (++n);
}

// ------------------------------------------------------------------ findings / checks

export function classify(list) {
  const errors = [], warnings = [];
  for (const f of list) (ERROR_TAGS.includes(f.tag) ? errors : warnings).push({ tag: f.tag, text: f.text, module: String(f.id || '').replace(/^mod:/, '') || undefined });
  return { errors, warnings };
}

export function findingsOf(stash) { return V.findings(stateOf(stash)); }

/** Error-class findings present after but not before (a human's pre-existing problems never block the agent). */
export function newErrorFindings(beforeStash, afterStash) {
  const key = f => f.tag + '|' + f.text;
  const had = new Set(beforeStash ? findingsOf(beforeStash).map(key) : []);
  return classify(findingsOf(afterStash)).errors.filter(f => !had.has(f.tag + '|' + f.text));
}

export function schemaErrors(stash) { return schemaValidate(WORKSPACE_SCHEMA, stash, WORKSPACE_SCHEMA); }
export function blobSchemaErrors(blob) { return schemaValidate({ $ref: '#/$defs/storageBlob' }, blob, WORKSPACE_SCHEMA); }
export function manifestOf(cw, stash) { return V.buildManifest(stateOf(stash), cw); }
export function manifestSchemaErrors(manifest) { return schemaValidate(MANIFEST_SCHEMA, manifest, MANIFEST_SCHEMA); }

/**
 * Local app-parity checks: what the Matrix app's publish validator (module_runtime/validate.py)
 * will say, computed without signing in. Errors would make the app refuse the publish.
 */
export function appParity(stash) {
  const errors = [], warnings = [], notes = [];
  const builtinKeys = new Set([...APP_BUILTIN_KEYS, ...Object.keys(APP_BUILTIN_ALIASES)]);
  for (const m of stash.modules) {
    const where = { module: m.key };
    if (m.kind === 'builtin') {
      if (APP_NOT_MODULES.includes(m.key)) errors.push({ code: 'not_a_module', message: `"${m.key}" is retired or a delegation scope — the app refuses it as a module`, ...where });
      else if (!builtinKeys.has(m.key)) errors.push({ code: 'unknown_builtin', message: `"${m.key}" is not a built-in module of the app`, ...where });
      continue;
    }
    if (builtinKeys.has(m.key) || APP_NOT_MODULES.includes(m.key)) errors.push({ code: 'custom_key_collides', message: `custom module "${m.key}" uses a built-in module key`, ...where });
    if (m.enabled && !m.stages.length) errors.push({ code: 'no_stages', message: 'a custom module needs at least one stage', ...where });
    if (m.pendingEng || (m.rollup && m.rollup.strategy === 'custom')) warnings.push({ code: 'rollup_custom', message: 'roll-up "custom" needs engineering; the module parks when it finishes', ...where });
    m.stages.forEach((s, i) => {
      const at = { ...where, stage: i + 1 };
      const keys = s.fields.map(f => f.key);
      if (new Set(keys).size !== keys.length) errors.push({ code: 'duplicate_field', message: `field keys repeat in "${s.name}": ${keys.join(', ')}`, ...at });
      if (!s.approvers.length) warnings.push({ code: 'no_approver', message: `"${s.name}" has no approvers; the app defaults it to a supervisor`, ...at });
      const dropped = s.approvers.filter(r => (r === 'executive' && (m.supervisorOnly || !m.tiers.executive)) || (r === 'business_admin' && !m.tiers.admin));
      if (dropped.length) warnings.push({ code: 'tier_dropped', message: `"${s.name}" lists ${dropped.join(', ')} but the module's tiers switch ${dropped.length > 1 ? 'them' : 'it'} off; the app drops ${dropped.length > 1 ? 'them' : 'it'} from the approval chain`, ...at });
      for (const f of s.fields) {
        if (!parseHint(f.kind, f.validation).parsed) warnings.push({ code: 'unparsed_hint', message: `validation hint "${f.validation}" of ${f.kind} field is not machine-readable; the app shows it as help text`, ...at, field: f.key });
        if (f.affects && !['choice', 'yesno'].includes(f.kind)) warnings.push({ code: 'rollup_field_ignored', message: `${f.kind} field marked "affects outcome" cannot be scored by the roll-up; ignored`, ...at, field: f.key });
      }
    });
  }
  if (stash.modules.some(m => m.kind === 'builtin')) notes.push('Built-in modules run their own code in the app: only enabled/name/order/supervisor-only/delegation apply; their gates, stages and approvers are descriptive (F4-API §5).');
  return { errors, warnings, notes };
}

// ------------------------------------------------------------------ gates

/**
 * Build a gate the way v5's rail does: refusal auto-generated from the first condition
 * (withRefusal) unless a custom refusal is given (then `touched: true`, and v5 stops
 * regenerating it). Keeps an existing hand-written refusal when none is passed.
 */
export function buildGate(stash, m, { match, conds, refusal }) {
  if (!conds.length) return null;
  const st = stateOf(stash);
  const prev = m.gate;
  if (typeof refusal === 'string' && refusal.trim()) return { match, conds, refusal: refusal.trim(), touched: true };
  if (prev && prev.touched) return { match, conds, refusal: prev.refusal, touched: true };
  return V.withRefusal(st, m, { match, conds, refusal: '' });
}

/** Regenerate untouched refusals that mention a module (after a rename / condition change). */
export function refreshRefusals(stash) {
  const st = stateOf(stash);
  stash.modules = stash.modules.map(m => (m.gate && !m.gate.touched && m.gate.conds.length) ? Object.assign({}, m, { gate: V.withRefusal(st, m, m.gate) }) : m);
  return stash;
}

// ------------------------------------------------------------------ summaries (what an agent reads)

const label = r => V.ROLE_LABELS[r] || r;

export function gateSentence(stash, gate) {
  if (!gate || !gate.conds.length) return 'no entry gate — open as soon as a site exists';
  const st = stateOf(stash);
  return 'starts when ' + gate.conds.map(c => V.nameOf(st, c.src) + ' is ' + c.out).join(gate.match === 'all' ? ' AND ' : ' OR ');
}

export function moduleSummary(stash, m, { detail = 'summary' } = {}) {
  const st = stateOf(stash);
  const custom = m.kind === 'custom';
  return {
    key: m.key, name: m.name, kind: m.kind, enabled: m.enabled,
    state: m.pendingEng ? 'pending_engineering' : m.status,
    route: V.moduleRoute(m),
    gate: m.gate ? { match: m.gate.match, conditions: m.gate.conds.map(c => ({ source: c.src, outcome: c.out })), refusal: m.gate.refusal, custom_refusal: !!m.gate.touched } : null,
    gate_sentence: gateSentence(stash, m.gate),
    tiers: { supervisor: true, executive: !m.supervisorOnly && !!m.tiers.executive, business_admin_signoff: !!m.tiers.admin, supervisor_only: !!m.supervisorOnly, delegation: !!m.delegation },
    rollup: m.rollup, rollup_sentence: V.rollupSentence(m), exit_signal: m.exit,
    outcomes_reachable: V.sourceOutcomes(st, m.key),
    stages: custom || detail === 'full'
      ? m.stages.map((s, i) => ({ n: i + 1, name: s.name, approvers: s.approvers, outcome: s.outcome, fields: s.fields.map(f => ({ key: f.key, label: f.label, kind: f.kind, required: f.required, validation: f.validation, affects_outcome: !!f.affects })) }))
      : m.stages.map((s, i) => `${i + 1}. ${s.name} → ${s.outcome} (${s.approvers.map(label).join(', ') || 'no approver'})`),
    dependents: V.dependentsOf(stash.modules, m.key).map(d => d.key),
    ...(detail === 'full' ? { navigation: m.nav.map(sec => ({ section: sec.title, items: sec.items.map(it => ({ label: it.label, page: it.page, roles: it.roles, badge: it.badge || null })) })) } : {}),
  };
}

export function workspaceSummary(cw, stash, { detail = 'summary' } = {}) {
  const f = classify(findingsOf(stash));
  const diff = V.diffList(stateOf(stash));
  return {
    workspace: { id: cw.id, name: cw.name, slug: cw.slug, start: cw.start, created: cw.created },
    versions: { live: stash.liveV ? 'v' + stash.liveV : null, draft: 'v' + stash.draftV, published: stash.liveV > 0, unpublished_changes: diff.length },
    flow: V.flowOrder(stash.modules).map(m => m.key + (m.gate && m.gate.conds.length ? ' ⇐ ' + m.gate.conds.map(c => c.src + ':' + c.out).join(m.gate.match === 'all' ? ' & ' : ' | ') : '')),
    disabled: stash.modules.filter(m => !m.enabled).map(m => m.key),
    modules: stash.modules.map(m => moduleSummary(stash, m, { detail })),
    findings: f,
    ...(detail === 'full' ? { permissions: stash.perms.map(p => ({ action: p.action, granted: p.roles, ceiling: p.ceiling })) } : { permissions_count: stash.perms.length }),
    last_publish: stash.history && stash.history[0] ? stash.history[0] : null,
  };
}

/** What changed between two stashes, in plain words (for op results). */
export function changeLines(before, after) {
  const st = stateOf(Object.assign({}, after, { live: { modules: before ? before.modules : [], perms: before ? before.perms : [] } }));
  return V.diffList(st).map(d => d.text);
}

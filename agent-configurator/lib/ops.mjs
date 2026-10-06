// The configurator's operations — one core for both front doors (bin/cfg.mjs and mcp-server.mjs).
//
// Adapted from the user's own operaton-plat (github.com/Adityashandilya555/operaton-plat @ fc654998,
// matrix.py op_* + mcp_server.py): small, fixed-shape operations an agent can chain from a plain-
// language brief; every change is validated before it is saved; errors go back to the agent; the
// human decides to publish. Here the "workspace.json" is the v5 draft blob of the visual Workspace
// Configurator (design-time store, D2) and publish goes through the Matrix app's platform API.
//
// Every op: { name, title, description, input (JSON Schema), readOnly, destructive, run(ctx, args) }.
import { readFileSync } from 'node:fs';
import { OpError, invalid, refused, notFound } from './errors.mjs';
import { ConflictError, createHttpStore } from './store.mjs';
import { createAppClient } from './app-api.mjs';
import { loadConfig } from './config.mjs';
import { validate as schemaValidate } from '../../building-blocks/lib/mini-schema.mjs';
import { toV5WorkspaceDocument } from '../../building-blocks/from-matrix-bd/flow-adapter.mjs';
import { v5CreateWorkspace, v5AddBuiltin, v5AddCustomModule, v5Toggle, v5Publish, maxIdSuffix } from './v5.mjs';
import { HINT_FORMATS, parseHint } from './hints.mjs';
import {
  V, VOCAB, BUILTIN_CATALOG, OUTCOMES, ROLLUPS, APPROVER_ROLES, PERM_ROLES, FIELD_KIND_IDS,
  APP_BUILTIN_KEYS, APP_BUILTIN_ALIASES, APP_NOT_MODULES, ERROR_TAGS, WARNING_TAGS,
  clone, v5Date, resolveWorkspace, withStash, withoutWorkspace, stateOf, findModule, requireCustom,
  findStage, findField, idFactory, classify, findingsOf, newErrorFindings, schemaErrors,
  manifestOf, manifestSchemaErrors, appParity, buildGate, refreshRefusals, moduleSummary,
  workspaceSummary, gateSentence,
} from './model.mjs';

// ====================================================================== context

export function createContext(o = {}) {
  const config = o.config || loadConfig(o.env);
  return {
    config,
    store: o.store || createHttpStore({ baseUrl: config.cfgUrl, fetchImpl: o.fetchImpl }),
    app: o.app || createAppClient({ apiUrl: config.apiUrl, credentials: config.adminCredentials, fetchImpl: o.fetchImpl }),
    agentName: config.agentName,
    appUrl: config.appUrl,
    today: o.today || (() => new Date()),
  };
}

// ====================================================================== schema helpers

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = description => ({ type: 'boolean', description });
const obj = (properties, required = [], description) => ({ type: 'object', properties, required, additionalProperties: false, ...(description ? { description } : {}) });
const WS = str('Workspace id (ws_…), slug or exact name — see list_workspaces.');
const MOD = str('Module key, e.g. "legal" or "vendor_onboarding" (see show_workspace).');
const STAGE = { type: ['integer', 'string'], description: 'Stage number (1-based) or its exact name.' };
const ALLOW = bool('Write even if the step leaves NEW broken-flow findings (gate cycle, dead gate, unreachable outcome, stage without approver, key collision). Use only for a deliberate partial step you will fix next; the findings are reported. Default false = such a step is refused and nothing is written.');
const DRY = bool('Only compute and report the result; write nothing.');
const CONFIRM = bool('Required (true) to actually apply this destructive change. Without it the op is a dry run that shows what would happen.');
const OUTCOME = { type: 'string', enum: OUTCOMES, description: 'One of: ' + OUTCOMES.join(', ') + '.' };
const APPROVERS = { type: 'array', items: { type: 'string', enum: APPROVER_ROLES }, minItems: 1, uniqueItems: true, description: 'Tier chain that signs this stage, any of executive < supervisor < business_admin. The lowest tier listed submits the stage form; each higher tier then approves (or sends back / rejects). E.g. ["executive","supervisor"] = executive fills it in, supervisor approves.' };
const FIELD_SPEC = obj({
  label: str('What the user sees, e.g. "GST number".'),
  key: str('Optional storage key (snake_case). Default: derived from the label like the v5 wizard.'),
  kind: { type: 'string', enum: FIELD_KIND_IDS, description: 'choice | yesno | text | number | date | file | person. Default text.' },
  required: bool('Must be filled before the stage can be submitted. Default false.'),
  validation: str('Validation hint. App-readable formats — choice: "a · b · c"; number: "min 0 · max 120" or "0–100"; text: a regex starting with ^; file: "pdf · max 10MB"; person: a tier name. Anything else is shown as help text only (warning unparsed_hint).'),
  affects_outcome: bool('This answer feeds the module roll-up (only choice / yes-no answers can be scored). Default false.'),
}, ['label'], 'A stage field.');
const STAGE_SPEC = obj({
  name: str('Stage name, unique within the module, e.g. "Compliance check".'),
  approvers: APPROVERS,
  outcome: { ...OUTCOME, description: 'Outcome the stage reaches when signed off (what downstream gates can wait for). Default approved. ' + OUTCOME.description },
  fields: { type: 'array', items: FIELD_SPEC, description: 'Fields of the stage form, in order.' },
}, ['name'], 'A stage of a custom module.');
const CONDITIONS = {
  type: 'array', minItems: 1,
  items: obj({ source: str('Module key the site must have reached an outcome in.'), outcome: { ...OUTCOME, description: 'Outcome to wait for. Default: approved if that module can reach it, else done, else its first outcome.' } }, ['source']),
  description: 'Gate conditions, combined with `match`.',
};
const ROLLUP_SPEC = obj({
  strategy: { type: 'string', enum: ROLLUPS, description: 'all_positive (approved when every checked answer is yes/n.a.; rejected on any no) | any_negative (rejected as soon as one is no) | count_at_least (approved when ≥ n of `of` are yes) | sum_under (approved while a number field stays under `limit`) | custom (needs engineering: module parks as Pending engineering).' },
  n: { type: 'integer', minimum: 1, description: 'count_at_least: yes answers needed.' },
  of: { type: 'integer', minimum: 1, description: 'count_at_least: out of how many checked fields.' },
  field: str('sum_under: label of the number field to sum.'),
  limit: { type: ['string', 'number'], description: 'sum_under: the limit, e.g. "25,00,000" or 2500000.' },
}, ['strategy']);

function checkInput(op, args) {
  const a = args === undefined || args === null ? {} : args;
  if (typeof a !== 'object' || Array.isArray(a)) throw invalid(`${op.name}: arguments must be a JSON object.`);
  const errs = schemaValidate(op.input, a, op.input);
  if (errs.length) throw invalid(`${op.name}: invalid arguments — ${errs.slice(0, 6).join('; ')}`, { errors: errs.slice(0, 20), expected: op.input });
  return a;
}

// ====================================================================== shared steps

function wsRef(cw) { return { id: cw.id, slug: cw.slug, name: cw.name }; }

function brief(stash) {
  return {
    modules: stash.modules.map(m => `${m.key}${m.enabled ? '' : ' (off)'}${m.kind === 'custom' ? ' [custom]' : ''}`),
    versions: { live: stash.liveV ? 'v' + stash.liveV : null, draft: 'v' + stash.draftV },
  };
}

function parityFor(stash, moduleKey) {
  const p = appParity(stash);
  const pick = list => moduleKey ? list.filter(x => x.module === moduleKey) : list;
  const out = { errors: pick(p.errors), warnings: pick(p.warnings) };
  return out.errors.length || out.warnings.length ? out : undefined;
}

async function readFresh(ctx, ref) {
  try {
    const { blob } = await ctx.store.read();
    const { cw, stash } = resolveWorkspace(blob, ref);
    return { workspace: wsRef(cw), ...brief(stash) };
  } catch { return null; }
}

/**
 * Merge-around invariant, checked on EVERY write: apart from the one target workspace, the blob we
 * send must carry every other workspace (customWs entry + draft data) byte-identical and in the
 * same order as it was read. So an op can never modify or drop a workspace it was not asked to
 * touch — e.g. a human's drafts sitting next to the agent's. Protected ids (CFG_PROTECTED_WORKSPACES)
 * cannot be the target at all.
 */
export function assertMergeAround(readBlob, nextBlob, targetId) {
  const others = b => b.customWs.filter(w => w.id !== targetId).map(w => JSON.stringify([w, (b.data || {})[w.id] === undefined ? null : b.data[w.id]]));
  const a = others(readBlob), b = others(nextBlob);
  const extra = Object.keys(nextBlob.data || {}).filter(id => id !== targetId && !nextBlob.customWs.some(w => w.id === id) && !(readBlob.data || {}).hasOwnProperty(id));
  if (a.length !== b.length || a.some((x, i) => x !== b[i]) || extra.length) {
    throw new OpError('internal', 'Refusing to write: the change would touch workspaces other than ' + targetId + ' (merge-around invariant). Nothing was written.');
  }
}

function assertWritable(ctx, id) {
  const p = (ctx.config && ctx.config.protectedWorkspaces) || [];
  if (p.includes(id)) throw refused(`Workspace ${id} is protected in this session (CFG_PROTECTED_WORKSPACES): the agent may read it but not change or delete it.`);
}

async function safeWrite(ctx, readBlob, nextBlob, etag, targetId) {
  assertWritable(ctx, targetId);
  assertMergeAround(readBlob, nextBlob, targetId);
  return ctx.store.write(nextBlob, etag);
}

async function writeOrConflict(ctx, ref, blob, etag, readBlob, targetId) {
  try {
    return await safeWrite(ctx, readBlob, blob, etag, targetId);
  } catch (e) {
    if (e instanceof ConflictError) {
      const current = await readFresh(ctx, ref);
      throw new OpError('conflict', 'Someone saved these drafts in the meantime (a human in the visual configurator, or another agent). Nothing was written. Re-read with show_workspace and redo this step on the current draft.', { current });
    }
    throw e;
  }
}

/**
 * Read → change → check → write, for ops on one existing workspace.
 * `fn({ blob, cw, stash })` mutates/returns { stash, changes[], notes?[], toast?, moduleKey?, extra? }.
 */
async function mutate(ctx, args, fn, { destructive = false } = {}) {
  const { blob, etag } = await ctx.store.read();
  const { cw, stash } = resolveWorkspace(blob, args.workspace);
  assertWritable(ctx, cw.id);
  const before = clone(stash);
  const r = await fn({ blob, cw, stash: clone(stash), before });
  const next = r.stash;
  const sErr = schemaErrors(next);
  if (sErr.length) throw new OpError('internal', 'Refusing to write: the resulting draft does not match workspace.schema.json (this is a bug in the agent configurator).', { schema_errors: sErr.slice(0, 10) });
  const added = newErrorFindings(before, next);
  if (added.length && !args.allow_new_findings) {
    throw refused('Refused: this step would leave the flow broken — ' + added.map(f => f.text).join(' | '), {
      new_findings: added,
      hint: 'Fix the cause first (e.g. add the stage/outcome the gate waits for, give the stage an approver, pick another source), or pass allow_new_findings:true for a deliberate partial step.',
    });
  }
  const result = {
    workspace: wsRef(cw),
    changes: r.changes || [],
    ...(r.toast ? { configurator_says: r.toast } : {}),
    ...(r.notes && r.notes.length ? { notes: r.notes } : {}),
    ...(added.length ? { new_findings: added } : {}),
    findings: classify(findingsOf(next)),
    ...(parityFor(next, r.moduleKey) ? { app_parity: parityFor(next, r.moduleKey) } : {}),
    ...(r.extra || {}),
  };
  const dry = args.dry_run || (destructive && args.confirm !== true);
  if (dry) return { dry_run: true, ...(destructive && args.confirm !== true ? { note: 'Dry run — nothing was written. Repeat with confirm:true to apply.' } : {}), ...result };
  const w = await writeOrConflict(ctx, args.workspace, withStash(blob, cw.id, next, r.customWs), etag, blob, cw.id);
  return { saved: true, ...result, ...(w && w.etag ? { etag: w.etag } : {}) };
}

function existingSlugs(blob) { return ['bluetokai', 'starbucks', 'burgerking', ...blob.customWs.map(w => w.slug)]; }

function customKeyError(key, stash) {
  const v5 = V.moduleKeyError(key, { modules: stash.modules, signals: [] });
  if (v5) return v5;
  if (APP_BUILTIN_KEYS.includes(key) || key in APP_BUILTIN_ALIASES || APP_NOT_MODULES.includes(key)) return `“${key}” is a built-in module key in the Matrix app — a custom module cannot reuse it.`;
  return '';
}

function normField(spec, { id, keyTouched = true } = {}) {
  const labelText = String(spec.label || '').trim();
  if (!labelText) throw invalid('Every field needs a label.');
  const key = V.slugify(spec.key !== undefined && spec.key !== '' ? spec.key : labelText);
  if (!key) throw invalid(`Field "${labelText}": cannot derive a key — pass key (snake_case).`);
  const f = {
    ...(id ? { id } : {}),
    label: labelText, key, kind: spec.kind || 'text', required: !!spec.required,
    validation: spec.validation === undefined || spec.validation === null ? '' : String(spec.validation),
    affects: !!spec.affects_outcome,
  };
  if (spec.key !== undefined && spec.key !== '' && keyTouched) f.keyTouched = true;
  return f;
}

function hintNotes(fields) {
  return fields.map(f => {
    const p = parseHint(f.kind, f.validation);
    if (!f.validation) return null;
    return p.parsed ? `${f.key}: hint "${f.validation}" → ${p.note || 'understood by the app'}` : `${f.key}: hint "${f.validation}" is not machine-readable for ${f.kind} fields — the app shows it as help text (format: ${HINT_FORMATS[f.kind]}).`;
  }).filter(Boolean);
}

function checkStageSpec(m, spec, otherNames) {
  const name = String(spec.name || '').trim();
  if (!name) throw invalid('A stage needs a name.');
  if (otherNames.some(n => n.toLowerCase() === name.toLowerCase())) throw invalid(`${m.key} already has a stage named "${name}" — stage names must be unique within a module (v5 matches stages by name).`);
  const approvers = spec.approvers || ['supervisor'];
  if ((m.supervisorOnly) && approvers.includes('executive')) throw invalid(`${m.name} is supervisor-only: a stage cannot list the executive tier. Use ["supervisor"] or turn supervisor_only off with set_tiers.`);
  const fields = (spec.fields || []).map(f => normField(f));
  const keys = fields.map(f => f.key);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) throw invalid(`Stage "${name}": two fields share the key "${dup}" (the app refuses duplicate field keys in a stage).`);
  return { name, approvers, outcome: spec.outcome || 'approved', fields };
}

function resolveConditions(stash, m, conditions) {
  const st = stateOf(stash);
  const seen = new Set();
  return conditions.map(c => {
    const src = stash.modules.find(x => x.key === c.source) || stash.modules.find(x => x.name.toLowerCase() === String(c.source).toLowerCase());
    if (!src) throw invalid(`Gate source "${c.source}" is not a module of this workspace.`, { modules: stash.modules.map(x => x.key) });
    if (m && src.key === m.key) throw invalid(`${m.name} cannot wait on itself.`);
    if (seen.has(src.key)) throw invalid(`The gate already waits on ${src.key} — one condition per source module.`);
    seen.add(src.key);
    const out = c.outcome || V.defaultOutcome(st, src.key);
    const reachable = V.sourceOutcomes(st, src.key);
    return { src: src.key, out, reachable: reachable.includes(out), reachableOutcomes: reachable };
  });
}

function rollupFrom(spec, m) {
  const r = { strategy: spec.strategy };
  const prev = m && m.rollup ? m.rollup : { n: 3, of: 5, limit: '25,00,000' };
  if (spec.strategy === 'count_at_least') {
    const of = spec.of ?? (m ? m.stages.reduce((a, s) => a + s.fields.filter(f => f.affects).length, 0) : 0) ?? prev.of;
    const n = spec.n ?? prev.n;
    if (!of || of < 1) throw invalid('count_at_least needs `of` ≥ 1 (how many checked fields there are).');
    if (n > of) throw invalid(`count_at_least: n (${n}) cannot exceed of (${of}).`);
    Object.assign(r, { n, of });
  } else if (spec.strategy === 'sum_under') {
    if (!spec.field || spec.limit === undefined) throw invalid('sum_under needs `field` (label of a number field) and `limit`.');
    const nf = m ? m.stages.flatMap(s => s.fields).find(f => f.kind === 'number' && (f.label === spec.field || f.key === spec.field)) : null;
    if (m && !nf) throw invalid(`sum_under: ${m.key} has no number field "${spec.field}".`);
    Object.assign(r, { field: nf ? nf.label : spec.field, limit: spec.limit });
  } else {
    // keep v5's carried-over defaults so the editor shows the same values a human would see
    Object.assign(r, { n: prev.n ?? 3, of: prev.of ?? 5, limit: prev.limit ?? '25,00,000' });
    if (prev.field) r.field = prev.field;
  }
  return r;
}

// ====================================================================== templates

let _seedCache = null;
function seeds() {
  if (!_seedCache) _seedCache = JSON.parse(readFileSync(new URL('../../building-blocks/from-design/seed-workspaces.json', import.meta.url), 'utf8'));
  return _seedCache;
}
let _flowCache = null;
function matrixBdFlow() {
  if (!_flowCache) _flowCache = JSON.parse(readFileSync(new URL('../../building-blocks/from-matrix-bd/matrix-bd-flow.json', import.meta.url), 'utf8'));
  return _flowCache;
}

const WORKSPACE_TEMPLATES = {
  empty: 'No modules — add built-in and custom modules yourself (v5 "Start from zero").',
  bluetokai: 'Copy of the Blue Tokai template: all 9 built-in modules as a draft (v5 "Copy the Blue Tokai template").',
  'matrix-bd': 'The production Matrix-bd (Blue Tokai) flow extracted from the real app: 9 built-ins with their real stages/fields (building-blocks/from-matrix-bd), as an unpublished draft.',
};

// ====================================================================== ops

const OPS = [];
const op = def => { OPS.push(def); return def; };

// ---------------------------------------------------------------- read-only

op({
  name: 'list_workspaces', title: 'List workspaces', readOnly: true,
  description: 'List the workspaces in the design-time draft store (the same drafts the visual Workspace Configurator shows): id, slug, live/draft version, module counts and open broken-flow findings. Also names the read-only demo templates. Set include_app:true to add each workspace\'s status in the Matrix app (provisioned? workspace code, live release) — that signs in as platform admin.',
  input: obj({ include_app: bool('Also fetch provisioning/release status from the Matrix app (needs platform-admin credentials).') }),
  async run(ctx, args) {
    const { blob } = await ctx.store.read();
    const workspaces = blob.customWs.map(cw => {
      const s = blob.data[cw.id];
      if (!s) return { id: cw.id, slug: cw.slug, name: cw.name, note: 'no draft data' };
      const f = classify(findingsOf(s));
      return {
        id: cw.id, slug: cw.slug, name: cw.name, start: cw.start, created: cw.created,
        live: s.liveV ? 'v' + s.liveV : null, draft: 'v' + s.draftV,
        modules: s.modules.length, enabled: s.modules.filter(m => m.enabled).length, custom: s.modules.filter(m => m.kind === 'custom').length,
        open_errors: f.errors.length, open_warnings: f.warnings.length,
      };
    });
    const out = {
      store: ctx.store.baseUrl || ctx.store.kind,
      workspaces,
      templates: Object.entries(WORKSPACE_TEMPLATES).map(([id, note]) => ({ id, note })),
      demo_workspaces_note: 'bluetokai, starbucks and burgerking are v5 demo workspaces: read-only examples, never persisted. Use create_workspace (template "bluetokai") to start from Blue Tokai.',
    };
    if (args.include_app) {
      try {
        const list = await ctx.app.listWorkspaces();
        const byRef = new Map((list.items || []).map(x => [x.configurator_ref, x]));
        for (const w of workspaces) {
          const a = byRef.get(w.id);
          w.app = a ? { status: a.status, workspace_code: a.workspace_code, live_release: a.live_release ? a.live_release.version : null, release_count: a.release_count } : { status: 'not provisioned' };
        }
        out.app_only = (list.items || []).filter(x => !blob.customWs.some(w => w.id === x.configurator_ref)).map(x => ({ ref: x.configurator_ref, company: x.company, status: x.status, live_release: x.live_release ? x.live_release.version : null }));
      } catch (e) {
        out.app = { skipped: e.message, code: e.code };
      }
    }
    return out;
  },
});

op({
  name: 'show_workspace', title: 'Show a workspace', readOnly: true,
  description: 'Read one workspace draft: modules in flow order with their entry gates (in words), tiers, roll-up, exit signal, stages and fields (custom modules in full; built-ins as one line per stage), reachable outcomes per module, dependents, open v5 findings (errors = broken flow, warnings = advisory) and app-parity checks. detail:"full" adds navigation, permissions and built-in fields; include_manifest:true adds the exact v5 draft manifest that publish would send to the app.',
  input: obj({ workspace: WS, detail: { type: 'string', enum: ['summary', 'full'], description: 'summary (default) or full.' }, include_manifest: bool('Include the v5 draft manifest (large).') }, ['workspace']),
  async run(ctx, args) {
    const { blob } = await ctx.store.read();
    const { cw, stash } = resolveWorkspace(blob, args.workspace);
    const out = workspaceSummary(cw, stash, { detail: args.detail || 'summary' });
    const p = appParity(stash);
    out.app_parity = p;
    if (args.include_manifest) out.manifest = manifestOf(cw, stash);
    return out;
  },
});

op({
  name: 'catalogue', title: 'Catalogue', readOnly: true,
  description: 'What you can build with: the 9 built-in modules (key, name, default gate, stages, pages; built-ins run on the platform\'s own code — you can switch them on/off, rename, re-gate, set tier flags), the custom-module wizard templates (vendor, retail, franchise), workspace templates, and every vocabulary — stage outcomes, field kinds with the validation-hint formats the app understands, roll-up strategies, approver tiers, permissions with their platform ceilings, key/slug rules. Call this first when turning a brief into a workspace.',
  input: obj({}),
  async run() {
    const wiz = seeds().wizardTemplates;
    return {
      builtin_modules: BUILTIN_CATALOG.map(b => ({
        key: b.key, name: b.name, icon: b.icon, app_key: APP_BUILTIN_ALIASES[b.key] || b.key,
        default_gate: b.gate ? { match: b.gate.match, conditions: b.gate.conds.map(c => ({ source: c.src, outcome: c.out })) } : null,
        stages: b.stages, supervisor_only: b.supervisorOnly, change_request_loop: !!b.changeRequestLoop,
        pages: b.pages.map(p => p[0]),
      })),
      builtin_note: 'add_builtin_module copies a built-in; its default gate keeps only the conditions whose source module is already in the workspace (v5 behaviour). In the Matrix app built-ins honour enabled/name/order/supervisor-only/delegation; their gates/stages/approvers are descriptive.',
      custom_module_templates: Object.fromEntries(Object.entries(wiz).map(([k, t]) => [k, {
        name: t.manifest.module.name, key: t.manifest.module.key,
        stages: t.manifest.stages.map(s => ({ name: s.name, approvers: s.approvers, outcome: s.outcome, fields: s.fields.map(f => `${f.key}:${f.kind}${f.required ? '*' : ''}${f.affects_outcome ? ' (affects outcome)' : ''}`) })),
      }])),
      workspace_templates: WORKSPACE_TEMPLATES,
      vocabularies: {
        outcomes: OUTCOMES,
        field_kinds: VOCAB.fieldKinds.map(k => ({ kind: k.id, label: k.label, hint_format: HINT_FORMATS[k.id] })),
        rollup_strategies: VOCAB.rollupStrategies.map(r => ({ strategy: r.id, title: r.title, meaning: r.preview })),
        approver_tiers: ['executive (does the work, submits)', 'supervisor (always present, owns the queue, approves)', 'business_admin (workspace-wide sign-off)'],
        tier_flags: VOCAB.tiers.map(t => ({ flag: t.k, label: t.label, meaning: t.sub })),
        gate_match: { all: 'every condition must hold (parallel join)', any: 'one condition is enough' },
        permissions: VOCAB.permissions.map(p => ({ action: p.action, ceiling: p.platformCeiling, granted_by_default: p.grantedByDefault })),
        module_icons: VOCAB.moduleIcons,
        nav_badges: VOCAB.navBadgeSources.map(b => b.id).filter(Boolean),
      },
      rules: {
        module_key: 'lowercase letters, digits, underscores; starts with a letter; 2–39 chars; not reserved (' + VOCAB.reservedModuleKeys.join(', ') + '); not a built-in key (' + [...APP_BUILTIN_KEYS, 'pex'].join(', ') + '); unique in the workspace',
        workspace_slug: 'lowercase letters, digits, hyphens; starts with a letter; 2–31 chars; not reserved (' + VOCAB.reservedWorkspaceSlugs.join(', ') + '); unique',
        broken_flow_findings: ERROR_TAGS,
        advisory_findings: WARNING_TAGS,
      },
    };
  },
});

op({
  name: 'validate', title: 'Validate a draft', readOnly: true,
  description: 'Check a draft before publishing: (1) local — workspace.schema.json, v5\'s own findings (errors = broken flow; warnings = advisory) and app-parity checks computed offline; (2) the Matrix app\'s dry run (POST …/releases/validate: JSON Schema, module resolution, gate/roll-up compilation, stage forms) unless app:false. verdict "ready" means publish will be accepted.',
  input: obj({ workspace: WS, app: bool('Run the app dry run too (default true; needs platform-admin credentials).') }, ['workspace']),
  async run(ctx, args) {
    const { blob } = await ctx.store.read();
    const { cw, stash } = resolveWorkspace(blob, args.workspace);
    const manifest = manifestOf(cw, stash);
    const local = {
      schema_errors: schemaErrors(stash),
      manifest_schema_errors: manifestSchemaErrors(manifest),
      findings: classify(findingsOf(stash)),
      app_parity: appParity(stash),
    };
    let app = { skipped: 'app:false' };
    if (args.app !== false) {
      try {
        const v = await ctx.app.validate(cw.id, manifest);
        app = { ok: v.ok, errors: v.errors, warnings: v.warnings, findings: v.findings, modules: v.modules };
      } catch (e) {
        app = { skipped: e.message, code: e.code };
      }
    }
    const localBlocked = local.schema_errors.length || local.manifest_schema_errors.length || local.findings.errors.length || local.app_parity.errors.length;
    const verdict = localBlocked || app.ok === false ? 'blocked' : (app.ok ? 'ready' : 'ready_locally (app check skipped)');
    return { workspace: wsRef(cw), verdict, local, app };
  },
});

op({
  name: 'diff', title: 'Draft vs live', readOnly: true,
  description: 'What publishing would change: v5\'s own draft-vs-live change list (created / renamed / enabled / disabled / gate / stages / roll-up / fields / approvers / navigation / removed / permissions) with the impact v5 explains for each, plus live stages with sites that the draft removes (need a decision).',
  input: obj({ workspace: WS }, ['workspace']),
  async run(ctx, args) {
    const { blob } = await ctx.store.read();
    const { cw, stash } = resolveWorkspace(blob, args.workspace);
    const st = stateOf(stash);
    const d = V.diffList(st);
    return {
      workspace: wsRef(cw), from: 'v' + stash.liveV, to: 'v' + stash.draftV,
      draft_matches_live: d.length === 0,
      changes: d.map(x => ({ tag: x.tag, text: x.text, impact: x.impact || null, level: x.level })),
      stages_needing_decision: V.stagesNeedingDecision(st).map(x => ({ module: x.mod.key, stage: x.stage.name, sites: x.stage.sites, default: 'finish on v' + stash.liveV })),
    };
  },
});

// ---------------------------------------------------------------- workspaces

op({
  name: 'create_workspace', title: 'Create a workspace',
  description: 'Create a new custom workspace draft exactly like v5\'s "+ New workspace" dialog. template: "empty" (no modules; default), "bluetokai" (all 9 built-in modules of the Blue Tokai template as a draft) or "matrix-bd" (the real production flow). The slug (URL name) is derived from the name unless given. Nothing is provisioned in the app until the first publish.',
  input: obj({
    name: str('Display name, e.g. "Agent Coffee".'),
    slug: str('Optional URL slug (lowercase, digits, hyphens; 2–31 chars). Default: from the name.'),
    template: { type: 'string', enum: Object.keys(WORKSPACE_TEMPLATES), description: 'empty | bluetokai | matrix-bd. Default empty.' },
    dry_run: DRY,
  }, ['name']),
  async run(ctx, args) {
    const name = String(args.name).trim();
    if (!name || name.length > 120) throw invalid('name must be 1–120 characters.');
    const slug = args.slug ? String(args.slug).trim() : V.workspaceSlugFromName(name);
    const template = args.template || 'empty';
    const { blob, etag } = await ctx.store.read();
    const slugErr = V.workspaceSlugError(slug, { existingSlugs: existingSlugs(blob) });
    if (!slug || slugErr) throw invalid(slugErr || 'Cannot derive a slug from that name — pass slug.', { slug });
    const id = V.workspaceIdFromSlug(slug);
    if (blob.customWs.some(w => w.id === id)) throw invalid(`A workspace with id ${id} already exists.`);
    const r = v5CreateWorkspace(blob, { name, slug, start: template === 'empty' ? 'empty' : 'template' });
    if (r.error) throw invalid(r.error);
    const customWs = r.customWs.map(w => w.id === id ? Object.assign({}, w, { created: v5Date(ctx.today()) }) : w);
    let stash = r.stash;
    const notes = [];
    if (template === 'matrix-bd') {
      const doc = toV5WorkspaceDocument(matrixBdFlow());
      stash = { modules: doc.modules.map(m => Object.assign({}, m, { status: 'draft' })), perms: doc.perms, live: { modules: [], perms: doc.perms }, liveV: 0, draftV: 1, history: [] };
      notes.push('Loaded the production Matrix-bd flow (building-blocks/from-matrix-bd/matrix-bd-flow.json) as an unpublished draft.');
    }
    const sErr = schemaErrors(stash);
    if (sErr.length) throw new OpError('internal', 'new workspace does not match workspace.schema.json', { schema_errors: sErr.slice(0, 10) });
    const cw = customWs.find(w => w.id === id);
    const result = {
      workspace: { ...wsRef(cw), start: cw.start, created: cw.created },
      ...(r.toast ? { configurator_says: r.toast } : {}),
      ...(notes.length ? { notes } : {}),
      ...brief(stash),
      next: stash.modules.length ? 'Adjust modules (disable_module / add_custom_module / set_gate …), then validate.' : 'Add modules: add_builtin_module (e.g. "bd") and/or add_custom_module.',
    };
    if (args.dry_run) return { dry_run: true, ...result };
    await writeOrConflict(ctx, id, withStash(blob, id, stash, customWs), etag, blob, id);
    return { saved: true, ...result };
  },
});

op({
  name: 'delete_workspace', title: 'Delete a workspace draft', destructive: true,
  description: 'Delete a workspace DRAFT from the design-time store (v5 has no delete button; this is for cleaning up). Its design-time release ledger is kept. It does NOT remove a tenant already provisioned in the Matrix app — the result says if one exists. Dry run unless confirm:true.',
  input: obj({ workspace: WS, confirm: CONFIRM }, ['workspace']),
  async run(ctx, args) {
    const { blob, etag } = await ctx.store.read();
    const { cw, stash } = resolveWorkspace(blob, args.workspace);
    let app = null;
    if (ctx.app.configured) {
      try {
        const a = await ctx.app.getWorkspace(cw.id);
        app = a ? { provisioned: true, status: a.status, workspace_code: a.workspace_code, live_release: a.live_release ? a.live_release.version : null, warning: 'The app tenant stays (there is no delete API); only the draft is removed.' } : { provisioned: false };
      } catch (e) { app = { skipped: e.message }; }
    }
    assertWritable(ctx, cw.id);
    const result = { workspace: wsRef(cw), ...brief(stash), app };
    if (args.confirm !== true) return { dry_run: true, note: 'Dry run — repeat with confirm:true to delete the draft.', ...result };
    await writeOrConflict(ctx, cw.id, withoutWorkspace(blob, cw.id), etag, blob, cw.id);
    return { deleted: true, ...result };
  },
});

// ---------------------------------------------------------------- modules

op({
  name: 'add_builtin_module', title: 'Add a built-in module',
  description: 'Add one of the 9 platform modules (see catalogue) to the workspace, exactly like v5\'s "Add built-in": it arrives enabled, as a draft, with its default entry gate reduced to the source modules already present (add them in flow order — e.g. bd before legal — to keep the usual gates). If it is already in the workspace but off, use enable_module.',
  input: obj({ workspace: WS, key: { type: 'string', enum: BUILTIN_CATALOG.map(b => b.key), description: 'Built-in key: ' + BUILTIN_CATALOG.map(b => b.key).join(', ') + '.' }, allow_new_findings: ALLOW, dry_run: DRY }, ['workspace', 'key']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ blob, cw, stash }) => {
      const have = stash.modules.find(m => m.key === args.key);
      if (have) throw invalid(`${have.name} is already in this workspace (${have.enabled ? 'on' : 'off'}).${have.enabled ? '' : ' Use enable_module.'}`);
      const r = v5AddBuiltin(blob, cw.id, args.key);
      if (r.error) throw invalid(r.error);
      const m = r.stash.modules.find(x => x.key === args.key);
      return { stash: r.stash, toast: r.toast, moduleKey: args.key, changes: [`Added built-in ${m.name} (${m.key}) — ${gateSentence(r.stash, m.gate)}.`] };
    });
  },
});

op({
  name: 'enable_module', title: 'Turn a module on',
  description: 'Switch a module that is in the workspace but off back on (v5 toggle: nav, pages, API and approvals come back; paused allocations resume).',
  input: obj({ workspace: WS, module: MOD, allow_new_findings: ALLOW, dry_run: DRY }, ['workspace', 'module']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ blob, cw, stash }) => {
      const m = findModule(stash, args.module);
      if (m.enabled) return { stash, changes: [`${m.name} is already on — nothing to do.`] };
      const r = v5Toggle(blob, cw.id, [m.key], false);
      return { stash: r.stash, toast: r.toast, moduleKey: m.key, changes: [`${m.name} turned on.`] };
    });
  },
});

op({
  name: 'disable_module', title: 'Turn a module off',
  description: 'Switch a module off for this workspace (v5 semantics: genuinely unavailable — nav, pages, API, notifications, approvals — not hidden; data is kept). Refused, with v5\'s explanation, when enabled modules wait on it in their gates; then either change their gates (set_gate) or pass also_disable_dependents:true to switch them (and their dependents) off too.',
  input: obj({ workspace: WS, module: MOD, also_disable_dependents: bool('Also switch off every enabled module that (transitively) waits on this one.'), revoke_allocations: bool('Revoke executive allocations instead of pausing them (v5 checkbox). Default false.'), allow_new_findings: ALLOW, dry_run: DRY }, ['workspace', 'module']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ blob, cw, stash }) => {
      const m = findModule(stash, args.module);
      if (!m.enabled) return { stash, changes: [`${m.name} is already off — nothing to do.`] };
      const st = stateOf(stash);
      const why = V.toggleOffRefusal(st, m.key);
      let keys = [m.key];
      if (why) {
        if (!args.also_disable_dependents) throw refused(why, { dependents: V.dependentsOf(stash.modules, m.key).filter(d => d.enabled).map(d => d.key), options: ['set_gate on each dependent so it no longer waits on ' + m.key, 'disable_module with also_disable_dependents:true'] });
        const queue = [m.key];
        while (queue.length) {
          const k = queue.shift();
          for (const d of V.dependentsOf(stash.modules, k)) if (d.enabled && !keys.includes(d.key)) { keys.push(d.key); queue.push(d.key); }
        }
      }
      const r = v5Toggle(blob, cw.id, keys, args.revoke_allocations);
      return { stash: r.stash, toast: r.toast, moduleKey: m.key, changes: keys.map(k => `${stash.modules.find(x => x.key === k).name} turned off${args.revoke_allocations ? ' (allocations revoked)' : ' (allocations paused)'}.`) };
    });
  },
});

op({
  name: 'remove_module', title: 'Remove a module', destructive: true,
  description: 'Delete a module from the draft (v5 itself only switches built-ins off — prefer disable_module for them; in the app a module missing from the manifest is disabled, its data kept but unreachable). Modules whose gates wait on it: dependents:"refuse" (default) stops; "drop_conditions" removes those conditions; "inherit_gate" makes them wait on what the removed module waited on (operaton-plat\'s remove_module rewiring). Dry run unless confirm:true.',
  input: obj({ workspace: WS, module: MOD, dependents: { type: 'string', enum: ['refuse', 'drop_conditions', 'inherit_gate'], description: 'What to do with gates that wait on this module. Default refuse.' }, confirm: CONFIRM, allow_new_findings: ALLOW }, ['workspace', 'module']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ stash }) => {
      const m = findModule(stash, args.module);
      const deps = V.dependentsOf(stash.modules, m.key).filter(d => d.key !== m.key);
      const mode = args.dependents || 'refuse';
      if (deps.length && mode === 'refuse') throw refused(`${deps.map(d => d.name).join(', ')} wait${deps.length === 1 ? 's' : ''} on ${m.name}. Choose dependents:"drop_conditions" or "inherit_gate", or re-gate them first with set_gate.`, { dependents: deps.map(d => d.key) });
      const changes = [`Removed ${m.kind} module ${m.name} (${m.key}).`];
      let mods = stash.modules.filter(x => x.key !== m.key);
      mods = mods.map(x => {
        if (!x.gate || !x.gate.conds.some(c => c.src === m.key)) return x;
        let conds = x.gate.conds.filter(c => c.src !== m.key);
        if (mode === 'inherit_gate' && m.gate) for (const c of m.gate.conds) if (c.src !== x.key && !conds.some(y => y.src === c.src)) conds.push({ src: c.src, out: c.out });
        changes.push(`${x.name}: gate now ${conds.length ? 'waits on ' + conds.map(c => c.src + ' ' + c.out).join(x.gate.match === 'all' ? ' and ' : ' or ') : 'removed (opens immediately)'}.`);
        return Object.assign({}, x, { gate: conds.length ? Object.assign({}, x.gate, { conds }) : null });
      });
      const next = refreshRefusals(Object.assign({}, stash, { modules: mods }));
      const notes = [];
      if (m.kind === 'builtin') notes.push('Built-in modules are normally switched off, not removed (v5 has no remove for them). Removing keeps nothing in the draft; disable_module keeps its configuration.');
      if (stash.live.modules.some(x => x.key === m.key)) notes.push(`${m.name} is live (v${stash.liveV}): after publish its site data stays in the database but becomes unreachable in the app.`);
      return { stash: next, changes, notes };
    }, { destructive: true });
  },
});

op({
  name: 'add_custom_module', title: 'Add a custom module',
  description: 'Create a custom module through v5\'s 9-step wizard (identity, people, entry gate, stages, fields, roll-up, screens, exit signal) in one call; the module runs on the app\'s generic runtime at /m/<key> with overview, queue, history and checklist-review screens. Give stages in order with approvers (tier chain) and fields; a gate via `gate` or the `starts_after` shorthand. template (vendor | retail | franchise) pre-fills the wizard like v5; anything you pass overrides it. Key: derived from the name unless given; checked against v5\'s key rules and the app\'s built-in keys.',
  input: obj({
    workspace: WS,
    name: str('Module name, e.g. "Vendor Onboarding".'),
    key: str('Optional module key (snake_case, 2–39 chars). Default: from the name.'),
    icon: str('Optional glyph, e.g. "⧉" (see catalogue.vocabularies.module_icons).'),
    template: { type: 'string', enum: ['blank', 'vendor', 'retail', 'franchise'], description: 'Wizard template. Default blank (one stage "Stage 1").' },
    supervisor_only: bool('No executive tier: supervisors do the work themselves. Default false.'),
    executive_tier: bool('Executives do the work and submit for review. Default true.'),
    business_admin_signoff: bool('Business admins can sign off stages. Default true.'),
    delegation: bool('Executives can only act on sites a supervisor assigned/delegated to them. Default true.'),
    gate: obj({ match: { type: 'string', enum: ['all', 'any'], description: 'all (default) or any.' }, conditions: CONDITIONS, refusal: str('Optional message shown while locked. Default: generated like v5.') }, ['conditions'], 'Entry gate: when sites enter this module\'s queue.'),
    starts_after: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Shorthand gate: module keys that must all reach their default outcome (approved, else done) first.' },
    stages: { type: 'array', items: STAGE_SPEC, minItems: 1, description: 'Stages in order (at least one).' },
    rollup: ROLLUP_SPEC,
    exit_signal: { ...OUTCOME, description: 'Outcome other modules\' gates see when this module finishes. Default approved.' },
    allow_new_findings: ALLOW, dry_run: DRY,
  }, ['workspace', 'name']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ blob, cw, stash }) => {
      const name = String(args.name).trim();
      if (!name) throw invalid('name is required.');
      const key = args.key ? V.sanitizeModuleKeyInput(args.key) : V.moduleKeyFromName(name);
      const kErr = customKeyError(key, stash);
      if (!key || kErr) throw invalid(kErr || 'Cannot derive a key from that name — pass key.', { key });
      if (args.gate && args.starts_after) throw invalid('Pass either gate or starts_after, not both.');
      const supervisorOnly = !!args.supervisor_only;
      const shell = { key, name, supervisorOnly, gate: null };
      const patch = { name, key, keyTouched: true };
      if (args.icon) patch.icon = args.icon;
      patch.supervisorOnly = supervisorOnly;
      patch.tiers = { executive: supervisorOnly ? false : args.executive_tier !== false, supervisor: true, admin: args.business_admin_signoff !== false };
      patch.delegation = args.delegation !== false;
      const notes = [];
      if (args.stages) {
        const names = [];
        patch.stages = args.stages.map(s => { const n = checkStageSpec(shell, s, names); names.push(n.name); return n; });
        patch.stages.forEach(s => notes.push(...hintNotes(s.fields)));
      }
      const gateSpec = args.gate || (args.starts_after ? { match: 'all', conditions: args.starts_after.map(s => ({ source: s })) } : null);
      if (gateSpec) {
        const conds = resolveConditions(stash, shell, gateSpec.conditions);
        const bad = conds.filter(c => !c.reachable);
        if (bad.length && !args.allow_new_findings) throw refused(bad.map(c => `${c.src} never reaches “${c.out}” (it can reach: ${c.reachableOutcomes.join(', ')})`).join('; '), { hint: 'Pick a reachable outcome, or pass allow_new_findings:true if you are about to add the stage that produces it.' });
        patch.gate = { match: gateSpec.match || 'all', conds: conds.map(c => ({ src: c.src, out: c.out })), refusal: gateSpec.refusal ? String(gateSpec.refusal).trim() : '' };
      }
      if (args.rollup) {
        const pseudo = { rollup: { n: 3, of: 5, field: 'Budget total', limit: '25,00,000' }, stages: (patch.stages || []).map(s => ({ fields: s.fields })) };
        // same key order as v5's wizard state: strategy, n, of, field, limit
        patch.rollup = Object.assign({ strategy: args.rollup.strategy, n: 3, of: 5, field: 'Budget total', limit: '25,00,000' }, rollupFrom(args.rollup, pseudo));
        if (args.rollup.strategy === 'custom') notes.push('Roll-up "custom" files an engineering request: the module sits in Pending engineering and parks cases until an engineer ships the rule.');
      }
      if (args.exit_signal) patch.exit = args.exit_signal;
      const r = v5AddCustomModule(blob, cw.id, args.template || 'blank', patch);
      if (r.error) throw invalid(r.error);
      let next = r.stash;
      if (gateSpec && gateSpec.refusal) next = Object.assign({}, next, { modules: next.modules.map(m => m.key === key ? Object.assign({}, m, { gate: Object.assign({}, m.gate, { touched: true }) }) : m) });
      const m = next.modules.find(x => x.key === key);
      return {
        stash: next, toast: r.toast, moduleKey: key, notes,
        changes: [`Created custom module ${m.name} (${m.key}) at ${V.moduleRoute(m)} — ${m.stages.length} stage(s): ${m.stages.map(s => `${s.name} [${s.approvers.join(' → ')}] → ${s.outcome}`).join('; ')}; ${gateSentence(next, m.gate)}.`],
        extra: { module: moduleSummary(next, m) },
      };
    });
  },
});

op({
  name: 'update_module', title: 'Rename / re-icon a module',
  description: 'Change a module\'s display name (= its label in the app\'s navigation) and/or icon. Works for built-ins too (marked "reconfigured" like v5\'s tenant edits). Untouched gate refusal messages that mention the module are regenerated.',
  input: obj({ workspace: WS, module: MOD, name: str('New display name.'), icon: str('New glyph.'), dry_run: DRY, allow_new_findings: ALLOW }, ['workspace', 'module']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ stash }) => {
      const m = findModule(stash, args.module);
      if (args.name === undefined && args.icon === undefined) throw invalid('Pass name and/or icon.');
      const changes = [];
      const patch = {};
      if (args.name !== undefined) {
        const nm = String(args.name).trim();
        if (!nm) throw invalid('name cannot be empty.');
        if (stash.modules.some(x => x.key !== m.key && x.name.toLowerCase() === nm.toLowerCase())) throw invalid(`Another module is already called "${nm}".`);
        patch.name = nm;
        if (m.kind === 'custom') patch.nav = m.nav.map(sec => sec.title === m.name ? Object.assign({}, sec, { title: nm }) : sec);
        else Object.assign(patch, { recon: true, edits: (m.edits || []).concat(['renamed “' + m.name + '” → “' + nm + '”']) });
        changes.push(`${m.name} renamed to ${nm}.`);
      }
      if (args.icon !== undefined) {
        const ic = String(args.icon).trim();
        if (!ic || [...ic].length > 2) throw invalid('icon must be one glyph.');
        patch.icon = ic;
        changes.push(`${patch.name || m.name}: icon ${m.icon} → ${ic}.`);
      }
      const next = Object.assign({}, stash, { modules: stash.modules.map(x => x.key === m.key ? Object.assign({}, x, patch) : x) });
      return { stash: refreshRefusals(next), changes, moduleKey: m.key };
    });
  },
});

op({
  name: 'set_gate', title: 'Set a module\'s entry gate',
  description: 'Decide when sites enter a module\'s queue ("starts after"). conditions = [{source, outcome}] combined with match all (every one — a parallel join) or any; starts_after = shorthand for all-of with default outcomes; clear:true removes the gate (opens immediately). Refused if it would create a cycle, wait on a module that is off, or wait for an outcome the source can never reach (the result lists reachable outcomes). The locked-screen refusal message is generated like v5 unless you pass one. On built-ins the gate is descriptive in the app.',
  input: obj({
    workspace: WS, module: MOD,
    conditions: CONDITIONS,
    starts_after: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Module keys that must all reach their default outcome first.' },
    match: { type: 'string', enum: ['all', 'any'], description: 'all (default; keeps the current setting when omitted) or any.' },
    refusal: str('Message shown while the module is locked. Omit to keep a hand-written one or auto-generate.'),
    clear: bool('Remove the gate entirely.'),
    allow_new_findings: ALLOW, dry_run: DRY,
  }, ['workspace', 'module']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ stash }) => {
      const m = findModule(stash, args.module);
      const given = ['conditions', 'starts_after', 'clear'].filter(k => args[k] !== undefined && args[k] !== false);
      if (given.length !== 1 && !(given.length === 0 && (args.match || args.refusal))) throw invalid('Pass exactly one of conditions, starts_after or clear:true (or only match/refusal to adjust the existing gate).');
      let gate;
      const notes = [];
      if (args.clear) gate = null;
      else {
        let condSpecs = args.conditions || (args.starts_after ? args.starts_after.map(s => ({ source: s })) : null);
        if (!condSpecs) {
          if (!m.gate) throw invalid(`${m.name} has no gate to adjust — pass conditions or starts_after.`);
          condSpecs = m.gate.conds.map(c => ({ source: c.src, outcome: c.out }));
        }
        const conds = resolveConditions(stash, m, condSpecs);
        const bad = conds.filter(c => !c.reachable);
        if (bad.length && !args.allow_new_findings) throw refused(bad.map(c => `${c.src} never reaches “${c.out}” (it can reach: ${c.reachableOutcomes.join(', ')})`).join('; '), { hint: 'Pick a reachable outcome, or allow_new_findings:true if you are about to add the stage that produces it.' });
        const match = args.match || (m.gate ? m.gate.match : 'all');
        const draftGate = { match, conds: conds.map(c => ({ src: c.src, out: c.out })), refusal: '' };
        const cyc = V.gateCycle(stateOf(stash), m.key, draftGate);
        if (cyc && !args.allow_new_findings) throw refused(cyc);
        gate = buildGate(stash, m, { match, conds: draftGate.conds, refusal: args.refusal });
      }
      if (m.kind === 'builtin') notes.push('Built-in module: the app runs its own code, so this gate is descriptive there (only custom modules enforce gates).');
      const next = Object.assign({}, stash, { modules: stash.modules.map(x => x.key === m.key ? Object.assign({}, x, { gate }) : x) });
      return { stash: next, moduleKey: m.key, notes, changes: [`${m.name}: ${gateSentence(next, gate)}.` + (gate ? ` Locked message: “${gate.refusal}”` : '')] };
    });
  },
});

// ---------------------------------------------------------------- stages & fields (custom modules)

function patchModule(stash, key, fn) {
  return Object.assign({}, stash, { modules: stash.modules.map(m => m.key === key ? fn(clone(m)) : m) });
}

op({
  name: 'add_stage', title: 'Add a stage',
  description: 'Insert a stage into a custom module (default: at the end). A stage = a step every site goes through: the lowest approver tier submits its form (fields), higher tiers approve / send back / reject; when signed off the stage reaches its outcome. Defaults like v5\'s wizard: approvers ["supervisor"], outcome approved, no fields.',
  input: obj({ workspace: WS, module: MOD, stage: STAGE_SPEC, position: { type: 'integer', minimum: 1, description: '1-based position to insert at. Default: after the last stage.' }, allow_new_findings: ALLOW, dry_run: DRY }, ['workspace', 'module', 'stage']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ blob, stash }) => {
      const m = findModule(stash, args.module); requireCustom(m, 'stages');
      const s = checkStageSpec(m, args.stage, m.stages.map(x => x.name));
      const uid = idFactory(maxIdSuffix(blob));
      const stage = { id: uid('s'), name: s.name, approvers: s.approvers, outcome: s.outcome, sites: 0, fields: s.fields.map(f => Object.assign({ id: uid('f') }, f)) };
      const pos = Math.min(Math.max((args.position || m.stages.length + 1) - 1, 0), m.stages.length);
      const next = patchModule(stash, m.key, x => { x.stages.splice(pos, 0, stage); return x; });
      return { stash: next, moduleKey: m.key, notes: hintNotes(stage.fields), changes: [`${m.name}: added stage ${pos + 1} “${stage.name}” [${stage.approvers.join(' → ')}] → ${stage.outcome}, ${stage.fields.length} field(s).`] };
    });
  },
});

op({
  name: 'update_stage', title: 'Change a stage',
  description: 'Rename a custom-module stage, change its approver chain or outcome, or move it (position). Fields are edited with add_field / update_field / remove_field.',
  input: obj({
    workspace: WS, module: MOD, stage: STAGE,
    changes: obj({ name: str('New name.'), approvers: APPROVERS, outcome: OUTCOME, position: { type: 'integer', minimum: 1, description: 'Move to this 1-based position.' } }, [], 'What to change.'),
    allow_new_findings: ALLOW, dry_run: DRY,
  }, ['workspace', 'module', 'stage', 'changes']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ stash }) => {
      const m = findModule(stash, args.module); requireCustom(m, 'stages');
      const i = findStage(m, args.stage);
      const c = args.changes;
      if (!Object.keys(c).length) throw invalid('changes is empty.');
      const cur = m.stages[i];
      const lines = [];
      const upd = Object.assign({}, cur);
      if (c.name !== undefined) {
        const nm = String(c.name).trim();
        if (!nm) throw invalid('name cannot be empty.');
        if (m.stages.some((s, j) => j !== i && s.name.toLowerCase() === nm.toLowerCase())) throw invalid(`${m.key} already has a stage named "${nm}".`);
        upd.name = nm; lines.push(`renamed “${cur.name}” → “${nm}”`);
      }
      if (c.approvers) {
        if (m.supervisorOnly && c.approvers.includes('executive')) throw invalid(`${m.name} is supervisor-only: no executive approvers.`);
        upd.approvers = c.approvers.slice(); lines.push(`approvers ${cur.approvers.join(' → ')} → ${c.approvers.join(' → ')}`);
      }
      if (c.outcome) { upd.outcome = c.outcome; lines.push(`outcome ${cur.outcome} → ${c.outcome}`); }
      const next = patchModule(stash, m.key, x => {
        x.stages[i] = upd;
        if (c.position) { const [s] = x.stages.splice(i, 1); x.stages.splice(Math.min(c.position - 1, x.stages.length), 0, s); lines.push(`moved to position ${Math.min(c.position, x.stages.length)}`); }
        return x;
      });
      const notes = [];
      if (stash.live.modules.some(lm => lm.key === m.key && lm.stages.some(ls => ls.name === cur.name && ls.sites)) && c.name) notes.push('Renaming a live stage that has sites counts as removing it: publish will ask what happens to those sites (default: they finish on the live version).');
      return { stash: next, moduleKey: m.key, notes, changes: [`${m.name} → stage “${cur.name}”: ${lines.join('; ')}.`] };
    });
  },
});

op({
  name: 'remove_stage', title: 'Remove a stage', destructive: true,
  description: 'Delete a stage from a custom module (a module keeps at least one stage). If the stage is live with sites in it, publishing lets them finish on the live version. Dry run unless confirm:true.',
  input: obj({ workspace: WS, module: MOD, stage: STAGE, confirm: CONFIRM, allow_new_findings: ALLOW }, ['workspace', 'module', 'stage']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ stash }) => {
      const m = findModule(stash, args.module); requireCustom(m, 'stages');
      const i = findStage(m, args.stage);
      if (m.stages.length === 1) throw invalid('A module needs at least one stage (v5 rule). Add another stage first, or remove the module.');
      const s = m.stages[i];
      const next = patchModule(stash, m.key, x => { x.stages.splice(i, 1); return x; });
      const notes = [];
      const ls = (stash.live.modules.find(x => x.key === m.key) || { stages: [] }).stages.find(x => x.name === s.name);
      if (ls && ls.sites) notes.push(`${ls.sites} live sites sit in “${s.name}”; at publish they finish on v${stash.liveV} (v5 default).`);
      const lost = s.fields.map(f => f.key);
      if (lost.length) notes.push('Fields removed with it: ' + lost.join(', ') + '.');
      return { stash: next, moduleKey: m.key, notes, changes: [`${m.name}: removed stage ${i + 1} “${s.name}”.`] };
    }, { destructive: true });
  },
});

op({
  name: 'add_field', title: 'Add a field',
  description: 'Add a field to a custom-module stage form. kind: choice (options in validation "a · b"), yesno, text (regex validation "^…$"), number ("min 0 · max 120"), date, file ("pdf · max 10MB"), person (validation = tier). affects_outcome:true makes the answer count in the module roll-up (choice / yes-no only). The key is derived from the label like the v5 wizard unless given; it must be unique in the stage.',
  input: obj({ workspace: WS, module: MOD, stage: STAGE, field: FIELD_SPEC, position: { type: 'integer', minimum: 1, description: '1-based position in the form. Default: last.' }, allow_new_findings: ALLOW, dry_run: DRY }, ['workspace', 'module', 'stage', 'field']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ blob, stash }) => {
      const m = findModule(stash, args.module); requireCustom(m, 'fields');
      const i = findStage(m, args.stage);
      const uid = idFactory(maxIdSuffix(blob));
      const f = normField(args.field, { id: uid('f') });
      if (m.stages[i].fields.some(x => x.key === f.key)) throw invalid(`Stage “${m.stages[i].name}” already has a field "${f.key}" — pass a different key.`);
      const elsewhere = m.stages.filter((s, j) => j !== i && s.fields.some(x => x.key === f.key)).map(s => s.name);
      const next = patchModule(stash, m.key, x => { const fs = x.stages[i].fields; fs.splice(Math.min((args.position || fs.length + 1) - 1, fs.length), 0, f); return x; });
      const notes = hintNotes([f]);
      if (elsewhere.length) notes.push(`Key "${f.key}" is also used in ${elsewhere.join(', ')} (allowed: values are stored per stage).`);
      if (f.affects && !['choice', 'yesno'].includes(f.kind)) notes.push('affects_outcome on a ' + f.kind + ' field is ignored by the roll-up (only choice / yes-no answers are scored).');
      return { stash: next, moduleKey: m.key, notes, changes: [`${m.name} → ${m.stages[i].name}: added ${f.kind} field “${f.label}” (${f.key})${f.required ? ', required' : ''}${f.affects ? ', affects outcome' : ''}.`] };
    });
  },
});

op({
  name: 'update_field', title: 'Change a field',
  description: 'Change a custom-module field: label, key, kind, required, validation hint or affects_outcome. Changing the kind of a field that is already live raises v5\'s "field kind" warning (stored values do not migrate).',
  input: obj({
    workspace: WS, module: MOD, stage: STAGE, field: str('Field key (or exact label).'),
    changes: obj({ label: str('New label.'), key: str('New key.'), kind: { type: 'string', enum: FIELD_KIND_IDS }, required: { type: 'boolean' }, validation: str('New hint ("" clears it).'), affects_outcome: { type: 'boolean' } }, [], 'What to change.'),
    allow_new_findings: ALLOW, dry_run: DRY,
  }, ['workspace', 'module', 'stage', 'field', 'changes']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ stash }) => {
      const m = findModule(stash, args.module); requireCustom(m, 'fields');
      const i = findStage(m, args.stage);
      const j = findField(m.stages[i], args.field);
      const cur = m.stages[i].fields[j];
      const c = args.changes;
      if (!Object.keys(c).length) throw invalid('changes is empty.');
      const upd = Object.assign({}, cur);
      const lines = [];
      if (c.label !== undefined) { const l = String(c.label).trim(); if (!l) throw invalid('label cannot be empty.'); upd.label = l; lines.push(`label → “${l}”`); }
      if (c.key !== undefined) {
        const k = V.slugify(c.key);
        if (!k) throw invalid('key must contain letters or digits.');
        if (m.stages[i].fields.some((x, n) => n !== j && x.key === k)) throw invalid(`Stage already has a field "${k}".`);
        upd.key = k; upd.keyTouched = true; lines.push(`key ${cur.key} → ${k}`);
      }
      if (c.kind) { upd.kind = c.kind; lines.push(`kind ${cur.kind} → ${c.kind}`); }
      if (c.required !== undefined) { upd.required = c.required; lines.push(c.required ? 'required' : 'optional'); }
      if (c.validation !== undefined) { upd.validation = String(c.validation); lines.push(`validation “${upd.validation}”`); }
      if (c.affects_outcome !== undefined) { upd.affects = c.affects_outcome; lines.push(c.affects_outcome ? 'affects outcome' : 'does not affect outcome'); }
      const next = patchModule(stash, m.key, x => { x.stages[i].fields[j] = upd; return x; });
      return { stash: next, moduleKey: m.key, notes: hintNotes([upd]), changes: [`${m.name} → ${m.stages[i].name} → ${cur.key}: ${lines.join('; ')}.`] };
    });
  },
});

op({
  name: 'remove_field', title: 'Remove a field', destructive: true,
  description: 'Delete a field from a custom-module stage form. Values already captured stay in the app\'s history but are no longer asked for. Dry run unless confirm:true.',
  input: obj({ workspace: WS, module: MOD, stage: STAGE, field: str('Field key (or exact label).'), confirm: CONFIRM, allow_new_findings: ALLOW }, ['workspace', 'module', 'stage', 'field']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ stash }) => {
      const m = findModule(stash, args.module); requireCustom(m, 'fields');
      const i = findStage(m, args.stage);
      const j = findField(m.stages[i], args.field);
      const f = m.stages[i].fields[j];
      const next = patchModule(stash, m.key, x => { x.stages[i].fields.splice(j, 1); return x; });
      const notes = [];
      if (m.rollup && m.rollup.strategy === 'sum_under' && m.rollup.field === f.label) notes.push(`The roll-up sums “${f.label}” — change it with set_outcome.`);
      return { stash: next, moduleKey: m.key, notes, changes: [`${m.name} → ${m.stages[i].name}: removed field “${f.label}” (${f.key}).`] };
    }, { destructive: true });
  },
});

// ---------------------------------------------------------------- people & outcome

op({
  name: 'set_tiers', title: 'Set tiers & delegation',
  description: 'Who works in a module: supervisor_only (no executive tier — supervisors do everything; executive approvers and nav access are removed), executive (executive tier on/off), business_admin_signoff (business admins may sign off stages), delegation (executives act only on sites assigned to them). On built-ins the app applies supervisor_only and delegation.',
  input: obj({ workspace: WS, module: MOD, supervisor_only: { type: 'boolean' }, executive: { type: 'boolean' }, business_admin_signoff: { type: 'boolean' }, delegation: { type: 'boolean' }, allow_new_findings: ALLOW, dry_run: DRY }, ['workspace', 'module']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ stash }) => {
      const m = findModule(stash, args.module);
      const keys = ['supervisor_only', 'executive', 'business_admin_signoff', 'delegation'].filter(k => args[k] !== undefined);
      if (!keys.length) throw invalid('Pass at least one of supervisor_only, executive, business_admin_signoff, delegation.');
      const lines = [];
      const notes = [];
      const next = patchModule(stash, m.key, x => {
        if (args.supervisor_only === true && !x.supervisorOnly) {
          if (x.kind === 'custom') {
            const execOnly = x.stages.filter(s => s.approvers.length === 1 && s.approvers[0] === 'executive');
            if (execOnly.length) throw invalid(`Stage(s) ${execOnly.map(s => '“' + s.name + '”').join(', ')} are signed by executives only — change their approvers (set_approvers) before making ${x.name} supervisor-only.`);
            x.stages = x.stages.map(s => s.approvers.includes('executive') ? Object.assign({}, s, { approvers: s.approvers.filter(r => r !== 'executive') }) : s);
          }
          x.supervisorOnly = true; x.tiers = Object.assign({}, x.tiers, { executive: false });
          x.nav = x.nav.map(sec => Object.assign({}, sec, { items: sec.items.map(it => Object.assign({}, it, { roles: it.roles.filter(r => r !== 'executive') })) }));
          lines.push('supervisor-only (executive tier removed from stages and navigation)');
        } else if (args.supervisor_only === false && x.supervisorOnly) {
          x.supervisorOnly = false; x.tiers = Object.assign({}, x.tiers, { executive: args.executive !== false });
          if (x.kind === 'custom') x.nav = x.nav.map(sec => Object.assign({}, sec, { items: sec.items.map(it => Object.assign({}, it, { roles: it.roles.includes('executive') ? it.roles : it.roles.concat(['executive']) })) }));
          else notes.push('Navigation of built-in modules is not changed: executives get pages back only where nav items list them.');
          lines.push('executives back (supervisor-only off)');
        }
        if (args.executive !== undefined && args.supervisor_only === undefined) {
          if (args.executive && x.supervisorOnly) throw invalid(`${x.name} is supervisor-only — pass supervisor_only:false to bring executives back.`);
          x.tiers = Object.assign({}, x.tiers, { executive: args.executive }); lines.push('executive tier ' + (args.executive ? 'on' : 'off'));
        }
        if (args.business_admin_signoff !== undefined) { x.tiers = Object.assign({}, x.tiers, { admin: args.business_admin_signoff }); lines.push('business-admin sign-off ' + (args.business_admin_signoff ? 'on' : 'off')); }
        if (args.delegation !== undefined) { x.delegation = args.delegation; lines.push('delegation ' + (args.delegation ? 'on (executives act only on assigned sites)' : 'off')); }
        return x;
      });
      return { stash: next, moduleKey: m.key, notes, changes: [`${m.name}: ${lines.join('; ') || 'no change'}.`] };
    });
  },
});

op({
  name: 'set_approvers', title: 'Set a stage\'s approvers',
  description: 'Set who signs a custom-module stage, as a tier chain executive < supervisor < business_admin: the lowest listed tier submits the stage form, each higher one approves. E.g. ["executive","supervisor"] = maker-checker; ["supervisor"] = supervisor does and approves; ["supervisor","business_admin"] = supervisor then business-admin sign-off.',
  input: obj({ workspace: WS, module: MOD, stage: STAGE, approvers: APPROVERS, allow_new_findings: ALLOW, dry_run: DRY }, ['workspace', 'module', 'stage', 'approvers']),
  async run(ctx, args) {
    return OPS_BY_NAME.update_stage.run(ctx, { workspace: args.workspace, module: args.module, stage: args.stage, changes: { approvers: args.approvers }, allow_new_findings: args.allow_new_findings, dry_run: args.dry_run });
  },
});

op({
  name: 'set_outcome', title: 'Set roll-up & outcomes',
  description: 'How a module decides and what it signals: rollup (the verdict from outcome-affecting answers: all_positive | any_negative | count_at_least {n, of} | sum_under {field, limit} | custom = needs engineering, parks the module), exit_signal (the outcome downstream gates see when the module finishes), and per-stage outcomes. Refused if a dependent\'s gate would wait for an outcome this module can no longer reach.',
  input: obj({
    workspace: WS, module: MOD,
    rollup: ROLLUP_SPEC,
    exit_signal: OUTCOME,
    stage_outcomes: { type: 'array', items: obj({ stage: STAGE, outcome: OUTCOME }, ['stage', 'outcome']), description: 'Per-stage outcome changes.' },
    allow_new_findings: ALLOW, dry_run: DRY,
  }, ['workspace', 'module']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ stash }) => {
      const m = findModule(stash, args.module);
      if (!args.rollup && !args.exit_signal && !args.stage_outcomes) throw invalid('Pass rollup, exit_signal and/or stage_outcomes.');
      if (args.stage_outcomes) requireCustom(m, 'stage outcomes');
      const lines = [], notes = [];
      const next = patchModule(stash, m.key, x => {
        if (args.rollup) {
          x.rollup = rollupFrom(args.rollup, x);
          x.pendingEng = args.rollup.strategy === 'custom';
          lines.push('roll-up: ' + V.rollupSentence(x));
          if (x.pendingEng) notes.push('custom roll-up → Pending engineering: the app parks finished cases until an engineer ships the rule.');
          if (x.kind === 'builtin') notes.push('Built-in roll-ups are descriptive in the app.');
        }
        if (args.exit_signal) { lines.push(`exit signal ${x.exit} → ${args.exit_signal}`); x.exit = args.exit_signal; }
        for (const so of args.stage_outcomes || []) { const i = findStage(x, so.stage); lines.push(`stage “${x.stages[i].name}” outcome ${x.stages[i].outcome} → ${so.outcome}`); x.stages[i] = Object.assign({}, x.stages[i], { outcome: so.outcome }); }
        return x;
      });
      return { stash: next, moduleKey: m.key, notes, changes: [`${m.name}: ${lines.join('; ')}.`] };
    });
  },
});

op({
  name: 'set_permission', title: 'Grant / narrow a permission',
  description: 'Set which roles may perform a workspace action (create_draft, shortlist, approve_details, reject, archive, legal_finalize_dd, …; see catalogue.vocabularies.permissions). Only roles inside the platform ceiling can be granted (v5 rule: operators can only narrow what the platform allows). Note: the app does not enforce manifest permissions yet.',
  input: obj({ workspace: WS, action: str('Permission action name.'), roles: { type: 'array', items: { type: 'string', enum: PERM_ROLES }, uniqueItems: true, description: 'Roles that hold the action (can be empty = nobody).' }, allow_new_findings: ALLOW, dry_run: DRY }, ['workspace', 'action', 'roles']),
  async run(ctx, args) {
    return mutate(ctx, args, ({ stash }) => {
      const p = stash.perms.find(x => x.action === args.action);
      if (!p) throw invalid(`No permission "${args.action}".`, { actions: stash.perms.map(x => x.action) });
      const outside = args.roles.filter(r => !p.ceiling.includes(r));
      if (outside.length) throw invalid(`Platform ceiling: ${outside.join(', ')} can never ${p.action} (ceiling: ${p.ceiling.join(', ')}).`);
      const roles = PERM_ROLES.filter(r => args.roles.includes(r));
      const next = Object.assign({}, stash, { perms: stash.perms.map(x => x.action === p.action ? Object.assign({}, x, { roles }) : x) });
      const notes = roles.length ? [] : ['Nobody holds this action now — every transition that needs it stalls (v5 diff impact: high).'];
      notes.push('The Matrix app does not enforce manifest permissions yet (F4a gap 2).');
      return { stash: next, notes, changes: [`${p.action}: ${p.roles.join(', ') || 'nobody'} → ${roles.join(', ') || 'nobody'}.`] };
    });
  },
});

// ---------------------------------------------------------------- publish & status

function provisionedView(ctx, d) {
  return {
    workspace_code: d.workspace_code,
    tenant_id: d.tenant_id,
    seat_limit: d.seat_limit,
    business_admin_email: d.admin_email,
    login_url: `${ctx.appUrl}/#/login/${encodeURIComponent(d.workspace_code)}`,
    setup_code: d.admin_setup_token,
    setup_code_warning: 'ONE-TIME SECRET, SHOWN ONLY NOW: give the setup code to the business admin privately (not in a shared channel, ticket or log). They claim the account on the app login page with the workspace code → "Request a reset" → enter the setup code → choose a password. It cannot be shown again.',
  };
}

op({
  name: 'publish', title: 'Publish', destructive: true,
  description: 'Make the draft live, exactly like the "Publish vN" button followed by the app hand-off: (1) checks — a reason is required (goes into version history), broken-flow findings block unless accept_findings:true, app-parity errors block, and the app\'s dry run must pass; (2) on the FIRST publish the workspace is provisioned as a real tenant in the Matrix app (needs provision.admin_email; company defaults to the workspace name) and the result carries the workspace code and the ONE-TIME setup code for the business admin (share privately; shown once); (3) v5 publish bookkeeping in the draft store (live snapshot, live vN, draft vN+1, history); (4) the manifest is stored as an immutable app release and activated (modules on/off, labels, order, custom-module runtime). Without confirm:true it is a dry run that reports exactly what would happen. resend_live:true re-sends the current live version to the app if an earlier hand-off failed.',
  input: obj({
    workspace: WS,
    reason: str('Why this version — required; shown in version history (≤ 500 chars).'),
    confirm: CONFIRM,
    provision: obj({
      admin_email: str('Business admin\'s e-mail (claims the account with the setup code).'),
      admin_name: str('Business admin\'s name.'),
      company: str('Company name in the app. Default: the workspace name.'),
      seat_limit: { type: 'integer', minimum: 1, description: 'Max users (1–10000). Default: the app\'s default.' },
      city: str('Optional city.'),
    }, ['admin_email'], 'Tenant details for the first publish (ignored when already provisioned).'),
    accept_findings: bool('Publish even though v5 reports broken-flow findings (v5: "allowed but not advised").'),
    resend_live: bool('Do not publish a new version: re-send the current live version to the app (only if the app does not have it yet).'),
  }, ['workspace']),
  async run(ctx, args) {
    const { blob, etag } = await ctx.store.read();
    const { cw, stash } = resolveWorkspace(blob, args.workspace);
    assertWritable(ctx, cw.id);
    if (args.resend_live) return resendLive(ctx, cw, stash, args);
    const reason = String(args.reason || '').trim();
    if (!reason) throw invalid('A reason is required — it goes into the version history (v5 blocks publishing without one).');
    if (reason.length > 500) throw invalid('reason must be ≤ 500 characters.');
    const st = stateOf(stash);
    const diff = V.diffList(st);
    const f = classify(findingsOf(stash));
    const parity = appParity(stash);
    const draftManifest = manifestOf(cw, stash);
    const mErr = manifestSchemaErrors(draftManifest);
    const plan = {
      workspace: wsRef(cw),
      version: { from: stash.liveV ? 'v' + stash.liveV : null, to: 'v' + stash.draftV },
      changes: diff.map(d => d.text),
      findings: f,
      ...(parity.errors.length || parity.warnings.length ? { app_parity: { errors: parity.errors, warnings: parity.warnings } } : {}),
      stages_needing_decision: V.stagesNeedingDecision(st).map(x => `${x.stage.sites} sites in ${x.mod.key} → “${x.stage.name}” finish on v${stash.liveV}`),
    };
    if (!diff.length && stash.liveV > 0) throw invalid(`Draft matches live v${stash.liveV} — nothing to publish. If the app is missing that version, use resend_live:true.`, plan);
    if (mErr.length) throw new OpError('internal', 'The v5 manifest does not match manifest.schema.json', { errors: mErr.slice(0, 10) });
    if (f.errors.length && !args.accept_findings) throw refused(`The draft has ${f.errors.length} broken-flow finding(s); fix them (validate shows them) or pass accept_findings:true.`, plan);
    if (parity.errors.length) throw refused('The Matrix app would refuse this draft: ' + parity.errors.map(e => e.message).join('; '), plan);
    // app dry run + provisioning state
    const v = await ctx.app.validate(cw.id, draftManifest);
    plan.app_validation = { ok: v.ok, errors: v.errors, warnings: v.warnings, findings: v.findings };
    if (!v.ok || v.errors > 0) throw refused(`The Matrix app's dry run found ${v.errors} error(s) — nothing was published.`, plan);
    const appWs = await ctx.app.getWorkspace(cw.id);
    if (appWs && appWs.status === 'provisioning') throw new OpError('app_error', 'The app is still provisioning this workspace (another publish in progress?). Retry in a minute.', plan);
    const needsProvision = !appWs || appWs.status === 'failed';
    const prov = args.provision || null;
    if (needsProvision) {
      plan.provisioning = prov && prov.admin_email
        ? { will_provision: true, configurator_ref: cw.id, company: prov.company || cw.name, admin_email: prov.admin_email, admin_name: prov.admin_name || null, seat_limit: prov.seat_limit || 'app default', ...(appWs ? { previous_attempt_failed: appWs.last_error || true } : {}) }
        : { will_provision: true, missing: 'provision.admin_email' };
    } else {
      plan.provisioning = { already_provisioned: true, workspace_code: appWs.workspace_code, live_release: appWs.live_release ? appWs.live_release.version : null };
    }
    if (args.confirm !== true) return { dry_run: true, note: 'Dry run — nothing was published. Show this plan to the human; repeat with confirm:true to publish.', ...plan };
    if (needsProvision && !(prov && prov.admin_email)) throw new OpError('needs_provisioning', 'First publish: the workspace must be provisioned as a tenant in the Matrix app. Pass provision: {admin_email, admin_name?, company?, seat_limit?}.', plan);

    // 1. provision (D3) — before anything is marked live, like the in-app portal's pre-publish gate
    let provisioned = null;
    if (needsProvision) {
      const body = { configurator_ref: cw.id, company: (prov.company || cw.name).slice(0, 200), admin_email: prov.admin_email, ...(prov.admin_name ? { admin_name: prov.admin_name } : {}), ...(prov.seat_limit ? { seat_limit: prov.seat_limit } : {}), ...(prov.city ? { city: prov.city } : {}) };
      const r = await ctx.app.provision(body);
      if (r.status === 201) provisioned = provisionedView(ctx, r.data);
      else if (r.status === 409 && r.data && r.data.code === 'already_provisioned') provisioned = null;
      else if (r.status === 422) throw invalid('The app refused the provisioning details: ' + ctx.app.detailText(r.data), { provision: { ...body } });
      else throw new OpError('app_error', `Provisioning answered ${r.status}: ${ctx.app.detailText(r.data)}`, { status: r.status, code: r.data && r.data.code });
    }
    const keep = provisioned ? { provisioned } : {};

    // 2. v5 publish bookkeeping in the design-time store (conflict-safe)
    const pub = v5Publish(blob, cw.id, reason, `${v5Date(ctx.today())} · agent:${ctx.agentName}`);
    if (pub.error) throw new OpError('internal', pub.error, keep);
    const manifest = manifestOf(cw, pub.stash);
    let written;
    try {
      written = await safeWrite(ctx, blob, withStash(blob, cw.id, pub.stash), etag, cw.id);
    } catch (e) {
      const current = e instanceof ConflictError ? await readFresh(ctx, cw.id) : undefined;
      throw new OpError(e instanceof ConflictError ? 'conflict' : (e.code || 'unavailable'),
        (e instanceof ConflictError ? 'Someone saved these drafts while publishing; nothing was published (the draft store is unchanged). ' : 'Could not save the publish to the draft store; nothing was published. ')
        + (provisioned ? 'The tenant WAS provisioned — keep the codes below; re-run publish (it will not provision again).' : 'Re-read and retry.'), { ...keep, ...(current ? { current } : {}) });
    }

    // 3. app release (D2)
    let rel;
    try {
      rel = await ctx.app.publish(cw.id, { manifest, reason, source_ref: `configurator:${cw.id}@v${pub.version}` });
    } catch (e) {
      throw new OpError(e.code || 'app_error', `The draft store now says v${pub.version} is live, but the hand-off to the app failed (${e.message}). Check release_status; if the app lacks v${pub.version}, run publish with resend_live:true.`, keep);
    }
    if (rel.status !== 201) {
      // roll the draft-store bookkeeping back so draft and app agree again
      let rolledBack = false;
      try {
        const now = await ctx.store.read();
        if (now.etag === (written && written.etag)) { await safeWrite(ctx, now.blob, withStash(now.blob, cw.id, stash), now.etag, cw.id); rolledBack = true; }
      } catch { rolledBack = false; }
      const detail = { status: rel.status, code: rel.data && rel.data.code, findings: rel.data && rel.data.findings, rolled_back_draft: rolledBack, ...keep };
      if (rel.status === 422) throw refused('The app refused the release (manifest_invalid).' + (rolledBack ? ' The draft was restored.' : ' Could not restore the draft automatically — check release_status.'), detail);
      throw new OpError('app_error', `The app answered ${rel.status} to the release: ${ctx.app.detailText(rel.data)}.` + (rolledBack ? ' The draft was restored.' : ''), detail);
    }

    // 4. design-time ledger (cfg_releases), like the browser bridge does after a publish
    const notes = [];
    try {
      await ctx.store.appendRelease({ workspace_slug: cw.slug, version: pub.version, reason, manifest, published_by: `agent:${ctx.agentName}` });
    } catch (e) { notes.push('Design-time release ledger not updated: ' + e.message); }
    const appWs2 = provisioned ? null : appWs;
    const r = rel.data;
    return {
      published: true,
      workspace: wsRef(cw),
      configurator_version: 'v' + pub.version,
      next_draft: 'v' + pub.stash.draftV,
      configurator_says: pub.toast,
      app_release: { version: r.release.version, id: r.release.id, manifest_sha256: r.release.manifest_sha256, published_by: r.release.published_by, created_at: r.release.created_at, source_ref: r.release.source_ref },
      app_findings: r.findings,
      app_modules: (r.modules || []).map(x => ({ key: x.key, label: x.label, kind: x.kind, enabled: x.enabled, position: x.position, supervisor_only: x.supervisor_only, route: x.route })),
      ...(provisioned ? { provisioned } : { workspace_code: appWs2 && appWs2.workspace_code, login_url: appWs2 ? `${ctx.appUrl}/#/login/${encodeURIComponent(appWs2.workspace_code)}` : undefined }),
      changes: plan.changes,
      ...(notes.length ? { notes } : {}),
    };
  },
});

async function resendLive(ctx, cw, stash, args) {
  if (!stash.liveV) throw invalid('This workspace has never been published — nothing to re-send.');
  const sourceRef = `configurator:${cw.id}@v${stash.liveV}`;
  const appWs = await ctx.app.getWorkspace(cw.id);
  if (!appWs) throw new OpError('needs_provisioning', 'The workspace is not provisioned in the app. Run a normal publish with provision:{…} after making a change, or provision it from the admin portal.');
  if ((appWs.releases || []).some(r => r.source_ref === sourceRef)) return { in_sync: true, note: `The app already has ${sourceRef}.`, live_release: appWs.live_release };
  const liveStash = Object.assign({}, stash, { modules: stash.live.modules.map(m => Object.assign({}, m, { status: 'live' })), perms: stash.live.perms });
  const manifest = manifestOf(cw, liveStash);
  const h = (stash.history || []).find(x => x.version === 'v' + stash.liveV);
  const reason = (h && h.reason) || String(args.reason || '').trim() || 're-sent live version';
  if (args.confirm !== true) return { dry_run: true, note: `Would re-send live v${stash.liveV} to the app as ${sourceRef}. Repeat with confirm:true.` };
  const rel = await ctx.app.publish(cw.id, { manifest, reason: reason.slice(0, 500), source_ref: sourceRef });
  if (rel.status !== 201) throw new OpError(rel.status === 422 ? 'refused' : 'app_error', `The app answered ${rel.status}: ${ctx.app.detailText(rel.data)}`, { findings: rel.data && rel.data.findings });
  return { resent: true, configurator_version: 'v' + stash.liveV, app_release: { version: rel.data.release.version, source_ref: sourceRef }, app_findings: rel.data.findings };
}

op({
  name: 'release_status', title: 'Release status', readOnly: true,
  description: 'Where a workspace stands on both sides: the draft store (live/draft versions, unpublished changes, recent history, design-time release ledger) and the Matrix app (provisioned?, workspace code, seats, live release, recent releases, the module registry as the app runs it, whether the business admin has claimed the account) — and whether the configurator\'s live version reached the app.',
  input: obj({ workspace: WS }, ['workspace']),
  async run(ctx, args) {
    const { blob } = await ctx.store.read();
    const { cw, stash } = resolveWorkspace(blob, args.workspace);
    const out = {
      workspace: wsRef(cw),
      draft_store: {
        live: stash.liveV ? 'v' + stash.liveV : null, draft: 'v' + stash.draftV,
        unpublished_changes: V.diffList(stateOf(stash)).length,
        history: (stash.history || []).slice(0, 3),
      },
    };
    try { out.draft_store.ledger = (await ctx.store.listReleases(cw.slug)).map(r => ({ version: r.version, published_by: r.published_by, at: r.createdAt })).slice(-5); } catch { /* optional */ }
    try {
      const a = await ctx.app.getWorkspace(cw.id);
      if (!a) out.app = { provisioned: false, note: 'Not provisioned yet — the first publish provisions it.' };
      else {
        const sourceRef = stash.liveV ? `configurator:${cw.id}@v${stash.liveV}` : null;
        out.app = {
          provisioned: true, status: a.status, company: a.company, workspace_code: a.workspace_code,
          login_url: `${ctx.appUrl}/#/login/${encodeURIComponent(a.workspace_code)}`,
          seats: { used: a.used_seats, limit: a.seat_limit },
          live_release: a.live_release, release_count: a.release_count,
          releases: (a.releases || []).slice(0, 5).map(r => ({ version: r.version, source_ref: r.source_ref, reason: r.reason, created_at: r.created_at, is_live: r.is_live })),
          modules: (a.modules || []).map(m => ({ key: m.key, label: m.label, kind: m.kind, enabled: m.enabled, position: m.position, supervisor_only: m.supervisor_only, route: m.route })),
          business_admin: a.business_admin ? { email: a.business_admin.email, claimed: !!a.business_admin.has_password } : null,
          ...(a.last_error ? { last_error: a.last_error } : {}),
        };
        out.in_sync = sourceRef ? (a.releases || []).some(r => r.source_ref === sourceRef) : null;
        if (out.in_sync === false) out.advice = `The app has no release for ${sourceRef}; run publish with resend_live:true.`;
      }
    } catch (e) { out.app = { skipped: e.message, code: e.code }; }
    return out;
  },
});

// ---------------------------------------------------------------- running cases (G3, docs/G3-API.md §1)
//
// Cases finish on the release their site is pinned to. migrate_running is the audited way to move in-flight
// custom-module cases (and their sites' pins) onto a newer release — the user's operaton-plat op_migrate_running,
// plus G3's dry run, compatibility report, stage mapping, per-site atomicity and audit trail.

const APP_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * The app-side configurator ref for `workspace`: a draft-store workspace (id, slug or exact name) → its id;
 * otherwise a ref the app knows but the draft store does not (provisioned elsewhere, e.g. a smoke workspace —
 * list_workspaces include_app:true shows them as app_only) is used as-is. A draft store that is down does
 * not block this app-only op.
 */
async function appRefOf(ctx, ref) {
  const r = typeof ref === 'string' ? ref.trim() : '';
  if (!r) throw invalid('`workspace` is required: the workspace id (ws_…), slug or exact name.');
  let list = null;
  try { list = (await ctx.store.read()).blob.customWs || []; } catch { list = null; }
  const cw = list && (list.find(w => w.id === r) || list.find(w => w.slug === r) || list.find(w => String(w.name).toLowerCase() === r.toLowerCase()));
  if (cw) return { ref: cw.id, workspace: wsRef(cw) };
  if (APP_REF_RE.test(r)) return { ref: r, workspace: { id: r, in_draft_store: list ? false : 'unknown (draft store unreachable)' } };
  throw notFound(`No workspace "${r}" in the draft store, and it is not a valid app workspace ref.`);
}

function appMigrationError(ctx, r, ref, what) {
  const code = r.data && r.data.code;
  const detail = ctx.app.detailText(r.data) || `HTTP ${r.status}`;
  const d = { status: r.status, ...(code ? { code } : {}) };
  if (r.status === 404 && code === 'unknown_release') return invalid(`${detail} (release_status lists the app's releases).`, d);
  if (r.status === 404) return notFound(`The Matrix app has no ${what} for "${ref}": ${detail} Only provisioned workspaces have running cases (list_workspaces include_app:true).`, d);
  if (r.status === 409) return refused(`The app refused: ${detail}`, d);
  if (r.status === 422) return invalid(`The app refused the request: ${detail}`, d);
  return new OpError('app_error', `The app answered ${r.status}: ${detail}`, d);
}

const quoted = s => (s && s.name ? `${s.order} “${s.name}”` : (s && s.order !== undefined ? String(s.order) : '?'));

/** One line per case, written for an agent to read out to a human. */
function migrationCaseLine(i) {
  const site = i.site ? `${i.site.name || i.site.id}${i.site.code ? ` [${i.site.code}]` : ''}` : (i.record_id || '?');
  const ver = i.in_flight === false || i.outcome === 'not_in_flight' ? `v${i.from_version}` : `v${i.from_version}→v${i.to_version}`;
  const head = `${site} · ${i.module_key} · ${ver} · ${i.case_status || '?'}${i.co_migrated ? ' · co-migrated' : ''}`;
  if (i.outcome === 'not_in_flight') return `${head} · finished — stays on v${i.from_version}`;
  const st = i.stage || {};
  const stage = st.before ? ` · stage ${quoted(st.before)}${st.before.role ? ` (at ${st.before.role})` : ''} → ${st.after ? quoted(st.after) : 'none'}` : '';
  const verdict = {
    would_migrate: 'WOULD MIGRATE', migrated: 'MIGRATED', blocked: 'BLOCKED', skipped: 'SKIPPED', failed: 'FAILED',
  }[i.outcome] || String(i.outcome || '?').toUpperCase();
  const why = (i.blocking || []).map(b => `${b.code}: ${b.message}`).join('; ') || i.message || '';
  const f = i.fields || {};
  const fieldBits = [['dropped', f.dropped], ['kind changed', f.kind_changed], ['newly required', f.new_required]]
    .filter(([, l]) => Array.isArray(l) && l.length).map(([k, l]) => `${l.length} ${k}`);
  const extras = [];
  if (['would_migrate', 'migrated'].includes(i.outcome)) extras.push(`${i.approvals_carried || 0} approval(s) carried`);
  if (fieldBits.length) extras.push('fields: ' + fieldBits.join(', '));
  if ((i.warnings || []).length) extras.push('warnings: ' + i.warnings.map(w => w.code).join(', '));
  return `${head}${stage} · ${verdict}${why ? ` — ${why}` : ''}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
}

function migrationView(data, { dryRun }) {
  const s = data.summary || {};
  const by = s.by_outcome || {};
  const items = data.items || [];
  const n = k => by[k] || 0;
  const counts = {
    cases: s.records || 0, sites: s.sites || 0, compatible: s.compatible || 0, blocked: s.blocked || 0,
    ...(dryRun ? { would_migrate: n('would_migrate') } : { migrated: n('migrated'), skipped: n('skipped'), failed: n('failed') }),
    not_in_flight: n('not_in_flight'),
  };
  const fromTxt = data.from ? (data.from.spec === 'all_older' ? `every older release (${(data.from.versions || []).map(v => 'v' + v).join(', ') || 'none'})` : data.from.spec) : '?';
  const to = data.to ? 'v' + data.to.version : '?';
  const runningItems = items.filter(i => i.outcome !== 'not_in_flight');
  const running = runningItems.length;
  const runningSites = new Set(runningItems.map(i => (i.site && i.site.id) || i.record_id)).size;
  let headline;
  if (!running) headline = `Nothing to migrate: no running custom-module cases on ${fromTxt} in scope (target ${to}).${counts.not_in_flight ? ` ${counts.not_in_flight} finished case(s) stay where they finished.` : ''}`;
  else if (dryRun) headline = `Dry run ${fromTxt} → ${to}: ${counts.would_migrate} running case(s) would migrate, ${counts.blocked} blocked, on ${runningSites} site(s)${counts.not_in_flight ? `; ${counts.not_in_flight} finished case(s) stay` : ''}. Nothing was moved.`;
  else headline = `Migration ${data.migration_id}: ${counts.migrated} case(s) migrated, ${counts.skipped} skipped, ${counts.failed} failed (${fromTxt} → ${to}, ${runningSites} site(s)).`;
  const next = [];
  if (dryRun && counts.would_migrate) next.push('Show this to the human. To move the compatible cases, repeat with confirm:true and a reason (recorded on every moved case). A site with any blocked case is skipped whole; the app re-checks every case under a lock at execution time.');
  if (counts.blocked) next.push('Blocked cases: read the reasons; an explicit stage_map {module_key: {"<from stage order>": <to stage order>|null}}, restart_stage_on_chain_change:true (for chain_changed_mid_stage) or a narrower scope may help — then dry-run again.');
  if (!dryRun) next.push(`Audit: every moved case shows "Moved to another release" in its audit trail. History: migration_status {workspace, migration_id: "${data.migration_id}"}.`);
  return {
    headline, counts,
    from: data.from, to: data.to ? { version: data.to.version } : null,
    cases: items.map(migrationCaseLine),
    ...(next.length ? { next } : {}),
  };
}

op({
  name: 'migrate_running', title: 'Migrate running cases', destructive: true,
  description: 'Move IN-FLIGHT custom-module cases (with their sites\' release pins) from an older release onto a newer one in the Matrix app — the audited hot-fix path (G3). Normally every case finishes on the release its site is pinned to. Default is a DRY RUN that writes nothing and reports, per case: compatible or blocked (+ reasons), stage before → after and how it was mapped, fields kept/dropped/changed/newly required, approvals carried; finished cases stay. To execute, pass confirm:true AND a reason (≥3 chars, recorded on every moved case) — only after the human has seen the dry run. Execution is one locked transaction per site; a site with any incompatible case is skipped whole (never half-migrated). An execute is never re-sent automatically: if the call fails, check migration_status before retrying. workspace = a draft-store workspace or an app-only configurator ref (list_workspaces include_app:true).',
  input: obj({
    workspace: str('Workspace id (ws_…), slug or exact name — or a configurator ref that exists only in the app (list_workspaces include_app:true → app_only).'),
    from_release_version: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['all_older'] }], description: 'Release the cases are on now: a version number, or "all_older" (default) = every release older than the target.' },
    to_release_version: { type: 'integer', minimum: 1, description: 'Release to move them onto. Default: the live release.' },
    scope: obj({
      module_keys: { type: 'array', items: str('Custom module key.'), minItems: 1, maxItems: 50, description: 'Only cases of these custom modules.' },
      site_ids: { type: 'array', items: str('Site uuid.'), minItems: 1, maxItems: 500, description: 'Only cases on these sites.' },
      record_ids: { type: 'array', items: str('Case (record) uuid.'), minItems: 1, maxItems: 500, description: 'Only these cases.' },
    }, [], 'Narrow the migration (all optional, combined with AND). Note: a running case of another module on a moving site moves too (co_migrated).'),
    reason: str('Why — required with confirm:true (3–500 chars); recorded on every moved case and in the audit trail.'),
    stage_map: {
      type: 'object', description: 'Explicit stage mapping per module: {"<module_key>": {"<from stage order>": <to stage order> | null}}. Otherwise stages map by same order+name, then same name, then same order.',
      additionalProperties: { type: 'object', additionalProperties: { type: ['integer', 'null'], minimum: 1 } },
    },
    restart_stage_on_chain_change: bool('If someone already acted in a case\'s current stage and that stage\'s approver chain changed, restart the stage at its first step (values kept) instead of blocking the case. Default false.'),
    confirm: bool('Required (true), together with a reason, to actually move the cases. Without it this is a dry run that moves nothing.'),
  }, ['workspace']),
  async run(ctx, args) {
    const { ref, workspace } = await appRefOf(ctx, args.workspace);
    const execute = args.confirm === true;
    const reason = String(args.reason || '').trim();
    if (reason.length > 500) throw invalid('reason must be ≤ 500 characters.');
    if (execute) {
      assertWritable(ctx, ref);
      if (reason.length < 3) throw invalid('A reason (at least 3 characters) is required to migrate running cases — it is recorded on every moved case. Nothing was sent.');
    }
    const body = {
      ...(args.from_release_version !== undefined ? { from_release_version: args.from_release_version } : {}),
      ...(args.to_release_version !== undefined ? { to_release_version: args.to_release_version } : {}),
      ...(args.scope ? { scope: args.scope } : {}),
      ...(reason ? { reason } : {}),
      dry_run: !execute,
      ...(args.stage_map ? { stage_map: args.stage_map } : {}),
      ...(args.restart_stage_on_chain_change !== undefined ? { restart_stage_on_chain_change: args.restart_stage_on_chain_change } : {}),
    };
    let r;
    try {
      r = await ctx.app.migrate(ref, body);
    } catch (e) {
      if (!execute || !(e instanceof OpError) || !['app_error', 'unavailable'].includes(e.code)) throw e;
      throw new OpError(e.code, `${e.message} The execute was NOT re-sent: the app may have moved some cases — run migration_status {workspace: "${ref}"} (and a fresh dry run) before trying again.`, e.details);
    }
    if (r.status !== 200) throw appMigrationError(ctx, r, ref, 'workspace or release');
    const view = migrationView(r.data, { dryRun: !execute });
    return {
      ...(execute ? { executed: true, migration_id: r.data.migration_id } : { dry_run: true, note: 'Dry run — nothing was moved. Show this to the human; repeat with confirm:true and a reason to execute.' }),
      workspace,
      ...view,
      raw: r.data,
    };
  },
});

op({
  name: 'migration_status', title: 'Migration history', readOnly: true,
  description: 'Executed "migrate running cases" runs of a workspace in the Matrix app (newest first; dry runs are never stored): id, status (running | done | failed), from → to, reason, who, counts. With migration_id: that run with its journal — one item per moved site pin and case (module, from version, stage before → after). Use it after migrate_running, or when an execute call failed, to see what actually happened.',
  input: obj({
    workspace: str('Workspace id (ws_…), slug or exact name — or an app-only configurator ref.'),
    migration_id: str('A migration id (uuid) from migrate_running or this list.', { pattern: '^[0-9a-fA-F-]{36}$' }),
    include_pre_state: bool('Include each journal item\'s FULL pre-migration case state (large). Default false.'),
  }, ['workspace']),
  async run(ctx, args) {
    const { ref, workspace } = await appRefOf(ctx, args.workspace);
    const countsTxt = s => s && s.by_outcome ? Object.entries(s.by_outcome).map(([k, v]) => `${k} ${v}`).join(', ') : 'no summary yet';
    if (!args.migration_id) {
      const r = await ctx.app.listMigrations(ref);
      if (r.status !== 200) throw appMigrationError(ctx, r, ref, 'workspace');
      const items = (r.data && r.data.items) || [];
      return {
        workspace, count: items.length,
        migrations: items.map(m => `${m.id} · ${m.status} · ${m.from} → v${m.to_version} · ${m.created_at} · by ${m.actor} · “${m.reason}” · ${countsTxt(m.summary)}`),
        ...(items.length ? {} : { note: 'No migration has been executed for this workspace (dry runs are never stored).' }),
        raw: r.data,
      };
    }
    const r = await ctx.app.getMigration(ref, args.migration_id);
    if (r.status !== 200) throw appMigrationError(ctx, r, ref, `migration ${args.migration_id}`);
    const d = r.data;
    const stageTxt = s => (s && typeof s === 'object' ? quoted(s) : (s === null || s === undefined ? '—' : String(s)));
    const journal = (d.items || []).map(i => i.record_id
      ? `case ${i.record_id} · ${i.module_key} · v${i.from_version} → v${d.to_version} · stage ${stageTxt(i.before_stage)} → ${stageTxt(i.after_stage)}`
      : `site ${i.site_id} · pin v${i.from_version} → v${d.to_version}`);
    const raw = args.include_pre_state ? d : { ...d, items: (d.items || []).map(({ before_state, ...rest }) => rest) };
    return {
      workspace, id: d.id, status: d.status, from: d.from, to_version: d.to_version, reason: d.reason, actor: d.actor,
      created_at: d.created_at, finished_at: d.finished_at, summary: d.summary, journal, raw,
    };
  },
});

export const OPS_BY_NAME = Object.fromEntries(OPS.map(o => [o.name, o]));

export function listOps() {
  return OPS.map(o => ({ name: o.name, title: o.title, description: o.description, inputSchema: o.input, readOnly: !!o.readOnly, destructive: !!o.destructive }));
}

/** Run one op: validates the arguments against the op's schema, then runs it. Throws OpError. */
export async function runOp(ctx, name, args) {
  const o = OPS_BY_NAME[name];
  if (!o) throw new OpError('invalid_input', `Unknown op "${name}".`, { ops: OPS.map(x => x.name) });
  const a = checkInput(o, args);
  return o.run(ctx, a);
}

export const SERVER_INSTRUCTIONS = `Designs Matrix workspaces — multi-tenant site-rollout apps (a site moves through modules: BD → Legal & Finance → Design → Project → NSO → Launch …) — in the SAME draft store as the visual Workspace Configurator (http://localhost:4300 and the app's /#/admin → Workspaces). A human sees your drafts there and you see theirs. Nothing reaches app users until publish.

Model
- workspace: one tenant's configuration; draft vN (editable) vs live vN (published). create_workspace: empty, or the Blue Tokai template (9 built-ins).
- module: work every site passes through. built-in (bd, legal, finance_ca, design, project, nso, pex, launch_approval, financial_closure) = platform code: switch on/off, rename, re-gate, tier flags. custom = generic runtime at /m/<key>: you define stages, fields, approvers, roll-up.
- entry gate: when a site enters a module's queue — conditions "<source module> is <outcome>" joined by all (parallel join) or any. No gate = opens at once. No cycles.
- stage (custom): ordered steps; approvers form a tier chain executive < supervisor < business_admin (lowest submits the form, higher ones approve / send back / reject); the stage then reaches its outcome.
- field: choice | yesno | text | number | date | file | person; required; validation hint (catalogue lists app-readable formats); affects_outcome feeds the roll-up (choice / yes-no only).
- roll-up: all_positive | any_negative | count_at_least{n,of} | sum_under{field,limit} | custom (parks: pending engineering). exit_signal = outcome downstream gates see.
- tiers: supervisor always; executive tier on/off (supervisor_only); business-admin sign-off; delegation (executives act only on assigned sites).

Loop: catalogue → list_workspaces → create_workspace → add_builtin_module / add_custom_module / disable_module / set_gate / add_stage / add_field / set_tiers / set_approvers / set_outcome → validate (local + app dry run) → diff → publish (dry run first; then confirm:true with the human's go-ahead; provision.admin_email on the first publish) → release_status. Running cases stay on the release their site is pinned to; to move them onto a newer release: migrate_running (dry run first, show the human; confirm:true + reason to execute) → migration_status.

Rules: every write is validated and saved immediately; a step that would break the flow (gate cycle, gate on a module that is off, unreachable outcome, stage without approver, key collision) is refused unless allow_new_findings:true. remove_*, delete_workspace, publish and migrate_running are dry runs unless confirm:true. "conflict" = a human saved meanwhile: re-read (show_workspace) and redo the step. When the brief is ambiguous (who approves? what waits for what? who is the business admin?) ask the human instead of guessing. The human decides to publish. The one-time setup code returned by the first publish is a secret: hand it to the human once, never repeat or store it.`;

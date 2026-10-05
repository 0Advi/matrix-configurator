#!/usr/bin/env node
// Regenerates building-blocks/from-design/{seed-workspaces,vocabularies,tokens}.json
// and tokens.css by EVALUATING the original v5 artifact (and v1–v4 for lineage)
// through lib/load-dc.mjs. Deterministic: run it twice, get identical output.
//
//   node scripts/extract-design.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadComponent, readArtifact, plain } from '../lib/load-dc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../from-design');
const write = (name, data) => {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
  return file;
};

const v5 = readArtifact(5);
const PROVENANCE = {
  artifact: 'sources/design-artifact/Workspace Configurator v5.dc.html',
  sha256: v5.sha256,
  method: 'evaluated: class Component from <script data-dc-script> run in node:vm with a DCLogic/React/localStorage shim (lib/load-dc.mjs)',
  generatedBy: 'building-blocks/scripts/extract-design.mjs',
};

// ---------------------------------------------------------------- seeds
const { Component } = loadComponent(5);
const WORKSPACES = ['bluetokai', 'starbucks', 'burgerking'];

const replayData = (c, id) => (id === 'bluetokai' ? [] : c.replaySteps(id).map((s, i) => ({
  step: i + 1, title: s.title, detail: s.detail, focus: s.focus || null,
  plannedCapability: s.cap || null, keyStep: !!s.key, refused: !!s.refused, publish: !!s.publish,
})));

const workspaces = {};
for (const id of WORKSPACES) {
  const c = new Component({ startWorkspace: id });
  const meta = plain(c.wsList().find(w => w.id === id));
  workspaces[id] = {
    meta: Object.assign(meta, { tenant: plain(c.tenantMeta(id)) }),
    counts: plain(c.counts(id)),
    activePlannedCapabilities: c.activeCaps(id),
    document: plain(c.stashOf(c.state)), // exactly what v5 persists per workspace
    signals: plain(c.state.signals),
    spine: plain(c.state.spine),
    spineEdges: plain(c.state.spineEdges),
    manifest: plain(c.manifest()),
    findings: plain(c.findings()),
    diffAgainstLive: plain(c.diffList()),
    flowOrder: c.flowOrder(c.state.modules).map(m => m.key),
    replaySteps: replayData(c, id),
  };
}

// The exact localStorage blob (`wsconfig_v5_custom`) after creating two custom
// workspaces through the real createWorkspace() code path.
const store = (() => {
  const loaded = loadComponent(5);
  const c = new loaded.Component({ startWorkspace: 'bluetokai' });
  c.setState({ newWs: { name: 'Acme Retail', slug: 'acme-retail', slugTouched: true, start: 'template', tried: false } });
  let prev = c.state; c.createWorkspace(); c.componentDidUpdate(c.props, prev);
  c.setState({ newWs: { name: 'Zero Co', slug: 'zero-co', slugTouched: true, start: 'empty', tried: false } });
  prev = c.state; c.createWorkspace(); c.componentDidUpdate(c.props, prev);
  // add one built-in module to the empty workspace via the real addBuiltin()
  prev = c.state; c.addBuiltin('bd'); c.componentDidUpdate(c.props, prev);
  return JSON.parse(loaded.localStorage.getItem('wsconfig_v5_custom'));
})();

// Fall-through quirk: unknown tenant ids replay the Burger King steps.
const quirk = (() => {
  const c = new Component({ startWorkspace: 'thirdwave' });
  return {
    seedThirdwaveModuleKeys: c.state.modules.map(m => m.key + (m.enabled ? '' : ':off')),
    wsResolvesTo: c.ws().id,
  };
})();

// Legacy tenants that only exist as picker entries in v2/v3 (seed() took no tenant there).
const legacy = {};
for (const v of [2, 3]) {
  const L = loadComponent(v);
  const c = new L.Component({ startWorkspace: 'bluetokai' });
  for (const w of c.wsList()) {
    if (w.id === 'bluetokai') continue;
    legacy[w.id] = legacy[w.id] || { note: 'Picker entry only — v' + v + ' seed() ignores the tenant, so this workspace shows the same Blue Tokai seed. No tenant-specific data exists.' };
    legacy[w.id]['v' + v] = plain(w);
  }
}

// Wizard templates → draft module manifests (wizManifest output)
const wizardTemplates = {};
for (const tpl of ['blank', 'vendor', 'retail', 'franchise']) {
  const c = new Component({ startWorkspace: 'bluetokai' });
  c.openWizard(tpl === 'blank' ? undefined : tpl);
  wizardTemplates[tpl] = { wizardState: plain(c.state.wizard), manifest: plain(c.wizManifest(c.state.wizard)) };
}

write('seed-workspaces.json', {
  $comment: 'Seed workspaces of the shipped design (v5). Generated — do not hand-edit; rerun scripts/extract-design.mjs.',
  provenance: PROVENANCE,
  notes: [
    'v5 seeds THREE workspaces: bluetokai (built-in template, live v7 / draft v8), starbucks and burgerking (draft v1, derived from Blue Tokai by replaying the steps listed under replaySteps).',
    'thirdwave and chaayos are NOT v5 workspaces: they appear only as picker entries in v2/v3 (see legacyWorkspaces). They carry no tenant-specific data.',
    'Quirk: in v5 seed(<unknown id>) falls through to the Burger King replay, and ws() falls back to bluetokai — see quirks.',
    'document = stashOf(state): the exact per-workspace object v5 persists (modules, perms, live, liveV, draftV, history).',
    'Element ids (f_N, s_N, ns_N, ni_N) come from a per-class counter and are only stable within one generation run.',
  ],
  workspaces,
  storageBlobExample: {
    $comment: 'Real localStorage["wsconfig_v5_custom"] produced by createWorkspace() twice (template + empty) and addBuiltin("bd").',
    key: 'wsconfig_v5_custom',
    value: store,
  },
  legacyWorkspaces: legacy,
  quirks: { unknownTenantFallthrough: quirk },
  wizardTemplates,
});

// ---------------------------------------------------------------- vocabularies
const c = new Component({ startWorkspace: 'bluetokai' });
const ROLES = ['supervisor', 'executive', 'business_admin', 'observer'];
const bt = c.seedBT();
const mDefaults = (() => { // defaults of the built-in module factory M(o) — read off a module that overrides little
  const m = bt.modules.find(x => x.key === 'launch_approval');
  return { kind: m.kind, enabled: m.enabled, color: m.color, tiers: m.tiers, supervisorOnly: m.supervisorOnly, delegation: m.delegation, rollup: m.rollup, exit: m.exit, pendingEng: m.pendingEng, status: m.status, recon: m.recon, edits: m.edits, caps: m.caps };
})();
const customDefaults = (() => {
  const m = c._cm({ key: 'x', name: 'X', band: 'site', y: 0, stages: [] });
  const out = plain(m); delete out.key; delete out.name; delete out.y; delete out.x; delete out.band; delete out.nav; delete out.stages;
  return out;
})();

write('vocabularies.json', {
  $comment: 'Constants and vocabularies of the shipped design (v5). Generated by scripts/extract-design.mjs.',
  provenance: PROVENANCE,
  stageOutcomes: c.OUTCOMES(),
  moduleIcons: c.ICONS(),
  fieldKinds: c.KINDS().map(([id, label]) => ({ id, label })),
  fieldValidationHints: { choice: 'options, comma separated', number: 'min 0 · max 120', text: 'regex pattern', date: 'range', file: 'pdf · max 10MB', person: 'tier filter', yesno: '—' },
  reservedModuleKeys: c.RESERVED(),
  moduleKeyPattern: '^[a-z][a-z0-9_]{1,38}$',
  reservedWorkspaceSlugs: ['admin', 'api', 'www', 'app', 'platform'],
  workspaceSlugPattern: '^[a-z][a-z0-9-]{1,30}$',
  workspaceStartModes: [
    { id: 'empty', title: 'Start from zero', sub: 'No modules. You create every module yourself — built-in or custom.' },
    { id: 'template', title: 'Copy the Blue Tokai template', sub: 'All 9 built-in modules as a draft, ready to rename, re-gate or switch off.' },
  ],
  bands: c.BANDS(),
  bandWidth: c.BANDW(),
  plannedCapabilities: c.CAPS(),
  wizardSteps: c.WSTEPS().map((label, i) => ({ step: i + 1, label })),
  rollupStrategies: c.STRATS(),
  navBadgeSources: c.BADGE_SRC().map(([id, label]) => ({ id, label })),
  navBadgeSampleCounts: c.BADGE_N(),
  roles: ROLES.map(r => ({ id: r, label: c.roleLabel(r), color: c.roleColor(r) })),
  stageApproverRoles: ['supervisor', 'executive', 'business_admin'],
  navRoles: ['supervisor', 'executive'],
  tiers: [
    { k: 'supervisor', label: 'Supervisor', sub: 'Always present — owns the queue', locked: true },
    { k: 'executive', label: 'Executive', sub: 'Does the work, submits for review' },
    { k: 'admin', label: 'Business admin sign-off', sub: 'Workspace-wide role can sign off a stage' },
  ],
  moduleKinds: ['builtin', 'custom'],
  moduleStates: ['live', 'draft', 'pending_engineering'],
  moduleStateBadges: { pending_engineering: 'PENDING ENG', off: 'OFF', draft: 'DRAFT' },
  gateMatch: ['all', 'any'],
  routeRules: { custom: '/m/<module_key>', builtin: '/<module_key with _ replaced by ->' },
  customModuleScreens: ['overview', 'queue', 'history', 'checklist_review'],
  customModulePages: [['overview', 'Overview'], ['queue', 'Queue'], ['history', 'History'], ['review', 'Checklist review']],
  findingTags: ['key collision', 'pending eng', 'gate cycle', 'dead gate', 'unreachable', 'no approver', 'dead link', 'field kind'],
  diffTags: ['created', 'renamed', 'enabled', 'disabled', 'gate', 'stages', 'roll-up', 'fields', 'approvers', 'navigation', 'label', 'removed', 'permissions'],
  diffImpactLevels: ['low', 'medium', 'high'],
  stageRemovalDecisions: ['finish', 'move', 'move_confirmed'],
  permissions: bt.perms.map(p => ({ action: p.action, platformCeiling: p.ceiling, grantedByDefault: p.roles })),
  permissionUsedBy: { shortlist: ['bd'], approve_details: ['bd'], upload_loi: ['bd'], create_draft: ['bd'], save_draft_details: ['bd'], submit_details_for_review: ['bd'], set_loi_timeline: ['bd'], reject: ['bd', 'legal'], archive: ['bd'], push_to_payments: ['bd'], reassign_site: ['bd', 'project'], legal_finalize_dd: ['legal'], legal_raise_change_request: ['legal'], design_approve_gfc: ['design'], project_approve_budget: ['project'], nso_mark_launched: ['nso'] },
  builtinModuleDefaults: mDefaults,
  customModuleDefaults: customDefaults,
  builtinModuleCatalog: bt.modules.map(m => ({ key: m.key, name: m.name, icon: m.icon, band: m.band, supervisorOnly: m.supervisorOnly, changeRequestLoop: !!m.changeRequestLoop, gate: m.gate, stages: m.stages.map(s => s.name), pages: m.pages })),
  wizardTemplates: ['blank', 'vendor', 'retail', 'franchise'],
  tenants: Object.fromEntries(WORKSPACES.map(id => [id, c.tenantMeta(id)])),
});

// ---------------------------------------------------------------- tokens
function parseRoot(css, selector = ':root') {
  const re = new RegExp(selector.replace(/[[\]"=]/g, m => '\\' + m) + '\\s*\\{([^}]*)\\}');
  const m = css.match(re); if (!m) return {};
  const out = {};
  for (const decl of m[1].split(';')) {
    const i = decl.indexOf(':'); if (i < 0) continue;
    const k = decl.slice(0, i).trim(); const v = decl.slice(i + 1).trim();
    if (k.startsWith('--')) out[k] = v;
  }
  return out;
}
const roots = {};
for (const v of [1, 2, 3, 4, 5]) {
  const a = readArtifact(v);
  roots['v' + v] = { ':root': parseRoot(a.style) };
  const dark = parseRoot(a.style, ':root[data-theme="dark"]');
  if (Object.keys(dark).length) roots['v' + v][':root[data-theme="dark"]'] = dark;
}
const v5root = roots.v5[':root'];
const fonts = { sans: "'IBM Plex Sans', system-ui, sans-serif", mono: "'IBM Plex Mono', monospace", googleFontsHref: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap' };
c.state.previewTheme = 'dark'; const previewDark = c.theme();
c.state.previewTheme = 'light'; const previewLight = c.theme();
const tokens = {
  $comment: 'Design tokens of the configurator (v5). cssCustomProperties is parsed from <helmet><style>:root; the rest is evaluated (roleColor, theme) or transcribed from v5 methods (line refs given).',
  provenance: PROVENANCE,
  cssCustomProperties: v5root,
  fonts,
  roleColors: Object.fromEntries(ROLES.map(r => [r, c.roleColor(r)])),
  moduleColors: { builtin: '#8A96A8', custom: '#35C2C8', reconfigured: '#F08A3C', off: '#6E7382', plannedCapability: '#E05FA8', pendingEngineering: '#A78BFA', draft: '#E8B65A' },
  impactLevelColors: { high: '#FF6B6B', medium: '#E8B65A', low: '#6E9BFF' },
  tagColors: { created: '#4FC3A1', removed: '#FF6B6B', disabled: '#FF6B6B', enabled: '#4FC3A1', gate: '#6E9BFF', navigation: '#6E9BFF', permissions: '#C58CF5', stages: '#C58CF5', renamed: '#8A96A8', label: '#8A96A8', 'pending eng': '#A78BFA', 'gate cycle': '#FF6B6B', 'dead gate': '#FF6B6B', 'dead link': '#E8B65A', 'no approver': '#FF6B6B', unreachable: '#FF6B6B', 'field kind': '#E8B65A', 'key collision': '#FF6B6B', $default: '#8A909E' },
  previewTheme: { dark: previewDark, light: previewLight },
  canvas: { moduleNode: { w: c.MW, h: c.MH }, spineNode: { w: c.SW, h: c.SH }, signalNode: { w: c.GW, h: c.GH }, zoom: { min: 0.3, max: 1.5, fitMin: 0.45, fitMax: 1 }, bandWidth: c.BANDW() },
  transcribedFrom: {
    moduleColors: 'v5 compareVals() COL map, _cm() color, wizSave() color, CAPS badge #E05FA8, stateBadge colors in railVals()',
    impactLevelColors: 'v5 publishVals() lvl map',
    tagColors: 'v5 publishVals() tagColor map',
  },
  lineage: roots,
};
write('tokens.json', tokens);

const cssLines = [
  '/* Matrix Workspace Configurator — design tokens (from Workspace Configurator v5.dc.html).',
  ` * sha256 ${v5.sha256}`,
  ' * Generated by building-blocks/scripts/extract-design.mjs — do not hand-edit. */',
  ':root {',
  ...Object.entries(v5root).map(([k, v]) => `  ${k}: ${v};`),
  '  /* role + state colours (evaluated / transcribed from v5 methods) */',
  ...Object.entries(tokens.roleColors).map(([k, v]) => `  --role-${k.replace(/_/g, '-')}: ${v};`),
  ...Object.entries(tokens.moduleColors).map(([k, v]) => `  --module-${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}: ${v};`),
  ...Object.entries(tokens.impactLevelColors).map(([k, v]) => `  --impact-${k}: ${v};`),
  `  --font-sans: ${fonts.sans};`,
  `  --font-mono: ${fonts.mono};`,
  '}',
  '/* Preview-pane themes (theme() in v5): the tenant app as the selected role sees it */',
  '[data-preview-theme="dark"] {',
  ...Object.entries(previewDark).map(([k, v]) => `  --preview-${k}: ${v};`),
  '}',
  '[data-preview-theme="light"] {',
  ...Object.entries(previewLight).map(([k, v]) => `  --preview-${k}: ${v};`),
  '}',
  '',
];
write('tokens.css', cssLines.join('\n'));

console.log('wrote seed-workspaces.json, vocabularies.json, tokens.json, tokens.css to', OUT);

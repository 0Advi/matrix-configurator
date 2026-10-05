// Adapters from matrix-bd-flow.json (v5-manifest-shaped modules + "x-matrix"
// annotations) to the two shapes the v5 configurator understands:
//
//   toV5Manifest(flow)          → validates against ../from-design/manifest.schema.json
//   toV5WorkspaceDocument(flow) → validates against ../from-design/workspace.schema.json
//                                 (the per-workspace `state` the web runtime / cfg_workspaces store)
//
// so the REAL Blue Tokai flow can be loaded into the configurator as a workspace.
// Pure functions, no dependencies.

/** Deep-copy `x`, dropping every key that starts with "x-" (the annotation namespace). */
export function stripAnnotations(x) {
  if (Array.isArray(x)) return x.map(stripAnnotations);
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) if (!k.startsWith('x-')) out[k] = stripAnnotations(v);
    return out;
  }
  return x;
}

export function toV5Manifest(flow) {
  return {
    workspace: { id: flow.workspace.id, name: flow.workspace.name, slug: flow.workspace.slug, live_version: 'v1', draft_version: 'v2' },
    pipeline: { editable: false, stages: [], note: 'BD backbone is platform-owned' },
    signals: [],
    modules: flow.modules.map(stripAnnotations),
    permissions: flow.permissions.map(p => ({ action: p.action, platform_ceiling: p.platform_ceiling, granted: p.granted })),
  };
}

const BAND_X = { site: 40, legalfin: 380, design: 720, build: 1060, audit: 1400, launch: 1740 }; // v5 BANDS()

/** Internal v5 module (editor shape) from a manifest-shaped module. */
export function toV5Module(m, i = 0) {
  const x = m['x-matrix'] || {};
  let n = 0; const id = p => `${p}_${m.key}_${++n}`;
  return {
    key: m.key, name: m.name, kind: m.type, enabled: m.enabled, color: m.type === 'custom' ? '#35C2C8' : '#8A96A8',
    tiers: { executive: !!m.tiers.executive, supervisor: true, admin: !!m.tiers.business_admin_signoff },
    supervisorOnly: !m.tiers.executive, delegation: !!m.tiers.delegation,
    rollup: Object.assign({}, m.rollup), exit: m.exit_signal,
    gate: m.entry_gate ? { match: m.entry_gate.match, conds: m.entry_gate.conditions.map(c => ({ src: c.source, out: c.outcome })), refusal: m.entry_gate.refusal_message } : null,
    pendingEng: m.state === 'pending_engineering', status: m.state === 'draft' ? 'draft' : 'live',
    icon: x.icon || '◆', versions: [],
    stages: m.stages.map(s => ({ id: id('s'), name: s.name, approvers: s.approvers.slice(), outcome: s.outcome, sites: 0,
      fields: s.fields.map(f => ({ id: id('f'), label: f.label, key: f.key, kind: f.kind, required: f.required, validation: f.validation || '', affects: !!f.affects_outcome })) })),
    nav: m.navigation.map(sec => ({ id: id('ns'), title: sec.section, items: sec.items.map(it => ({ id: id('ni'), icon: it.icon, label: it.label, page: it.page, roles: it.roles.slice(), badge: it.badge || '' })) })),
    pages: (() => { const seen = new Map(); m.navigation.forEach(sec => sec.items.forEach(it => { if (!seen.has(it.page)) seen.set(it.page, it.label); })); return [...seen.entries()]; })(),
    recon: false, edits: [], caps: x.caps || [], band: x.band || 'site',
    x: (BAND_X[x.band] ?? 40) + 38, y: x.y ?? 200 + 120 * (i % 4), sitesTotal: 0,
    ...(x.changeRequestLoop ? { changeRequestLoop: true } : {}),
  };
}

export function toV5WorkspaceDocument(flow) {
  const modules = flow.modules.map(toV5Module);
  const perms = flow.permissions.map(p => ({ action: p.action, ceiling: p.platform_ceiling.slice(), roles: p.granted.slice() }));
  return {
    modules,
    perms,
    live: JSON.parse(JSON.stringify({ modules, perms })),
    liveV: 1,
    draftV: 2,
    history: [{ version: 'v1', meta: `${flow.provenance.commitDate} · extracted from ${flow.provenance.repo}@${flow.provenance.sha.slice(0, 12)}`, reason: 'Imported: the production Matrix-bd (Blue Tokai) flow as configurator data', lines: [`${modules.length} built-in modules`, `${modules.reduce((a, m) => a + m.stages.length, 0)} stages`] }],
  };
}

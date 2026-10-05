// Projection of the v5 configurator state into NocoBase rows.
//
// Two kinds of mapping live here, both pure (no I/O):
//
// 1. blob <-> cfg_workspaces rows
//    The blob is exactly what v5 stores in localStorage['wsconfig_v5_custom']:
//      { customWs: [ {id, name, slug, start, created} ], data: { [id]: stash } }
//    where stash = { modules, perms, live: {modules, perms}, liveV, draftV, history }.
//    Each custom workspace becomes one cfg_workspaces row whose `state` is
//      { format, workspace: <customWs entry>, order: <index in customWs>, data: <stash|null> }
//    which is enough to rebuild the blob losslessly (rowsToBlob ∘ blobToWorkspaceRows = id).
//
// 2. stash -> read models (cfg_modules / cfg_gates / cfg_stages)
//    Built from the DRAFT modules (`stash.modules`, what the canvas shows). Each module's
//    status says whether it is live, draft, pending engineering or switched off.

export const STATE_FORMAT = 'wsconfig_v5_custom/1';

/** v5 manifest() route rule: custom modules live under /m/<key>, built-ins at /<key-with-dashes>. */
export function moduleRoute(m) {
  return m.kind === 'custom' ? '/m/' + m.key : '/' + String(m.key).replace(/_/g, '-');
}

/** 'disabled' | 'pending_engineering' | 'live' | 'draft' (v5 manifest state, plus the on/off switch). */
export function moduleStatus(m) {
  if (m.enabled === false) return 'disabled';
  if (m.pendingEng) return 'pending_engineering';
  return m.status || 'draft';
}

/** v5 picker rule for custom workspaces: first two characters, upper-cased. */
export function initialsOf(name) {
  return String(name || '').slice(0, 2).toUpperCase();
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * One workspace's stash → rows for cfg_modules, cfg_gates and cfg_stages.
 * @param {string} slug   workspace slug (cfg_workspaces.slug)
 * @param {object} stash  { modules, live?, ... } as stored by v5
 */
export function projectWorkspace(slug, stash) {
  const modules = (stash && Array.isArray(stash.modules)) ? stash.modules : [];
  const liveKeys = new Set(((stash && stash.live && stash.live.modules) || []).map(m => m.key));
  const out = { modules: [], gates: [], stages: [] };

  for (const m of modules) {
    if (!m || !m.key) continue;
    const { stages, ...rest } = m;
    const stageList = Array.isArray(stages) ? stages : [];
    out.modules.push({
      workspace_slug: slug,
      module_key: m.key,
      name: m.name || m.key,
      glyph: m.icon || '',
      kind: m.kind || 'builtin',
      status: moduleStatus(m),
      route: moduleRoute(m),
      data: Object.assign(clone(rest), { stage_count: stageList.length, in_live: liveKeys.has(m.key) })
    });

    const gate = m.gate;
    const conds = gate && Array.isArray(gate.conds) ? gate.conds : [];
    conds.forEach((c, i) => {
      out.gates.push({
        workspace_slug: slug,
        from_key: c.src,
        to_key: m.key,
        condition: {
          outcome: c.out,
          match: gate.match || 'all',
          position: i + 1,
          of: conds.length,
          refusal: gate.refusal || '',
          touched: !!gate.touched
        }
      });
    });

    stageList.forEach((st, i) => {
      out.stages.push({
        workspace_slug: slug,
        module_key: m.key,
        position: i + 1,
        name: st.name,
        outcome: st.outcome,
        terminal: i === stageList.length - 1,
        data: { id: st.id, approvers: clone(st.approvers) || [], fields: clone(st.fields) || [], sites: st.sites || 0 }
      });
    });
  }
  return out;
}

/** True when the value looks like a v5 blob. Throws a descriptive Error otherwise. */
export function validateBlob(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) throw new Error('state must be a JSON object');
  if (Object.keys(blob).length === 0) return true; // "no state"
  if (!Array.isArray(blob.customWs)) throw new Error('state.customWs must be an array');
  if (blob.data != null && (typeof blob.data !== 'object' || Array.isArray(blob.data))) throw new Error('state.data must be an object');
  const seen = new Set();
  for (const cw of blob.customWs) {
    if (!cw || typeof cw !== 'object') throw new Error('state.customWs[] entries must be objects');
    if (typeof cw.id !== 'string' || !cw.id) throw new Error('state.customWs[].id must be a non-empty string');
    if (typeof cw.slug !== 'string' || !cw.slug) throw new Error('state.customWs[].slug must be a non-empty string');
    if (seen.has(cw.slug)) throw new Error('duplicate workspace slug: ' + cw.slug);
    seen.add(cw.slug);
  }
  return true;
}

/** blob → cfg_workspaces rows (custom workspaces only — v5 persists nothing else). */
export function blobToWorkspaceRows(blob) {
  if (!blob || !Array.isArray(blob.customWs)) return [];
  const data = blob.data || {};
  return blob.customWs.map((cw, i) => {
    const stash = Object.prototype.hasOwnProperty.call(data, cw.id) ? data[cw.id] : null;
    return {
      slug: cw.slug,
      name: cw.name || cw.slug,
      initials: initialsOf(cw.name || cw.slug),
      is_custom: true,
      live_version: stash ? (Number(stash.liveV) || 0) : 0,
      draft_version: stash ? (Number(stash.draftV) || 1) : 1,
      state: { format: STATE_FORMAT, workspace: cw, order: i, data: stash }
    };
  });
}

/** cfg_workspaces rows → blob. Non-custom rows are ignored. Returns {} when there are none. */
export function rowsToBlob(rows) {
  const custom = (rows || []).filter(r => r && r.is_custom && r.state && r.state.workspace);
  if (!custom.length) return {};
  custom.sort((a, b) => {
    const oa = Number.isFinite(a.state.order) ? a.state.order : Infinity;
    const ob = Number.isFinite(b.state.order) ? b.state.order : Infinity;
    if (oa !== ob) return oa - ob;
    return String(a.createdAt || a.id || '').localeCompare(String(b.createdAt || b.id || ''));
  });
  const blob = { customWs: [], data: {} };
  for (const r of custom) {
    const cw = r.state.workspace;
    blob.customWs.push(cw);
    if (r.state.data != null) blob.data[cw.id] = r.state.data;
  }
  return blob;
}

/** Normalize a blob the way the server stores it (drops orphaned `data` entries etc.). */
export function normalizeBlob(blob) {
  return rowsToBlob(blobToWorkspaceRows(blob));
}

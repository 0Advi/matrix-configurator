// Pure, DOM-free logic shared by the browser storage bridge (storage-bridge.js) and the
// Node test-suite. Nothing in here touches window, document, fetch or localStorage.
//
// The v5 configurator persists ONLY custom (user-created) workspaces, under
// localStorage['wsconfig_v5_custom'], with this shape (written by v5's componentDidUpdate):
//
//   {
//     customWs: [ { id: 'ws_third_wave', name, slug: 'third-wave', start: 'template'|'empty', created } ],
//     data: {
//       [id]: { modules: [...], perms: [...], live: { modules, perms },
//               liveV: <int>, draftV: <int>, history: [ { version: 'v1', meta, reason, lines } ] }
//     }
//   }
//
// A publish (v5 publishVals().onConfirmPublish) sets liveV = draftV, draftV += 1, copies the
// draft into `live`, and prepends a history entry carrying the reason the user typed.

export const STORAGE_KEY = 'wsconfig_v5_custom';
export const META_KEY = 'wsconfig_v5_custom__sync';
export const BACKUP_KEY = 'wsconfig_v5_custom__conflict_backup';
export const DEFAULT_PUBLISHER = 'platform:ops@matrix.io';

/** Parse a raw localStorage value / server payload into a normalized blob, or null. */
export function parseBlob(raw) {
  if (raw == null || raw === '') return null;
  let v = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v;
}

/** True when the blob holds at least one custom workspace (v5 never writes an empty one). */
export function hasState(blob) {
  return !!(blob && Array.isArray(blob.customWs) && blob.customWs.length > 0);
}

/** Deterministic JSON (sorted keys) so equality / etags don't depend on key order. */
export function canonicalJSON(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

export function sameBlob(a, b) {
  return canonicalJSON(a || {}) === canonicalJSON(b || {});
}

/**
 * Decide what to do at boot, before the configurator mounts.
 * @param {object} p
 * @param {'nocobase'|'local'} p.mode         server mode from /cfg/health ('local' if unreachable)
 * @param {object|null} p.serverBlob           GET /cfg/state body ({} when the server has none)
 * @param {string|null} p.serverEtag           ETag of that body
 * @param {string|null} p.localRaw             localStorage[STORAGE_KEY]
 * @param {object|null} p.meta                 parsed localStorage[META_KEY] ({dirty, base})
 * @returns {{action: 'local'|'none'|'pull'|'push'|'conflict', reason: string}}
 */
export function decideHydration({ mode, serverBlob, serverEtag, localRaw, meta }) {
  if (mode !== 'nocobase') return { action: 'local', reason: 'server is in local mode or unreachable' };
  const local = parseBlob(localRaw);
  const serverHas = hasState(serverBlob);
  const localHas = hasState(local);
  if (!serverHas && !localHas) return { action: 'none', reason: 'no state anywhere yet' };
  if (!serverHas && localHas) return { action: 'push', reason: 'first run: migrating browser state to the server' };
  if (serverHas && !localHas) return { action: 'pull', reason: 'loading server state into this browser' };
  if (sameBlob(local, serverBlob)) return { action: 'pull', reason: 'browser already matches server' };
  if (meta && meta.dirty && meta.base && meta.base === serverEtag) {
    return { action: 'push', reason: 'unsynced browser edits on top of the current server state' };
  }
  if (meta && !meta.dirty) return { action: 'pull', reason: 'server has newer state' };
  return { action: 'conflict', reason: 'browser and server both changed; server wins, browser copy backed up' };
}

function versionNumber(v) {
  if (typeof v === 'number') return v;
  const m = /^v?(\d+)$/.exec(String(v || '').trim());
  return m ? Number(m[1]) : NaN;
}

/** "11 Sep 2026 · platform:ops@matrix.io" → "platform:ops@matrix.io" */
export function publisherFromMeta(meta) {
  const parts = String(meta || '').split('·');
  const who = parts.length > 1 ? parts[parts.length - 1].trim() : '';
  return who || DEFAULT_PUBLISHER;
}

/**
 * Mirrors v5 `manifest()` for a custom workspace, built from the PUBLISHED snapshot
 * (stash.live) at the moment of publish. v5 marks every draft module 'live' on publish,
 * so module state is 'live' unless the module is pending engineering.
 */
export function buildManifest(cw, stash, opts = {}) {
  const live = (stash && stash.live) || { modules: [], perms: [] };
  const fromDraft = opts.source === 'draft';
  const modules = fromDraft ? (stash.modules || []) : (live.modules || []);
  const perms = fromDraft ? (stash.perms || []) : (live.perms || []);
  return {
    workspace: { id: cw.id, name: cw.name, slug: cw.slug, live_version: 'v' + (stash.liveV || 0), draft_version: 'v' + (stash.draftV || 0) },
    pipeline: { editable: false, stages: [], note: 'BD backbone is platform-owned' },
    signals: [],
    modules: modules.map(m => ({
      key: m.key, name: m.name, type: m.kind, enabled: m.enabled, route: m.kind === 'custom' ? '/m/' + m.key : '/' + m.key.replace(/_/g, '-'),
      state: m.pendingEng ? 'pending_engineering' : (fromDraft ? m.status : 'live'),
      tiers: { supervisor: true, executive: !m.supervisorOnly && m.tiers.executive, business_admin_signoff: m.tiers.admin, delegation: m.delegation },
      entry_gate: m.gate ? { match: m.gate.match, conditions: m.gate.conds.map(c => ({ source: c.src, outcome: c.out })), refusal_message: m.gate.refusal } : null,
      stages: m.stages.map((st, i) => ({ order: i + 1, name: st.name, outcome: st.outcome, terminal: i === m.stages.length - 1, approvers: st.approvers, fields: st.fields.map(f => ({ key: f.key, label: f.label, kind: f.kind, required: f.required, validation: f.validation || null, affects_outcome: !!f.affects })) })),
      rollup: m.rollup, exit_signal: m.exit,
      navigation: m.nav.map(sec => ({ section: sec.title, items: sec.items.map(it => ({ label: it.label, icon: it.icon, page: it.page, badge: it.badge || null, roles: it.roles })) }))
    })),
    permissions: perms.map(p => ({ action: p.action, platform_ceiling: p.ceiling, granted: p.roles }))
  };
}

/**
 * Compare the last blob known to be on the server with the one about to be saved and
 * return one release per newly published version (a workspace's liveV went up).
 * The reason/publisher come from v5's own history entry for that version. Only the newest
 * version in a jump gets a manifest (intermediate snapshots are not retained by v5).
 */
export function detectPublishes(prevBlob, nextBlob) {
  const out = [];
  const next = parseBlob(nextBlob);
  if (!hasState(next)) return out;
  const prev = parseBlob(prevBlob) || {};
  const prevData = (prev && prev.data) || {};
  for (const cw of next.customWs) {
    const n = next.data && next.data[cw.id];
    if (!n) continue;
    const p = prevData[cw.id];
    const fromV = p ? (Number(p.liveV) || 0) : 0;
    const toV = Number(n.liveV) || 0;
    if (!(toV > fromV)) continue;
    const history = Array.isArray(n.history) ? n.history : [];
    for (let v = fromV + 1; v <= toV; v++) {
      const h = history.find(x => versionNumber(x && x.version) === v);
      if (!h && v !== toV) continue; // nothing recorded for an intermediate version
      out.push({
        workspace_slug: cw.slug,
        version: v,
        reason: h ? (h.reason || '') : '',
        published_by: h ? publisherFromMeta(h.meta) : DEFAULT_PUBLISHER,
        manifest: v === toV ? buildManifest(cw, n) : null,
        // extra context, ignored by the contract fields but handy for the ledger
        lines: h && Array.isArray(h.lines) ? h.lines : []
      });
    }
  }
  return out;
}

/**
 * Trailing debounce with a max-wait ceiling, so continuous edits (e.g. dragging a node,
 * which writes on every frame) still flush at least every `maxWait` ms.
 * Timer functions are injectable for tests.
 */
export function createDebouncer(fn, { wait = 600, maxWait = 3000, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  let timer = null;
  let firstAt = null; // time of the first trigger in the current burst
  const fire = () => {
    timer = null;
    firstAt = null;
    fn();
  };
  return {
    trigger() {
      const t = now();
      if (firstAt === null) firstAt = t;
      if (timer) clearTimer(timer);
      const remaining = Math.max(0, Math.min(wait, maxWait - (t - firstAt)));
      timer = setTimer(fire, remaining);
    },
    flushNow() {
      if (timer) { clearTimer(timer); fire(); }
    },
    cancel() {
      if (timer) clearTimer(timer);
      timer = null;
      firstAt = null;
    },
    get pending() { return timer !== null; }
  };
}

/** Status-pill copy for each sync state. */
export function statusText(state, detail) {
  switch (state) {
    case 'booting': return 'Connecting…';
    case 'saved': return 'Saved · NocoBase';
    case 'pending': return 'Unsaved changes…';
    case 'saving': return 'Saving…';
    case 'local': return 'Local only';
    case 'error': return 'Sync error';
    case 'conflict': return 'Sync conflict · reload';
    case 'stale': return 'Newer data on server · reload';
    default: return detail || state;
  }
}

// The v5 engine: the REAL `class Component` of "Workspace Configurator v5.dc.html", evaluated in a
// node:vm sandbox by building-blocks/lib/load-dc.mjs (same file the visual configurator runs,
// sha256 b30033e9…2bda). Where v5 itself has the action, the agent performs it through v5's own
// method, so the draft it writes is exactly what a human clicking the same thing would produce:
//
//   create workspace   → state.newWs + createWorkspace()          (customWs entry + seed via loadTenant)
//   add built-in       → addBuiltin(key)                          (gate filtered to modules present)
//   add custom module  → openWizard(tpl) + wizard patch + wizSave() (nav, pages, ids, canvas spot)
//   enable / disable   → applyToggle([keys], revoke)
//   publish            → publishVals().onConfirmPublish()         (live snapshot, liveV/draftV, history)
//
// Every session starts from the blob read from the store; nothing here touches the network.
import { loadComponent } from '../../building-blocks/lib/load-dc.mjs';

const ID_RE = /^(?:f|s|ns|ni|ws|wf)_(\d+)$/;

/** Highest numeric suffix of any v5 element id (f_12, s_7, ns_3, ni_9, …) anywhere in `x`. */
export function maxIdSuffix(x) {
  let max = 0;
  const walk = v => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      if (typeof v.id === 'string') { const m = ID_RE.exec(v.id); if (m) max = Math.max(max, Number(m[1])); }
      for (const k in v) if (k !== 'id') walk(v[k]);
    }
  };
  walk(x);
  return max;
}

/**
 * Open a v5 session on `blob` and (optionally) load workspace `wsId` into the canvas state.
 * v5 bumps its id counter to Date.now() % 1e7 when custom workspaces exist; we additionally make
 * sure it is past every id already in the blob, so ids never collide with earlier sessions.
 */
export function openSession(blob, wsId) {
  const raw = JSON.stringify(blob && Array.isArray(blob.customWs) ? blob : { customWs: [], data: {} });
  const { Component } = loadComponent(5, { localStorage: { wsconfig_v5_custom: raw } });
  Component._c = Math.max(Component._c || 0, maxIdSuffix(blob));
  const c = new Component({ startWorkspace: 'bluetokai', skipPicker: false, previewDensity: 'comfortable' });
  Component._c = Math.max(Component._c, maxIdSuffix(blob));
  if (wsId) c.loadTenant(wsId);
  return {
    c,
    Component,
    uid: p => c.uid(p),
    stash: () => c.stashOf(c.state),
    /** v5's last toast = the human-readable confirmation a person would have seen. */
    toast: () => c.state.toast || null,
  };
}

/** createWorkspace() exactly as the "+ New workspace" dialog does it. */
export function v5CreateWorkspace(blob, { name, slug, start }) {
  const s = openSession(blob);
  const err = s.c.wsSlugError(slug);
  if (err) return { error: err };
  s.c.setState({ newWs: { name, slug, start, tried: false } });
  s.c.createWorkspace();
  const id = 'ws_' + slug.replace(/-/g, '_');
  if (s.c.state.ws !== id) return { error: 'v5 did not create the workspace (name or slug rejected).' };
  return { id, customWs: s.c.state.customWs, stash: s.stash(), toast: s.toast(), session: s };
}

export function v5AddBuiltin(blob, wsId, key) {
  const s = openSession(blob, wsId);
  const before = s.c.state.modules.length;
  s.c.addBuiltin(key);
  if (s.c.state.modules.length !== before + 1) return { error: `v5 has no built-in module "${key}".` };
  return { stash: s.stash(), toast: s.toast() };
}

/**
 * Custom module through the v5 wizard. `patch` = wizard-state fields (name, key, keyTouched, icon,
 * tiers, supervisorOnly, delegation, gate {match, conds, refusal}, stages, rollup, exit).
 * Stage/field ids in `patch.stages` are replaced by wizSave() like in the browser.
 */
export function v5AddCustomModule(blob, wsId, template, patch) {
  const s = openSession(blob, wsId);
  s.c.openWizard(template === 'blank' ? undefined : template);
  const w = s.c.state.wizard;
  const stages = patch.stages ? patch.stages.map(st => Object.assign({ id: s.uid('ws') }, st, {
    fields: (st.fields || []).map(f => Object.assign({ id: s.uid('wf') }, f)),
  })) : w.stages;
  s.c.wp(Object.assign({}, patch, { stages }));
  const keyErr = s.c.wizKeyError();
  if (keyErr) return { error: keyErr };
  const n = s.c.state.modules.length;
  s.c.wizSave();
  if (s.c.state.modules.length !== n + 1) return { error: s.toast() || 'v5 refused to save the module.' };
  return { stash: s.stash(), toast: s.toast() };
}

/** applyToggle(keys, revoke): flips `enabled` on every key (v5 semantics: a toggle, not a set). */
export function v5Toggle(blob, wsId, keys, revoke) {
  const s = openSession(blob, wsId);
  s.c.applyToggle(keys, !!revoke);
  return { stash: s.stash(), toast: s.toast() };
}

/**
 * Publish exactly like the "Publish vN" button. v5 hard-codes the history meta
 * ('11 Sep 2026 · platform:ops@matrix.io'); the agent records the real date and its own identity
 * in that free-text line instead (documented deviation — the shape is unchanged).
 */
export function v5Publish(blob, wsId, reason, meta) {
  const s = openSession(blob, wsId);
  s.c.setState({ publishReason: reason });
  const vals = s.c.publishVals();
  const fromV = s.c.state.liveV;
  vals.onConfirmPublish();
  if (s.c.state.liveV === fromV) return { error: s.toast() || 'v5 refused to publish.' };
  let toast = s.toast();
  if (meta && s.c.state.history[0]) {
    s.c.state.history[0].meta = meta;
    const who = meta.split('·').pop().trim();
    if (toast) toast = toast.replace('platform:ops@matrix.io', who);
  }
  return { stash: s.stash(), toast, version: s.c.state.liveV };
}

/** The class's own findings()/diffList()/manifest() for a stash (parity checks). */
export function v5Evaluate(blob, wsId) {
  const s = openSession(blob, wsId);
  return { findings: s.c.findings(), diff: s.c.diffList(), manifest: s.c.manifest(), stagesNeedingDecision: s.c.stagesNeedingDecision() };
}

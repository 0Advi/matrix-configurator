// Matrix Workspace Configurator — validation & derivation rules.
//
// Faithful, dependency-free ports of the pure logic inside the v5 design
// artifact (`class Component` in "Workspace Configurator v5.dc.html",
// sha256 b30033e932d4702924b3ad1b831aacf48eda0bcb7e262750d82f37ba52f55bda).
// Every exported function names the original method it ports; the parity
// suite in ../test/validation.parity.test.mjs evaluates the ORIGINAL class and
// asserts identical output over seeded + mutated workspaces.
//
// `state` below is the configurator's per-workspace state:
//   { modules, signals = [], live = { modules, perms }, perms = [], spine = [],
//     liveV, draftV, mode = 'draft' | 'live' }
// Exactly one helper is NOT a port: evaluateRollup() (marked INFERRED).

export const STAGE_OUTCOMES = Object.freeze(['pending', 'allocated', 'in progress', 'submitted', 'rejected', 'approved', 'done', 'skipped']); // OUTCOMES()
export const FIELD_KINDS = Object.freeze(['choice', 'yesno', 'text', 'number', 'date', 'file', 'person']); // KINDS()
export const RESERVED_MODULE_KEYS = Object.freeze(['admin', 'api', 'new', 'site', 'sites', 'user', 'users', 'module', 'modules', 'settings', 'auth', 'report', 'reports']); // RESERVED()
export const MODULE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,38}$/; // wizKeyError()
export const RESERVED_WORKSPACE_SLUGS = Object.freeze(['admin', 'api', 'www', 'app', 'platform']); // wsSlugError()
export const WORKSPACE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/; // wsSlugError()
export const ROLLUP_STRATEGIES = Object.freeze(['all_positive', 'any_negative', 'count_at_least', 'sum_under', 'custom']); // STRATS()
export const ROLE_LABELS = Object.freeze({ supervisor: 'Supervisor', executive: 'Executive', business_admin: 'Business admin', observer: 'Observer' }); // roleLabel()

// ------------------------------------------------------------ identifiers

/** slug(s) — free text → snake_case identifier (used for field keys, module keys). */
export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
/** onWizName (key not yet touched) — module key auto-derived from the module name. */
export function moduleKeyFromName(name) { return slugify(name).slice(0, 39); }
/** onWizKey — keystroke sanitiser for the module-key input. */
export function sanitizeModuleKeyInput(v) { return String(v).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 39); }
/** onNewWsName (slug not yet touched) — workspace slug auto-derived from its name. */
export function workspaceSlugFromName(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31); }
/** onNewWsSlug — keystroke sanitiser for the workspace-slug input. */
export function sanitizeWorkspaceSlugInput(v) { return String(v).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 31); }
/** createWorkspace() — internal workspace id derived from its slug. */
export function workspaceIdFromSlug(slug) { return 'ws_' + String(slug).replace(/-/g, '_'); }
/** renderVals() newWsUrl — public URL of a workspace. */
export function workspaceUrl(slug) { return 'https://' + (slug || '<slug>') + '.matrix.io'; }
/** manifest()/railVals() — route of a module: custom → /m/<key>, built-in → /<key-with-dashes>. */
export function moduleRoute(m) { return m.kind === 'custom' ? '/m/' + m.key : '/' + m.key.replace(/_/g, '-'); }

/**
 * wizKeyError() — '' when valid, otherwise the exact user-facing message.
 * @param {string} key
 * @param {{modules?: {key:string}[], signals?: {key:string}[]}} ctx  draft modules + signals of the workspace
 */
export function moduleKeyError(key, ctx = {}) {
  const k = key;
  if (!k) return '';
  if (!MODULE_KEY_PATTERN.test(k)) return 'Must start with a letter and use only lowercase letters, numbers and underscores (2–39 characters).';
  if (RESERVED_MODULE_KEYS.indexOf(k) >= 0) return '“' + k + '” is a reserved word in the platform router.';
  if ((ctx.modules || []).some(m => m.key === k) || (ctx.signals || []).some(g => g.key === k)) return 'Key collision — “' + k + '” already exists in this workspace.';
  return '';
}

/**
 * wsSlugError() — '' when valid, otherwise the exact user-facing message.
 * NOTE (faithful): uniqueness is checked BEFORE the reserved list, so a reserved slug
 * that is also taken reports "already exists".
 * @param {string} slug
 * @param {{existingSlugs?: string[]}} ctx  slugs of every workspace on the platform
 */
export function workspaceSlugError(slug, ctx = {}) {
  if (!slug) return '';
  if (!WORKSPACE_SLUG_PATTERN.test(slug)) return 'Lowercase letters, numbers and hyphens; starts with a letter; 2–31 characters.';
  if ((ctx.existingSlugs || []).some(s => s === slug)) return 'A workspace with the slug “' + slug + '” already exists.';
  if (RESERVED_WORKSPACE_SLUGS.indexOf(slug) >= 0) return '“' + slug + '” is reserved by the platform.';
  return '';
}

// ------------------------------------------------------------ graph helpers

const signalsOf = st => st.signals || [];
/** mods() — modules visible in the current mode. */
export function visibleModules(st) { return st.mode === 'live' ? st.live.modules : st.modules; }
/** srcName(k) — display name for a module or signal key (falls back to the key). */
export function nameOf(st, k) {
  const m = visibleModules(st).find(x => x.key === k); if (m) return m.name;
  const g = signalsOf(st).find(x => x.key === k); return g ? g.name : k;
}
/** srcOutcomes(k) — outcomes a gate can wait for on source k (stage outcomes, then exit). */
export function sourceOutcomes(st, k) {
  const g = signalsOf(st).find(x => x.key === k); if (g) return g.outcomes;
  const m = visibleModules(st).find(x => x.key === k); if (!m) return STAGE_OUTCOMES.slice();
  const o = [];
  m.stages.forEach(s => { if (o.indexOf(s.outcome) < 0) o.push(s.outcome); });
  if (o.indexOf(m.exit) < 0) o.push(m.exit);
  return o;
}
/** defaultOutcome(k) — approved > done > first outcome > 'approved'. */
export function defaultOutcome(st, k) {
  const o = sourceOutcomes(st, k);
  return o.indexOf('approved') >= 0 ? 'approved' : (o.indexOf('done') >= 0 ? 'done' : (o[0] || 'approved'));
}
/** dependentsOf(key) — draft modules whose gate waits on `key`. */
export function dependentsOf(modules, key) { return modules.filter(m => m.gate && m.gate.conds.some(c => c.src === key)); }

/**
 * Path-returning core of gateCycle(): with `gate` substituted for module `key`,
 * returns the list of keys on a loop through `key` (starting at key) or null.
 */
export function findGateCycle(modules, key, gate) {
  if (!gate || !gate.conds.length) return null;
  const adj = {};
  modules.forEach(m => { const g = m.key === key ? gate : m.gate; adj[m.key] = g ? (g.conds || []).map(c => c.src) : []; });
  adj[key] = gate.conds.map(c => c.src);
  const seen = {}, path = [];
  const walk = (n, start) => {
    if (n === start && path.length) return path.slice();
    if (seen[n]) return null;
    seen[n] = 1; path.push(n);
    const nb = adj[n] || [];
    for (let i = 0; i < nb.length; i++) { if (nb[i] === start) return path.slice(); const r = walk(nb[i], start); if (r) return r; }
    path.pop(); return null;
  };
  return walk(key, key);
}
/** gateCycle(key, gate) — exact user-facing message, or null when there is no cycle. */
export function gateCycle(st, key, gate) {
  const loop = findGateCycle(st.modules, key, gate);
  if (!loop) return null;
  return 'Gate cycle: ' + loop.map(k => nameOf(st, k)).join(' waits on ') + ' waits on ' + nameOf(st, key) + '. Nothing in this loop can ever start.';
}
/** flowOrder(mods) — topological order of ENABLED modules by gate; leftovers (cycles) appended. */
export function flowOrder(mods) {
  const on = mods.filter(m => m.enabled), done = {}, out = [];
  let guard = 0;
  while (out.length < on.length && guard++ < 40) {
    on.forEach(m => {
      if (done[m.key]) return;
      const deps = m.gate ? m.gate.conds.map(c => c.src).filter(k => on.some(x => x.key === k)) : [];
      if (deps.every(k => done[k])) { done[m.key] = 1; out.push(m); }
    });
  }
  on.forEach(m => { if (!done[m.key]) out.push(m); });
  return out;
}

// ------------------------------------------------------------ sentences

/** rollupSentence(m) */
export function rollupSentence(m) {
  const r = m.rollup || {};
  if (m.pendingEng || r.strategy === 'custom') return 'Custom logic — an engineering request is filed and the module sits in Pending engineering until it ships.';
  if (r.strategy === 'any_negative') return 'Any negative — rejected as soon as one checked field is No.';
  if (r.strategy === 'count_at_least') return 'Count at least — approved when at least ' + r.n + ' of ' + r.of + ' checked fields are Yes.';
  if (r.strategy === 'sum_under') return 'Sum under — approved when ' + r.field + ' stays under ₹ ' + r.limit + '.';
  return 'All positive — approved when every checked field is Yes or N/A; rejected if any is No.';
}
/** wizQueueSentence(w) — when sites appear in a module's queue (wizard wording). */
export function queueSentence(st, gate) {
  const c = gate ? gate.conds : [];
  if (!c.length) return 'No entry gate — sites appear in this module’s queue as soon as the workspace creates them.';
  const parts = c.map(x => nameOf(st, x.src) + ' is ' + x.out);
  return 'Sites appear in this module’s queue when ' + parts.join(gate.match === 'all' ? ' and ' : ' or ') + '.';
}
/** wizAutoRefusal(w) — default refusal message from the first gate condition. */
export function autoRefusal(st, moduleName, gate) {
  const c = gate ? gate.conds : [], nm = moduleName || 'This module';
  if (!c.length) return '';
  return nm + ' is locked: waiting for ' + nameOf(st, c[0].src) + ' ' + c[0].out + '.';
}
/** withRefusal(m, gate) — regenerate the refusal unless the admin edited it (gate.touched). */
export function withRefusal(st, m, gate) {
  if (!gate || gate.touched || !gate.conds.length) return gate;
  const c = gate.conds[0];
  return Object.assign({}, gate, { refusal: m.name + ' is locked: waiting for ' + nameOf(st, c.src) + ' ' + c.out + '.' });
}
/**
 * consequencesVals() refusal — why a module cannot be switched off (null if it can).
 * Only ENABLED dependents block.
 */
export function toggleOffRefusal(st, key) {
  const m = st.modules.find(x => x.key === key); if (!m || !m.enabled) return null;
  const deps = dependentsOf(st.modules, key).filter(d => d.enabled);
  if (!deps.length) return null;
  return deps.map(d => d.name + ' can’t start until ' + m.name + ' is ' + ((d.gate.conds.find(x => x.src === m.key) || {}).out || 'approved')).join('. ') + '. Turning ' + m.name + ' off would leave ' + deps.map(d => d.name).join(' and ') + ' stuck with no way forward.';
}

// ------------------------------------------------------------ validation

/**
 * findings() — open validation findings for the draft. Each: { tag, text, id }.
 * Tags: key collision · pending eng · gate cycle · dead gate · unreachable ·
 *       no approver · dead link · field kind
 */
export function findings(st) {
  const out = [], seen = {};
  const dmod = k => st.modules.find(m => m.key === k);
  st.modules.forEach(m => {
    if (seen[m.key]) out.push({ tag: 'key collision', text: 'Two modules share the key “' + m.key + '”. Keys are used in URLs and the API and must be unique.', id: 'mod:' + m.key });
    seen[m.key] = 1;
    if (m.pendingEng) out.push({ tag: 'pending eng', text: m.name + ' is Pending engineering — its roll-up rule needs custom logic and cannot go live until an engineer ships it.', id: 'mod:' + m.key });
    const cyc = m.gate ? gateCycle(st, m.key, m.gate) : null;
    if (cyc) out.push({ tag: 'gate cycle', text: cyc, id: 'mod:' + m.key });
    if (m.gate && m.enabled) m.gate.conds.forEach(c => {
      const src = dmod(c.src);
      if (src && !src.enabled) out.push({ tag: 'dead gate', text: m.name + ' waits on ' + src.name + ', which is turned off — no site will ever reach ' + m.name + '.', id: 'mod:' + m.key });
      if (src && src.enabled) { const outs = sourceOutcomes(st, c.src); if (outs.indexOf(c.out) < 0) out.push({ tag: 'unreachable', text: m.name + ' waits for ' + src.name + ' to be “' + c.out + '”, but no stage in ' + src.name + ' ends in that outcome.', id: 'mod:' + m.key }); }
    });
    m.stages.forEach(s => { if (!s.approvers.length) out.push({ tag: 'no approver', text: m.name + ' → “' + s.name + '” has no approver tier — a site entering it can never move on.', id: 'mod:' + m.key }); });
    m.nav.forEach(sec => sec.items.forEach(it => {
      const other = st.modules.find(x => x.key !== m.key && !x.enabled && it.label.trim().toLowerCase() === x.name.trim().toLowerCase());
      if (other) out.push({ tag: 'dead link', text: m.name + ' → “' + it.label + '” points at ' + other.name + ', which is turned off for this workspace.', id: 'mod:' + m.key });
    }));
    const lm = st.live.modules.find(x => x.key === m.key);
    if (lm) m.stages.forEach(s => {
      const ls = lm.stages.find(x => x.name === s.name); if (!ls) return;
      s.fields.forEach(f => { const lf = ls.fields.find(x => x.key === f.key); if (lf && lf.kind !== f.kind) out.push({ tag: 'field kind', text: m.name + ' → “' + f.label + '” changed kind from ' + lf.kind + ' to ' + f.kind + ' after publish. Stored values will not migrate.', id: 'mod:' + m.key }); });
    });
  });
  return out;
}

/** diffList() — draft-vs-live change list. Each: { tag, text, impact: string|false, level }. */
export function diffList(st) {
  const L = st.live, out = [];
  const push = (tag, text, impact, level) => out.push({ tag, text, impact: impact || false, level: level || 'low' });
  const label = r => ROLE_LABELS[r] || r;
  st.modules.forEach(m => {
    const lm = L.modules.find(x => x.key === m.key);
    if (!lm) { push('created', 'Created module ' + m.name + ' (' + m.key + ') — custom, ' + m.stages.length + ' stages, ' + m.stages.reduce((a, x) => a + x.fields.length, 0) + ' fields.', 'Provisioning generates the generic runtime tables, the /m/' + m.key + ' route and its four screens. Existing sites are unaffected.' + (m.pendingEng ? ' Roll-up is Pending engineering and will not evaluate until an engineer ships it.' : ''), m.pendingEng ? 'high' : 'medium'); return; }
    if (lm.name !== m.name) push('renamed', lm.name + ' renamed to ' + m.name + '.', false, 'low');
    if (lm.enabled !== m.enabled) push(m.enabled ? 'enabled' : 'disabled', m.name + ': turned ' + (m.enabled ? 'on' : 'off') + '.', m.enabled ? false : m.name + ' becomes unavailable in nav, pages, API, notifications and approvals. ' + (m.sitesTotal || 0) + ' sites keep their history; 12 executive allocations pause.', m.enabled ? 'medium' : 'high');
    if (JSON.stringify(lm.gate) !== JSON.stringify(m.gate)) push('gate', m.name + ': entry gate is now ' + (m.gate ? m.gate.conds.map(c => nameOf(st, c.src) + ' is ' + c.out).join(m.gate.match === 'all' ? ' and ' : ' or ') : 'always available') + '.', 'Sites already inside ' + m.name + ' are not re-evaluated. The new gate applies to sites arriving after publish.', 'medium');
    if (lm.stages.length !== m.stages.length) push('stages', m.name + ': stages ' + lm.stages.length + ' → ' + m.stages.length + '.', false, 'medium');
    if (JSON.stringify(lm.rollup) !== JSON.stringify(m.rollup)) push('roll-up', m.name + ': outcome roll-up is now “' + rollupSentence(m).split(' — ')[0] + '”.', m.pendingEng ? 'Parks ' + m.name + ' in Pending engineering — the roll-up will not evaluate until an engineer ships it.' : 'Stage outcomes are recalculated for sites that arrive after publish.', m.pendingEng ? 'high' : 'medium');
    lm.stages.forEach(ls => {
      const cs = m.stages.find(x => x.name === ls.name);
      if (!cs) { if (ls.sites) push('stages', m.name + ': stage “' + ls.name + '” removed while ' + ls.sites + ' sites sit in it.', 'Needs a decision below before this can publish.', 'high'); return; }
      if (cs.fields.length !== ls.fields.length) push('fields', m.name + ' → ' + ls.name + ': fields ' + ls.fields.length + ' → ' + cs.fields.length + '.', false, 'low');
      if (cs.approvers.join() !== ls.approvers.join()) push('approvers', m.name + ' → ' + ls.name + ': approvers now ' + (cs.approvers.map(label).join(', ') || 'nobody') + '.', cs.approvers.length ? false : 'No tier can sign this stage off — sites entering it will stall.', cs.approvers.length ? 'low' : 'high');
    });
    lm.nav.forEach((lsec, si) => (lsec.items || []).forEach((lit, ii) => {
      const cur = (m.nav[si] && m.nav[si].items[ii]) ? m.nav[si].items[ii] : null; if (!cur) return;
      ['supervisor', 'executive'].forEach(r => {
        const was = lit.roles.indexOf(r) >= 0, now = cur.roles.indexOf(r) >= 0;
        if (was && !now) push('navigation', m.name + ': ' + label(r) + 's can no longer open ' + cur.label + '.', 'The page is blocked, not just hidden — an ' + label(r) + ' following an old link gets a refusal.', 'medium');
        if (!was && now) push('navigation', m.name + ': ' + label(r) + 's can now open ' + cur.label + '.', false, 'low');
      });
      if (lit.label !== cur.label) push('label', m.name + ': nav item “' + lit.label + '” renamed to “' + cur.label + '”.', false, 'low');
    }));
  });
  L.modules.forEach(lm => { if (!st.modules.find(m => m.key === lm.key)) push('removed', 'Module ' + lm.name + ' removed.', 'Its site data stays in the database but becomes unreachable in the app.', 'high'); });
  (st.perms || []).forEach(p => {
    const lp = (L.perms || []).find(x => x.action === p.action); if (!lp) return;
    if (lp.roles.join() !== p.roles.join()) {
      const removed = lp.roles.filter(r => p.roles.indexOf(r) < 0), added = p.roles.filter(r => lp.roles.indexOf(r) < 0);
      push('permissions', p.action + ': ' + (removed.length ? 'removed from ' + removed.map(label).join(', ') : '') + (removed.length && added.length ? '; ' : '') + (added.length ? 'restored for ' + added.map(label).join(', ') : '') + '.', p.roles.length ? false : 'No role holds this action — every transition that needs it stalls.', p.roles.length ? 'medium' : 'high');
    }
  });
  return out;
}

/** stagesNeedingDecision() — live stages with sites that the draft removes. */
export function stagesNeedingDecision(st) {
  const out = [];
  st.live.modules.forEach(lm => {
    const m = st.modules.find(x => x.key === lm.key); if (!m) return;
    lm.stages.forEach(ls => { if (ls.sites && !m.stages.some(x => x.name === ls.name)) out.push({ mod: m, stage: ls }); });
  });
  return out;
}

/**
 * Publish is blocked only by an empty reason (publishVals: `blocked = !reason.trim()`).
 * Findings are advisory ("Publishing anyway is allowed but not advised").
 */
export function publishBlocked(reason) { return !String(reason || '').trim(); }

// ------------------------------------------------------------ manifests

/** manifest() — the workspace "draft manifest" JSON (see manifest.schema.json). */
export function buildManifest(st, workspace) {
  return {
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, live_version: 'v' + st.liveV, draft_version: 'v' + st.draftV },
    pipeline: { editable: false, stages: (st.spine || []).map(x => x.id), note: 'BD backbone is platform-owned' },
    signals: signalsOf(st).map(g => ({ key: g.key, outcomes: g.outcomes })),
    modules: st.modules.map(m => ({
      key: m.key, name: m.name, type: m.kind, enabled: m.enabled, route: moduleRoute(m),
      state: m.pendingEng ? 'pending_engineering' : m.status,
      tiers: { supervisor: true, executive: !m.supervisorOnly && m.tiers.executive, business_admin_signoff: m.tiers.admin, delegation: m.delegation },
      entry_gate: m.gate ? { match: m.gate.match, conditions: m.gate.conds.map(c => ({ source: c.src, outcome: c.out })), refusal_message: m.gate.refusal } : null,
      stages: m.stages.map((s, i) => ({ order: i + 1, name: s.name, outcome: s.outcome, terminal: i === m.stages.length - 1, approvers: s.approvers, fields: s.fields.map(f => ({ key: f.key, label: f.label, kind: f.kind, required: f.required, validation: f.validation || null, affects_outcome: !!f.affects })) })),
      rollup: m.rollup, exit_signal: m.exit,
      navigation: m.nav.map(sec => ({ section: sec.title, items: sec.items.map(it => ({ label: it.label, icon: it.icon, page: it.page, badge: it.badge || null, roles: it.roles })) })),
    })),
    permissions: (st.perms || []).map(p => ({ action: p.action, platform_ceiling: p.ceiling, granted: p.roles })),
  };
}

/** wizManifest(w) — the single custom-module draft manifest shown in wizard step 9. */
export function buildModuleDraftManifest(w, st = { modules: [], signals: [], live: { modules: [] } }) {
  return {
    module: { key: w.key || null, name: w.name || null, type: 'custom', icon: w.icon, route: '/m/' + (w.key || '<module_key>'), runtime: 'generic' },
    tiers: { supervisor: true, executive: w.supervisorOnly ? false : !!w.tiers.executive, business_admin_signoff: !!w.tiers.admin, delegation: !!w.delegation },
    entry_gate: w.gate.conds.length ? { match: w.gate.match, conditions: w.gate.conds.map(c => ({ source: c.src, outcome: c.out })), refusal_message: w.gate.refusal || autoRefusal(st, w.name, w.gate) } : null,
    stages: w.stages.map((s, i) => ({ order: i + 1, name: s.name, outcome: s.outcome, terminal: i === w.stages.length - 1, approvers: s.approvers, fields: s.fields.map(f => ({ key: f.key, label: f.label, kind: f.kind, required: f.required, validation: f.validation || null, affects_outcome: f.affects })) })),
    rollup: w.rollup.strategy === 'custom' ? { strategy: 'custom', engineering_request: 'filed', state: 'pending_engineering' }
      : w.rollup.strategy === 'count_at_least' ? { strategy: 'count_at_least', n: Number(w.rollup.n) || 0, of: Number(w.rollup.of) || 0 }
        : w.rollup.strategy === 'sum_under' ? { strategy: 'sum_under', field: w.rollup.field, limit: w.rollup.limit } : { strategy: w.rollup.strategy },
    screens: ['overview', 'queue', 'history', 'checklist_review'],
    exit_signal: w.exit,
  };
}

// ------------------------------------------------------------ INFERRED (not in the source)

/**
 * INFERRED — v5 only *describes* roll-up strategies (STRATS preview text and
 * rollupSentence); it never evaluates them. This is a reference evaluator that
 * follows those descriptions so a runtime can be built against it.
 * @param {{strategy:string,n?:number|string,limit?:string|number}} rollup
 * @param {Array<'yes'|'no'|'n/a'|string>} checks values of fields with affects_outcome=true
 * @param {number} [sum] value of the numeric field for sum_under
 * @returns {'approved'|'rejected'|'pending'|'pending_engineering'}
 */
export function evaluateRollup(rollup, checks = [], sum) {
  const v = checks.map(x => String(x).trim().toLowerCase());
  const isYes = x => x === 'yes' || x === 'true' || x === 'done' || x === 'ready';
  const isNo = x => x === 'no' || x === 'false' || x === 'blocked';
  const isNA = x => x === 'n/a' || x === 'na';
  switch (rollup && rollup.strategy) {
    case 'custom': return 'pending_engineering';
    case 'any_negative': return v.some(isNo) ? 'rejected' : (v.length && v.every(x => isYes(x) || isNA(x)) ? 'approved' : 'pending');
    case 'count_at_least': return v.filter(isYes).length >= Number(rollup.n || 0) ? 'approved' : (v.every(x => x) ? 'rejected' : 'pending');
    case 'sum_under': {
      if (sum === undefined || sum === null || sum === '') return 'pending';
      const limit = Number(String(rollup.limit).replace(/[^0-9.]/g, ''));
      return Number(sum) < limit ? 'approved' : 'rejected';
    }
    case 'all_positive':
    default:
      if (v.some(isNo)) return 'rejected';
      return v.length && v.every(x => isYes(x) || isNA(x)) ? 'approved' : 'pending';
  }
}

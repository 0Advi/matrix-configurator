// Parity: every ported function in from-design/validation.mjs must produce the
// SAME output as the original method of the v5 design artifact, evaluated live
// from sources/design-artifact/Workspace Configurator v5.dc.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadComponent, plain } from '../lib/load-dc.mjs';
import * as V from '../from-design/validation.mjs';

const { Component } = loadComponent(5);
const WORKSPACES = ['bluetokai', 'starbucks', 'burgerking'];
const clone = x => JSON.parse(JSON.stringify(x));
// Normalise both sides to plain JSON: the original runs in a separate vm realm,
// so its arrays/objects have different prototypes than ours.
const norm = x => (x === undefined ? undefined : plain(x));
const eq = (a, b, msg) => assert.deepEqual(norm(a), norm(b), msg);
const fresh = ws => new Component({ startWorkspace: ws });
const find = (mods, k) => mods.find(m => m.key === k);

// Mutations: each takes a cloned {modules, perms, signals, live, mode} and edits it.
const MUTATIONS = {
  identity: () => {},
  gateCycle: s => { const bd = find(s.modules, 'bd'); bd.gate = { match: 'all', conds: [{ src: 'financial_closure', out: 'done' }], refusal: 'x' }; },
  selfLoop: s => { const m = find(s.modules, 'legal'); m.gate = { match: 'any', conds: [{ src: 'legal', out: 'approved' }], refusal: 'x' }; },
  disableLegal: s => { find(s.modules, 'legal').enabled = false; },
  unreachableOutcome: s => { const d = find(s.modules, 'project'); d.gate = { match: 'all', conds: [{ src: 'nso', out: 'skipped' }], refusal: 'x' }; },
  noApprover: s => { find(s.modules, 'nso').stages[1].approvers = []; },
  deadLink: s => { find(s.modules, 'nso').enabled = false; const p = find(s.modules, 'project'); p.nav[0].items.push({ id: 'x', icon: '◆', label: ' nso ', page: 'overview', roles: ['supervisor'], badge: '' }); },
  fieldKindChange: s => { find(s.modules, 'bd').stages[0].fields[0].kind = 'number'; },
  keyCollision: s => { s.modules.push(clone(find(s.modules, 'pex'))); },
  pendingEng: s => { const m = find(s.modules, 'pex'); if (m) { m.pendingEng = true; m.rollup = { strategy: 'custom' }; } },
  rollupCountAtLeast: s => { find(s.modules, 'legal').rollup = { strategy: 'count_at_least', n: 2, of: 3, limit: '1' }; },
  rollupSumUnder: s => { find(s.modules, 'project').rollup = { strategy: 'sum_under', field: 'Budget total', limit: '9,00,000' }; },
  rollupAnyNeg: s => { find(s.modules, 'nso').rollup = { strategy: 'any_negative' }; },
  renameAndStages: s => { const m = find(s.modules, 'design'); m.name = 'Store Design 2'; m.stages = m.stages.slice(1); },
  removeStageWithSites: s => { const m = find(s.modules, 'bd'); m.stages = m.stages.filter(x => x.name !== 'Shortlist review'); },
  navRoleAndLabel: s => { const it = find(s.modules, 'bd').nav[0].items[0]; it.roles = ['supervisor']; it.label = 'Queue'; const it2 = find(s.modules, 'nso').nav[0].items[0]; it2.roles = ['supervisor', 'executive']; },
  approverChange: s => { find(s.modules, 'legal').stages[0].approvers = []; find(s.modules, 'design').stages[1].approvers = ['executive']; },
  removeModule: s => { s.modules = s.modules.filter(m => m.key !== 'financial_closure'); },
  permChange: s => { s.perms[0].roles = []; s.perms[1].roles = ['supervisor']; s.perms[6].roles = ['business_admin', 'executive']; },
  gateChangeAnyMatch: s => { const m = find(s.modules, 'design'); m.gate = Object.assign({}, m.gate, { match: 'any' }); },
  signalGate: s => { s.signals = [{ key: 'finance_sig', name: 'Finance', outcomes: ['pending', 'cleared', 'blocked'], x: 0, y: 0 }]; find(s.modules, 'project').gate = { match: 'all', conds: [{ src: 'finance_sig', out: 'cleared' }, { src: 'missing_src', out: 'approved' }], refusal: 'r' }; },
  liveMode: s => { s.mode = 'live'; find(s.modules, 'bd').name = 'Draft-only BD name'; },
  emptyWorkspace: s => { s.modules = []; },
  addField: s => { find(s.modules, 'legal').stages[1].fields.push({ id: 'fx', label: 'Stamp duty paid', key: 'stamp_duty', kind: 'yesno', required: true, validation: '', affects: true }); },
  enabledVsLive: s => { find(s.live.modules, 'design').enabled = false; },
};

function stateFor(ws, mut) {
  const c = fresh(ws);
  const st = clone({ modules: c.state.modules, perms: c.state.perms, signals: c.state.signals, live: c.state.live, mode: c.state.mode });
  MUTATIONS[mut](st);
  c.state = Object.assign({}, c.state, st);
  return c;
}

for (const ws of WORKSPACES) {
  for (const mut of Object.keys(MUTATIONS)) {
    test(`parity ${ws} · ${mut}`, () => {
      const c = stateFor(ws, mut);
      const st = c.state;
      eq(V.findings(st), plain(c.findings()), 'findings');
      eq(V.diffList(st), plain(c.diffList()), 'diffList');
      eq(V.stagesNeedingDecision(st).map(d => [d.mod.key, d.stage.name]), plain(c.stagesNeedingDecision().map(d => [d.mod.key, d.stage.name])), 'stagesNeedingDecision');
      eq(V.buildManifest(st, c.ws()), plain(c.manifest()), 'manifest');
      eq(V.flowOrder(st.modules).map(m => m.key), plain(c.flowOrder(st.modules).map(m => m.key)), 'flowOrder');
      for (const m of st.modules) {
        assert.equal(V.gateCycle(st, m.key, m.gate), c.gateCycle(m.key, m.gate), 'gateCycle ' + m.key);
        eq(V.sourceOutcomes(st, m.key), plain(c.srcOutcomes(m.key)), 'srcOutcomes ' + m.key);
        assert.equal(V.defaultOutcome(st, m.key), c.defaultOutcome(m.key), 'defaultOutcome ' + m.key);
        assert.equal(V.nameOf(st, m.key), c.srcName(m.key), 'srcName ' + m.key);
        eq(V.dependentsOf(st.modules, m.key).map(d => d.key), plain(c.dependentsOf(m.key).map(d => d.key)), 'dependentsOf ' + m.key);
        assert.equal(V.rollupSentence(m), c.rollupSentence(m), 'rollupSentence ' + m.key);
        eq(V.withRefusal(st, m, m.gate), plain(c.withRefusal(m, m.gate)), 'withRefusal ' + m.key);
        assert.equal(V.moduleRoute(m), c.manifest().modules.find(x => x.key === m.key).route, 'route ' + m.key);
        c.state = Object.assign({}, c.state, { consequences: { key: m.key, revoke: false } });
        const cv = c.consequencesVals();
        if (m.enabled && st.modules.filter(x => x.key === m.key).length === 1) assert.equal(V.toggleOffRefusal(st, m.key), cv.consequences.refusal || null, 'toggleOffRefusal ' + m.key);
      }
      assert.equal(V.nameOf(st, 'does_not_exist'), c.srcName('does_not_exist'));
      eq(V.sourceOutcomes(st, 'does_not_exist'), plain(c.srcOutcomes('does_not_exist')));
    });
  }
}

test('coverage · the mutations above exercise every finding tag and every diff tag (in the ORIGINAL)', () => {
  const ft = new Set(), dt = new Set();
  for (const ws of WORKSPACES) for (const mut of Object.keys(MUTATIONS)) {
    const c = stateFor(ws, mut);
    c.findings().forEach(f => ft.add(f.tag));
    c.diffList().forEach(d => dt.add(d.tag));
  }
  eq([...ft].sort(), ['dead gate', 'dead link', 'field kind', 'gate cycle', 'key collision', 'no approver', 'pending eng', 'unreachable']);
  eq([...dt].sort(), ['approvers', 'created', 'disabled', 'enabled', 'fields', 'gate', 'label', 'navigation', 'permissions', 'removed', 'renamed', 'roll-up', 'stages']);
});

test('parity · moduleKeyError over fixed + fuzzed keys', () => {
  const c = fresh('starbucks');
  const keys = ['', 'a', 'ab', 'Ab', '1ab', 'a-b', 'a_b', 'bd', 'legal', 'store_design', 'admin', 'reports', 'modules', 'x'.repeat(39), 'x'.repeat(40), 'vendor_onboarding', 'a b', 'é', '_ab', 'a__', 'finance'];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789_-A ';
  for (let i = 0; i < 400; i++) { let s = ''; const n = Math.floor(rnd() * 44); for (let j = 0; j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)]; keys.push(s); }
  c.state.signals = [{ key: 'finance', name: 'Finance', outcomes: ['pending'] }];
  for (const key of keys) {
    c.state = Object.assign({}, c.state, { wizard: { key } });
    assert.equal(V.moduleKeyError(key, { modules: c.state.modules, signals: c.state.signals }), c.wizKeyError(), JSON.stringify(key));
  }
});

test('parity · workspaceSlugError over fixed + fuzzed slugs', () => {
  const c = fresh('bluetokai');
  c.state = Object.assign({}, c.state, { customWs: [{ id: 'ws_acme_retail', name: 'Acme', slug: 'acme-retail', start: 'empty', created: 'x' }] });
  const existingSlugs = c.wsList().map(w => w.slug);
  const slugs = ['', 'a', 'ab', 'bluetokai', 'starbucks', 'acme-retail', 'admin', 'api', 'www', 'app', 'platform', 'a-', '-a', 'a_b', 'A', '9a', 'a'.repeat(31), 'a'.repeat(32), 'new-co'];
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-_A';
  for (let i = 0; i < 400; i++) { let s = ''; const n = Math.floor(rnd() * 36); for (let j = 0; j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)]; slugs.push(s); }
  for (const slug of slugs) assert.equal(V.workspaceSlugError(slug, { existingSlugs }), c.wsSlugError(slug), JSON.stringify(slug));
});

test('parity · identifier sanitisers vs the original input handlers', () => {
  const c = fresh('bluetokai');
  const inputs = ['Vendor Onboarding', '  Hello World Café!! ', 'ABC', 'a--b__c', '9 lives', '', 'x'.repeat(60), 'Ünïcödé name', 'Store Design – Final'];
  for (const v of inputs) {
    assert.equal(V.slugify(v), c.slug(v));
    c.setState({ newWs: { name: '', slug: '', slugTouched: false, start: 'empty', tried: false } });
    let rv = c.renderVals(); rv.onNewWsName({ target: { value: v } });
    assert.equal(V.workspaceSlugFromName(v), c.state.newWs.slug, 'workspaceSlugFromName ' + v);
    rv = c.renderVals(); rv.onNewWsSlug({ target: { value: v } });
    assert.equal(V.sanitizeWorkspaceSlugInput(v), c.state.newWs.slug, 'sanitizeWorkspaceSlugInput ' + v);
    c.openWizard();
    let wv = c.wizVals(); wv.onWizName({ target: { value: v } });
    assert.equal(V.moduleKeyFromName(v), c.state.wizard.key, 'moduleKeyFromName ' + v);
    wv = c.wizVals(); wv.onWizKey({ target: { value: v } });
    assert.equal(V.sanitizeModuleKeyInput(v), c.state.wizard.key, 'sanitizeModuleKeyInput ' + v);
    c.setState({ wizard: null, newWs: null });
  }
  c.setState({ newWs: { name: 'Acme', slug: 'acme-retail', slugTouched: true, start: 'empty', tried: false } });
  assert.equal(V.workspaceUrl('acme-retail'), c.renderVals().newWsUrl);
  c.createWorkspace();
  assert.ok(c.state.customWs.some(w => w.id === V.workspaceIdFromSlug('acme-retail')));
});

test('parity · wizard manifest, queue sentence and auto-refusal', () => {
  const variants = [
    w => w,
    w => Object.assign(w, { key: 'joint_qa', name: 'Joint QA', gate: { match: 'all', conds: [{ src: 'nso', out: 'done' }, { src: 'legal', out: 'approved' }], refusal: '' } }),
    w => Object.assign(w, { gate: { match: 'any', conds: [{ src: 'bd', out: 'done' }], refusal: 'Custom refusal' }, supervisorOnly: true }),
    w => Object.assign(w, { rollup: { strategy: 'custom', n: 3, of: 5, field: 'f', limit: '1' } }),
    w => Object.assign(w, { rollup: { strategy: 'count_at_least', n: '4', of: 'x', field: 'f', limit: '1' } }),
    w => Object.assign(w, { rollup: { strategy: 'sum_under', n: 3, of: 5, field: 'Budget total', limit: '25,00,000' }, tiers: { executive: false, supervisor: true, admin: false }, delegation: false }),
    w => Object.assign(w, { key: '', name: '', exit: 'done' }),
  ];
  for (const tpl of [undefined, 'vendor', 'retail', 'franchise']) {
    for (const vary of variants) {
      const c = fresh('bluetokai');
      c.openWizard(tpl);
      const w = vary(clone(c.state.wizard));
      c.state = Object.assign({}, c.state, { wizard: w });
      eq(V.buildModuleDraftManifest(w, c.state), plain(c.wizManifest(w)));
      assert.equal(V.queueSentence(c.state, w.gate), c.wizQueueSentence(w));
      assert.equal(V.autoRefusal(c.state, w.name, w.gate), c.wizAutoRefusal(w));
      if (w.key) assert.equal(V.gateCycle(c.state, w.key, w.gate), c.gateCycle(w.key, w.gate));
    }
  }
});

test('constants match the evaluated originals', () => {
  const c = fresh('bluetokai');
  eq([...V.STAGE_OUTCOMES], plain(c.OUTCOMES()));
  eq([...V.FIELD_KINDS], plain(c.KINDS().map(k => k[0])));
  eq([...V.RESERVED_MODULE_KEYS], plain(c.RESERVED()));
  eq([...V.ROLLUP_STRATEGIES], plain(c.STRATS().map(s => s.id)));
  for (const r of Object.keys(V.ROLE_LABELS)) assert.equal(V.ROLE_LABELS[r], c.roleLabel(r));
});

test('publishBlocked mirrors publishVals: only an empty reason blocks', () => {
  const c = fresh('starbucks');
  for (const reason of ['', '   ', 'Customer request #1']) {
    c.state = Object.assign({}, c.state, { publishReason: reason });
    const blockedOriginal = c.publishVals().publishNote.startsWith('A reason is required');
    assert.equal(V.publishBlocked(reason), blockedOriginal);
  }
});

test('INFERRED evaluateRollup follows the STRATS descriptions', () => {
  assert.equal(V.evaluateRollup({ strategy: 'all_positive' }, ['yes', 'n/a']), 'approved');
  assert.equal(V.evaluateRollup({ strategy: 'all_positive' }, ['yes', 'no']), 'rejected');
  assert.equal(V.evaluateRollup({ strategy: 'all_positive' }, ['yes', '']), 'pending');
  assert.equal(V.evaluateRollup({ strategy: 'any_negative' }, ['no']), 'rejected');
  assert.equal(V.evaluateRollup({ strategy: 'count_at_least', n: 2, of: 3 }, ['yes', 'yes', 'no']), 'approved');
  assert.equal(V.evaluateRollup({ strategy: 'count_at_least', n: 3, of: 3 }, ['yes', 'yes', 'no']), 'rejected');
  assert.equal(V.evaluateRollup({ strategy: 'sum_under', limit: '25,00,000' }, [], 2400000), 'approved');
  assert.equal(V.evaluateRollup({ strategy: 'sum_under', limit: '25,00,000' }, [], 2500000), 'rejected');
  assert.equal(V.evaluateRollup({ strategy: 'custom' }, ['yes']), 'pending_engineering');
});

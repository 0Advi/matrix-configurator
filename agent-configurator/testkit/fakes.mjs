// Test helpers: an in-process configurator server (the REAL web/server.mjs handler + store, with the
// web suite's TEST-ONLY in-memory NocoBase client), a fake Matrix platform API, and stand-ins for the
// two workspaces already in the live store — the user's `ws_aditya_test` and F4b's `ws_chai_point_retail`
// (built with the v5 class directly, independent of the code under test).
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { createApp } from '../../web/server.mjs';
import { createStore } from '../../web/lib/store.mjs';
import { createFakeNocoBase } from '../../web/test/helpers/fake-nocobase.mjs';
import { loadComponent } from '../../building-blocks/lib/load-dc.mjs';
import { validate as schemaValidate } from '../../building-blocks/lib/mini-schema.mjs';
import { MANIFEST_SCHEMA } from '../lib/model.mjs';

export const USER_WS_IDS = ['ws_aditya_test', 'ws_chai_point_retail'];

/**
 * A blob holding stand-ins for the two pre-existing workspaces (user's + F4b's), made by clicking through the real v5
 * class (template copy; Chai Point with two wizard modules and a publish), like a human did.
 */
export function userBlob() {
  const { Component, localStorage } = loadComponent(5);
  const c = new Component({ startWorkspace: 'bluetokai' });
  const save = () => localStorage.setItem('wsconfig_v5_custom', JSON.stringify({ customWs: c.state.customWs, data: Object.assign({}, c.state.wsData, { [c.state.ws]: c.stashOf(c.state) }) }));
  c.setState({ newWs: { name: 'ADITYA TEST', slug: 'aditya-test', start: 'template' } }); c.createWorkspace();
  c.setState({ wsData: Object.assign({}, c.state.wsData, { ws_aditya_test: c.stashOf(c.state) }) });
  c.setState({ newWs: { name: 'Chai Point Retail', slug: 'chai-point-retail', start: 'template' } }); c.createWorkspace();
  c.openWizard('vendor'); c.wizSave();
  c.openWizard(); c.wp({ name: 'Store fit-out', key: 'store_fit_out' }); c.wizSave();
  c.setState({ publishReason: 'first go-live' }); c.publishVals().onConfirmPublish();
  save();
  const blob = JSON.parse(localStorage.getItem('wsconfig_v5_custom'));
  // keep only the two custom workspaces (wsData also holds the demo bluetokai stash)
  return { customWs: blob.customWs, data: Object.fromEntries(USER_WS_IDS.map(id => [id, blob.data[id]])) };
}

export const sha = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
/** Fingerprint of the user's workspaces inside a blob (customWs entry + draft data). */
export function userFingerprint(blob) {
  return Object.fromEntries(USER_WS_IDS.map(id => [id, sha([blob.customWs.find(w => w.id === id), blob.data[id]])]));
}

const silent = { info() {}, warn() {} };

/** The real configurator server handler on a random port, backed by the test-only fake NocoBase. */
export async function startCfgServer(initialBlob) {
  const fake = createFakeNocoBase();
  const store = createStore({ loadClient: async () => ({ createClient: () => fake.client }), log: silent, healthTtlMs: 0, failTtlMs: 0, builtinSeeds: null });
  const server = http.createServer(createApp({ store, log: silent }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  if (initialBlob) {
    const g = await fetch(base + '/cfg/state');
    const r = await fetch(base + '/cfg/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': g.headers.get('etag') }, body: JSON.stringify(initialBlob) });
    if (r.status !== 200) throw new Error('seed PUT failed ' + r.status);
  }
  return {
    base, fake, store,
    async state() { const r = await fetch(base + '/cfg/state'); return { blob: await r.json(), etag: r.headers.get('etag') }; },
    async put(blob, etag) { return fetch(base + '/cfg/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) }, body: JSON.stringify(blob) }); },
    close: () => new Promise(r => server.close(r)),
  };
}

function fakeJwt(ttlS = 1800) {
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b({ alg: 'none' }) + '.' + b({ sub: 'platform-admin', exp: Math.floor(Date.now() / 1000) + ttlS, n: randomBytes(6).toString('hex') }) + '.sig';
}

/**
 * Fake Matrix platform API (docs/F4-API.md §1) with switches for failure modes.
 * Credentials are random per test run; tests assert they never appear in any output.
 */
export async function startFakeApp() {
  const creds = { email: 'admin-' + randomBytes(3).toString('hex') + '@example.test', password: 'pw-' + randomBytes(12).toString('hex') };
  const st = {
    logins: 0, tokens: new Set(), workspaces: new Map(), calls: [],
    loginStatus: null, validateErrors: [], publishStatus: null, expireTokens: false,
    // G3 migrations (docs/G3-API.md §1): every POST body received, executed runs, and a failure switch
    // { status: 502 | 500 | 'reset', times: n } applied to the next n POSTs.
    migrationBodies: [], migrations: [], migrateFail: null,
  };
  const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const ch of req) body += ch;
    const data = body ? JSON.parse(body) : null;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    st.calls.push(req.method + ' ' + p);
    if (p === '/api/health') return send(res, 200, { status: 'ok' });
    if (p === '/api/tenancy/admin/login' && req.method === 'POST') {
      st.logins += 1;
      if (st.loginStatus === 429) return send(res, 429, { detail: 'Too many requests. Please wait a moment and try again.' }, { 'Retry-After': '300' });
      if (!data || data.email !== creds.email || data.password !== creds.password) return send(res, 401, { detail: 'Invalid email or password.' });
      const t = fakeJwt(); st.tokens.add(t); return send(res, 200, { token: t, email: creds.email });
    }
    if (!p.startsWith('/api/platform/')) return send(res, 404, { detail: 'not found' });
    const key = req.headers['x-platform-admin-key'];
    if (!key || !st.tokens.has(key) || st.expireTokens) { st.expireTokens = false; st.tokens.clear(); return send(res, 401, { detail: 'Invalid or expired admin token.' }); }
    const mm = /^\/api\/platform\/workspaces\/([^/]+)\/migrations(?:\/([^/]+))?$/.exec(p);
    if (mm) return fakeMigrations(req, res, decodeURIComponent(mm[1]), mm[2], data);
    const m = /^\/api\/platform\/workspaces(?:\/([^/]+))?(?:\/releases(?:\/(validate|\d+))?)?$/.exec(p);
    if (!m) return send(res, 404, { detail: 'not found' });
    const ref = m[1] && decodeURIComponent(m[1]);
    const ws = ref ? st.workspaces.get(ref) : null;
    const summary = w => ({ configurator_ref: w.ref, status: w.status, tenant_id: w.tenant_id, company: w.company, workspace_code: w.code, seat_limit: w.seat_limit, used_seats: 1, live_release: w.releases.length ? { id: w.releases.at(-1).id, version: w.releases.length } : null, release_count: w.releases.length, last_error: null });
    if (!ref && req.method === 'GET') return send(res, 200, { items: [...st.workspaces.values()].map(summary), total: st.workspaces.size });
    if (!ref && req.method === 'POST') {
      if (st.workspaces.has(data.configurator_ref)) { const w = st.workspaces.get(data.configurator_ref); return send(res, 409, { detail: 'already provisioned', code: 'already_provisioned', configurator_ref: w.ref, tenant_id: w.tenant_id, workspace_code: w.code }); }
      if (!/@/.test(data.admin_email || '')) return send(res, 422, { detail: [{ loc: ['body', 'admin_email'], msg: 'invalid email' }] });
      const w = { ref: data.configurator_ref, status: 'active', tenant_id: 't-' + randomBytes(4).toString('hex'), company: data.company, code: 'FAKE-' + randomBytes(4).toString('hex').toUpperCase(), seat_limit: data.seat_limit || 10, admin_email: data.admin_email, releases: [], setup: 'setup-' + randomBytes(10).toString('hex') };
      st.workspaces.set(w.ref, w);
      return send(res, 201, { configurator_ref: w.ref, tenant_id: w.tenant_id, workspace_code: w.code, seat_limit: w.seat_limit, business_admin_id: 'ba-1', admin_email: w.admin_email, admin_setup_token: w.setup, workspace_request_id: 'wr-1', live_release: null, message: 'Provisioned.' });
    }
    if (ref && !m[2] && req.method === 'GET' && !p.endsWith('/releases')) {
      if (!ws) return send(res, 404, { detail: 'not linked' });
      return send(res, 200, { ...summary(ws), releases: ws.releases.map((r, i) => ({ ...r, version: i + 1, is_live: i === ws.releases.length - 1 })).reverse(), modules: ws.modules || [], business_admin: { email: ws.admin_email, name: null, has_password: false } });
    }
    if (m[2] === 'validate' && req.method === 'POST') {
      const errs = schemaValidate(MANIFEST_SCHEMA, data.manifest, MANIFEST_SCHEMA).map(e => ({ severity: 'error', code: 'schema', message: e }));
      const findings = errs.concat(st.validateErrors);
      return send(res, 200, { ok: !findings.some(f => f.severity === 'error'), errors: findings.filter(f => f.severity === 'error').length, warnings: findings.filter(f => f.severity !== 'error').length, findings, modules: (data.manifest.modules || []).map(x => ({ key: x.key, manifest_key: x.key, kind: x.type, enabled: x.enabled })) });
    }
    if (p.endsWith('/releases') && req.method === 'POST') {
      if (!ws) return send(res, 404, { detail: 'Provision it first' });
      if (st.publishStatus === 422) { st.publishStatus = null; return send(res, 422, { detail: 'manifest invalid', code: 'manifest_invalid', findings: [{ severity: 'error', code: 'schema', message: 'forced' }] }); }
      const rel = { id: 'rel-' + randomBytes(4).toString('hex'), manifest: data.manifest, manifest_sha256: createHash('sha256').update(JSON.stringify(data.manifest)).digest('hex'), published_by: creds.email, reason: data.reason || null, source_ref: data.source_ref || null, created_at: new Date().toISOString() };
      ws.releases.push(rel);
      ws.modules = data.manifest.modules.map((x, i) => ({ key: x.key === 'pex' ? 'project_excellence' : x.key, label: x.name, kind: x.type, position: (i + 1) * 10, enabled: x.enabled, supervisor_only: !x.tiers.executive, route: x.type === 'custom' ? '/m/' + x.key : x.route }));
      return send(res, 201, { configurator_ref: ws.ref, tenant_id: ws.tenant_id, release: { id: rel.id, version: ws.releases.length, manifest_sha256: rel.manifest_sha256, published_by: rel.published_by, reason: rel.reason, source_ref: rel.source_ref, created_at: rel.created_at }, findings: [], modules: ws.modules });
    }
    return send(res, 404, { detail: 'not found' });
  });

  // Fake of POST/GET …/migrations with the app's shapes: three cases on the workspace — a finished one
  // (stays), a compatible running one, and a blocked running one (stage_missing; skipped on execute).
  function fakeMigrations(req, res, ref, id, data) {
    const w = st.workspaces.get(ref);
    if (!w) return send(res, 404, { detail: `No workspace is linked to configurator id '${ref}'.` });
    if (w.status !== 'active') return send(res, 409, { detail: `Workspace '${ref}' is ${w.status}.`, code: 'workspace_not_active' });
    const mine = st.migrations.filter(x => x.ref === ref).map(({ ref: _r, ...x }) => x);
    if (req.method === 'GET' && !id) return send(res, 200, { items: mine.reverse().map(({ items, ...head }) => head) });
    if (req.method === 'GET') { const x = mine.find(y => y.id === id); return x ? send(res, 200, x) : send(res, 404, { detail: 'Migration not found.' }); }
    if (req.method !== 'POST' || id) return send(res, 405, { detail: 'method not allowed' });
    st.migrationBodies.push(data);
    const f = st.migrateFail;
    if (f && f.times-- > 0) { if (f.status === 'reset') return req.socket.destroy(); return send(res, f.status, { detail: 'forced failure' }); }
    const allowed = ['from_release_version', 'to_release_version', 'scope', 'reason', 'dry_run', 'stage_map', 'restart_stage_on_chain_change'];
    const extra = Object.keys(data || {}).filter(k => !allowed.includes(k));
    if (extra.length) return send(res, 422, { detail: extra.map(k => ({ loc: ['body', k], msg: 'Extra inputs are not permitted' })) });
    const dryRun = data.dry_run !== false;
    const reason = String(data.reason || '').trim();
    if (!dryRun && reason.length < 3) return send(res, 422, { detail: 'A reason (at least 3 characters) is required to migrate running cases.', code: 'reason_required' });
    const nRel = w.releases.length;
    if (!nRel) return send(res, 409, { detail: 'This workspace has no published release.', code: 'no_release' });
    const to = data.to_release_version || nRel;
    if (to > nRel) return send(res, 404, { detail: `Release v${to} does not exist.`, code: 'unknown_release' });
    const from = data.from_release_version || 'all_older';
    if (from !== 'all_older' && from > nRel) return send(res, 404, { detail: `Release v${from} does not exist.`, code: 'unknown_release' });
    if (from === to) return send(res, 422, { detail: 'The source and target release are the same.', code: 'same_release' });
    const versions = from === 'all_older' ? Array.from({ length: to - 1 }, (_, i) => i + 1) : [from];
    const scope = data.scope || {};
    const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const signOff = { order: 3, name: 'Sign-off', step: 0, role: 'supervisor', chain: ['supervisor'], restricted_to: null };
    const none = { kept: [], dropped: [], kind_changed: [], new_required: [] };
    const item = (n, name, fromV, status, outcome, extra = {}) => ({
      record_id: uuid(n), module_key: 'vendor_onboarding', site: { id: uuid(100 + n), name, code: 'BT-FAKE-' + n },
      from_version: fromV, to_version: to, case_status: status, in_flight: status === 'in_progress',
      compatible: ['would_migrate', 'migrated'].includes(outcome), co_migrated: false, outcome, blocking: [], warnings: [],
      stage: { before: null, after: null }, stage_mapping: [], fields: none, approvals_carried: 0, message: null, ...extra,
    });
    let items = [
      item(1, 'Site One', 1, 'completed', 'not_in_flight', { blocking: [{ code: 'not_in_flight', message: 'The case is completed; finished cases keep their release.' }] }),
      item(2, 'Site Two', 1, 'in_progress', dryRun ? 'would_migrate' : 'migrated', {
        stage: { before: signOff, after: signOff }, approvals_carried: 2,
        warnings: [{ code: 'fields_dropped', message: 'Values of fields the target no longer has are removed from the live case.' }],
        fields: { ...none, kept: [{ stage: 1, field: 'vendor_name' }], dropped: [{ stage: 1, field: 'old_note' }] },
      }),
      item(3, 'Site Three', 1, 'in_progress', dryRun ? 'blocked' : 'skipped', {
        stage: { before: signOff, after: null },
        blocking: [{ code: 'stage_missing', message: `Current stage 3 “Sign-off” has no counterpart in v${to}.`, stage: 3 }],
        ...(dryRun ? {} : { message: 'incompatible at execution time' }),
      }),
    ].filter(i => versions.includes(i.from_version));
    if (scope.module_keys && !scope.module_keys.includes('vendor_onboarding')) items = [];
    if (scope.record_ids) items = items.filter(i => scope.record_ids.includes(i.record_id));
    const by = {};
    for (const i of items) by[i.outcome] = (by[i.outcome] || 0) + 1;
    const summary = { records: items.length, sites: new Set(items.map(i => i.site.id)).size, compatible: items.filter(i => i.compatible).length, blocked: items.filter(i => i.in_flight && !i.compatible).length, by_outcome: by };
    const options = { stage_map: data.stage_map || {}, restart_stage_on_chain_change: !!data.restart_stage_on_chain_change };
    const head = { configurator_ref: ref, tenant_id: w.tenant_id, dry_run: dryRun, from: { spec: from === 'all_older' ? 'all_older' : 'v' + from, versions }, to: { id: 'rel-' + to, version: to }, scope, options, reason: reason || null, actor: creds.email };
    if (dryRun) return send(res, 200, { ...head, migration_id: null, summary, items });
    const migId = '11111111-2222-4333-8444-' + String(st.migrations.length + 1).padStart(12, '0');
    const at = new Date().toISOString();
    const moved = items.filter(i => i.outcome === 'migrated');
    st.migrations.push({
      ref, id: migId, from: head.from.spec, to_version: to, scope: { ...scope, options }, reason, actor: creds.email, status: 'done', summary, created_at: at, finished_at: at,
      items: moved.flatMap(i => [
        { site_id: i.site.id, record_id: null, module_key: null, from_version: i.from_version, before_stage: null, after_stage: null, before_state: null, plan: {}, at },
        { site_id: i.site.id, record_id: i.record_id, module_key: i.module_key, from_version: i.from_version, before_stage: i.stage.before, after_stage: i.stage.after, before_state: { values: { vendor_name: 'Acme', old_note: 'PRE-STATE-MARKER' } }, plan: {}, at },
      ]),
    });
    return send(res, 200, { ...head, migration_id: migId, summary, items });
  }

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { base, creds, st, close: () => new Promise(r => server.close(r)) };
}

/** Env for a context / child process pointing at the fakes. */
export function envFor(cfg, app, extra = {}) {
  return {
    CFG_URL: cfg ? cfg.base : 'http://127.0.0.1:1',
    MATRIX_API_URL: app ? app.base : 'http://127.0.0.1:1/api',
    MATRIX_PLATFORM_ADMIN_EMAIL: app ? app.creds.email : '',
    MATRIX_PLATFORM_ADMIN_PASSWORD: app ? app.creds.password : '',
    MATRIX_APP_ENV_FILE: '/nonexistent',
    MATRIX_APP_URL: 'http://localhost:5173',
    CFG_AGENT_NAME: 'test-agent',
    ...extra,
  };
}

#!/usr/bin/env node
// Backend proof of the CONFIGURATOR journey (Phase 2, F4a). Zero dependencies.
//
//   node app-stack/smoke-configurator.mjs          (backend must be up: ./start.sh)
//   API=http://localhost:8000/api node app-stack/smoke-configurator.mjs
//
// Journey: platform-admin login -> build a v5 workspace manifest (the Starbucks seed from
// building-blocks/from-design/seed-workspaces.json, which DISABLES the built-ins `design` and
// `pex`, plus a custom module derived from the wizard "Vendor onboarding" template: 2 stages,
// executive -> SUPERVISOR approval, supervisor -> business-admin sign-off, entry gate on the
// built-in BD outcome "in progress") -> publish checks refuse a broken manifest -> provision the
// workspace through the app's own approval path -> publish v1 -> workspace-code check (real vs
// fake) -> SEC-1 (F5a): the unclaimed BA cannot be claimed without the setup code; the platform
// admin re-issues the code (the old one stops working) -> BA sets password WITH the new setup code
// -> BA login -> data-driven modules -> BA onboards a supervisor + executive INTO THE CUSTOM
// MODULE (codes, signup with their own password, approval, login with the module claim) -> the disabled built-in is refused -> create a site -> the gate refuses ->
// BD shortlist -> open the case -> executive submits -> supervisor sends back -> resubmit ->
// supervisor approves -> stage 2 -> business-admin sign-off -> case completes -> publish v2 ->
// the old case stays on v1 while a new site runs v2 -> business-admin override is flagged ->
// audit trail carries release provenance and an intact hash chain.
//
// Evidence (no tokens / passwords / setup codes): app-stack/run/smoke/configurator-last-run.json;
// test users' passwords: run/smoke/configurator-last-run.secrets.json (mode 600).
// Rate limits: uses 3x password-reset/complete, 1x password-setup, 2x signup, ~12 logins — restart
// the backend between smoke runs (./stop.sh --apps && ./start.sh) to reset the in-memory windows.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const API = (process.env.API || 'http://localhost:8000/api').replace(/\/$/, '');
const ORIGIN = process.env.ORIGIN || 'http://localhost:5173';
const OUT_DIR = path.join(HERE, 'run', 'smoke');

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const benv = readEnv(path.join(ROOT, 'app', 'backend', '.env'));
const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'building-blocks', 'from-design', 'seed-workspaces.json'), 'utf8'));

const steps = [];
let failed = 0;
function record(name, ok, detail) {
  steps.push({ step: name, ok, ...detail });
  if (!ok) failed += 1;
  const d = Object.entries(detail).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${d}`);
}
async function call(method, p, { body, token, admin, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (admin) h['X-Platform-Admin-Key'] = admin;
  const res = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  const txt = await res.text();
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (res.status === 429) console.log(`\n429 rate-limited on ${method} ${p} — restart the backend (./stop.sh --apps && ./start.sh).`);
  return { status: res.status, data };
}
// F5a: multipart upload of a file for a custom-module file field.
async function upload(p, { token, field, name, type, bytes }) {
  const fd = new FormData();
  fd.append('field', field);
  fd.append('file', new Blob([bytes], { type }), name);
  const res = await fetch(`${API}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  let data = null;
  const txt = await res.text();
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  return { status: res.status, data };
}
const expect = (name, r, want, extra = {}, cond = true) =>
  record(name, r.status === want && cond, { status: r.status, want, ...extra, ...(r.status !== want || !cond ? { detail: r.data?.detail ?? r.data, code: r.data?.code } : {}) });
const internal = { 'X-Matrix-Internal': '1', Origin: ORIGIN };
const pw = () => `Cfg-${crypto.randomBytes(9).toString('base64url')}`;
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── the workspace manifest (v5 shape) ────────────────────────────────────────
function vendorModule({ v2 = false } = {}) {
  const t = clone(seeds.wizardTemplates.vendor.manifest); // moduleDraftManifest (wizard step 9)
  const stages = clone(t.stages);
  stages[0].approvers = ['executive', 'supervisor'];          // executive submits, SUPERVISOR approves
  stages[1].approvers = v2 ? ['supervisor'] : ['supervisor', 'business_admin'];
  // F5a: the template's optional `msme_certificate` file field (pdf · max 10MB) is kept — uploads work now.
  if (v2) stages[1].fields.push({ key: 'payment_terms', label: 'Payment terms', kind: 'choice', required: true, validation: 'advance · net 30 · net 60', affects_outcome: false });
  return {
    key: t.module.key, name: t.module.name, type: 'custom', enabled: true, route: t.module.route, state: 'live',
    tiers: clone(t.tiers),
    entry_gate: { match: 'all', conditions: [{ source: 'bd', outcome: 'in progress' }],
                  refusal_message: 'Vendor onboarding is locked: waiting for the BD shortlist.' },
    stages, rollup: clone(t.rollup), exit_signal: t.exit_signal, navigation: [],
  };
}
function workspaceManifest(ref, company, opts = {}) {
  const m = clone(seeds.workspaces.starbucks.manifest);
  m.workspace = { id: ref, name: company, slug: ref.replace(/_/g, '-').slice(0, 31), live_version: opts.v2 ? 'v1' : 'v0', draft_version: opts.v2 ? 'v2' : 'v1' };
  m.modules.push(vendorModule(opts));
  // F5a: v2 also switches three built-ins OFF whose routes used to check role only.
  if (opts.v2) for (const mod of m.modules) if (['finance_ca', 'launch_approval', 'financial_closure'].includes(mod.key)) mod.enabled = false;
  return m;
}

async function main() {
  const run = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const ref = `ws_smoke_${run}`;
  const company = `Configurator Smoke ${run}`;
  const baEmail = `cfg.ba.${run}@example.com`;
  const supEmail = `cfg.sup.${run}@example.com`;
  const execEmail = `cfg.exec.${run}@example.com`;
  const secrets = { ba: { email: baEmail, password: pw() }, supervisor: { email: supEmail, password: pw() }, executive: { email: execEmail, password: pw() } };
  const MOD = 'vendor_onboarding';
  console.log(`API ${API}  run ${run}  configurator_ref ${ref}\n`);

  let r = await call('GET', '/health'); expect('health', r, 200);

  // 1. platform admin
  r = await call('POST', '/tenancy/admin/login', { body: { email: benv.PLATFORM_ADMIN_EMAIL, password: benv.PLATFORM_ADMIN_PASSWORD } });
  expect('platform-admin login', r, 200);
  const admin = r.data?.token;
  r = await call('GET', '/platform/workspaces', { admin: 'not-a-jwt' });
  expect('platform API rejects a bad X-Platform-Admin-Key (401)', r, 401);

  // 2. publish checks (dry run + refusal) before anything exists
  const v1 = workspaceManifest(ref, company);
  const broken = clone(v1);
  broken.modules.find((m) => m.key === MOD).entry_gate.conditions.push({ source: 'no_such_module', outcome: 'done' });
  r = await call('POST', `/platform/workspaces/${ref}/releases/validate`, { admin, body: { manifest: v1 } });
  expect('validate v1 manifest (dry run) -> ok', r, 200, { errors: r.data?.errors, warnings: r.data?.warnings }, r.data?.ok === true);
  r = await call('POST', `/platform/workspaces/${ref}/releases/validate`, { admin, body: { manifest: broken } });
  expect('validate broken manifest -> errors listed', r, 200,
    { errors: r.data?.errors, codes: [...new Set((r.data?.findings || []).filter((f) => f.severity === 'error').map((f) => f.code))] },
    r.data?.ok === false && (r.data?.findings || []).some((f) => f.code === 'gate_unknown_source'));

  // 3. provision (the app's own request + approve path)
  r = await call('POST', '/platform/workspaces', { admin, body: { configurator_ref: ref, company, admin_email: baEmail, admin_name: 'Cfg BA', seat_limit: 25, city: 'Mumbai' } });
  const ws = r.data || {};
  expect('provision workspace from configurator', r, 201, { workspace_code: ws.workspace_code, setup_code_returned: Boolean(ws.admin_setup_token) },
    Boolean(ws.tenant_id && ws.workspace_code && ws.admin_setup_token));
  const code = ws.workspace_code;
  r = await call('POST', '/platform/workspaces', { admin, body: { configurator_ref: ref, company, admin_email: baEmail } });
  expect('provision again with the same configurator_ref -> 409 (idempotent, no new tenant)', r, 409,
    { code: r.data?.code }, r.data?.code === 'already_provisioned' && r.data?.tenant_id === ws.tenant_id && !r.data?.admin_setup_token);
  r = await call('GET', '/tenancy/requests?status_filter=approved', { admin });
  expect('provisioned via a normal (approved) workspace request', r, 200, {}, (r.data?.items || []).some((i) => i.id === ws.workspace_request_id && i.status === 'approved'));

  // 4. publish v1
  r = await call('POST', `/platform/workspaces/${ref}/releases`, { admin, body: { manifest: broken, reason: 'should be refused' } });
  expect('publish refuses a manifest with errors (422 + findings)', r, 422, { code: r.data?.code }, r.data?.code === 'manifest_invalid' && Array.isArray(r.data?.findings));
  r = await call('POST', `/platform/workspaces/${ref}/releases`, { admin, body: { manifest: v1, reason: 'initial configuration', source_ref: 'nocobase-cfg-release-1' } });
  const rel1 = r.data?.release || {};
  const mods1 = r.data?.modules || [];
  expect('publish v1', r, 201, { version: rel1.version, published_by: rel1.published_by, warnings: (r.data?.findings || []).length },
    rel1.version === 1 && rel1.published_by === benv.PLATFORM_ADMIN_EMAIL);
  expect('v1 projected onto tenant_modules (design + pex OFF, vendor_onboarding custom ON)', { status: 200 }, 200,
    { design: mods1.find((m) => m.key === 'design')?.enabled, project_excellence: mods1.find((m) => m.key === 'project_excellence')?.enabled, [MOD]: mods1.find((m) => m.key === MOD)?.kind },
    mods1.find((m) => m.key === 'design')?.enabled === false && mods1.find((m) => m.key === MOD)?.enabled === true && mods1.find((m) => m.key === MOD)?.kind === 'custom');
  r = await call('GET', `/platform/workspaces/${ref}`, { admin });
  expect('platform workspace detail: active, live v1, history', r, 200, { ws_status: r.data?.status, live: r.data?.live_release?.version, releases: (r.data?.releases || []).length },
    r.data?.status === 'active' && r.data?.live_release?.version === 1 && r.data?.workspace_code === code);
  r = await call('GET', '/platform/workspaces', { admin });
  expect('platform workspace list includes it', r, 200, {}, (r.data?.items || []).some((i) => i.configurator_ref === ref));

  // 5. workspace-code authenticity
  const bogus = `${code.split('-')[0]}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  r = await call('GET', `/tenancy/branding?code=${encodeURIComponent(code)}`);
  expect('branding(real code) -> company', r, 200, { name: r.data?.name }, r.data?.name === company);
  r = await call('GET', `/tenancy/branding?code=${encodeURIComponent(bogus)}`);
  expect('branding(fake code) -> no name', r, 200, {}, r.data?.name === null);
  r = await call('POST', '/auth/login/check', { body: { email: baEmail, workspace_code: code }, headers: internal });
  expect('login/check(real code) -> needs_password', r, 200, { state: r.data?.account_state }, r.data?.account_state === 'needs_password');
  r = await call('POST', '/auth/login/check', { body: { email: baEmail, workspace_code: bogus }, headers: internal });
  expect('login/check(fake code) -> unknown', r, 200, { state: r.data?.account_state }, r.data?.account_state === 'unknown');

  // 6. SEC-1 (F5a): (email, workspace code) alone no longer claims the unclaimed BA
  r = await call('POST', '/auth/password-setup', { body: { email: baEmail, workspace_code: code, new_password: `x-${crypto.randomBytes(6).toString('hex')}` } });
  expect('SEC-1: claim unclaimed BA via password-setup WITHOUT setup code -> 422', r, 422);
  //    the platform admin re-issues the setup code (e.g. the first one was lost): old code dies
  r = await call('POST', `/platform/workspaces/${ref}/admin-setup-code`, { admin });
  expect('platform admin re-issues the BA setup code', r, 200, { admin_email: r.data?.admin_email, expires_at: r.data?.expires_at },
    Boolean(r.data?.admin_setup_token) && r.data?.admin_setup_token !== ws.admin_setup_token && r.data?.admin_email === baEmail);
  const setupCode = r.data?.admin_setup_token;
  r = await call('POST', '/auth/password-reset/complete', { body: { email: baEmail, workspace_code: code, new_password: secrets.ba.password, reset_token: ws.admin_setup_token } });
  expect('superseded (first) setup code no longer works -> 403', r, 403);
  //    BA claims the account WITH the (new) setup code
  r = await call('POST', '/auth/password-reset/complete', { body: { email: baEmail, workspace_code: code, new_password: secrets.ba.password, reset_token: 'wrong-setup-code' } });
  expect('BA set password with WRONG setup code -> 403', r, 403);
  r = await call('POST', '/auth/password-reset/complete', { body: { email: baEmail, workspace_code: code, new_password: secrets.ba.password, reset_token: setupCode } });
  expect('BA set password with the setup code', r, 200);
  r = await call('POST', `/platform/workspaces/${ref}/admin-setup-code`, { admin });
  expect('re-issue refused once the BA has claimed the account (409)', r, 409);
  r = await call('POST', '/auth/login', { body: { email: baEmail, workspace_code: code, password: secrets.ba.password } });
  expect('BA login', r, 200, { role: r.data?.user?.role }, r.data?.user?.role === 'business_admin');
  const baTok = r.data?.access_token;

  // 7. data-driven modules
  r = await call('GET', '/workspace/modules', { token: baTok });
  const navKeys = (r.data?.modules || []).map((m) => m.key);
  const vend = (r.data?.modules || []).find((m) => m.key === MOD) || {};
  const bdNav = (r.data?.modules || []).find((m) => m.key === 'bd') || {};
  expect('GET /workspace/modules: live v1, custom module routed to /m/<key>, design hidden, labels + navigation from the manifest', r, 200,
    { release: r.data?.release?.version, modules: navKeys.join(','), bd_label: bdNav.label, bd_route: bdNav.route },
    r.data?.release?.version === 1 && vend.kind === 'custom' && vend.route === `/m/${MOD}` && !navKeys.includes('design')
      && !navKeys.includes('project_excellence') && bdNav.route === '/' && (bdNav.navigation || []).length > 0);
  r = await call('GET', '/business-admin/org', { token: baTok });
  const orgKeys = (r.data?.modules || []).map((m) => m.module);
  expect('BA org view: custom department present, disabled design absent', r, 200, { departments: orgKeys.join(',') },
    orgKeys.includes(MOD) && !orgKeys.includes('design') && orgKeys.includes('bd'));
  r = await call('POST', '/business-admin/dept-codes/design/rotate', { token: baTok });
  expect('disabled built-in mints no department code (403)', r, 403);

  // 8. onboarding INTO the custom module
  r = await call('POST', `/business-admin/dept-codes/${MOD}/rotate`, { token: baTok });
  expect('BA mints the custom module department code', r, 200, { module: r.data?.module }, r.data?.module === MOD && Boolean(r.data?.code));
  const deptCode = r.data?.code;
  r = await call('POST', '/auth/signup/supervisor', { body: { email: supEmail, dept_code: deptCode, password: secrets.supervisor.password } });
  expect('supervisor signup (custom module code + own password)', r, 202);
  const supId = r.data?.user_id;
  r = await call('GET', '/business-admin/pending-supervisors', { token: baTok });
  expect('BA sees the pending supervisor under the custom module', r, 200, {}, (r.data || []).some((s) => s.id === supId && s.module === MOD));
  r = await call('POST', `/business-admin/pending-supervisors/${supId}/approve`, { token: baTok, body: { module: MOD } });
  expect('BA approves supervisor into the custom module', r, 204);
  r = await call('POST', '/auth/login', { body: { email: supEmail, workspace_code: code, password: secrets.supervisor.password } });
  expect('supervisor login', r, 200, { role: r.data?.user?.role }, r.data?.user?.role === 'supervisor');
  const supTok = r.data?.access_token;
  r = await call('GET', '/auth/whoami', { token: supTok });
  expect('supervisor whoami carries the custom module claim', r, 200, { module: r.data?.module, module_role: r.data?.module_role }, r.data?.module === MOD && r.data?.module_role === 'supervisor');
  r = await call('POST', `/supervisor-codes/me/${MOD}/rotate`, { token: supTok });
  expect('supervisor mints a custom-module invite code', r, 200, {}, r.data?.module === MOD && Boolean(r.data?.code));
  const invite = r.data?.code;
  r = await call('POST', '/auth/signup/executive', { body: { email: execEmail, supervisor_code: invite, password: secrets.executive.password } });
  expect('executive signup (supervisor code + own password)', r, 202);
  const execId = r.data?.user_id;
  r = await call('POST', `/supervisor-codes/me/pending-executives/${execId}/approve?module=${MOD}`, { token: supTok });
  expect('supervisor approves executive into the custom module', r, 204);
  r = await call('POST', '/auth/login', { body: { email: execEmail, workspace_code: code, password: secrets.executive.password } });
  expect('executive login', r, 200, { role: r.data?.user?.role }, r.data?.user?.role === 'executive');
  const execTok = r.data?.access_token;
  r = await call('GET', '/auth/whoami', { token: execTok });
  expect('executive whoami: custom module claim + reports to the supervisor', r, 200, { module: r.data?.module },
    r.data?.module === MOD && r.data?.supervisor_id === supId);

  // 9. the disabled built-in is refused (require_module, every role)
  r = await call('GET', '/design/queue', { token: baTok });
  expect('disabled built-in (design) refused for the business admin (403)', r, 403, { detail: r.data?.detail });
  r = await call('GET', '/design/queue', { token: supTok });
  expect('disabled built-in (design) refused for a supervisor (403)', r, 403);
  r = await call('GET', '/project-excellence/budget-admin-queue', { token: baTok });
  expect('F5a: business-admin tier of a disabled built-in (pex budget queue) refused (403)', r, 403, { detail: r.data?.detail });

  // 10. a site; the entry gate on the built-in BD outcome
  r = await call('POST', '/bd/drafts', { token: baTok, body: { name: `Cfg Site A ${run}`, city: 'Mumbai', visit_date: '2026-10-04' } });
  expect('create site (BD draft)', r, 201, { site_status: r.data?.status });
  const siteA = r.data?.id;
  r = await call('GET', `/m/${MOD}/records?site_id=${siteA}`, { token: supTok });
  expect('site gate preview: locked, BD "in progress" unmet', r, 200, { can_open: r.data?.site_gate?.can_open, reached_bd: r.data?.site_gate?.gate?.conditions?.[0]?.reached },
    r.data?.site_gate?.can_open === false && r.data?.site_gate?.reason === 'gate_closed' && r.data?.site_gate?.release_version === 1);
  r = await call('POST', `/m/${MOD}/records`, { token: supTok, body: { site_id: siteA } });
  expect('open case refused while the entry gate is closed (409 gate_closed, explains)', r, 409,
    { code: r.data?.code, detail: r.data?.detail, unmet: (r.data?.gate?.conditions || []).filter((c) => !c.met).map((c) => `${c.source}:${c.outcome}`) },
    r.data?.code === 'gate_closed' && (r.data?.gate?.conditions || []).some((c) => c.source === 'bd' && !c.met));
  r = await call('POST', `/bd/drafts/${siteA}/shortlist`, { token: baTok });
  expect('BD shortlist (built-in moves to "in progress")', r, 200, { site_status: r.data?.status });
  r = await call('POST', `/m/${MOD}/records`, { token: supTok, body: { site_id: siteA } });
  const rec = r.data?.record || {};
  expect('open case once the gate is open (pinned to v1)', r, 201,
    { release: r.data?.release?.version, next: r.data?.next_step?.role, form_fields: Object.keys(r.data?.next_step?.form?.schema?.properties || {}).join(',') },
    r.data?.release?.version === 1 && r.data?.next_step?.role === 'executive' && r.data?.gate?.open === true);
  const recId = rec.id;
  r = await call('POST', `/m/${MOD}/records`, { token: supTok, body: { site_id: siteA } });
  expect('second open on the same site -> 409 record_exists', r, 409, { code: r.data?.code }, r.data?.code === 'record_exists');

  // 11. tier flow
  r = await call('POST', `/m/${MOD}/records/${recId}/actions`, { token: execTok, body: { action: 'submit', values: { vendor_name: 'Acme', gst_number: '27ABCDE1234F1Z5' } } });
  expect('executive without a delegation is refused (403 no_delegation)', r, 403, { code: r.data?.code }, r.data?.code === 'no_delegation');
  r = await call('GET', `/m/${MOD}/members`, { token: supTok });
  expect('module members (assign picker) list the executive', r, 200, { members: (r.data?.items || []).map((m) => m.role_in_module).join(',') },
    (r.data?.items || []).some((m) => m.id === execId && m.role_in_module === 'executive'));
  r = await call('POST', `/m/${MOD}/records/${recId}/assign`, { token: supTok, body: { executive_id: execId } });
  expect('supervisor assigns the case to the executive', r, 200, {}, r.data?.record?.assigned_to === execId);
  r = await call('POST', `/m/${MOD}/records/${recId}/actions`, { token: execTok, body: { action: 'submit', values: { vendor_name: 'Acme', gst_number: 'not-a-gst' } } });
  expect('invalid form refused by the backend (422 invalid_form + errors)', r, 422, { code: r.data?.code, errors: r.data?.errors }, r.data?.code === 'invalid_form' && (r.data?.errors || []).length > 0);
  r = await call('POST', `/m/${MOD}/records/${recId}/actions`, { token: execTok, body: { action: 'submit', values: { vendor_name: 'Acme Supplies', gst_number: '27ABCDE1234F1Z5' } } });
  expect('executive submits stage 1', r, 200, { next: r.data?.next_step?.role, stage1: r.data?.stages?.[0]?.state }, r.data?.next_step?.role === 'supervisor');
  r = await call('POST', `/m/${MOD}/records/${recId}/actions`, { token: execTok, body: { action: 'approve' } });
  // the runtime checks separation of duties (same person, other tier, same stage pass) before the tier itself
  expect('executive cannot approve their own submission / the supervisor step (403)', r, 403, { code: r.data?.code },
    ['separation_of_duties', 'wrong_tier'].includes(r.data?.code));
  r = await call('POST', `/m/${MOD}/records/${recId}/actions`, { token: supTok, body: { action: 'send_back' } });
  expect('send back without a reason -> 422 reason_required', r, 422, { code: r.data?.code }, r.data?.code === 'reason_required');
  r = await call('POST', `/m/${MOD}/records/${recId}/actions`, { token: supTok, body: { action: 'send_back', note: 'GST certificate name differs — please recheck' } });
  expect('supervisor sends stage 1 back', r, 200, { next: r.data?.next_step?.role }, r.data?.next_step?.role === 'executive');
  const seqNow = r.data?.record?.seq;
  r = await call('POST', `/m/${MOD}/records/${recId}/actions`, { token: execTok, body: { action: 'submit', expected_seq: seqNow - 1, values: { vendor_name: 'Acme Supplies Pvt Ltd', gst_number: '27ABCDE1234F1Z5' } } });
  expect('stale expected_seq refused (409 stale)', r, 409, { code: r.data?.code }, r.data?.code === 'stale');
  r = await call('POST', `/m/${MOD}/records/${recId}/actions`, { token: execTok, body: { action: 'submit', expected_seq: seqNow, values: { vendor_name: 'Acme Supplies Pvt Ltd', gst_number: '27ABCDE1234F1Z5' } } });
  expect('executive resubmits stage 1', r, 200, {}, r.data?.next_step?.role === 'supervisor');
  r = await call('POST', `/m/${MOD}/records/${recId}/actions`, { token: supTok, body: { action: 'approve' } });
  expect('supervisor approves stage 1 -> stage 2', r, 200, { stage: r.data?.record?.current_stage, next: r.data?.next_step?.role, kind: r.data?.next_step?.kind },
    r.data?.record?.current_stage === 2 && r.data?.next_step?.role === 'supervisor' && r.data?.next_step?.kind === 'submit');
  // F5a: the stage-2 file field — validated, stored in the app's storage, referenced by id, tenant/record-bound
  const filesUrl = `/m/${MOD}/records/${recId}/files`;
  const pdfBytes = Buffer.from(`%PDF-1.4\n% F5a smoke MSME certificate ${run}\n%%EOF\n`);
  r = await upload(filesUrl, { token: supTok, field: 'msme_certificate', name: 'msme.png', type: 'image/png',
    bytes: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') });
  expect('F5a file field refuses a type outside its hint (png for a pdf field -> 415)', r, 415, { code: r.data?.code }, r.data?.code === 'file_type');
  r = await upload(filesUrl, { token: execTok, field: 'msme_certificate', name: 'msme.pdf', type: 'application/pdf', bytes: pdfBytes });
  expect('F5a only whoever may submit the step uploads (executive on the supervisor step -> 403)', r, 403, { code: r.data?.code });
  r = await upload(filesUrl, { token: supTok, field: 'credit_days', name: 'msme.pdf', type: 'application/pdf', bytes: pdfBytes });
  expect('F5a upload only for a file field of the current step (422)', r, 422, { code: r.data?.code }, r.data?.code === 'unknown_field');
  r = await upload(filesUrl, { token: supTok, field: 'msme_certificate', name: 'msme.pdf', type: 'application/pdf', bytes: pdfBytes });
  const upl = r.data || {};
  expect('F5a supervisor uploads the MSME certificate (pdf) -> file id', r, 201, { size: upl.size, stage: upl.stage },
    Boolean(upl.id) && upl.stage === 2 && upl.size === pdfBytes.length && upl.sha256 === crypto.createHash('sha256').update(pdfBytes).digest('hex'));
  r = await call('POST', `/m/${MOD}/records/${recId}/actions`, { token: supTok, body: { action: 'submit', values: { credit_days: 45, msme_certificate: 'see email' } } });
  expect('F5a a typed reference instead of an uploaded file is refused (422 invalid_form)', r, 422, { errors: r.data?.errors },
    r.data?.code === 'invalid_form' && (r.data?.errors || []).some((e) => e.startsWith('msme_certificate:')));
  r = await call('POST', `/m/${MOD}/records/${recId}/actions`, { token: supTok, body: { action: 'submit', values: { credit_days: 45, msme_certificate: upl.id } } });
  expect('supervisor submits stage 2 (with the uploaded file)', r, 200, { next: r.data?.next_step?.role },
    r.data?.next_step?.role === 'business_admin' && r.data?.stages?.[1]?.field_values?.msme_certificate === upl.id
      && r.data?.files?.[upl.id]?.file_name === 'msme.pdf' && (r.data?.audit || []).some((a) => a.action === 'module_file_uploaded'));
  r = await call('GET', `/m/${MOD}/files/${upl.id}`, { token: execTok });
  const dl = r.ok !== false && r.data?.url ? await fetch(r.data.url) : null;
  const dlBytes = dl ? Buffer.from(await dl.arrayBuffer()) : Buffer.alloc(0);
  expect('F5a the case\'s executive downloads it through a short-lived signed URL (same bytes)', r, 200,
    { file: r.data?.file_name, download: dl?.status }, dl?.status === 200 && dlBytes.equals(pdfBytes));
  r = await call('POST', `/m/${MOD}/records/${recId}/actions`, { token: baTok, body: { action: 'approve' } });
  const done1 = r.data || {};
  expect('business admin signs off -> case completes', r, 200, { record_status: done1.record?.status, case: done1.record?.case_status, reached: done1.record?.reached },
    done1.record?.case_status === 'completed' && done1.record?.exit_outcome === 'approved' && (done1.record?.reached || []).includes('approved'));
  r = await call('POST', `/m/${MOD}/records/${recId}/actions`, { token: supTok, body: { action: 'approve' } });
  expect('acting on a finished case -> 409 closed', r, 409, { code: r.data?.code }, r.data?.code === 'closed');

  // 12. publish v2; the old case stays pinned to v1
  const v2 = workspaceManifest(ref, company, { v2: true });
  r = await call('POST', `/platform/workspaces/${ref}/releases`, { admin, body: { manifest: v2, reason: 'stage 2: supervisor-only sign-off + payment terms' } });
  expect('publish v2', r, 201, { version: r.data?.release?.version }, r.data?.release?.version === 2);
  // F5a: v2 switched finance_ca, launch_approval and financial_closure OFF — the API refuses them now
  r = await call('GET', '/launch-approvals/queue', { token: baTok });
  expect('F5a: disabled launch_approval refused (403)', r, 403, { detail: r.data?.detail });
  r = await call('GET', '/business-admin/finance-approvals', { token: baTok });
  expect('F5a: disabled finance_ca admin queue refused (403)', r, 403);
  r = await call('POST', `/sites/${siteA}/finance/approve`, { token: supTok });
  expect('F5a: disabled finance_ca tab write refused (403)', r, 403);
  r = await call('GET', '/financial-closure/admin-queue', { token: baTok });
  expect('F5a: disabled financial_closure read refused (403)', r, 403);
  r = await call('GET', '/auth/whoami', { token: baTok });
  expect('session lists the disabled modules', r, 200, { disabled: r.data?.disabled_modules },
    ['finance_ca', 'launch_approval', 'financial_closure', 'design'].every((k) => (r.data?.disabled_modules || []).includes(k)));
  r = await call('GET', `/m/${MOD}/records/${recId}`, { token: supTok });
  expect('old case stays on v1 (v1 chain for stage 2) while live is v2', r, 200,
    { release: r.data?.release?.version, live: r.data?.release?.live_version, stage2_chain: r.data?.stages?.[1]?.chain },
    r.data?.release?.version === 1 && r.data?.release?.live_version === 2 && JSON.stringify(r.data?.stages?.[1]?.chain) === '["supervisor","business_admin"]');
  r = await call('POST', '/bd/drafts', { token: baTok, body: { name: `Cfg Site B ${run}`, city: 'Pune', visit_date: '2026-10-04' } });
  const siteB = r.data?.id;
  expect('create a second site after v2', r, 201);
  await call('POST', `/bd/drafts/${siteB}/shortlist`, { token: baTok });
  r = await call('POST', `/m/${MOD}/records`, { token: baTok, body: { site_id: siteB } });
  const recB = r.data?.record?.id;
  expect('new site runs v2 (stage 2 chain = [supervisor], new field)', r, 201,
    { release: r.data?.release?.version, stage2_chain: r.data?.stages?.[1]?.chain },
    r.data?.release?.version === 2 && JSON.stringify(r.data?.stages?.[1]?.chain) === '["supervisor"]');

  // 13. business-admin override is recorded, not hidden
  r = await call('POST', `/m/${MOD}/records/${recB}/actions`, { token: baTok, body: { action: 'submit', values: { vendor_name: 'Beta Traders', gst_number: '29ABCDE1234F1Z5' } } });
  expect('business admin performs the executive step (override)', r, 200, { next: r.data?.next_step?.role }, r.data?.next_step?.role === 'supervisor');
  const ovr = (r.data?.approvals || []).find((a) => a.verdict === 'submitted');
  expect('override flagged on the approval row and in the audit provenance', { status: 200 }, 200,
    { is_override: ovr?.is_override, tier: ovr?.tier, actor_role: ovr?.actor_role },
    ovr?.is_override === true && ovr?.tier === 'executive' && ovr?.actor_role === 'business_admin' && (r.data?.audit || []).some((a) => a.provenance?.override === true));

  // 14. audit trail with provenance
  r = await call('GET', `/m/${MOD}/records/${recId}`, { token: baTok });
  const audit = r.data?.audit || [];
  const approvals = r.data?.approvals || [];
  const relIds = new Set(audit.map((a) => a.config_release_id));
  expect('audit trail: every event carries the v1 release + module + policy', r, 200,
    { events: audit.length, policies: [...new Set(audit.map((a) => a.provenance?.policy))].join(','), chain_valid: r.data?.audit_chain_valid },
    audit.length >= 10 && relIds.size === 1 && relIds.has(rel1.id) && audit.every((a) => a.module_key === MOD) && r.data?.audit_chain_valid === true
      && audit.some((a) => a.provenance?.policy === 'gate' && a.provenance?.inputs?.reached?.bd));
  expect('approvals ledger: submitted/sent_back/approved per tier, no override in the normal chain', { status: 200 }, 200,
    { rows: approvals.map((a) => `${a.stage_order}:${a.tier}:${a.verdict}${a.is_override ? '!' : ''}`).join(' ') },
    approvals.length === 6 && approvals.every((a) => a.is_override === false && a.release_id === rel1.id) && approvals.some((a) => a.verdict === 'sent_back'));
  r = await call('GET', `/m/${MOD}/records`, { token: execTok });
  expect('executive lists only their own cases', r, 200, { total: r.data?.total }, r.data?.total === 1 && r.data?.items?.[0]?.id === recId);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const evidence = { run, api: API, finished_at: new Date().toISOString(), configurator_ref: ref, company, workspace_code: code,
    tenant_id: ws.tenant_id, releases: { v1: rel1.id }, records: { v1_case: recId, v2_case: recB },
    users: { business_admin: baEmail, supervisor: supEmail, executive: execEmail }, passed: steps.length - failed, failed, steps };
  fs.writeFileSync(path.join(OUT_DIR, 'configurator-last-run.json'), JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, `configurator-run-${run}.json`), JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'configurator-last-run.secrets.json'), JSON.stringify({ workspace_code: code, ...secrets }, null, 2), { mode: 0o600 });
  console.log(`\n${steps.length - failed}/${steps.length} passed — evidence: app-stack/run/smoke/configurator-last-run.json`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('smoke crashed:', e); process.exit(2); });

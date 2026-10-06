#!/usr/bin/env node
// Baseline proof for the UNMODIFIED Matrix app: drives the app's EXISTING
// provisioning + onboarding endpoints end-to-end on localhost. Zero dependencies.
//
//   node app-stack/smoke-existing.mjs            (backend must be up: ./start.sh)
//   API=http://localhost:8000/api node app-stack/smoke-existing.mjs
//
// Flow: platform-admin login -> request workspace -> approve (workspace_code +
// one-time setup code) -> workspace-code authenticity checks (valid vs invalid)
// -> SEC-1 probes (claiming the unclaimed BA without / with a wrong setup code
// fails) -> BA sets password with the setup code (single use) -> BA login ->
// whoami -> BA mints a dept code -> supervisor signs up WITH A PASSWORD -> BA
// approves -> supervisor logs in with it -> supervisor mints invite code ->
// executive signs up with a password -> supervisor approves -> executive logs in
// -> SEC-1: a password-less (legacy-style) approved account cannot be claimed
// without a code; recovery = reset request -> platform admin confirms -> code
// -> org + seat checks.
//
// Output: PASS/FAIL per step with HTTP status + roles. Evidence (no tokens,
// passwords or setup codes) -> app-stack/run/smoke/last-run.json. The test
// users' generated passwords go to app-stack/run/smoke/last-run.secrets.json
// (mode 600, gitignored) so a browser check can sign in as them.
//
// Rate limits (in-memory, per client IP + path, reset on backend restart):
// request-workspace 3/300s, password-setup 5/300s (4 per run), password-reset/
// complete 5/300s (3 per run), signup/supervisor 5/300s (3 per run), login 10/60s,
// admin/login 10/300s. => ONE full run per 5 minutes; restart the backend between
// runs (`./stop.sh --apps && ./start.sh`).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
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
const benv = readEnv(path.join(HERE, '..', 'app', 'backend', '.env'));

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
  if (res.status === 429) {
    console.log(`\n429 rate-limited on ${method} ${p} — wait ${res.headers.get('retry-after')}s or restart the backend (./stop.sh --apps && ./start.sh).`);
  }
  return { status: res.status, data };
}

const expect = (name, r, want, extra = {}, cond = true) =>
  record(name, r.status === want && cond, { status: r.status, want, ...extra, ...(r.status !== want ? { detail: r.data?.detail ?? r.data } : {}) });

const internal = { 'X-Matrix-Internal': '1', Origin: ORIGIN };
const pw = () => `Smk-${crypto.randomBytes(9).toString('base64url')}`;

async function main() {
  const run = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const company = `Smoke Retail ${run}`;
  const baEmail = `ba.${run}@example.com`;
  const supEmail = `sup.${run}@example.com`;
  const execEmail = `exec.${run}@example.com`;
  const secrets = { ba: { email: baEmail, password: pw() }, supervisor: { email: supEmail, password: pw() }, executive: { email: execEmail, password: pw() } };
  console.log(`API ${API}  run ${run}\n`);

  // 0. health
  let r = await call('GET', '/health'); expect('health', r, 200);
  r = await call('GET', '/health/db'); expect('health/db', r, 200);

  // 1. platform admin
  r = await call('POST', '/tenancy/admin/login', { body: { email: benv.PLATFORM_ADMIN_EMAIL, password: 'definitely-wrong' } });
  expect('platform-admin login (wrong password rejected)', r, 401);
  r = await call('POST', '/tenancy/admin/login', { body: { email: benv.PLATFORM_ADMIN_EMAIL, password: benv.PLATFORM_ADMIN_PASSWORD } });
  expect('platform-admin login', r, 200);
  const adminJwt = r.data?.token;
  r = await call('GET', '/tenancy/requests', { admin: 'not-a-jwt' });
  expect('admin endpoint rejects bad X-Platform-Admin-Key', r, 401);

  // 2. request + approve workspace
  r = await call('POST', '/tenancy/request-workspace', { body: { company, admin_email: baEmail, team_size: '11 to 50 users' } });
  expect('request-workspace (public)', r, 201, { req_status: r.data?.status }, r.data?.status === 'pending');
  const requestId = r.data?.id;
  r = await call('GET', '/tenancy/requests', { admin: adminJwt });
  expect('admin lists pending requests', r, 200, {}, (r.data?.items || []).some((i) => i.id === requestId));
  r = await call('POST', `/tenancy/requests/${requestId}/approve`, { admin: adminJwt, body: { admin_name: 'Smoke BA', city: 'Bengaluru' } });
  const ws = r.data || {};
  expect('approve -> provision tenant + business_admin', r, 200,
    { workspace_code: ws.workspace_code, seat_limit: ws.seat_limit, setup_code_returned: Boolean(ws.admin_setup_token) },
    Boolean(ws.workspace_code && ws.admin_setup_token && ws.tenant_id));
  const code = ws.workspace_code;
  r = await call('POST', `/tenancy/requests/${requestId}/approve`, { admin: adminJwt, body: {} });
  expect('approve is single-shot (2nd approve -> 409)', r, 409);

  // 3. workspace-code authenticity
  const bogus = `${code.split('-')[0]}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  r = await call('GET', `/tenancy/branding?code=${encodeURIComponent(code)}`);
  expect('branding(valid code) -> company name', r, 200, { name: r.data?.name }, r.data?.name === company);
  r = await call('GET', `/tenancy/branding?code=${encodeURIComponent(bogus)}`);
  expect('branding(invalid code) -> no name (uniform, anti-enumeration)', r, 200, { name: r.data?.name }, r.data?.name === null);
  r = await call('POST', '/auth/login/check', { body: { email: baEmail, workspace_code: code }, headers: internal });
  expect('login/check(valid code, BA email) -> needs_password', r, 200, { account_state: r.data?.account_state }, r.data?.account_state === 'needs_password');
  r = await call('POST', '/auth/login/check', { body: { email: baEmail, workspace_code: bogus }, headers: internal });
  expect('login/check(invalid code) -> unknown', r, 200, { account_state: r.data?.account_state }, r.data?.account_state === 'unknown');
  r = await call('POST', '/auth/login/check', { body: { email: baEmail, workspace_code: code } });
  expect('login/check without first-party headers -> opaque', r, 200, { account_state: r.data?.account_state }, r.data?.account_state === 'checked');
  r = await call('POST', '/auth/login', { body: { email: baEmail, workspace_code: bogus, password: 'x' } });
  expect('login(invalid code) -> soft 202 pending, no token', r, 202, {}, !r.data?.access_token);

  // 4. SEC-1 (F5a): the approved-but-unclaimed BA cannot be claimed with (email, workspace code)
  //    alone — the old /auth/password-setup attack — nor with a guessed code.
  const attackerPw = pw();
  r = await call('POST', '/auth/password-setup', { body: { email: baEmail, workspace_code: code, new_password: attackerPw } });
  expect('SEC-1: claim unclaimed BA via password-setup WITHOUT setup code -> 422', r, 422);
  r = await call('POST', '/auth/password-setup', { body: { email: baEmail, workspace_code: code, new_password: attackerPw, setup_code: 'guessed-setup-code' } });
  expect('SEC-1: claim unclaimed BA via password-setup with a GUESSED code -> 403', r, 403);
  r = await call('POST', '/auth/login', { body: { email: baEmail, workspace_code: code, password: attackerPw } });
  expect('SEC-1: attacker password does not sign in (account still unclaimed) -> 401', r, 401);

  //    BA sets password with the one-time setup code (single use), then logs in
  r = await call('POST', '/auth/password-reset/complete', { body: { email: baEmail, workspace_code: code, new_password: secrets.ba.password, reset_token: 'wrong-setup-code' } });
  expect('BA set password with WRONG setup code -> 403', r, 403);
  r = await call('POST', '/auth/password-reset/complete', { body: { email: baEmail, workspace_code: code, new_password: secrets.ba.password, reset_token: ws.admin_setup_token } });
  expect('BA set password with setup code', r, 200, { result: r.data?.status });
  r = await call('POST', '/auth/password-reset/complete', { body: { email: baEmail, workspace_code: code, new_password: attackerPw, reset_token: ws.admin_setup_token } });
  expect('setup code is single use (replay -> 403)', r, 403);
  r = await call('POST', '/auth/login', { body: { email: baEmail, workspace_code: code, password: secrets.ba.password } });
  expect('BA login (code + email + password)', r, 200, { role: r.data?.user?.role, tenant: r.data?.user?.tenant_name }, r.data?.user?.role === 'business_admin');
  const baTok = r.data?.access_token;
  r = await call('GET', '/auth/whoami', { token: baTok });
  expect('BA whoami', r, 200, { role: r.data?.role, tenant_matches: r.data?.tenant_id === ws.tenant_id }, r.data?.role === 'business_admin' && r.data?.tenant_id === ws.tenant_id);
  r = await call('GET', '/tenancy/workspace-info', { token: baTok });
  expect('workspace-info (authed) returns the provisioned code', r, 200, { code_matches: r.data?.workspace_code === code, used_seats: r.data?.used_seats }, r.data?.workspace_code === code);
  r = await call('GET', '/tenancy/workspace-info');
  expect('workspace-info without a session -> 401', r, 401);

  // 5. BA onboards a supervisor via a department code
  r = await call('POST', '/business-admin/dept-codes/bd/rotate', { token: baTok });
  expect('BA mints BD dept code', r, 200, { module: r.data?.module }, Boolean(r.data?.code));
  const deptCode = r.data?.code;
  r = await call('POST', '/auth/signup/supervisor', { body: { email: supEmail, dept_code: 'NOPE-NOPE' } });
  expect('supervisor signup with bad dept code -> 404', r, 404);
  r = await call('POST', '/auth/signup/supervisor', { body: { email: supEmail, dept_code: deptCode, password: secrets.supervisor.password } });
  expect('supervisor signup (dept code + own password)', r, 202);
  const supId = r.data?.user_id;
  r = await call('POST', '/auth/login', { body: { email: supEmail, workspace_code: code, password: 'x' } });
  expect('pending supervisor cannot log in (202)', r, 202);
  r = await call('GET', '/business-admin/pending-supervisors', { token: baTok });
  expect('BA sees pending supervisor', r, 200, {}, (r.data || []).some((s) => s.id === supId && s.module === 'bd'));
  r = await call('POST', `/business-admin/pending-supervisors/${supId}/approve`, { token: baTok, body: { module: 'bd' } });
  expect('BA approves supervisor', r, 204);
  r = await call('POST', '/auth/login/check', { body: { email: supEmail, workspace_code: code }, headers: internal });
  expect('approved supervisor login/check -> active (password chosen at signup)', r, 200, { account_state: r.data?.account_state }, r.data?.account_state === 'active');
  r = await call('POST', '/auth/login', { body: { email: supEmail, workspace_code: code, password: secrets.supervisor.password } });
  expect('supervisor login (signup password)', r, 200, { role: r.data?.user?.role }, r.data?.user?.role === 'supervisor');
  const supTok = r.data?.access_token;
  r = await call('GET', '/auth/whoami', { token: supTok });
  expect('supervisor whoami', r, 200, { role: r.data?.role, module: r.data?.module, module_role: r.data?.module_role },
    r.data?.role === 'supervisor' && r.data?.tenant_id === ws.tenant_id);

  // 6. supervisor onboards an executive via their invite code
  r = await call('POST', '/supervisor-codes/me/bd/rotate', { token: supTok });
  expect('supervisor mints BD invite code', r, 200, { module: r.data?.module }, Boolean(r.data?.code));
  const invite = r.data?.code;
  r = await call('POST', '/auth/signup/executive', { body: { email: execEmail, supervisor_code: invite, password: secrets.executive.password } });
  expect('executive signup (supervisor code + own password)', r, 202);
  const execId = r.data?.user_id;
  r = await call('GET', '/supervisor-codes/me/bd/pending-executives', { token: supTok });
  expect('supervisor sees pending executive', r, 200, {}, (r.data || []).some((e) => e.id === execId));
  r = await call('POST', `/supervisor-codes/me/pending-executives/${execId}/approve?module=bd`, { token: supTok });
  expect('supervisor approves executive', r, 204);
  r = await call('POST', '/auth/login', { body: { email: execEmail, workspace_code: code, password: secrets.executive.password } });
  expect('executive login (signup password)', r, 200, { role: r.data?.user?.role }, r.data?.user?.role === 'executive');
  const execTok = r.data?.access_token;
  r = await call('GET', '/auth/whoami', { token: execTok });
  expect('executive whoami', r, 200, { role: r.data?.role, module: r.data?.module, reports_to_supervisor: r.data?.supervisor_id === supId },
    r.data?.role === 'executive' && r.data?.supervisor_id === supId);

  // 6b. SEC-1: an approved account WITHOUT a password (signed up by an old client / before F5a)
  //     cannot be claimed with (email, workspace code); the supported recovery is the existing
  //     reset machinery: request -> platform admin confirms -> one-time code -> first password.
  const legacyEmail = `legacy.${run}@example.com`;
  secrets.legacy = { email: legacyEmail, password: pw() };
  r = await call('POST', '/auth/signup/supervisor', { body: { email: legacyEmail, dept_code: deptCode } });
  expect('legacy-style supervisor signup without a password', r, 202);
  const legacyId = r.data?.user_id;
  r = await call('POST', `/business-admin/pending-supervisors/${legacyId}/approve`, { token: baTok, body: { module: 'bd' } });
  expect('BA approves it', r, 204);
  r = await call('POST', '/auth/password-setup', { body: { email: legacyEmail, workspace_code: code, new_password: attackerPw } });
  expect('SEC-1: claim approved password-less staff WITHOUT a code -> 422', r, 422);
  r = await call('POST', '/auth/password-setup', { body: { email: legacyEmail, workspace_code: code, new_password: attackerPw, setup_code: 'guessed-setup-code' } });
  expect('SEC-1: ... with no code ever issued -> 403', r, 403);
  r = await call('POST', '/auth/password-reset/request', { body: { email: legacyEmail, workspace_code: code } });
  expect('owner asks for a setup code (reset request)', r, 200);
  r = await call('GET', '/tenancy/password-reset-requests', { admin: adminJwt });
  const resetReq = (r.data?.items || []).find((x) => x.email === legacyEmail);
  expect('platform admin sees the request', r, 200, {}, Boolean(resetReq));
  r = await call('POST', `/tenancy/password-reset-requests/${resetReq?.id}/confirm`, { admin: adminJwt });
  expect('platform admin confirms -> one-time code', r, 200, {}, Boolean(r.data?.reset_token));
  const legacyCode = r.data?.reset_token;
  r = await call('POST', '/auth/password-setup', { body: { email: legacyEmail, workspace_code: code, new_password: secrets.legacy.password, setup_code: legacyCode } });
  expect('first password with the code', r, 200, { result: r.data?.status });
  r = await call('POST', '/auth/login', { body: { email: legacyEmail, workspace_code: code, password: secrets.legacy.password } });
  expect('that supervisor signs in', r, 200, { role: r.data?.user?.role }, r.data?.user?.role === 'supervisor');

  // 7. roll-up as the BA
  r = await call('GET', '/business-admin/org', { token: baTok });
  const bd = (r.data?.modules || []).find((m) => m.module === 'bd') || {};
  const supsInBd = bd.supervisors || [];
  const nested = supsInBd.flatMap((s) => s.executives || []);
  expect('BA org view lists supervisor + executive under BD', r, 200,
    { bd_supervisors: supsInBd.length, bd_executives: nested.length },
    supsInBd.some((s) => s.id === supId) && nested.some((e) => e.id === execId));
  r = await call('GET', '/tenancy/workspace-info', { token: baTok });
  expect('seat usage after onboarding', r, 200, { used_seats: r.data?.used_seats, seat_limit: r.data?.seat_limit }, r.data?.used_seats === 4);
  r = await call('GET', '/business-admin/dept-codes', { token: execTok });
  expect('executive cannot use BA endpoints (403)', r, 403);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const evidence = { run, api: API, finished_at: new Date().toISOString(), company, workspace_code: code, tenant_id: ws.tenant_id,
    users: { business_admin: baEmail, supervisor: supEmail, executive: execEmail, legacy_supervisor: legacyEmail }, passed: steps.length - failed, failed, steps };
  fs.writeFileSync(path.join(OUT_DIR, 'last-run.json'), JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, `run-${run}.json`), JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'last-run.secrets.json'), JSON.stringify({ workspace_code: code, ...secrets }, null, 2), { mode: 0o600 });
  console.log(`\n${steps.length - failed}/${steps.length} passed — evidence: app-stack/run/smoke/last-run.json`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('smoke crashed:', e); process.exit(2); });

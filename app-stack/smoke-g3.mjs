#!/usr/bin/env node
// Backend proof of Phase 2b / G3 — zero dependencies.
//
//   node app-stack/smoke-g3.mjs          (backend must be up: ./start.sh; restart first to reset rate limits)
//
// #3 creator-scoped rule: a custom module whose stage 1 is `restricted_to: "site_creator"` —
//    a non-creator executive (even with a delegation) and a non-creator supervisor are refused
//    (403 not_site_creator), the creator executive acts without a delegation and sees the case in
//    "My cases", a business admin acts only as a FLAGGED override (approval is_override +
//    provenance creator_override), and the DB's approvals guard refuses a forged non-creator row.
// #4 role-scoped saved views: seeded per module on publish; executive / supervisor / business admin
//    see different view sets and defaults; a view outside your audience is 404; only a BA manages
//    views; a crafted filter is refused (422) and a view never widens the server-side scope.
// #2 migrate running cases: publish v2 (hot-fix: stage 2 gets a field and becomes terminal, stage 3
//    removed) -> dry-run (A compatible, B blocked: its stage is gone) writes nothing -> execute
//    without a reason refused -> execute: A moves (site pin + record), B's site skipped -> re-pin
//    outside the migration path refused by the DB (plain UPDATE and the old allow_repin switch) ->
//    the case audit trail carries provenance {from, to, actor, reason, before/after stage, pre_state}
//    with an intact hash chain -> the migrated case finishes on v2.
//
// Rate limits: uses 1x password-reset/complete, 3x password-setup, 3x signup — the backend allows 5 per
// 300 s per endpoint (in memory), so restart the backend (./stop.sh --apps && ./start.sh) before running it
// right after smoke-existing + smoke-configurator.
//
// Evidence (no tokens / passwords / setup codes): app-stack/run/smoke/g3-last-run.json;
// test users' passwords: run/smoke/g3-last-run.secrets.json (mode 600).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const API = (process.env.API || 'http://localhost:8000/api').replace(/\/$/, '');
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
const senv = readEnv(path.join(HERE, '.env'));
const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'building-blocks', 'from-design', 'seed-workspaces.json'), 'utf8'));

const steps = [];
let failed = 0;
function record(name, ok, detail) {
  steps.push({ step: name, ok, ...detail });
  if (!ok) failed += 1;
  const d = Object.entries(detail).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${d}`);
}
async function call(method, p, { body, token, admin } = {}) {
  const h = { Accept: 'application/json' };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (admin) h['X-Platform-Admin-Key'] = admin;
  const res = await fetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (res.status === 429) console.log(`\n429 rate-limited on ${method} ${p} — restart the backend (./stop.sh --apps && ./start.sh).`);
  return { status: res.status, data };
}
const expect = (name, r, want, extra = {}, cond = true) =>
  record(name, r.status === want && cond, { status: r.status, want, ...extra, ...(r.status !== want || !cond ? { detail: r.data?.detail ?? r.data, code: r.data?.code } : {}) });
const check = (name, cond, extra = {}) => record(name, Boolean(cond), extra);
const pw = () => `G3-${crypto.randomBytes(9).toString('base64url')}`;
const clone = (x) => JSON.parse(JSON.stringify(x));

// SQL straight into the sandbox DB (only to prove what the DB itself refuses). Each probe runs in a
// transaction that is rolled back, so even an unexpected success writes nothing.
function sql(statement) {
  try {
    const out = execFileSync('docker', ['exec', '-i', 'matrix-app-db-1', 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1',
      '-U', senv.APP_DB_USER || 'postgres', '-d', senv.APP_DB_NAME || 'matrix'], { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, err: String(e.stderr || e.message).split('\n').find((l) => l.startsWith('ERROR')) || String(e.stderr || e.message).slice(0, 200) };
  }
}

// ── manifests ────────────────────────────────────────────────────────────────
const MOD = 'g3_vendor';
function g3Module({ v2 = false } = {}) {
  const stages = [
    { order: 1, name: 'Vendor capture', outcome: 'submitted', terminal: false, approvers: ['executive', 'supervisor'],
      restricted_to: 'site_creator',
      fields: [{ key: 'vendor_name', label: 'Vendor name', kind: 'text', required: true, validation: null, affects_outcome: false }] },
    { order: 2, name: 'Compliance check', outcome: 'approved', terminal: v2, approvers: ['supervisor'],
      fields: [{ key: 'credit_days', label: 'Credit days', kind: 'number', required: true, validation: 'min 0 · max 120', affects_outcome: false }] },
  ];
  if (v2) stages[1].fields.push({ key: 'payment_terms', label: 'Payment terms', kind: 'choice', required: false, validation: 'advance · net 30 · net 60', affects_outcome: false });
  else stages.push({ order: 3, name: 'Sign-off', outcome: 'approved', terminal: true, approvers: ['supervisor', 'business_admin'], fields: [] });
  return {
    key: MOD, name: 'G3 Vendor', type: 'custom', enabled: true, route: `/m/${MOD}`, state: 'live',
    tiers: { supervisor: true, executive: true, business_admin_signoff: true, delegation: true },
    entry_gate: { match: 'all', conditions: [{ source: 'bd', outcome: 'in progress' }], refusal_message: 'G3 Vendor is locked: waiting for the BD shortlist.' },
    stages, rollup: { strategy: 'all_positive' }, exit_signal: 'approved', navigation: [],
  };
}
function workspaceManifest(ref, company, v2 = false) {
  const m = clone(seeds.workspaces.starbucks.manifest);
  m.workspace = { id: ref, name: company, slug: ref.replace(/_/g, '-').slice(0, 31), live_version: v2 ? 'v1' : 'v0', draft_version: v2 ? 'v2' : 'v1' };
  m.modules.push(g3Module({ v2 }));
  return m;
}

async function main() {
  const run = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const ref = `ws_g3_${run}`;
  const company = `G3 Smoke ${run}`;
  const emails = { ba: `g3.ba.${run}@example.com`, sup: `g3.sup.${run}@example.com`, ex1: `g3.ex1.${run}@example.com`, ex2: `g3.ex2.${run}@example.com` };
  const secrets = Object.fromEntries(Object.entries(emails).map(([k, e]) => [k, { email: e, password: pw() }]));
  console.log(`API ${API}  run ${run}  configurator_ref ${ref}\n`);

  // ── 0. workspace: provision + publish v1 (with the creator rule) ────────────
  let r = await call('POST', '/tenancy/admin/login', { body: { email: benv.PLATFORM_ADMIN_EMAIL, password: benv.PLATFORM_ADMIN_PASSWORD } });
  expect('platform-admin login', r, 200);
  const admin = r.data?.token;
  const v1 = workspaceManifest(ref, company);
  const badRule = clone(v1);
  badRule.modules.find((m) => m.key === MOD).stages[1].restricted_to = 'anyone';
  r = await call('POST', `/platform/workspaces/${ref}/releases/validate`, { admin, body: { manifest: badRule } });
  expect('#3 publish check: unknown restricted_to value is a schema error', r, 200, {}, r.data?.ok === false
    && (r.data?.findings || []).some((f) => f.code === 'schema' && f.path?.endsWith('restricted_to')));
  const warnRule = clone(v1);
  warnRule.modules.find((m) => m.key === MOD).stages[1].restricted_to = 'site_creator';
  r = await call('POST', `/platform/workspaces/${ref}/releases/validate`, { admin, body: { manifest: warnRule } });
  expect('#3 publish check: creator rule on a supervisor-first stage -> warning creator_rule_first_tier', r, 200, {},
    r.data?.ok === true && (r.data?.findings || []).some((f) => f.code === 'creator_rule_first_tier' && f.stage === 2));
  r = await call('POST', '/platform/workspaces', { admin, body: { configurator_ref: ref, company, admin_email: emails.ba, admin_name: 'G3 BA', seat_limit: 25, city: 'Pune' } });
  expect('provision workspace', r, 201);
  const ws = r.data || {};
  const code = ws.workspace_code;
  r = await call('POST', `/platform/workspaces/${ref}/releases`, { admin, body: { manifest: v1, reason: 'G3 v1: creator-scoped capture stage' } });
  const rel1 = r.data?.release || {};
  expect('publish v1 (stage 1 restricted_to site_creator)', r, 201, { version: rel1.version }, rel1.version === 1);

  // ── people ──────────────────────────────────────────────────────────────────
  r = await call('POST', '/auth/password-reset/complete', { body: { email: emails.ba, workspace_code: code, new_password: secrets.ba.password, reset_token: ws.admin_setup_token } });
  expect('BA claims the account with the setup code', r, 200);
  r = await call('POST', '/auth/login', { body: { email: emails.ba, workspace_code: code, password: secrets.ba.password } });
  const baTok = r.data?.access_token;
  expect('BA login', r, 200);
  r = await call('POST', `/business-admin/dept-codes/${MOD}/rotate`, { token: baTok });
  const deptCode = r.data?.code;
  r = await call('POST', '/auth/signup/supervisor', { body: { email: emails.sup, dept_code: deptCode } });
  const supId = r.data?.user_id;
  r = await call('POST', `/business-admin/pending-supervisors/${supId}/approve`, { token: baTok, body: { module: MOD } });
  expect('supervisor joins the module', r, 204);
  r = await call('POST', '/auth/password-setup', { body: { email: emails.sup, workspace_code: code, new_password: secrets.sup.password } });
  expect('supervisor sets a first password (rate limit 5/300 s — restart the backend between smoke runs)', r, 200);
  r = await call('POST', '/auth/login', { body: { email: emails.sup, workspace_code: code, password: secrets.sup.password } });
  const supTok = r.data?.access_token;
  r = await call('POST', `/supervisor-codes/me/${MOD}/rotate`, { token: supTok });
  const invite = r.data?.code;
  const execIds = {};
  const execTok = {};
  for (const k of ['ex1', 'ex2']) {
    r = await call('POST', '/auth/signup/executive', { body: { email: emails[k], supervisor_code: invite } });
    execIds[k] = r.data?.user_id;
    r = await call('POST', `/supervisor-codes/me/pending-executives/${execIds[k]}/approve?module=${MOD}`, { token: supTok });
    r = await call('POST', '/auth/password-setup', { body: { email: emails[k], workspace_code: code, new_password: secrets[k].password } });
    expect(`executive ${k} sets a first password`, r, 200);
    r = await call('POST', '/auth/login', { body: { email: emails[k], workspace_code: code, password: secrets[k].password } });
    execTok[k] = r.data?.access_token;
  }
  check('two executives + a supervisor in the module', supTok && execTok.ex1 && execTok.ex2, { ex1: Boolean(execTok.ex1), ex2: Boolean(execTok.ex2) });

  // ── #3 creator-scoped rule ───────────────────────────────────────────────────
  const sites = {};
  for (const k of ['S1', 'S2']) {
    r = await call('POST', '/bd/drafts', { token: execTok.ex1, body: { name: `G3 ${k} ${run}`, city: 'Pune', visit_date: '2026-10-05' } });
    sites[k] = r.data?.id;
    expect(`executive 1 creates site ${k} (BD draft: submitted_by = executive 1)`, r, 201);
    r = await call('POST', `/bd/drafts/${sites[k]}/shortlist`, { token: baTok });
  }
  r = await call('POST', `/m/${MOD}/records`, { token: supTok, body: { site_id: sites.S1 } });
  const recA = r.data?.record?.id;
  expect('supervisor opens the case on S1: next step is the creator step', r, 201,
    { next: r.data?.next_step?.role, restricted_to: r.data?.next_step?.restricted_to, actions: r.data?.allowed_actions },
    r.data?.next_step?.restricted_to === 'site_creator' && (r.data?.allowed_actions || []).length === 0 && r.data?.stages?.[0]?.restricted_to === 'site_creator');
  r = await call('POST', `/m/${MOD}/records/${recA}/actions`, { token: supTok, body: { action: 'submit', values: { vendor_name: 'Not mine' } } });
  expect('#3 supervisor who did not create the site is refused (403 not_site_creator)', r, 403, { code: r.data?.code }, r.data?.code === 'not_site_creator');
  r = await call('POST', `/m/${MOD}/records/${recA}/assign`, { token: supTok, body: { executive_id: execIds.ex2 } });
  expect('supervisor delegates the case to executive 2', r, 200, {}, r.data?.record?.assigned_to === execIds.ex2);
  r = await call('GET', `/m/${MOD}/records/${recA}`, { token: execTok.ex2 });
  expect('executive 2 (delegate) sees the case but may not act', r, 200, { actions: r.data?.allowed_actions, owns: r.data?.me?.owns_site },
    (r.data?.allowed_actions || []).length === 0 && r.data?.me?.owns_site === false);
  r = await call('POST', `/m/${MOD}/records/${recA}/actions`, { token: execTok.ex2, body: { action: 'submit', values: { vendor_name: 'Delegate try' } } });
  expect('#3 non-creator executive (even delegated) is refused (403 not_site_creator)', r, 403, { code: r.data?.code }, r.data?.code === 'not_site_creator');
  r = await call('GET', `/m/${MOD}/records`, { token: execTok.ex1 });
  expect('#3 the creator (no delegation) sees the case in their list', r, 200, { total: r.data?.total },
    (r.data?.items || []).some((i) => i.id === recA && i.owned_by_me === true && (i.allowed_actions || []).includes('submit')));
  r = await call('POST', `/m/${MOD}/records/${recA}/actions`, { token: execTok.ex1, body: { action: 'submit', values: { vendor_name: 'Acme Pune' } } });
  const subA = (r.data?.approvals || []).find((a) => a.verdict === 'submitted');
  expect('#3 the site creator submits the creator step (no override)', r, 200, { next: r.data?.next_step?.role, is_override: subA?.is_override },
    r.data?.next_step?.role === 'supervisor' && subA?.actor_id === execIds.ex1 && subA?.is_override === false
      && (r.data?.audit || []).some((a) => a.provenance?.rule === 'site_creator' && a.provenance?.site_creator === true));
  r = await call('POST', `/m/${MOD}/records/${recA}/actions`, { token: supTok, body: { action: 'approve' } });
  expect('supervisor approves stage 1 -> case A at stage 2 (v1)', r, 200, { stage: r.data?.record?.current_stage }, r.data?.record?.current_stage === 2);
  // forged approval row straight into the DB: the guard enforces the rule too
  const forged = sql(`BEGIN; INSERT INTO module_approvals (tenant_id, record_id, stage_order, release_id, tier, actor_id, actor_role, verdict)
    SELECT tenant_id, id, 1, release_id, 'executive', '${execIds.ex2}', 'executive', 'submitted' FROM module_records WHERE id = '${recA}'; ROLLBACK;`);
  check('#3 DB approvals guard refuses a non-creator executive row on the creator stage', !forged.ok && /may not act/.test(forged.err || ''), { db: forged.err || forged.out });

  r = await call('POST', `/m/${MOD}/records`, { token: baTok, body: { site_id: sites.S2 } });
  const recB = r.data?.record?.id;
  expect('BA opens the case on S2', r, 201);
  r = await call('POST', `/m/${MOD}/records/${recB}/actions`, { token: baTok, body: { action: 'submit', values: { vendor_name: 'Override Traders' } } });
  const ovr = (r.data?.approvals || []).find((a) => a.verdict === 'submitted');
  expect('#3 business admin performs the creator step only as a FLAGGED override', r, 200,
    { is_override: ovr?.is_override, tier: ovr?.tier },
    ovr?.is_override === true && ovr?.actor_role === 'business_admin'
      && (r.data?.audit || []).some((a) => a.provenance?.creator_override === true && a.provenance?.override === true));
  r = await call('POST', `/m/${MOD}/records/${recB}/actions`, { token: supTok, body: { action: 'approve' } });
  r = await call('POST', `/m/${MOD}/records/${recB}/actions`, { token: supTok, body: { action: 'submit', values: { credit_days: 30 } } });
  expect('case B moves on to stage 3 (sign-off) on v1', r, 200, { stage: r.data?.record?.current_stage }, r.data?.record?.current_stage === 3);

  // ── #4 role-scoped saved views ───────────────────────────────────────────────
  const views = {};
  for (const [who, tok] of [['ex1', execTok.ex1], ['ex2', execTok.ex2], ['sup', supTok], ['ba', baTok]]) {
    r = await call('GET', `/m/${MOD}/views`, { token: tok });
    views[who] = r.data || {};
  }
  const names = (v) => (v.items || []).map((x) => x.seed_key || x.name);
  const byKey = (v, k) => (v.items || []).find((x) => x.seed_key === k);
  check('#4 defaults seeded on publish; executive sees its views (no team queue / admin sign-off)',
    names(views.ex1).join() === 'awaiting_me,my_cases,all,closed' && views.ex1.role === 'executive' && views.ex1.can_manage === false,
    { ex1: names(views.ex1) });
  check('#4 supervisor sees a different set (team queue)', names(views.sup).join() === 'awaiting_me,my_cases,team_queue,all,closed', { sup: names(views.sup) });
  check('#4 business admin sees admin views and may manage', names(views.ba).join() === 'admin_signoff,team_queue,all,closed' && views.ba.can_manage === true, { ba: names(views.ba) });
  check('#4 defaults differ by role (executive/supervisor: Awaiting my approval; BA: Admin sign-off)',
    views.ex1.default_view_id === byKey(views.ex1, 'awaiting_me')?.id && views.ba.default_view_id === byKey(views.ba, 'admin_signoff')?.id,
    { ex1_default: views.ex1.default_view_id === byKey(views.ex1, 'awaiting_me')?.id });
  r = await call('GET', `/m/${MOD}/records?view=${byKey(views.ex1, 'my_cases').id}`, { token: execTok.ex1 });
  expect('#4 "My cases" (creator) lists both cases on the sites executive 1 created', r, 200, { total: r.data?.total },
    r.data?.total === 2 && r.data?.view?.seed_key === 'my_cases');
  r = await call('GET', `/m/${MOD}/records?view=${byKey(views.sup, 'awaiting_me').id}`, { token: supTok });
  expect('#4 supervisor "Awaiting my approval" = the cases waiting on the supervisor tier', r, 200, { ids: (r.data?.items || []).map((i) => i.id === recA ? 'A' : 'B') },
    r.data?.items?.length === 2);
  r = await call('GET', `/m/${MOD}/records?view=${byKey(views.ba, 'admin_signoff').id}`, { token: execTok.ex1 });
  expect('#4 a view outside your audience does not exist for you (404)', r, 404);
  r = await call('POST', `/m/${MOD}/views`, { token: execTok.ex1, body: { name: 'Mine', filter: {} } });
  expect('#4 only a business admin may create views (403)', r, 403);
  r = await call('POST', `/m/${MOD}/views`, { token: baTok, body: { name: 'Crafted', filter: { tenant_id: ws.tenant_id, role: 'business_admin' }, audience: ['executive'] } });
  expect('#4 a crafted filter with scope keys is refused (422)', r, 422);
  r = await call('POST', `/m/${MOD}/views`, { token: baTok, body: { name: 'S2 only (crafted)', filter: { site_ids: [sites.S2] }, audience: ['executive'], position: 5 } });
  const crafted = r.data || {};
  expect('#4 BA creates an executive view filtered to site S2', r, 201, {}, crafted.audience?.join() === 'executive');
  r = await call('GET', `/m/${MOD}/records?view=${crafted.id}&site_id=${sites.S2}`, { token: execTok.ex2 });
  expect('#4 the view cannot widen scope: executive 2 (not creator/assignee of S2) still sees nothing', r, 200, { total: r.data?.total }, r.data?.total === 0);
  r = await call('GET', `/m/${MOD}/records?view=${crafted.id}`, { token: execTok.ex1 });
  expect('#4 ...while the creator of S2 sees exactly that case through it', r, 200, { total: r.data?.total }, r.data?.total === 1 && r.data?.items?.[0]?.id === recB);
  r = await call('PATCH', `/m/${MOD}/views/${crafted.id}`, { token: baTok, body: { name: 'S2 only', audience: ['executive', 'supervisor'] } });
  expect('#4 BA edits the view', r, 200, {}, r.data?.name === 'S2 only' && r.data?.audience?.includes('supervisor'));
  r = await call('DELETE', `/m/${MOD}/views/${byKey(views.ba, 'closed').id}`, { token: baTok });
  expect('#4 BA removes the default "Closed" view', r, 204);
  r = await call('POST', `/m/${MOD}/views/reset`, { token: baTok });
  expect('#4 reset to defaults restores the seeded set and drops custom views', r, 200, { reset: r.data?.reset },
    (r.data?.items || []).filter((v) => v.seed_key).length === 6 && !(r.data?.items || []).some((v) => v.name === 'S2 only'));

  // ── #2 migrate running cases ─────────────────────────────────────────────────
  const v2 = workspaceManifest(ref, company, true);
  r = await call('POST', `/platform/workspaces/${ref}/releases`, { admin, body: { manifest: v2, reason: 'G3 v2 hot-fix: payment terms, drop sign-off' } });
  const rel2 = r.data?.release || {};
  expect('publish v2 (hot-fix)', r, 201, { version: rel2.version }, rel2.version === 2);
  r = await call('POST', `/platform/workspaces/${ref}/migrations`, { admin, body: { from_release_version: 'all_older', scope: { module_keys: [MOD] } } });
  const dry = r.data || {};
  const itemA = (dry.items || []).find((i) => i.record_id === recA);
  const itemB = (dry.items || []).find((i) => i.record_id === recB);
  expect('#2 dry-run: per-record compatibility, stage mapping, fields, approvals carried', r, 200,
    { summary: dry.summary, A: itemA?.outcome, B: itemB?.outcome, B_why: itemB?.blocking?.map((b) => b.code) },
    dry.dry_run === true && dry.migration_id === null && dry.to?.version === 2
      && itemA?.outcome === 'would_migrate' && itemA?.stage?.after?.order === 2 && itemA?.approvals_carried === 2
      && itemA?.stage_mapping?.find((m) => m.from.order === 3)?.to === null
      && itemB?.outcome === 'blocked' && itemB?.blocking?.some((b) => b.code === 'stage_missing'));
  r = await call('GET', `/m/${MOD}/records/${recA}`, { token: supTok });
  expect('#2 the dry-run wrote nothing (case A still on v1)', r, 200, { release: r.data?.release?.version }, r.data?.release?.version === 1);
  r = await call('POST', `/platform/workspaces/${ref}/migrations`, { admin, body: { from_release_version: 1, scope: { module_keys: [MOD] }, dry_run: false } });
  expect('#2 executing without a reason is refused (422 reason_required)', r, 422, { code: r.data?.code }, r.data?.code === 'reason_required');
  const reason = 'Hot-fix: sign-off stage removed, payment terms added';
  r = await call('POST', `/platform/workspaces/${ref}/migrations`, { admin, body: { from_release_version: 1, to_release_version: 2, scope: { module_keys: [MOD] }, reason, dry_run: false } });
  const ex = r.data || {};
  const exA = (ex.items || []).find((i) => i.record_id === recA);
  const exB = (ex.items || []).find((i) => i.record_id === recB);
  expect('#2 execute: case A migrated, incompatible case B skipped (never half-migrated)', r, 200,
    { migration: Boolean(ex.migration_id), summary: ex.summary?.by_outcome }, Boolean(ex.migration_id) && exA?.outcome === 'migrated' && exB?.outcome === 'skipped');
  r = await call('GET', `/m/${MOD}/records/${recA}`, { token: supTok });
  const detA = r.data || {};
  const migAudit = (detA.audit || []).find((a) => a.action === 'module_release_migrated');
  expect('#2 case A now runs v2 (stage 2 has the new field, no stage 3)', r, 200,
    { release: detA.release?.version, stages: (detA.stages || []).length, form: Object.keys(detA.next_step?.form?.schema?.properties || {}) },
    detA.release?.version === 2 && (detA.stages || []).length === 2 && Boolean(detA.next_step?.form?.schema?.properties?.payment_terms));
  check('#2 audit trail: append-only migration event with provenance {from, to, actor, reason, before/after stage, pre_state}',
    migAudit && migAudit.provenance?.from_release?.version === 1 && migAudit.provenance?.to_release?.version === 2
      && migAudit.provenance?.actor === benv.PLATFORM_ADMIN_EMAIL && migAudit.provenance?.reason === reason
      && migAudit.provenance?.before_stage?.order === 2 && migAudit.provenance?.after_stage?.order === 2
      && migAudit.provenance?.pre_state?.release === rel1.id && migAudit.provenance?.event?.type === 'release_migrated',
    { action: migAudit?.action, actor_name: migAudit?.actor_name });
  check('#2 hash chain still verifies across releases; approvals carried (v1 rows kept)', detA.audit_chain_valid === true
    && (detA.approvals || []).length === 2 && (detA.approvals || []).every((a) => a.release_id === rel1.id), { chain: detA.audit_chain_valid });
  r = await call('GET', `/m/${MOD}/records/${recB}`, { token: supTok });
  expect('#2 skipped case B stays on v1, untouched', r, 200, { release: r.data?.release?.version, stage: r.data?.record?.current_stage },
    r.data?.release?.version === 1 && r.data?.record?.current_stage === 3);
  const pins = sql(`SELECT (SELECT r.version FROM sites s JOIN tenant_config_releases r ON r.id = s.config_release_id WHERE s.id = '${sites.S1}') || ',' ||
                           (SELECT r.version FROM sites s JOIN tenant_config_releases r ON r.id = s.config_release_id WHERE s.id = '${sites.S2}');`);
  check('#2 site pins: S1 moved to v2 with its case, S2 still on v1', pins.ok && pins.out === '2,1', { pins: pins.out || pins.err });
  const plain = sql(`BEGIN; UPDATE sites SET config_release_id = '${rel1.id}' WHERE id = '${sites.S1}'; ROLLBACK;`);
  check('#2 DB refuses a re-pin outside the migration path (plain UPDATE)', !plain.ok && /only an audited release migration/.test(plain.err || ''), { db: plain.err });
  const oldSwitch = sql(`BEGIN; SET LOCAL matrix.allow_repin = 'on'; UPDATE sites SET config_release_id = '${rel1.id}' WHERE id = '${sites.S1}'; ROLLBACK;`);
  check('#2 ...and the old matrix.allow_repin switch no longer works', !oldSwitch.ok && /only an audited release migration/.test(oldSwitch.err || ''), { db: oldSwitch.err });
  const forgedMig = sql(`BEGIN; SELECT set_config('matrix.release_migration', '${ex.migration_id}', true); UPDATE module_records SET release_id = '${rel2.id}', runtime_state = runtime_state || '{"release":"${rel2.id}"}' WHERE id = '${recB}'; ROLLBACK;`);
  check('#2 ...nor naming a finished migration that has no item for the record', !forgedMig.ok && /only an audited release migration/.test(forgedMig.err || ''), { db: forgedMig.err });
  const itemsUpd = sql(`BEGIN; UPDATE module_release_migration_items SET plan = '{}' WHERE migration_id = '${ex.migration_id}'; ROLLBACK;`);
  check('#2 migration journal is append-only', !itemsUpd.ok && /append-only/.test(itemsUpd.err || ''), { db: itemsUpd.err });
  r = await call('GET', `/platform/workspaces/${ref}/migrations`, { admin });
  expect('#2 migration history lists it with reason + actor', r, 200, {}, (r.data?.items || []).some((m) => m.id === ex.migration_id && m.reason === reason && m.actor === benv.PLATFORM_ADMIN_EMAIL && m.status === 'done'));
  r = await call('GET', `/platform/workspaces/${ref}/migrations/${ex.migration_id}`, { admin });
  expect('#2 migration journal keeps the full pre-migration state', r, 200, { items: (r.data?.items || []).length },
    (r.data?.items || []).some((i) => i.record_id === recA && i.before_state?.release === rel1.id) && (r.data?.items || []).some((i) => i.record_id === null));
  r = await call('POST', `/m/${MOD}/records/${recA}/actions`, { token: supTok, body: { action: 'submit', expected_seq: detA.record?.seq, values: { credit_days: 45, payment_terms: 'net 30' } } });
  expect('#2 the migrated case finishes on v2 (stage 2 is terminal there)', r, 200, { case: r.data?.record?.case_status }, r.data?.record?.case_status === 'completed');
  r = await call('POST', `/platform/workspaces/${ref}/migrations`, { admin, body: { from_release_version: 2, to_release_version: 2, reason: 'noop' } });
  expect('#2 same source and target refused (422)', r, 422);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const evidence = { run, api: API, finished_at: new Date().toISOString(), configurator_ref: ref, company, workspace_code: code,
    tenant_id: ws.tenant_id, releases: { v1: rel1.id, v2: rel2.id }, sites, records: { A: recA, B: recB }, migration_id: ex.migration_id,
    users: emails, passed: steps.length - failed, failed, steps };
  fs.writeFileSync(path.join(OUT_DIR, 'g3-last-run.json'), JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'g3-last-run.secrets.json'), JSON.stringify({ workspace_code: code, ...secrets }, null, 2), { mode: 0o600 });
  console.log(`\n${steps.length - failed}/${steps.length} passed — evidence: app-stack/run/smoke/g3-last-run.json`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('smoke crashed:', e); process.exit(2); });

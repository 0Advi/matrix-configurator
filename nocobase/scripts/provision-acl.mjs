#!/usr/bin/env node
// Idempotently provision the read-only NocoBase role `configurator_viewer` (core ACL, community edition):
//
//   role      configurator_viewer — no UI-editor / plugin-manager / settings access (snippets !ui.* !pm !pm.*),
//             new menus are NOT auto-granted (allowNewMenu=false), global table strategy: no actions.
//   tables    independent permission "view" (all fields) on cfg_workspaces, cfg_releases, cfg_modules,
//             cfg_gates, cfg_stages, cfg_activity — nothing else (no create / update / destroy / export).
//   menu      the "Matrix Configurator" group, its pages and their tabs (roles.desktopRoutes:set).
//
// With --test-user it also creates (or repairs) a local test user that has ONLY this role. Its e-mail and a
// generated password are written to the gitignored project .env as NOCOBASE_VIEWER_EMAIL /
// NOCOBASE_VIEWER_PASSWORD and are never printed. Whenever those credentials exist the script ends with a
// live check AS THAT USER: every cfg_* list works, every write / UI-config attempt must be refused (403).
// The write probes cannot change data even if ACL were wrong: update/destroy target id 0 (no such row) and
// the create probe uses workspace_slug "__n1_acl_probe__" and is deleted again if it ever succeeds.
//
//   node nocobase/scripts/provision-acl.mjs [--test-user] [--no-verify]
//
// Run after provision-ui.mjs (needs the menu routes) and provision-workflow.mjs (needs cfg_activity).

import { randomBytes } from 'node:crypto';
import { createClient, NocoBaseError } from '../lib/client.mjs';
import { loadEnv, setEnvValue } from '../lib/env.mjs';
import { GROUP, PAGES, UI_COLLECTIONS } from '../lib/ui-spec.mjs';

loadEnv();
const args = new Set(process.argv.slice(2));
const log = (...m) => console.log('[provision-acl]', ...m);
const changes = [];
const warnings = [];
const nb = createClient();

const ROLE = {
  name: 'configurator_viewer',
  title: 'Configurator viewer',
  description: 'Read-only access to the Matrix Configurator pages and cfg_* collections. Provisioned by nocobase/scripts/provision-acl.mjs.',
  hidden: false,
  allowConfigure: false,
  allowNewMenu: false,
  allowNewMobileMenu: false,
  snippets: ['!pm', '!pm.*', '!ui.*'], // NocoBase stores them sorted
  strategy: { actions: [] },
};
const VIEWER = { username: 'configurator-viewer', nickname: 'Configurator viewer', email: 'configurator-viewer@matrix-configurator.test' };

function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

// ------------------------------------------------------------------ role

async function ensureRole() {
  const existing = await nb.get('roles', { name: ROLE.name });
  if (!existing) {
    await nb.request('POST', 'roles:create', { body: ROLE });
    changes.push(`created role ${ROLE.name}`);
    return;
  }
  const drift = Object.keys(ROLE).filter((k) => canon(existing[k]) !== canon(ROLE[k]));
  if (drift.length) {
    await nb.request('POST', 'roles:update', { query: { filterByTk: ROLE.name }, body: ROLE });
    changes.push(`updated role ${ROLE.name} (${drift.join(', ')})`);
  }
}

async function ensureDataSourceStrategy() {
  const res = await nb.request('GET', 'dataSources/main/roles:get', { query: { filterByTk: ROLE.name } });
  if (canon(res?.data?.strategy) !== canon(ROLE.strategy)) {
    await nb.request('POST', 'dataSources/main/roles:update', { query: { filterByTk: ROLE.name }, body: { strategy: ROLE.strategy } });
    changes.push(`set global table strategy of ${ROLE.name} on data source "main" to no actions`);
  }
}

async function ensureTablePermissions() {
  const collections = await nb.list('collections', { filter: { name: { $in: UI_COLLECTIONS } }, appends: ['fields'] });
  for (const name of UI_COLLECTIONS) {
    const coll = collections.find((c) => c.name === name);
    if (!coll) {
      warnings.push(`collection ${name} missing; no permission granted (run provision.mjs / provision-workflow.mjs first)`);
      continue;
    }
    const fields = (coll.fields || []).map((f) => f.name).sort();
    const want = { usingActionsConfig: true, actions: [{ name: 'view', fields }] };
    const base = `roles/${ROLE.name}/dataSourceResources`;
    const filter = { dataSourceKey: 'main', name };
    const current = (await nb.request('GET', `${base}:get`, { query: { filter, appends: ['actions'] } }))?.data;
    if (!current) {
      await nb.request('POST', `${base}:create`, { body: { dataSourceKey: 'main', name, ...want } });
      changes.push(`granted ${ROLE.name} "view" on ${name}`);
      continue;
    }
    const have = {
      usingActionsConfig: current.usingActionsConfig,
      actions: (current.actions || []).map((a) => ({ name: a.name, fields: [...(a.fields || [])].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
    };
    if (canon(have) !== canon(want)) {
      await nb.request('POST', `${base}:update`, { query: { filter }, body: want });
      changes.push(`reset ${ROLE.name} permissions on ${name} to "view" only`);
    }
  }
}

// ------------------------------------------------------------------ menu routes

async function ensureRoutes() {
  const [group] = await nb.list('desktopRoutes', { filter: { type: 'group', title: GROUP.title } });
  if (!group) {
    warnings.push(`menu group "${GROUP.title}" not found (run provision-ui.mjs first); no route permissions granted`);
    return;
  }
  const pages = await nb.list('desktopRoutes', { filter: { parentId: group.id } });
  const tabs = pages.length ? await nb.list('desktopRoutes', { filter: { parentId: { $in: pages.map((p) => p.id) } } }) : [];
  const want = [group, ...pages, ...tabs].map((r) => String(r.id)).sort();
  const have = ((await nb.request('GET', `roles/${ROLE.name}/desktopRoutes:list`, { query: { paginate: false } }))?.data || []).map((r) => String(r.id)).sort();
  if (canon(want) !== canon(have)) {
    await nb.request('POST', `roles/${ROLE.name}/desktopRoutes:set`, { body: want });
    changes.push(`menu permissions of ${ROLE.name}: "${GROUP.title}" group + ${pages.length} pages + ${tabs.length} tabs`);
  }
  const missingPages = PAGES.filter((p) => !pages.some((r) => r.schemaUid === p.pageSchemaUid)).map((p) => p.title);
  if (missingPages.length) warnings.push(`pages not provisioned yet: ${missingPages.join(', ')}`);
}

// ------------------------------------------------------------------ test user

async function ensureTestUser() {
  let email = process.env.NOCOBASE_VIEWER_EMAIL || VIEWER.email;
  let password = process.env.NOCOBASE_VIEWER_PASSWORD || '';
  const user = (await nb.list('users', { filter: { $or: [{ email }, { username: VIEWER.username }] }, appends: ['roles'] }))[0];
  if (!password) password = randomBytes(18).toString('base64url');
  if (!user) {
    await nb.request('POST', 'users:create', {
      body: { username: VIEWER.username, nickname: VIEWER.nickname, email, password, roles: [ROLE.name] },
    });
    changes.push(`created test user ${VIEWER.username} (role ${ROLE.name} only)`);
  } else {
    const roles = (user.roles || []).map((r) => r.name).sort();
    if (canon(roles) !== canon([ROLE.name])) {
      await nb.request('POST', `users/${user.id}/roles:set`, { body: [ROLE.name] });
      changes.push(`test user ${user.username}: roles ${roles.join(',') || '(none)'} → ${ROLE.name}`);
    }
    email = user.email || email;
    const probe = createClient({ token: '', email, password });
    const signInOk = process.env.NOCOBASE_VIEWER_PASSWORD
      ? await probe.request('GET', 'auth:check').then(() => true, () => false)
      : false;
    if (!signInOk) {
      await nb.request('POST', 'users:update', { query: { filterByTk: user.id }, body: { password } });
      changes.push(`test user ${user.username}: password reset (stored in .env)`);
    }
  }
  if (process.env.NOCOBASE_VIEWER_EMAIL !== email) setEnvValue('NOCOBASE_VIEWER_EMAIL', email);
  if (process.env.NOCOBASE_VIEWER_PASSWORD !== password) {
    setEnvValue('NOCOBASE_VIEWER_PASSWORD', password);
    changes.push('wrote NOCOBASE_VIEWER_EMAIL / NOCOBASE_VIEWER_PASSWORD to .env (gitignored; not printed)');
  }
  process.env.NOCOBASE_VIEWER_EMAIL = email;
  process.env.NOCOBASE_VIEWER_PASSWORD = password;
}

// ------------------------------------------------------------------ verification as the viewer

async function verifyAsViewer() {
  const email = process.env.NOCOBASE_VIEWER_EMAIL;
  const password = process.env.NOCOBASE_VIEWER_PASSWORD;
  if (!email || !password) {
    log('verify: skipped (no NOCOBASE_VIEWER_* credentials; run with --test-user to create a test user)');
    return true;
  }
  const viewer = createClient({ token: '', email, password });
  const results = [];
  const expect = async (label, wantAllowed, fn) => {
    let status;
    let note = '';
    try {
      const r = await fn();
      status = 200;
      if (r?.rows !== undefined) note = ` (${r.rows} rows)`;
      if (r?.cleanup) await r.cleanup();
    } catch (err) {
      if (!(err instanceof NocoBaseError)) throw err;
      status = err.status;
    }
    const allowed = status >= 200 && status < 300;
    results.push({ label: `${label}${note} → ${wantAllowed ? 'allowed' : 'denied'} expected`, status, ok: allowed === wantAllowed });
  };

  const check = await viewer.request('GET', 'roles:check');
  const roleName = check?.data?.role;
  results.push({ label: `signed in; current role = ${roleName}`, status: 200, ok: roleName === ROLE.name });
  const routes = (await viewer.request('GET', 'desktopRoutes:listAccessible', { query: { tree: true } }))?.data || [];
  const group = routes.find((r) => r.title === GROUP.title);
  const visible = (group?.children || []).map((c) => c.title);
  results.push({ label: `menu visible: ${GROUP.title} → ${visible.join(', ')}`, status: 200, ok: visible.length === PAGES.length && routes.length === 1 });

  for (const c of UI_COLLECTIONS) {
    await expect(`view   ${c}:list`, true, async () => {
      const res = await viewer.request('GET', `${c}:list`, { query: { pageSize: 1 } });
      return { rows: res?.meta?.count };
    });
  }
  await expect('update cfg_workspaces (id 0)', false, () => viewer.request('POST', 'cfg_workspaces:update', { query: { filterByTk: 0 }, body: { name: 'acl probe' } }));
  await expect('destroy cfg_releases (id 0)', false, () => viewer.request('POST', 'cfg_releases:destroy', { query: { filterByTk: 0 } }));
  await expect('create cfg_gates (__n1_acl_probe__)', false, async () => {
    await viewer.request('POST', 'cfg_gates:create', { body: { workspace_slug: '__n1_acl_probe__', from_key: 'probe', to_key: 'probe' } });
    return { cleanup: () => nb.destroy('cfg_gates', { workspace_slug: '__n1_acl_probe__' }) };
  });
  await expect('export cfg_stages', false, () => viewer.request('POST', 'cfg_stages:export', { body: { columns: [] } }));
  await expect('UI editor: flowModels:save', false, () => viewer.request('POST', 'flowModels:save', { body: { uid: 'n1-acl-probe', use: 'MarkdownBlockModel' } }));
  await expect('settings: collections:create', false, () => viewer.request('POST', 'collections:create', { body: { name: 'n1_acl_probe' } }));
  await expect('workflows:list (Settings → Workflow)', false, () => viewer.request('GET', 'workflows:list'));

  for (const r of results) log(`verify ${r.ok ? 'ok  ' : 'FAIL'} ${r.label}; got HTTP ${r.status}`);
  return results.every((r) => r.ok);
}

try {
  if (!(await nb.health({ deep: false }))) throw new Error(`NocoBase at ${nb.baseUrl} is not up`);
  await ensureRole();
  await ensureDataSourceStrategy();
  await ensureTablePermissions();
  await ensureRoutes();
  if (args.has('--test-user')) await ensureTestUser();
  const ok = args.has('--no-verify') ? true : await verifyAsViewer();
  for (const w of warnings) console.warn('[provision-acl] WARNING:', w);
  if (changes.length === 0) log('no changes — already provisioned');
  else {
    for (const c of changes) log(`change: ${c}`);
    log(`${changes.length} change(s) applied`);
  }
  if (!ok) throw new Error('viewer verification failed (see FAIL lines above)');
} catch (err) {
  console.error('[provision-acl] FAILED:', err?.message || err);
  if (err?.body) console.error(JSON.stringify(err.body).slice(0, 800));
  process.exit(1);
}

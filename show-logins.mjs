#!/usr/bin/env node
// Builds LOGINS.local.md — every login for the localhost sandbox, with passwords — from the
// gitignored sources where they live (.env files + app-stack/run/**/*.secrets.json).
// Re-run any time: smoke tests create fresh workspaces/users on every run, so the list changes.
//
//   node show-logins.mjs        → writes LOGINS.local.md (mode 600, gitignored) and prints a summary
//   cat LOGINS.local.md         → the full list
//
// This script contains no secrets; it only reads local files. Output never leaves this machine.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'LOGINS.local.md');
const APP = 'http://localhost:5173';

const readEnv = rel => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(fs.readFileSync(p, 'utf8').split('\n')
    .map(l => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
    .map(m => [m[1], m[2].replace(/^['"]|['"]$/g, '')]));
};
const readJson = rel => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return null; } };
const mtime = rel => { try { return fs.statSync(path.join(ROOT, rel)).mtime.toISOString().slice(0, 16).replace('T', ' '); } catch { return '?'; } };

const rootEnv = readEnv('.env');
const backendEnv = readEnv('app/backend/.env');
const stackEnv = readEnv('app-stack/.env');

const rows = []; // [section, role, url, code, login, password]
const add = (...r) => rows.push(r);

// Platform + NocoBase
add('Platform admin (app)', 'platform admin — approves/provisions workspaces, embedded configurator',
    `${APP}/#/admin`, '—', backendEnv.PLATFORM_ADMIN_EMAIL, backendEnv.PLATFORM_ADMIN_PASSWORD);
add('NocoBase', 'root admin — Matrix Configurator pages, workflow, ACL',
    'http://localhost:13000', '—', rootEnv.NOCOBASE_ROOT_EMAIL || rootEnv.NOCOBASE_ROOT_USERNAME, rootEnv.NOCOBASE_ROOT_PASSWORD);
if (rootEnv.NOCOBASE_VIEWER_EMAIL)
  add('NocoBase', 'configurator_viewer — read-only', 'http://localhost:13000', '—', rootEnv.NOCOBASE_VIEWER_EMAIL, rootEnv.NOCOBASE_VIEWER_PASSWORD);

// Sandbox workspaces (each file = one workspace's users)
const workspaces = [
  ['app-stack/run/f4b-journey/secrets.json', 'Chai Point Retail — F4b browser journey (custom modules)', j => j.users],
  ['app-stack/run/smoke/g3-last-run.secrets.json', 'G3 smoke (latest run) — saved views, creator rule, migration', j => j],
  ['app-stack/run/smoke/configurator-last-run.secrets.json', 'Configurator smoke (latest run) — custom module + v2 pinning', j => j],
  ['app-stack/run/smoke/last-run.secrets.json', 'Existing-flow smoke (latest run) — BD module', j => j],
];
const ROLE = { ba: 'business admin', business_admin: 'business admin', sup: 'supervisor', supervisor: 'supervisor',
               executive: 'executive', ex1: 'executive 1', ex2: 'executive 2' };
for (const [rel, label, users] of workspaces) {
  const j = readJson(rel);
  if (!j) continue;
  const code = j.workspace_code || '—';
  for (const [k, u] of Object.entries(users(j) || {})) {
    if (!u || typeof u !== 'object' || !u.email) continue;
    add(`${label} · updated ${mtime(rel)}`, ROLE[k] || k, code !== '—' ? `${APP}/#/login/${code}` : `${APP}`, code, u.email, u.password);
  }
}

// Developer access
add('Developer (psql)', 'sandbox app database `matrix` on 127.0.0.1:54330',
    'psql -h 127.0.0.1 -p 54330 -d matrix', '—', stackEnv.APP_DB_USER, stackEnv.APP_DB_PASSWORD);

const esc = v => String(v ?? '—').replace(/\|/g, '\\|');
let md = `# Sandbox logins (LOCAL ONLY — gitignored, never commit or share)\n\n`;
md += `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by \`node show-logins.mjs\`. Re-run after any smoke test — `;
md += `smokes create fresh workspaces and users each run.\n\nAll services: \`./app-stack/start.sh\` · check: \`./app-stack/status.sh\`.\n\n`;
let section = null;
for (const [sec, role, url, code, login, pw] of rows) {
  if (sec !== section) {
    md += `\n## ${sec}\n\n| Role | Sign in at | Workspace code | Login | Password |\n|---|---|---|---|---|\n`;
    section = sec;
  }
  md += `| ${esc(role)} | ${esc(url)} | ${esc(code)} | ${esc(login)} | \`${esc(pw)}\` |\n`;
}
md += `\n---\nNot listed: **Agent Coffee** (\`AGENTC-2313B9A4C05CAF00\`) — its business admin was never claimed (setup code not stored); `;
md += `the platform admin can re-issue a setup code once the SEC-1 fix lands. **ADITYA TEST** is a configurator draft only (not provisioned), so it has no logins.\n`;

fs.writeFileSync(OUT, md, { mode: 0o600 });
fs.chmodSync(OUT, 0o600);
console.log(`wrote ${path.relative(process.cwd(), OUT) || OUT}: ${rows.length} logins in ${new Set(rows.map(r => r[0])).size} groups (mode 600, gitignored). View: cat LOGINS.local.md`);

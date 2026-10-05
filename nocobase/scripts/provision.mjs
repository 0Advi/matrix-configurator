#!/usr/bin/env node
// Idempotently provision the Workspace Configurator data model in NocoBase:
//   1. create any missing `cfg_*` collections (collection-manager API, so they show up in the admin UI)
//   2. add any missing fields to existing collections (never alters or drops existing ones; drift is reported)
//   3. ensure a long-lived root API key exists and is stored in `.env` as NOCOBASE_TOKEN
//      (skipped with --no-api-key, or when the API Keys plugin is unavailable)
// Re-running is a no-op when everything is already in place.
//
//   node nocobase/scripts/provision.mjs [--no-api-key]

import { createClient, NocoBaseError } from '../lib/client.mjs';
import { loadEnv, setEnvValue, ENV_PATH } from '../lib/env.mjs';
import { COLLECTIONS, presetFields } from '../lib/schema.mjs';

loadEnv();
const args = new Set(process.argv.slice(2));
const API_KEY_NAME = 'matrix-configurator';
const changes = [];
const warnings = [];
const log = (...m) => console.log('[provision]', ...m);

async function waitUntilUp(nb, seconds = 120) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (await nb.health({ deep: false })) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`NocoBase at ${nb.baseUrl} is not up (run: docker compose up -d && node nocobase/scripts/wait-for-nocobase.mjs)`);
}

/** Session client using only root credentials (ignores NOCOBASE_TOKEN). */
const root = createClient({ token: '' });

/** Is the configured NOCOBASE_TOKEN accepted by NocoBase? */
async function tokenIsValid(token) {
  if (!token) return false;
  const probe = createClient({ token, email: '', password: '' });
  try {
    await probe.request('GET', 'auth:check');
    return true;
  } catch (err) {
    if (err instanceof NocoBaseError && err.status === 401) return false;
    throw err;
  }
}

async function provisionCollections() {
  const names = COLLECTIONS.map((c) => c.name);
  const existing = await root.list('collections', { filter: { name: { $in: names } }, appends: ['fields'] });
  const byName = new Map(existing.map((c) => [c.name, c]));

  for (const def of COLLECTIONS) {
    const current = byName.get(def.name);
    if (!current) {
      await root.request('POST', 'collections:create', {
        body: {
          name: def.name,
          title: def.title,
          description: def.description,
          template: 'general',
          logging: true,
          autoGenId: false,
          createdAt: true,
          updatedAt: true,
          createdBy: true,
          updatedBy: true,
          sortable: false,
          titleField: def.titleField,
          fields: [...presetFields(), ...def.fields],
        },
      });
      changes.push(`created collection ${def.name} (${def.fields.length} fields)`);
      log(`created collection ${def.name}`);
      continue;
    }

    const have = new Map((current.fields || []).map((f) => [f.name, f]));
    for (const field of def.fields) {
      const f = have.get(field.name);
      if (!f) {
        await root.request('POST', `collections/${def.name}/fields:create`, { body: field });
        changes.push(`added field ${def.name}.${field.name}`);
        log(`added field ${def.name}.${field.name}`);
        continue;
      }
      if (f.type !== field.type) warnings.push(`${def.name}.${field.name}: type is ${f.type}, expected ${field.type} (left unchanged)`);
      if (field.unique && !f.unique) warnings.push(`${def.name}.${field.name}: expected unique (left unchanged)`);
    }
  }
}

async function provisionApiKey() {
  if (args.has('--no-api-key')) {
    log('API key: skipped (--no-api-key)');
    return;
  }
  const configured = (process.env.NOCOBASE_TOKEN || '').trim();
  if (await tokenIsValid(configured)) {
    log('API key: NOCOBASE_TOKEN in .env is valid');
    return;
  }
  if (configured) warnings.push('NOCOBASE_TOKEN in .env was rejected by NocoBase; replacing it');

  const enabled = await root.request('GET', 'pm:listEnabled').catch(() => null);
  const pluginNames = (enabled?.data || []).map((p) => p.name);
  if (enabled && !pluginNames.includes('api-keys')) {
    warnings.push('API Keys plugin not enabled; NOCOBASE_TOKEN left empty (client will sign in with root creds)');
    return;
  }

  // Remove stale keys we created earlier (their tokens are no longer in .env).
  const stale = await root.list('apiKeys', { filter: { name: API_KEY_NAME } }).catch(() => []);
  for (const k of stale) await root.request('POST', 'apiKeys:destroy', { query: { filterByTk: k.id } });

  const res = await root.request('POST', 'apiKeys:create', {
    body: { name: API_KEY_NAME, role: { name: 'root' }, expiresIn: 'never' },
  });
  const token = res?.data?.token;
  if (!token) throw new Error('apiKeys:create returned no token');
  if (!(await tokenIsValid(token))) throw new Error('newly created API key was rejected by NocoBase');
  setEnvValue('NOCOBASE_TOKEN', token);
  process.env.NOCOBASE_TOKEN = token;
  changes.push(`created root API key "${API_KEY_NAME}" and wrote NOCOBASE_TOKEN to ${ENV_PATH}`);
  log(`API key: created "${API_KEY_NAME}" (root role, never expires) → .env NOCOBASE_TOKEN`);
}

async function verify() {
  const nb = createClient(); // as the app will use it (API key if present)
  for (const def of COLLECTIONS) await nb.list(def.name, { pageSize: 1, limit: 1 });
  if (!(await nb.health())) throw new Error('deep health check failed after provisioning');
  log(`verified: all ${COLLECTIONS.length} collections readable via client (auth mode: ${nb.authMode})`);
}

try {
  await waitUntilUp(root);
  await provisionCollections();
  await provisionApiKey();
  await verify();
  for (const w of warnings) console.warn('[provision] WARNING:', w);
  if (changes.length === 0) log('no changes — already provisioned');
  else log(`${changes.length} change(s) applied`);
} catch (err) {
  console.error('[provision] FAILED:', err?.message || err);
  process.exit(1);
}

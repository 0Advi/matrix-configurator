// skipcq: JS-0833
// The signed-in tenant's modules, from its published configuration (F4b).
//
// GET /workspace/modules (docs/F4-API.md §2.1) returns the ENABLED modules in release order
// with label, kind (builtin|custom), supervisor_only, route, the caller's roles and the
// manifest's navigation. A tenant that never published gets the 9 built-ins (release: null),
// i.e. exactly today's behaviour. The chrome (sidebar, module switchers, routing) reads it
// from here instead of the hard-coded WORKSPACE_MODULES list.
//
// One fetch per token, shared by every component through a small module-level store (no
// provider needed — tests and pages that never sign in never fetch). Until it answers,
// consumers get status 'loading' and should fall back to the static list.
import { useEffect, useState } from 'react';
import { createApiClient } from '../services/api/axiosClient.js';
import * as authToken from '../services/api/authToken.js';

// The bearer token, read defensively: this hook sits in shared chrome (sidebar, switchers)
// that many unit tests render with a partial mock of authToken.js — a missing export must
// mean "not signed in", not a crash.
function readToken() {
  try { return authToken.getAuthToken?.() ?? null; } catch { return null; }
}
function useTokenSafe() {
  const [token, setToken] = useState(readToken);
  useEffect(() => {
    try { return authToken.subscribeAuthToken?.((t) => setToken(t ?? null)); } catch { return undefined; }
  }, []);
  return token;
}

let client = null;
const EMPTY = Object.freeze([]);
const store = { token: null, status: 'idle', data: null, error: null, promise: null };
const listeners = new Set();
const emit = () => listeners.forEach((l) => { try { l(); } catch { /* listener gone */ } });

export async function fetchWorkspaceModules() {
  if (!client) client = createApiClient();
  return (await client.get('/workspace/modules')).data;
}

export function loadWorkspaceModules(token, { force = false } = {}) {
  if (!token) {
    if (store.token !== null) Object.assign(store, { token: null, status: 'idle', data: null, error: null, promise: null });
    return Promise.resolve(null);
  }
  if (!force && store.token === token && (store.status === 'ready' || store.promise)) return store.promise || Promise.resolve(store.data);
  if (store.token !== token) Object.assign(store, { data: null, error: null });
  store.token = token;
  store.status = store.data ? 'refreshing' : 'loading';
  const p = fetchWorkspaceModules()
    .then((d) => { if (store.token === token) Object.assign(store, { data: d, status: 'ready', error: null }); return d; })
    .catch((e) => { if (store.token === token) Object.assign(store, { status: 'error', error: e?.detail || e?.message || 'Could not load modules' }); return null; })
    .finally(() => { if (store.promise === p) store.promise = null; emit(); });
  store.promise = p;
  emit();
  return p;
}

/** Test helper: forget everything. */
export function __resetWorkspaceModules() {
  Object.assign(store, { token: null, status: 'idle', data: null, error: null, promise: null });
  emit();
}

export function useWorkspaceModules() {
  const token = useTokenSafe();
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => { loadWorkspaceModules(token); }, [token]);
  const mine = token && store.token === token;
  const data = mine ? store.data : null;
  const modules = Array.isArray(data?.modules) ? data.modules : EMPTY;
  return {
    status: mine ? store.status : 'idle',
    error: mine ? store.error : null,
    release: data?.release || null,
    modules,
    /** The module row for `key`, or null (disabled or unknown modules are not in the list). */
    get: (key) => modules.find((m) => m.key === key) || null,
    reload: () => loadWorkspaceModules(token, { force: true }),
  };
}

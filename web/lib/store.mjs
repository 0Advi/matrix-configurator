// NocoBase-backed persistence for the web server, with graceful degradation.
//
// - Mode is 'nocobase' when the B client module loads AND client.health() is true
//   (cached a few seconds); otherwise 'local' and every state/release call throws
//   UnavailableError (the browser keeps using localStorage, exactly like the original).
// - The client is loaded lazily and re-tried, so the server can start before NocoBase
//   (or before nocobase/lib/client.mjs exists) and switch to 'nocobase' later.
// - Writes are serialized; PUT honours If-Match (optimistic concurrency on the whole blob).
// - Projections (cfg_modules/gates/stages) run asynchronously after a save, coalesced per
//   workspace; a projection failure never fails the save.
import { createHash } from 'node:crypto';
import { canonicalJSON } from '../public/bridge-core.js';
import { blobToWorkspaceRows, rowsToBlob, projectWorkspace, validateBlob, STATE_FORMAT } from './projection.mjs';

export class ConflictError extends Error {
  constructor(etag) { super('state changed on the server since it was loaded'); this.code = 'CONFLICT'; this.etag = etag; }
}
export class UnavailableError extends Error {
  constructor(msg = 'NocoBase is not available (local mode)') { super(msg); this.code = 'UNAVAILABLE'; }
}
export class ValidationError extends Error {
  constructor(msg) { super(msg); this.code = 'INVALID'; }
}

export function etagOf(blob) {
  return '"' + createHash('sha256').update(canonicalJSON(blob || {})).digest('hex').slice(0, 32) + '"';
}
function stripWeak(tag) { return String(tag || '').trim().replace(/^W\//, ''); }
export function etagMatches(header, etag) {
  return String(header).split(',').map(stripWeak).some(t => t === '*' || t === stripWeak(etag));
}

export function withTimeout(promise, ms, what = 'operation') {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ' timed out after ' + ms + 'ms')), ms); })
  ]);
}

const WS_FIELDS = ['slug', 'name', 'initials', 'is_custom', 'live_version', 'draft_version', 'state'];
function pickWs(row) { const o = {}; for (const k of WS_FIELDS) o[k] = row[k] === undefined ? null : row[k]; return o; }

/**
 * @param {object} o
 * @param {() => Promise<{createClient: Function}>} o.loadClient   dynamic import of nocobase/lib/client.mjs
 * @param {object} [o.clientOptions]                                passed to createClient
 * @param {() => Array} [o.builtinSeeds]                            demo workspaces to upsert (is_custom=false)
 */
export function createStore(o) {
  const log = o.log || console;
  const healthTtlMs = o.healthTtlMs ?? 5000;
  const failTtlMs = o.failTtlMs ?? 3000;
  const healthTimeoutMs = o.healthTimeoutMs ?? 6000;
  const callTimeoutMs = o.callTimeoutMs ?? 15000;
  const projectionTimeoutMs = o.projectionTimeoutMs ?? 120000;

  let client = null;
  let clientState = 'not-loaded';
  let clientError = null;
  let loading = null;
  let health = { ok: false, at: 0 };
  let checking = null;
  let seededThisProcess = false;
  let lock = Promise.resolve();
  const projQueue = new Map();
  let projRunning = null;
  const projection = { pending: 0, runs: 0, lastRunAt: null, lastError: null };

  async function ensureClient() {
    if (client) return client;
    if (!loading) {
      loading = (async () => {
        try {
          const mod = await o.loadClient();
          if (!mod || typeof mod.createClient !== 'function') throw new Error('client module has no createClient export');
          client = mod.createClient(o.clientOptions || {});
          clientState = 'loaded';
          clientError = null;
        } catch (e) {
          clientState = e && e.code === 'ERR_MODULE_NOT_FOUND' ? 'missing' : (e && e.code === 'DISABLED' ? 'disabled' : 'error');
          clientError = e;
        }
      })().finally(() => { loading = null; });
    }
    await loading;
    return client;
  }

  function snapshot() {
    return {
      mode: health.ok ? 'nocobase' : 'local',
      nocobase: health.ok,
      client: clientState,
      clientError: clientError ? String(clientError.message || clientError) : null,
      projection: { ...projection }
    };
  }

  // Stale-while-revalidate: once a result exists, a stale cache triggers a background
  // re-check and answers immediately, so /cfg/health stays fast for the browser. A failed
  // NocoBase call resets `health.at` to 0, which forces the next caller to wait for a check.
  async function status({ force = false } = {}) {
    const ttl = health.ok ? healthTtlMs : failTtlMs;
    const fresh = health.at && Date.now() - health.at < ttl;
    if (!force && fresh) return snapshot();
    if (!checking) {
      checking = (async () => {
        const c = await ensureClient();
        let ok = false;
        if (c) {
          try { ok = (await withTimeout(c.health({ timeoutMs: Math.min(4000, healthTimeoutMs) }), healthTimeoutMs, 'NocoBase health')) === true; } catch { ok = false; }
        }
        const was = health.ok;
        health = { ok, at: Date.now() };
        if (ok !== was) log.info?.(`[cfg] mode -> ${ok ? 'nocobase' : 'local'}`);
        if (ok && !seededThisProcess) seedBuiltins();
      })().finally(() => { checking = null; });
    }
    if (!force && health.at) return snapshot(); // stale but known: don't block the caller
    await checking;
    return snapshot();
  }

  async function available() {
    const s = await status();
    if (s.mode !== 'nocobase') throw new UnavailableError();
    return client;
  }
  async function call(fn, what, ms = callTimeoutMs) {
    const c = await available();
    try {
      return await withTimeout(fn(c), ms, what);
    } catch (e) {
      // A failed call may mean NocoBase went away: re-check health on the next request.
      health.at = 0;
      throw e;
    }
  }
  function withLock(fn) {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  }

  async function readState() {
    const rows = await call(c => c.listWorkspaces(), 'listWorkspaces');
    const custom = (rows || []).filter(r => r && r.is_custom);
    const blob = rowsToBlob(custom);
    return { blob, etag: etagOf(blob), rows: custom };
  }

  async function writeState(blob, ifMatch) {
    try { validateBlob(blob); } catch (e) { throw new ValidationError(e.message); }
    return withLock(async () => {
      const cur = await readState();
      if (ifMatch && !etagMatches(ifMatch, cur.etag)) throw new ConflictError(cur.etag);
      const nextRows = blobToWorkspaceRows(blob);
      const remaining = new Map(cur.rows.map(r => [r.slug, r]));
      const changed = [];
      for (const row of nextRows) {
        const old = remaining.get(row.slug);
        remaining.delete(row.slug);
        if (old && canonicalJSON(pickWs(old)) === canonicalJSON(row)) continue;
        await call(c => c.upsertWorkspace(row), 'upsertWorkspace');
        changed.push(row);
      }
      const deleted = [...remaining.keys()];
      for (const slug of deleted) await call(c => c.deleteWorkspace(slug), 'deleteWorkspace');
      for (const row of changed) queueProjection(row.slug, row.state.data);
      for (const slug of deleted) queueProjection(slug, null);
      return { etag: etagOf(rowsToBlob(nextRows)), changed: changed.map(r => r.slug), deleted };
    });
  }

  function validateRelease(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new ValidationError('release must be a JSON object');
    if (typeof r.workspace_slug !== 'string' || !r.workspace_slug.trim() || r.workspace_slug.length > 200) throw new ValidationError('workspace_slug must be a non-empty string');
    const version = Number(r.version);
    if (!Number.isInteger(version) || version < 1) throw new ValidationError('version must be a positive integer');
    if (r.reason != null && typeof r.reason !== 'string') throw new ValidationError('reason must be a string');
    if (r.published_by != null && typeof r.published_by !== 'string') throw new ValidationError('published_by must be a string');
    if (r.manifest != null && (typeof r.manifest !== 'object' || Array.isArray(r.manifest))) throw new ValidationError('manifest must be an object or null');
    return {
      workspace_slug: r.workspace_slug.trim(),
      version,
      reason: r.reason || '',
      manifest: r.manifest || null,
      published_by: r.published_by || 'unknown'
    };
  }

  /** Append-only and idempotent on (workspace_slug, version). */
  async function appendRelease(input) {
    const rel = validateRelease(input);
    return withLock(async () => {
      const existing = await call(c => c.listReleases(rel.workspace_slug), 'listReleases');
      const dup = (existing || []).find(x => Number(x.version) === rel.version);
      if (dup) return { duplicate: true, release: dup };
      const row = await call(c => c.appendRelease(rel), 'appendRelease');
      return { duplicate: false, release: row };
    });
  }

  async function listReleases(slug) {
    if (typeof slug !== 'string' || !slug.trim()) throw new ValidationError('query parameter ws is required');
    return call(c => c.listReleases(slug.trim()), 'listReleases');
  }

  function queueProjection(slug, stash) {
    projQueue.set(slug, stash);
    projection.pending = projQueue.size;
    if (!projRunning) projRunning = runProjections().finally(() => { projRunning = null; });
  }
  async function runProjections() {
    while (projQueue.size) {
      const [slug, stash] = projQueue.entries().next().value;
      projQueue.delete(slug);
      projection.pending = projQueue.size;
      try {
        const rows = stash ? projectWorkspace(slug, stash) : { modules: [], gates: [], stages: [] };
        const filter = { workspace_slug: slug };
        await call(c => c.replaceWhere('cfg_modules', filter, rows.modules), 'replaceWhere cfg_modules', projectionTimeoutMs);
        await call(c => c.replaceWhere('cfg_gates', filter, rows.gates), 'replaceWhere cfg_gates', projectionTimeoutMs);
        await call(c => c.replaceWhere('cfg_stages', filter, rows.stages), 'replaceWhere cfg_stages', projectionTimeoutMs);
        projection.runs++;
        projection.lastRunAt = new Date().toISOString();
        projection.lastError = null;
      } catch (e) {
        projection.lastError = { slug, message: String(e && e.message || e), at: new Date().toISOString() };
        log.warn?.(`[cfg] projection failed for ${slug}: ${projection.lastError.message}`);
      }
    }
  }
  /** Resolves when no projection work is queued or running (used by tests / smoke checks). */
  async function projectionsIdle() {
    while (projRunning) await projRunning;
  }

  // Upserts the v5 demo workspaces as read-only reference rows (is_custom=false) once per
  // process, so NocoBase's admin UI shows real modules/gates/stages before anyone creates a
  // custom workspace. They never appear in GET /cfg/state (v5 does not persist them).
  function seedBuiltins() {
    if (seededThisProcess || !o.builtinSeeds) return;
    seededThisProcess = true;
    (async () => {
      let seeds;
      try { seeds = o.builtinSeeds(); } catch (e) { log.warn?.(`[cfg] could not evaluate v5 seeds: ${e.message}`); return; }
      for (const b of seeds) {
        try {
          await withLock(() => call(c => c.upsertWorkspace({
            slug: b.workspace.slug, name: b.workspace.name, initials: b.initials, is_custom: false,
            live_version: Number(b.stash.liveV) || 0, draft_version: Number(b.stash.draftV) || 1,
            state: { format: STATE_FORMAT, builtin: true, workspace: b.workspace, order: -1, data: b.stash }
          }), 'upsertWorkspace (builtin)'));
          queueProjection(b.workspace.slug, b.stash);
        } catch (e) {
          seededThisProcess = false; // retry on the next availability check
          log.warn?.(`[cfg] seeding built-in workspace ${b.workspace.slug} failed: ${e.message}`);
          return;
        }
      }
    })();
  }

  return { status, readState, writeState, appendRelease, listReleases, projectionsIdle };
}

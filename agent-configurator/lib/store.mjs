// The design-time draft store = the configurator server's /cfg API (web/server.mjs), i.e. the
// very blob the visual configurator (http://localhost:4300 and the in-app copy under /#/admin)
// hydrates from: v5's localStorage['wsconfig_v5_custom'] = { customWs: [...], data: {[id]: stash} }.
//
// Conflict safety: every read returns the server ETag; every write sends If-Match. A 409 means a
// human (or another agent) saved in between — the op is NOT retried blindly: we re-read and report.
// The server persists the blob to NocoBase (cfg_workspaces + projections) and refuses writes in
// local mode (503), in which case we refuse too: drafts would otherwise live only in one browser.
import { OpError } from './errors.mjs';

const TIMEOUT_MS = 15000;

export class ConflictError extends OpError {
  constructor(message, details) { super('conflict', message, details); }
}

function emptyBlob() { return { customWs: [], data: {} }; }
function normalize(blob) {
  if (!blob || typeof blob !== 'object' || !Array.isArray(blob.customWs)) return emptyBlob();
  return { customWs: blob.customWs, data: blob.data && typeof blob.data === 'object' ? blob.data : {} };
}

/**
 * HTTP store against the configurator server.
 * @param {{ baseUrl: string, fetchImpl?: typeof fetch }} opts
 */
export function createHttpStore({ baseUrl, fetchImpl = fetch }) {
  const base = baseUrl.replace(/\/+$/, '');

  async function call(method, path, { body, headers = {} } = {}) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new OpError('unavailable', `The configurator server at ${base} is not reachable (${e.name === 'TimeoutError' ? 'timeout' : e.message}). Start it with the project's start.sh — the agent does not start services itself.`);
    }
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; } }
    return { status: res.status, data, etag: res.headers.get('etag') };
  }

  function localMode() {
    return new OpError('unavailable', 'The configurator server is in LOCAL mode (NocoBase is unreachable): drafts would only live in one browser\'s localStorage, so the agent refuses to read or write them. Bring NocoBase back (start.sh), then retry.');
  }

  return {
    kind: 'http',
    baseUrl: base,
    async health() {
      const r = await call('GET', '/cfg/health');
      return r.data || {};
    },
    /** → { blob, etag } */
    async read() {
      const r = await call('GET', '/cfg/state');
      if (r.status === 503) throw localMode();
      if (r.status !== 200) throw new OpError('unavailable', `GET /cfg/state answered ${r.status}`, { status: r.status });
      return { blob: normalize(r.data), etag: r.etag };
    },
    /** Write the whole blob with If-Match. → { etag, changed, deleted } */
    async write(blob, etag) {
      if (!etag) throw new OpError('internal', 'refusing an unconditional write: no ETag from the read');
      const r = await call('PUT', '/cfg/state', { body: blob, headers: { 'If-Match': etag } });
      if (r.status === 409) throw new ConflictError('The drafts changed on the server since they were read (someone edited in the visual configurator, or another agent wrote). Nothing was written.', { server_etag: r.data && r.data.etag });
      if (r.status === 503) throw localMode();
      if (r.status !== 200) throw new OpError('unavailable', `PUT /cfg/state answered ${r.status}: ${(r.data && r.data.error) || ''}`.trim(), { status: r.status });
      return { etag: r.etag || (r.data && r.data.etag), changed: (r.data && r.data.changed) || [], deleted: (r.data && r.data.deleted) || [] };
    },
    /** Design-time release ledger (cfg_releases), idempotent on (workspace_slug, version). */
    async appendRelease(rel) {
      const r = await call('POST', '/cfg/releases', { body: rel });
      if (r.status === 503) throw localMode();
      if (r.status !== 200 && r.status !== 201) throw new OpError('unavailable', `POST /cfg/releases answered ${r.status}`, { status: r.status });
      return { duplicate: !!(r.data && r.data.duplicate) };
    },
    async listReleases(slug) {
      const r = await call('GET', '/cfg/releases?ws=' + encodeURIComponent(slug));
      if (r.status === 503) throw localMode();
      if (r.status !== 200) return [];
      return Array.isArray(r.data) ? r.data : [];
    },
  };
}

/**
 * In-memory store with the same ETag/409 semantics (tests, dry runs). `bump()` simulates a
 * concurrent edit by someone else.
 */
export function createMemoryStore(initial = emptyBlob()) {
  let blob = JSON.parse(JSON.stringify(normalize(initial)));
  let version = 1;
  const releases = [];
  const etag = () => `"mem-${version}"`;
  return {
    kind: 'memory',
    async health() { return { ok: true, mode: 'memory' }; },
    async read() { return { blob: JSON.parse(JSON.stringify(blob)), etag: etag() }; },
    async write(next, ifMatch) {
      if (ifMatch !== etag()) throw new ConflictError('The drafts changed on the server since they were read. Nothing was written.', { server_etag: etag() });
      blob = JSON.parse(JSON.stringify(next));
      version += 1;
      return { etag: etag(), changed: [], deleted: [] };
    },
    async appendRelease(rel) {
      if (releases.some(r => r.workspace_slug === rel.workspace_slug && r.version === rel.version)) return { duplicate: true };
      releases.push(JSON.parse(JSON.stringify(rel)));
      return { duplicate: false };
    },
    async listReleases(slug) { return releases.filter(r => r.workspace_slug === slug); },
    // test helpers
    snapshot() { return JSON.parse(JSON.stringify(blob)); },
    releases,
    bump(mutator) { if (mutator) mutator(blob); version += 1; },
  };
}

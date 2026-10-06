// Client for the Matrix app's platform API (docs/F4-API.md §1) — the run-time side of D2.
//
//   POST /tenancy/admin/login                      → 30-minute admin JWT (sent as X-Platform-Admin-Key)
//   GET  /platform/workspaces[/{ref}]              list / detail (status, code, releases, registry)
//   POST /platform/workspaces                      provision a tenant (first publish)
//   POST /platform/workspaces/{ref}/releases       publish (422 manifest_invalid + findings)
//   POST /platform/workspaces/{ref}/releases/validate   dry run
//   GET  /platform/workspaces/{ref}/releases/{v}   one release incl. manifest
//   POST /platform/workspaces/{ref}/migrations     G3: dry-run / execute "migrate running cases" (docs/G3-API.md §1)
//   GET  /platform/workspaces/{ref}/migrations[/{id}]   G3: executed migrations / one incl. its journal
//
// Secrets: the credentials are read lazily from config and used for the login call only; the
// token lives in this process's memory (never on disk, never in a result, never logged). Sign-in
// is rate-limited by the app (10 per 5 minutes per IP, shared with the browser portal), so the
// token is cached for its lifetime and a 401 triggers exactly one re-login.
import { OpError } from './errors.mjs';

const TIMEOUT_MS = 30000;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MARGIN_MS = 60 * 1000;
const RETRY_BUDGET_MS = 16000;
// A migration execute runs one locked transaction per site; give it longer than a normal call. It is
// never re-sent after a timeout (the app may still be working on it).
const MIGRATION_EXECUTE_TIMEOUT_MS = 120000;

function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch { return null; }
}

function detailText(data) {
  if (!data) return '';
  if (typeof data.detail === 'string') return data.detail;
  if (Array.isArray(data.detail)) return data.detail.map(d => `${(d.loc || []).join('.')}: ${d.msg}`).join('; ');
  return '';
}

/**
 * @param {object} o
 * @param {string} o.apiUrl                         e.g. http://127.0.0.1:8000/api
 * @param {() => ({email:string,password:string}|null)} o.credentials
 * @param {typeof fetch} [o.fetchImpl]
 * @param {() => number} [o.now]
 */
export function createAppClient({ apiUrl, credentials, fetchImpl = fetch, now = Date.now, retryBudgetMs = RETRY_BUDGET_MS, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const base = apiUrl.replace(/\/+$/, '');
  let session = null; // { token, expiresAt }
  let logins = 0;
  let retries = 0;

  /**
   * One HTTP call, riding out a backend restart (~15 s by default) with backoff 0.5 → 4 s:
   *  - connection refused (nothing was sent to the app)  → retried for every call;
   *  - other transport errors and 502/503/504            → retried only when `idempotent`
   *    (reads, the dry-run validate, sign-in). A provision or publish is never re-sent after
   *    the app may have seen it: a second provision would lose the one-time setup code and a
   *    second publish would create a duplicate release — release_status tells what happened.
   */
  async function raw(method, path, { body, headers = {}, idempotent = method === 'GET', timeoutMs = TIMEOUT_MS, unsentHint } = {}) {
    const started = now();
    for (let attempt = 0; ; attempt++) {
      let res = null, err = null;
      try {
        res = await fetchImpl(base + path, {
          method,
          headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) { err = e; }
      const refused = err && /ECONNREFUSED/.test(String((err.cause && (err.cause.code || err.cause.message)) || err.message));
      const transient = err ? (refused || (idempotent && err.name !== 'TimeoutError')) : (idempotent && [502, 503, 504].includes(res.status));
      const wait = Math.min(4000, 500 * 2 ** attempt);
      if (transient && now() - started + wait <= retryBudgetMs) { retries += 1; await sleep(wait); continue; }
      if (err) {
        throw new OpError('unavailable', `The Matrix app backend at ${base} is not reachable (${err.name === 'TimeoutError' ? 'timeout' : (refused ? 'connection refused' : err.message)})${attempt ? ` after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}` : ''}. It may be restarting — retry shortly; the agent does not start services (check app-stack/status.sh).${idempotent ? '' : (' ' + (unsentHint || 'If this was a publish, run release_status before retrying.'))}`);
      }
      return finish(res);
    }
  }

  async function finish(res) {
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = { detail: text.slice(0, 300) }; } }
    return { status: res.status, data, retryAfter: res.headers.get('retry-after') };
  }

  async function login() {
    const creds = credentials ? credentials() : null;
    if (!creds) {
      throw new OpError('not_configured', 'No platform-admin credentials: set MATRIX_PLATFORM_ADMIN_EMAIL and MATRIX_PLATFORM_ADMIN_PASSWORD (or MATRIX_APP_ENV_FILE pointing at the sandbox app/backend/.env). Draft-only ops keep working without them.');
    }
    logins += 1;
    const r = await raw('POST', '/tenancy/admin/login', { body: { email: creds.email, password: creds.password }, idempotent: true });
    if (r.status === 429) {
      const s = Number(r.retryAfter) || 300;
      throw new OpError('rate_limited', `Platform-admin sign-in is rate limited by the app (10 per 5 minutes per IP, shared with the browser portal). Wait up to ${s}s and retry; do not loop.`, { retry_after_s: s });
    }
    if (r.status === 401) throw new OpError('not_configured', 'Platform-admin sign-in was refused (401): the configured credentials are not valid for this app.');
    if (r.status === 503) throw new OpError('not_configured', 'The app answered 503 to sign-in: its platform-admin portal is disabled (PLATFORM_ADMIN_EMAIL/PASSWORD unset on the backend), or it is still starting.');
    if (r.status !== 200 || !r.data || !r.data.token) throw new OpError('app_error', `Platform-admin sign-in failed (${r.status}).`, { status: r.status });
    const token = r.data.token;
    const exp = jwtExpiryMs(token) || (now() + DEFAULT_TTL_MS);
    session = { token, expiresAt: exp - MARGIN_MS };
  }

  async function authed(method, path, opts = {}) {
    if (!session || now() >= session.expiresAt) await login();
    let r = await raw(method, path, { ...opts, headers: { 'X-Platform-Admin-Key': session.token } });
    if (r.status === 401) {
      session = null;
      await login();
      r = await raw(method, path, { ...opts, headers: { 'X-Platform-Admin-Key': session.token } });
    }
    if (r.status === 429) {
      const s = Number(r.retryAfter) || 60;
      throw new OpError('rate_limited', `The app rate-limited ${method} ${path}. Wait ${s}s and retry.`, { retry_after_s: s });
    }
    if (r.status >= 500) throw new OpError('app_error', `The app answered ${r.status} to ${method} ${path}: ${detailText(r.data) || 'server error'}`, { status: r.status });
    return r;
  }

  const enc = encodeURIComponent;
  return {
    get configured() { return !!(credentials && credentials()); },
    get signedIn() { return !!session; },
    get loginCount() { return logins; },
    get retryCount() { return retries; },
    async health() {
      const r = await raw('GET', '/health');
      return r.status === 200;
    },
    /** POST …/releases/validate → {ok, errors, warnings, findings, modules} */
    async validate(ref, manifest) {
      const r = await authed('POST', `/platform/workspaces/${enc(ref)}/releases/validate`, { body: { manifest }, idempotent: true });
      if (r.status !== 200) throw new OpError('app_error', `Dry-run validation answered ${r.status}: ${detailText(r.data)}`, { status: r.status, body: r.data });
      return r.data;
    },
    /** GET /platform/workspaces/{ref} → detail, or null when not provisioned (404). */
    async getWorkspace(ref) {
      const r = await authed('GET', `/platform/workspaces/${enc(ref)}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new OpError('app_error', `GET workspace answered ${r.status}: ${detailText(r.data)}`, { status: r.status });
      return r.data;
    },
    async listWorkspaces() {
      const r = await authed('GET', '/platform/workspaces');
      if (r.status !== 200) throw new OpError('app_error', `GET /platform/workspaces answered ${r.status}`, { status: r.status });
      return r.data;
    },
    async getRelease(ref, version) {
      const r = await authed('GET', `/platform/workspaces/${enc(ref)}/releases/${enc(version)}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new OpError('app_error', `GET release answered ${r.status}`, { status: r.status });
      return r.data;
    },
    /** POST /platform/workspaces → raw {status, data} (201 | 409 already_provisioned | 409 in progress | 422). */
    async provision(body) {
      return authed('POST', '/platform/workspaces', { body });
    },
    /** POST …/releases → raw {status, data} (201 | 404 | 409 | 422 manifest_invalid). */
    async publish(ref, body) {
      return authed('POST', `/platform/workspaces/${enc(ref)}/releases`, { body });
    },
    /**
     * POST …/migrations → raw {status, data} (200 | 404 unknown ref / unknown_release | 409 workspace_not_active /
     * no_release | 422 reason_required / same_release / body). A dry run writes nothing, so it is retried like a
     * read; an execute (`dry_run: false`) is sent at most once — only "connection refused" (nothing reached the
     * app) is retried — because the app may already be moving cases: check migration history instead.
     */
    async migrate(ref, body) {
      const execute = body.dry_run === false;
      return authed('POST', `/platform/workspaces/${enc(ref)}/migrations`, {
        body, idempotent: !execute,
        ...(execute ? { timeoutMs: MIGRATION_EXECUTE_TIMEOUT_MS, unsentHint: 'If this was a migration execute it may have run: check migration_status before retrying.' } : {}),
      });
    },
    /** GET …/migrations → raw {status, data:{items}} (executed migrations, newest first; dry runs are never stored). */
    async listMigrations(ref) {
      return authed('GET', `/platform/workspaces/${enc(ref)}/migrations`);
    },
    /** GET …/migrations/{id} → raw {status, data} (header + journal items). */
    async getMigration(ref, id) {
      return authed('GET', `/platform/workspaces/${enc(ref)}/migrations/${enc(id)}`);
    },
    detailText,
  };
}

// NocoBase client for the Workspace Configurator.
// ESM, zero dependencies (global fetch, Node >= 18). See docs/CONTRACT.md.
//
//   import { createClient } from '../nocobase/lib/client.mjs';
//   const nb = createClient();            // reads NOCOBASE_URL / NOCOBASE_TOKEN / NOCOBASE_ROOT_* from process.env
//   if (await nb.health()) { ... }
//
// Auth: if a token (NOCOBASE_TOKEN, an API key) is configured it is sent as a Bearer token.
// Otherwise the client signs in with the root e-mail/password (POST /api/auth:signIn with
// `X-Authenticator: basic`), caches the session token, follows NocoBase's `x-new-token`
// renewal header, and on HTTP 401 re-signs in once and retries the request. If an API key
// is rejected with 401 and root credentials are available, the client falls back to sign-in.

const DEFAULT_URL = 'http://localhost:13000';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGES = 10000;

/** Error raised for any non-2xx NocoBase response (or transport failure). */
export class NocoBaseError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, method?: string, path?: string, body?: any, cause?: any }} [info]
   */
  constructor(message, info = {}) {
    super(message, info.cause ? { cause: info.cause } : undefined);
    this.name = 'NocoBaseError';
    /** HTTP status (0 for network/timeout errors). */
    this.status = info.status ?? 0;
    /** NocoBase error code when provided (e.g. `INVALID_TOKEN`). */
    this.code = info.code;
    this.method = info.method;
    this.path = info.path;
    /** Parsed response body, if any. */
    this.body = info.body;
  }
}

/**
 * @typedef {Object} ClientOptions
 * @property {string} [baseUrl]   NocoBase origin, e.g. `http://localhost:13000` (env `NOCOBASE_URL`).
 * @property {string} [token]     Long-lived API key (env `NOCOBASE_TOKEN`). Empty → sign in with root creds.
 * @property {string} [email]     Root account e-mail or username (env `NOCOBASE_ROOT_EMAIL`).
 * @property {string} [password]  Root password (env `NOCOBASE_ROOT_PASSWORD`).
 * @property {number} [timeoutMs] Per-request timeout, default 15000.
 */

/**
 * @typedef {Object} ListOptions
 * @property {object} [filter]          NocoBase filter object, e.g. `{ workspace_slug: 'acme' }` or `{ version: { $gt: 3 } }`.
 * @property {string|string[]} [sort]   Field name(s); prefix with `-` for descending, e.g. `['-version', 'id']`.
 * @property {number} [pageSize]        Rows fetched per HTTP request (default 200). All pages are always returned.
 * @property {number} [limit]           Optional cap on the total number of rows returned.
 * @property {string[]} [fields]        Only return these fields.
 * @property {string[]} [appends]       Association fields to append (e.g. `['createdBy']`).
 */

/**
 * @typedef {Object} Workspace
 * @property {string} slug
 * @property {string} [name]
 * @property {string} [initials]
 * @property {boolean} [is_custom]
 * @property {number} [live_version]
 * @property {number} [draft_version]
 * @property {any} [state]   Arbitrary JSON document (round-trips intact, key order preserved).
 */

/**
 * @typedef {Object} Release
 * @property {string} workspace_slug
 * @property {number} version
 * @property {string} [reason]
 * @property {any} [manifest]
 * @property {string} [published_by]
 */

const WORKSPACE_FIELDS = ['slug', 'name', 'initials', 'is_custom', 'live_version', 'draft_version', 'state'];
const RELEASE_FIELDS = ['workspace_slug', 'version', 'reason', 'manifest', 'published_by'];
const PROJECTION_COLLECTIONS = ['cfg_modules', 'cfg_gates', 'cfg_stages'];

/** @param {object} obj @param {string[]} keys */
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** @param {any} v */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {any} filter */
function assertFilter(filter, what) {
  if (!isPlainObject(filter) || Object.keys(filter).length === 0) {
    throw new TypeError(`${what}: a non-empty filter object is required (refusing to match every row)`);
  }
}

/** @param {string} collection */
function assertCollection(collection) {
  if (typeof collection !== 'string' || !/^[A-Za-z_][\w.]*$/.test(collection)) {
    throw new TypeError(`invalid collection name: ${collection}`);
  }
}

/**
 * Create a NocoBase client. All options are optional and fall back to environment variables.
 * @param {ClientOptions} [options]
 */
export function createClient(options = {}) {
  const env = typeof process !== 'undefined' ? process.env : {};
  const baseUrl = String(options.baseUrl || env.NOCOBASE_URL || DEFAULT_URL).replace(/\/+$/, '');
  const apiBase = `${baseUrl}/api`;
  const apiKey = String(options.token ?? env.NOCOBASE_TOKEN ?? '').trim();
  const account = String(options.email ?? env.NOCOBASE_ROOT_EMAIL ?? '').trim();
  const password = String(options.password ?? env.NOCOBASE_ROOT_PASSWORD ?? '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Current bearer token (API key or session token). */
  let token = apiKey || null;
  /** 'apiKey' while the configured key is in use, 'session' after sign-in. */
  let mode = apiKey ? 'apiKey' : 'session';
  /** @type {Promise<string> | null} */
  let signingIn = null;

  const hasCredentials = () => Boolean(account && password);

  /**
   * Low-level fetch with timeout and JSON handling. Never retries.
   * @returns {Promise<{ status: number, headers: Headers, body: any }>}
   */
  async function rawFetch(method, url, { headers = {}, body, timeout = timeoutMs } = {}) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? `timed out after ${timeout}ms` : err?.cause?.code || err?.message || String(err);
      throw new NocoBaseError(`NocoBase ${method} ${url.replace(baseUrl, '')} failed: ${reason}`, { status: 0, method, path: url, cause: err });
    }
    const textBody = await res.text();
    let parsed = textBody;
    if (textBody) {
      try {
        parsed = JSON.parse(textBody);
      } catch {
        /* keep text */
      }
    } else {
      parsed = null;
    }
    return { status: res.status, headers: res.headers, body: parsed };
  }

  /** @param {{ status: number, body: any }} r */
  function toError(r, method, path) {
    const first = r.body?.errors?.[0];
    const msg = first?.message || (typeof r.body === 'string' && r.body.slice(0, 200)) || `HTTP ${r.status}`;
    return new NocoBaseError(`NocoBase ${method} ${path} → ${r.status}: ${msg}`, {
      status: r.status,
      code: first?.code,
      method,
      path,
      body: r.body,
    });
  }

  /** Sign in with root credentials; concurrent callers share one request. */
  async function signIn() {
    if (!hasCredentials()) {
      throw new NocoBaseError('NocoBase: no API token and no root credentials (NOCOBASE_ROOT_EMAIL / NOCOBASE_ROOT_PASSWORD)', { status: 401 });
    }
    if (!signingIn) {
      signingIn = (async () => {
        const r = await rawFetch('POST', `${apiBase}/auth:signIn`, {
          headers: { 'X-Authenticator': 'basic' },
          body: { account, password },
        });
        if (r.status < 200 || r.status >= 300 || !r.body?.data?.token) throw toError(r, 'POST', '/api/auth:signIn');
        token = r.body.data.token;
        mode = 'session';
        return token;
      })().finally(() => {
        signingIn = null;
      });
    }
    return signingIn;
  }

  /**
   * Authenticated request against `/api/<resource>:<action>`.
   * @param {'GET'|'POST'} method
   * @param {string} action   e.g. `cfg_workspaces:list`
   * @param {{ query?: Record<string, any>, body?: any }} [opts]
   * @returns {Promise<any>} parsed body (`{ data, meta }`)
   */
  async function request(method, action, { query, body } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null) continue;
      if (k === 'filter') qs.set('filter', JSON.stringify(v));
      else if (Array.isArray(v)) v.forEach((item) => qs.append(`${k}[]`, String(item)));
      else qs.set(k, String(v));
    }
    const qsText = qs.toString();
    const path = `/api/${action}${qsText ? `?${qsText}` : ''}`;
    const url = `${baseUrl}${path}`;

    if (!token) await signIn();

    for (let attempt = 0; ; attempt++) {
      const sentToken = token;
      const r = await rawFetch(method, url, {
        headers: { Authorization: `Bearer ${sentToken}`, 'X-Authenticator': 'basic' },
        body,
      });
      // Session tokens are renewed transparently by NocoBase via this header.
      const renewed = r.headers.get('x-new-token');
      if (renewed && mode === 'session' && token === sentToken) token = renewed;

      if (r.status === 401 && attempt === 0 && hasCredentials()) {
        // Another request may already have refreshed the token; otherwise sign in again
        // (signIn() de-duplicates, so concurrent 401s share one sign-in).
        if (token === sentToken || !token) {
          token = null;
          await signIn();
        }
        continue;
      }
      if (r.status < 200 || r.status >= 300) throw toError(r, method, path);
      return r.body;
    }
  }

  /** @param {any} row */
  const unwrapRow = (row) => (Array.isArray(row) ? (row[0] ?? null) : (row ?? null));

  const client = {
    /** Resolved NocoBase origin. */
    baseUrl,

    /**
     * Is NocoBase usable? Never throws.
     * By default ("deep") checks that the app is running AND that an authenticated read of
     * `cfg_workspaces` succeeds (i.e. credentials work and the collections are provisioned).
     * Pass `{ deep: false }` to only check that the NocoBase app is up.
     * @param {{ deep?: boolean, timeoutMs?: number }} [opts]
     * @returns {Promise<boolean>}
     */
    async health({ deep = true, timeoutMs: t = 4000 } = {}) {
      try {
        const r = await rawFetch('GET', `${apiBase}/__health_check`, { timeout: t });
        if (r.status !== 200) return false;
        if (!deep) return true;
        await request('GET', 'cfg_workspaces:list', { query: { pageSize: 1 } });
        return true;
      } catch {
        return false;
      }
    },

    /**
     * List rows, transparently following pagination.
     * @param {string} collection
     * @param {ListOptions} [opts]
     * @returns {Promise<object[]>}
     */
    async list(collection, { filter, sort, pageSize = DEFAULT_PAGE_SIZE, limit, fields, appends } = {}) {
      assertCollection(collection);
      const size = Math.max(1, Math.min(Number(pageSize) || DEFAULT_PAGE_SIZE, 1000));
      const rows = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await request('GET', `${collection}:list`, {
          query: {
            page,
            pageSize: size,
            filter: filter && Object.keys(filter).length ? filter : undefined,
            sort: sort === undefined ? undefined : Array.isArray(sort) ? sort : [sort],
            fields,
            appends,
          },
        });
        const batch = Array.isArray(res?.data) ? res.data : [];
        rows.push(...batch);
        if (limit && rows.length >= limit) return rows.slice(0, limit);
        const meta = res?.meta || {};
        const more =
          meta.hasNext !== undefined ? Boolean(meta.hasNext) : meta.totalPage !== undefined ? page < meta.totalPage : batch.length === size;
        if (!more || batch.length === 0) break;
      }
      return rows;
    },

    /**
     * Fetch a single row.
     * @param {string} collection
     * @param {object|string|number} filter  filter object, or a primary-key value
     * @returns {Promise<object|null>}
     */
    async get(collection, filter) {
      assertCollection(collection);
      const query = isPlainObject(filter) ? { filter } : { filterByTk: filter };
      if (query.filter) assertFilter(filter, 'get');
      else if (filter === undefined || filter === null || filter === '') throw new TypeError('get: filter or primary key required');
      const res = await request('GET', `${collection}:get`, { query });
      return unwrapRow(res?.data);
    },

    /**
     * Insert one row (or an array of rows in a single request).
     * @param {string} collection
     * @param {object|object[]} values
     * @returns {Promise<object>} the created row (array of rows if `values` was an array)
     */
    async create(collection, values) {
      assertCollection(collection);
      const res = await request('POST', `${collection}:create`, { body: values });
      return res?.data ?? null;
    },

    /**
     * Update the row with primary key `filterByTk`.
     * @param {string} collection
     * @param {string|number} filterByTk  primary key (`id`)
     * @param {object} values             partial values to set
     * @returns {Promise<object|null>} the updated row, or null if no row matched
     */
    async update(collection, filterByTk, values) {
      assertCollection(collection);
      if (filterByTk === undefined || filterByTk === null || filterByTk === '') throw new TypeError('update: filterByTk required');
      const res = await request('POST', `${collection}:update`, { query: { filterByTk }, body: values });
      return unwrapRow(res?.data);
    },

    /**
     * Delete rows matching `filter` (a non-empty filter object, or a primary-key value).
     * @param {string} collection
     * @param {object|string|number} filter
     * @returns {Promise<void>}
     */
    async destroy(collection, filter) {
      assertCollection(collection);
      if (isPlainObject(filter)) {
        assertFilter(filter, 'destroy');
        await request('POST', `${collection}:destroy`, { query: { filter } });
      } else {
        if (filter === undefined || filter === null || filter === '') throw new TypeError('destroy: filter or primary key required');
        await request('POST', `${collection}:destroy`, { query: { filterByTk: filter } });
      }
    },

    /**
     * Delete every row matching `filter`, then insert `rows` (one bulk request).
     * Not transactional across the two steps (NocoBase REST has no multi-request transactions).
     * @param {string} collection
     * @param {object} filter   non-empty filter object
     * @param {object[]} rows
     * @returns {Promise<object[]>} the inserted rows
     */
    async replaceWhere(collection, filter, rows) {
      assertFilter(filter, 'replaceWhere');
      if (!Array.isArray(rows)) throw new TypeError('replaceWhere: rows must be an array');
      await client.destroy(collection, filter);
      if (rows.length === 0) return [];
      const created = await client.create(collection, rows);
      return Array.isArray(created) ? created : [created];
    },

    // ------------------------------------------------------------------ workspace helpers

    /**
     * All workspaces, ordered by slug.
     * @returns {Promise<object[]>}
     */
    async listWorkspaces() {
      return client.list('cfg_workspaces', { sort: ['slug'] });
    },

    /**
     * Create or update the workspace identified by `slug`. Only contract fields are written;
     * fields left `undefined` are not touched on update.
     * @param {Workspace} ws
     * @returns {Promise<object>} the stored row
     */
    async upsertWorkspace(ws) {
      if (!ws || typeof ws.slug !== 'string' || !ws.slug) throw new TypeError('upsertWorkspace: slug required');
      const values = pick(ws, WORKSPACE_FIELDS);
      const existing = await client.get('cfg_workspaces', { slug: ws.slug });
      if (existing) return client.update('cfg_workspaces', existing.id, values);
      try {
        return await client.create('cfg_workspaces', values);
      } catch (err) {
        // Lost a race with a concurrent insert of the same slug (unique constraint) → update instead.
        const again = await client.get('cfg_workspaces', { slug: ws.slug }).catch(() => null);
        if (again) return client.update('cfg_workspaces', again.id, values);
        throw err;
      }
    },

    /**
     * Delete a workspace and its projection rows (cfg_modules / cfg_gates / cfg_stages).
     * The release ledger (cfg_releases) is append-only and is kept.
     * @param {string} slug
     * @returns {Promise<void>}
     */
    async deleteWorkspace(slug) {
      if (typeof slug !== 'string' || !slug) throw new TypeError('deleteWorkspace: slug required');
      await client.destroy('cfg_workspaces', { slug });
      for (const c of PROJECTION_COLLECTIONS) await client.destroy(c, { workspace_slug: slug });
    },

    /**
     * Append an entry to the publish ledger.
     * @param {Release} release
     * @returns {Promise<object>} the stored row
     */
    async appendRelease(release) {
      if (!release || typeof release.workspace_slug !== 'string' || !release.workspace_slug) {
        throw new TypeError('appendRelease: workspace_slug required');
      }
      return client.create('cfg_releases', pick(release, RELEASE_FIELDS));
    },

    /**
     * Releases for one workspace (or all when `slug` is omitted), oldest first (by version, then id).
     * @param {string} [slug]
     * @returns {Promise<object[]>}
     */
    async listReleases(slug) {
      return client.list('cfg_releases', {
        filter: slug ? { workspace_slug: slug } : undefined,
        sort: ['version', 'id'],
      });
    },

    // ------------------------------------------------------------------ escape hatches

    /**
     * Raw authenticated call, e.g. `nb.request('GET', 'collections:list', { query: { pageSize: 50 } })`.
     * @type {typeof request}
     */
    request,

    /** Which credential is currently in use: `'apiKey'` or `'session'`. */
    get authMode() {
      return mode;
    },
  };

  return client;
}

export default createClient;

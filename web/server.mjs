#!/usr/bin/env node
// Workspace Configurator web server — zero dependencies (Node >= 18).
//
//   GET  /cfg/health            { ok, mode: 'nocobase'|'local', nocobase, client, projection }
//   GET  /cfg/state             v5 blob (localStorage['wsconfig_v5_custom']) rebuilt from cfg_workspaces; {} if none
//   PUT  /cfg/state             persist the blob (If-Match supported) + rebuild projections (async, best-effort)
//   POST /cfg/releases          append to cfg_releases (idempotent per workspace_slug+version)
//   GET  /cfg/releases?ws=slug  list releases
//   *                           static files from ./public
//
// In local mode (NocoBase or its client unavailable) the /cfg/state and /cfg/releases routes
// answer 503 {mode:'local'} and the browser keeps persisting to localStorage on its own.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from './lib/env.mjs';
import { serveStatic } from './lib/static.mjs';
import { createStore } from './lib/store.mjs';
import { builtinWorkspaces } from './lib/v5-model.mjs';

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(WEB_DIR, '..');
export const PUBLIC_DIR = path.join(WEB_DIR, 'public');

const DEFAULT_MAX_BODY = 5 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function sendJSON(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(text);
}

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, `request body exceeds ${limit} bytes`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, `request body exceeds ${limit} bytes`));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

async function readJSON(req, limit) {
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, 'Content-Type must be application/json');
  const text = await readBody(req, limit);
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'body is not valid JSON'); }
}

function hostAllowed(req, extraHosts) {
  const raw = String(req.headers.host || '');
  if (!raw) return false;
  let hostname;
  try { hostname = new URL('http://' + raw).hostname; } catch { return false; }
  return LOOPBACK_HOSTS.has(hostname) || extraHosts.has(hostname);
}

function mapError(e) {
  if (e instanceof HttpError) return [e.status, { error: e.message, ...(e.extra || {}) }];
  switch (e && e.code) {
    case 'UNAVAILABLE': return [503, { error: e.message, mode: 'local' }];
    case 'CONFLICT': return [409, { error: 'conflict', message: e.message, etag: e.etag }];
    case 'INVALID': return [400, { error: e.message }];
    default: return [502, { error: 'upstream error', message: String(e && e.message || e) }];
  }
}

/**
 * Build the request handler. `store` is the persistence layer (lib/store.mjs or a test double).
 */
export function createApp({ store, publicDir = PUBLIC_DIR, maxBodyBytes = DEFAULT_MAX_BODY, allowedHosts = [], log = console } = {}) {
  const extraHosts = new Set(allowedHosts.filter(Boolean));

  async function api(req, res, url) {
    const route = url.pathname.replace(/\/+$/, '');
    const m = req.method;

    if (route === '/cfg/health') {
      if (m !== 'GET' && m !== 'HEAD') return sendJSON(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
      const s = await store.status();
      return sendJSON(res, 200, { ok: true, mode: s.mode, nocobase: s.nocobase, client: s.client, projection: s.projection });
    }

    if (route === '/cfg/state') {
      if (m === 'GET' || m === 'HEAD') {
        const { blob, etag } = await store.readState();
        return sendJSON(res, 200, blob, { ETag: etag });
      }
      if (m === 'PUT') {
        const body = await readJSON(req, maxBodyBytes);
        const r = await store.writeState(body, req.headers['if-match']);
        return sendJSON(res, 200, { ok: true, etag: r.etag, changed: r.changed, deleted: r.deleted }, { ETag: r.etag });
      }
      return sendJSON(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD, PUT' });
    }

    if (route === '/cfg/releases') {
      if (m === 'GET' || m === 'HEAD') {
        const rows = await store.listReleases(url.searchParams.get('ws'));
        return sendJSON(res, 200, rows);
      }
      if (m === 'POST') {
        const body = await readJSON(req, maxBodyBytes);
        const r = await store.appendRelease(body);
        return sendJSON(res, r.duplicate ? 200 : 201, { ok: true, duplicate: r.duplicate, release: r.release });
      }
      return sendJSON(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD, POST' });
    }

    return sendJSON(res, 404, { error: 'unknown endpoint' });
  }

  return async function handler(req, res) {
    const started = Date.now();
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return sendJSON(res, 400, { error: 'bad request' }); }
    const isApi = url.pathname === '/cfg' || url.pathname.startsWith('/cfg/');
    try {
      if (isApi) {
        if (!hostAllowed(req, extraHosts)) return sendJSON(res, 403, { error: 'host not allowed' });
        await api(req, res, url);
        if (url.pathname !== '/cfg/health') log.info?.(`[cfg] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Method Not Allowed');
      }
      // Opening the design document directly would run it standalone (no bridge, no offline
      // adaptations); send browser navigations to the app. boot.js fetch()es it normally.
      if (/^\/configurator\.dc\.html$/i.test(url.pathname) && req.headers['sec-fetch-dest'] === 'document') {
        res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
        return res.end();
      }
      const served = await serveStatic(req, res, publicDir, url.pathname === '/' ? '/index.html' : url.pathname);
      if (!served) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        res.end('Not Found');
      }
    } catch (e) {
      const [status, body] = mapError(e);
      if (status >= 500 && status !== 503) log.warn?.(`[cfg] ${req.method} ${url.pathname} -> ${status}: ${body.message || body.error}`);
      if (!res.headersSent) sendJSON(res, status, body);
      else res.destroy();
    }
  };
}

function clientOptionsFromEnv(env) {
  const o = {};
  if (env.NOCOBASE_URL) o.baseUrl = env.NOCOBASE_URL;
  if (env.NOCOBASE_TOKEN) o.token = env.NOCOBASE_TOKEN;
  if (env.NOCOBASE_ROOT_EMAIL) o.email = env.NOCOBASE_ROOT_EMAIL;
  if (env.NOCOBASE_ROOT_PASSWORD) o.password = env.NOCOBASE_ROOT_PASSWORD;
  return o;
}

export async function main() {
  const envFile = process.env.CFG_ENV_FILE || path.join(PROJECT_ROOT, '.env');
  const envResult = loadEnvFile(envFile);
  const env = process.env;
  const port = Number(env.WEB_PORT ?? 4300);
  const host = env.WEB_HOST || '127.0.0.1';
  const clientPath = env.CFG_CLIENT_MODULE ? path.resolve(env.CFG_CLIENT_MODULE) : path.join(PROJECT_ROOT, 'nocobase', 'lib', 'client.mjs');
  const clientUrl = pathToFileURL(clientPath).href;
  let attempts = 0;
  const forceLocal = String(env.CFG_MODE || '').toLowerCase() === 'local';

  const store = createStore({
    // Re-tried on later health checks; the query string defeats the module cache after a failure.
    loadClient: forceLocal
      ? () => Promise.reject(Object.assign(new Error('NocoBase disabled by CFG_MODE=local'), { code: 'DISABLED' }))
      : () => import(attempts++ ? `${clientUrl}?attempt=${attempts}` : clientUrl),
    clientOptions: clientOptionsFromEnv(env),
    builtinSeeds: env.CFG_SEED_BUILTINS === '0' ? null : () => builtinWorkspaces()
  });

  const handler = createApp({
    store,
    maxBodyBytes: Number(env.CFG_MAX_BODY_BYTES) || DEFAULT_MAX_BODY,
    allowedHosts: String(env.WEB_ALLOWED_HOSTS || '').split(',').map(s => s.trim())
  });
  const server = http.createServer(handler);
  server.requestTimeout = 60000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  const shownHost = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  console.log(`[cfg] listening on http://${shownHost}:${addr.port} (.env ${envResult.loaded ? 'loaded' : 'not found'})`);

  store.status({ force: true }).then((s) => {
    console.log(`[cfg] mode=${s.mode} nocobase=${s.nocobase} client=${s.client}${s.clientError && s.client !== 'missing' ? ' (' + s.clientError + ')' : ''}`);
  }).catch(() => {});

  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('[cfg] failed to start:', e.message); process.exit(1); });
}

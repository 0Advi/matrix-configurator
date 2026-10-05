#!/usr/bin/env node
// Local stand-in for the slice of the Supabase Storage REST API the Matrix
// backend uses (app/backend/app/services/storage_service.py). Zero dependencies.
//
//   PUT|POST /storage/v1/object/<bucket>/<path>        upload (x-upsert honoured)
//   DELETE   /storage/v1/object/<bucket>/<path>        delete
//   POST     /storage/v1/object/sign/<bucket>/<path>   {expiresIn} -> {signedURL}
//   GET      /storage/v1/object/sign/<bucket>/<path>?token=...   download via signed URL
//   GET      /health
//
// Auth: writes/signing require `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`
// (read from app/backend/.env, same as the backend sends). Signed URLs carry an
// HMAC(token) with an expiry, like Supabase's signed-URL JWT. Files live under
// app-stack/run/storage/<bucket>/<path> (gitignored). Loopback only.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, 'run', 'storage');
const ENV_FILE = path.resolve(HERE, '..', 'app', 'backend', '.env');

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = readEnv(ENV_FILE);
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
const base = new URL(env.SUPABASE_PROJECT_URL || 'http://127.0.0.1:54331');
const PORT = Number(process.env.STORAGE_STUB_PORT || base.port || 54331);
if (!KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY missing in app/backend/.env'); process.exit(1); }
fs.mkdirSync(ROOT, { recursive: true });

const send = (res, code, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isBuf ? (headers['Content-Type'] || 'application/octet-stream') : 'application/json',
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
};

function resolveObject(bucket, objPath) {
  const decoded = decodeURIComponent(objPath);
  const full = path.resolve(ROOT, bucket, decoded);
  if (!full.startsWith(path.resolve(ROOT, bucket) + path.sep)) return null; // traversal guard
  return full;
}

const sign = (s) => crypto.createHmac('sha256', KEY).update(s).digest('base64url');
const authed = (req) => {
  const h = req.headers.authorization || '';
  const a = Buffer.from(h); const b = Buffer.from(`Bearer ${KEY}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') return send(res, 204, {}, { 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' });
  if (url.pathname === '/health') return send(res, 200, { status: 'ok', service: 'storage-stub' });

  let m = url.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
  if (m) {
    const [, bucket, obj] = m;
    const file = resolveObject(bucket, obj);
    if (!file) return send(res, 400, { error: 'bad path' });
    if (req.method === 'POST') {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (!fs.existsSync(file)) return send(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        let expiresIn = 300;
        try { expiresIn = Number(JSON.parse(raw || '{}').expiresIn) || 300; } catch { /* default */ }
        const exp = Math.floor(Date.now() / 1000) + expiresIn;
        const payload = `${bucket}/${obj}|${exp}`;
        const token = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
        send(res, 200, { signedURL: `/object/sign/${bucket}/${obj}?token=${token}` });
      });
      return undefined;
    }
    if (req.method === 'GET') {
      const [p64, sig] = (url.searchParams.get('token') || '').split('.');
      const payload = p64 ? Buffer.from(p64, 'base64url').toString() : '';
      const [what, exp] = payload.split('|');
      const ok = sig && sig === sign(payload) && what === `${bucket}/${obj}` && Number(exp) > Date.now() / 1000;
      if (!ok) return send(res, 400, { error: 'InvalidJWT', message: 'invalid or expired signature' });
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not_found' });
      let ct = 'application/octet-stream';
      try { ct = JSON.parse(fs.readFileSync(`${file}.meta.json`, 'utf8')).contentType || ct; } catch { /* default */ }
      return send(res, 200, fs.readFileSync(file), { 'Content-Type': ct });
    }
  }

  m = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
  if (m) {
    const [, bucket, obj] = m;
    const file = resolveObject(bucket, obj);
    if (!file) return send(res, 400, { error: 'bad path' });
    if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'PUT' || req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (fs.existsSync(file) && req.headers['x-upsert'] !== 'true') {
          return send(res, 409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.concat(chunks));
        fs.writeFileSync(`${file}.meta.json`, JSON.stringify({ contentType: req.headers['content-type'] || null }));
        send(res, 200, { Key: `${bucket}/${decodeURIComponent(obj)}` });
      });
      return undefined;
    }
    if (req.method === 'DELETE') {
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not_found' });
      fs.rmSync(file); fs.rmSync(`${file}.meta.json`, { force: true });
      return send(res, 200, { message: 'Successfully deleted' });
    }
  }
  return send(res, 404, { error: 'not_found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`storage-stub listening on http://127.0.0.1:${PORT} (root ${ROOT})`));

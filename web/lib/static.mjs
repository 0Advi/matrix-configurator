// Static file serving for web/public with no directory traversal, no listings, no dotfiles.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon'
};

// Enforces "no CDN at runtime" in the browser: every script, style, font and fetch must come
// from this origin. 'unsafe-eval' is required by the dc-runtime (it evaluates the design's
// logic class with `new Function`); inline styles are how the design renders.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');

export function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  if (/^(LICENSE|LICENCE|NOTICE|README)$/i.test(path.basename(file))) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * Map a URL pathname to an absolute file path inside `root`, or null if it must not be served.
 * Rejects malformed escapes, NUL bytes, backslashes, `..` escapes and dot-segments (dotfiles).
 */
export function resolveStaticPath(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (!decoded.startsWith('/')) return null;
  if (decoded.endsWith('/')) decoded += 'index.html';
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some(s => s === '..' || s.startsWith('.'))) return null;
  const rootAbs = path.resolve(root);
  const full = path.resolve(rootAbs, ...segments);
  if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) return null;
  return full;
}

/** Serve a GET/HEAD for `pathname` from `root`. Returns false when nothing matched (caller 404s). */
export async function serveStatic(req, res, root, pathname) {
  const file = resolveStaticPath(root, pathname);
  if (!file) return false;
  let st;
  try { st = await stat(file); } catch { return false; }
  if (!st.isFile()) return false;

  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': contentTypeFor(file),
    'Content-Length': st.size,
    'Last-Modified': st.mtime.toUTCString(),
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    // vendor/ paths are version-pinned; everything else is revalidated on each load
    'Cache-Control': pathname.startsWith('/vendor/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  };
  if (headers['Content-Type'].startsWith('text/html')) {
    headers['Content-Security-Policy'] = CSP;
    headers['Referrer-Policy'] = 'no-referrer';
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] });
    res.end();
    return true;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  await new Promise((resolve) => {
    const s = createReadStream(file);
    s.on('error', () => { res.destroy(); resolve(); });
    s.on('end', resolve);
    s.pipe(res);
  });
  return true;
}

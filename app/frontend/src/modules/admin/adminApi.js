// Platform-admin API helpers (X-Platform-Admin-Key).
//
// Moved out of AdminPortalPage.jsx (F4b) so the Workspaces area can share them; behaviour of
// the original two helpers is unchanged except that errors now also carry the parsed body
// (`err.body`) and its machine-readable `code`, which the new /platform/* endpoints use
// (`findings`, `already_provisioned`, …). `detail` stays the human-readable message.
//
// The admin token is passed in by the caller on every call — it lives only in the portal
// page's memory (see AdminPortalPage.jsx), never in storage and never in the configurator
// iframe.

export const apiBase = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL)
  || 'http://localhost:8000/api';

function toError(r, parsed, fallback) {
  const detail = parsed?.detail || fallback;
  const err = new Error(typeof detail === 'string' ? detail
    : Array.isArray(detail) ? detail.map((d) => d?.msg || JSON.stringify(d)).join('; ')
      : JSON.stringify(detail));
  err.status = r.status;
  err.body = parsed;
  err.code = parsed?.code;
  return err;
}

async function parse(r) {
  const text = await r.text();
  try { return text ? JSON.parse(text) : null; } catch { return { detail: text }; }
}

export async function apiFetch(path, { key, method = 'GET', body } = {}) {
  const r = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-Admin-Key': key || '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed = await parse(r);
  if (!r.ok) throw toError(r, parsed, `Request failed (${r.status})`);
  return parsed;
}

export async function apiUpload(path, { key, formData }) {
  const r = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'X-Platform-Admin-Key': key || '' },
    body: formData,
  });
  const parsed = await parse(r);
  if (!r.ok) throw toError(r, parsed, `Upload failed (${r.status})`);
  return parsed;
}

export async function adminLogin(email, password) {
  const r = await fetch(`${apiBase}/tenancy/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const parsed = await parse(r);
  if (!r.ok) throw toError(r, parsed, `Login failed (${r.status})`);
  if (!parsed?.token) throw new Error('Login response missing token.');
  return parsed.token;
}

// Seconds until the admin JWT expires (null when it cannot be read). Display only — the
// backend decides; a 401 is still handled wherever it happens.
export function adminTokenSecondsLeft(token, now = Date.now()) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload?.exp) return null;
    return Math.round(payload.exp - now / 1000);
  } catch {
    return null;
  }
}

// ── /platform/workspaces (docs/F4-API.md §1) ─────────────────────────────────

const enc = encodeURIComponent;

export const platformApi = {
  list: (key) => apiFetch('/platform/workspaces', { key }),
  get: (key, ref) => apiFetch(`/platform/workspaces/${enc(ref)}`, { key }),
  provision: (key, body) => apiFetch('/platform/workspaces', { key, method: 'POST', body }),
  validate: (key, ref, manifest) => apiFetch(`/platform/workspaces/${enc(ref)}/releases/validate`, {
    key, method: 'POST', body: { manifest },
  }),
  publish: (key, ref, { manifest, reason, sourceRef }) => apiFetch(`/platform/workspaces/${enc(ref)}/releases`, {
    key, method: 'POST',
    body: { manifest, ...(reason ? { reason: String(reason).slice(0, 500) } : {}), ...(sourceRef ? { source_ref: sourceRef } : {}) },
  }),
  release: (key, ref, version) => apiFetch(`/platform/workspaces/${enc(ref)}/releases/${enc(version)}`, { key }),
  // G3 (docs/G3-API.md §1): migrate running custom-module cases between releases.
  // body: {from_release_version: <n>|'all_older', to_release_version?, scope?, reason?, dry_run, ...}
  migrate: (key, ref, body) => apiFetch(`/platform/workspaces/${enc(ref)}/migrations`, { key, method: 'POST', body }),
  migrations: (key, ref) => apiFetch(`/platform/workspaces/${enc(ref)}/migrations`, { key }),
  migration: (key, ref, id) => apiFetch(`/platform/workspaces/${enc(ref)}/migrations/${enc(id)}`, { key }),
};

// The SPA uses a HashRouter: a workspace's branded login page is /#/login/<CODE>.
export function workspaceLoginUrl(code, origin = (typeof window !== 'undefined' ? window.location.origin : '')) {
  return `${origin}/#/login/${encodeURIComponent(code)}`;
}

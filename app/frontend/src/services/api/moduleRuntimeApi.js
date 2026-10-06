// Generic custom-module runtime API (F4b; backend contract docs/F4-API.md §3).
//
//   GET  /m/{key}/members                      → assign picker / person widget
//   GET  /m/{key}/records[?site_id=]           → cases (+ site_gate preview with ?site_id)
//   POST /m/{key}/records {site_id}            → open a case (409 gate_closed → locked screen)
//   GET  /m/{key}/records/{id}                 → case detail
//   POST /m/{key}/records/{id}/actions         → submit / approve / send_back / reject
//   POST /m/{key}/records/{id}/assign          → delegate to an executive
//   G3 (docs/G3-API.md §3):
//   GET  /m/{key}/views[?manage=true]          → saved views for my role (+ default_view_id, can_manage)
//   POST|PATCH|DELETE /m/{key}/views[/{id}]    → business admin manages views; POST /views/reset → defaults
//   GET  /m/{key}/records?view=<id>            → the view is applied server-side, on top of my scope
//   F5a: POST /m/{key}/records/{id}/files (multipart) → upload for a file field; GET /m/{key}/files/{id} → signed url
//
// Refusals keep `detail` as a string and carry machine-readable extras (`code`, `gate`,
// `errors`, `record_id`, …). The shared axios client wraps errors in ApiError; problemOf()
// recovers the whole body from it so pages can branch on `code`.
import { createApiClient } from './axiosClient.js';

const client = createApiClient();
const enc = encodeURIComponent;
const base = (key) => `/m/${enc(key)}`;

export async function listMembers(moduleKey) {
  return (await client.get(`${base(moduleKey)}/members`)).data;
}

export async function listRecords(moduleKey, { siteId, viewId } = {}) {
  const params = { ...(siteId ? { site_id: siteId } : {}), ...(viewId ? { view: viewId } : {}) };
  return (await client.get(`${base(moduleKey)}/records`, { params: Object.keys(params).length ? params : undefined })).data;
}

// ── G3: role-scoped saved views ──────────────────────────────────────────────

export async function listViews(moduleKey, { manage = false } = {}) {
  return (await client.get(`${base(moduleKey)}/views`, { params: manage ? { manage: true } : undefined })).data;
}

/** body: {name, filter, columns, audience, position, is_default, all_modules} */
export async function createView(moduleKey, body) {
  return (await client.post(`${base(moduleKey)}/views`, body)).data;
}

export async function updateView(moduleKey, viewId, patch) {
  return (await client.patch(`${base(moduleKey)}/views/${enc(viewId)}`, patch)).data;
}

export async function deleteView(moduleKey, viewId) {
  return (await client.delete(`${base(moduleKey)}/views/${enc(viewId)}`)).data;
}

export async function resetViews(moduleKey) {
  return (await client.post(`${base(moduleKey)}/views/reset`)).data;
}

// The configurator's navigation pages (overview / queue / review / history, F4b sidebar links
// `?view=<page>`) mapped onto the seeded views (migration 20261005_3).
export const LEGACY_VIEW_SEEDS = {
  queue: ['team_queue', 'awaiting_me', 'admin_signoff'],
  review: ['awaiting_me', 'admin_signoff'],
  history: ['closed'],
};

/** The view a `?view=` param selects: a view id, a seed key, a legacy page key, else the role's default. */
export function resolveView(views, param, defaultId) {
  const list = Array.isArray(views) ? views : [];
  if (!list.length) return null;
  const byId = list.find((v) => v.id === param);
  if (byId) return byId;
  const bySeed = list.find((v) => param && v.seed_key === param);
  if (bySeed) return bySeed;
  for (const seed of LEGACY_VIEW_SEEDS[param] || []) {
    const v = list.find((x) => x.seed_key === seed);
    if (v) return v;
  }
  return list.find((v) => v.id === defaultId) || list[0];
}

export async function openRecord(moduleKey, siteId) {
  return (await client.post(`${base(moduleKey)}/records`, { site_id: siteId })).data;
}

export async function getRecord(moduleKey, recordId) {
  return (await client.get(`${base(moduleKey)}/records/${enc(recordId)}`)).data;
}

/** body: {action, values?, reason?, to_stage?, expected_seq?} */
export async function actOnRecord(moduleKey, recordId, body) {
  return (await client.post(`${base(moduleKey)}/records/${enc(recordId)}/actions`, body)).data;
}

export async function assignRecord(moduleKey, recordId, executiveId) {
  return (await client.post(`${base(moduleKey)}/records/${enc(recordId)}/assign`, { executive_id: executiveId })).data;
}

// ── F5a: files for `kind: file` fields ───────────────────────────────────────
// POST /m/{key}/records/{id}/files (multipart: field, file) → {id, file_name, content_type, size, …};
// the form then submits that id. GET /m/{key}/files/{id} → metadata + a short-lived signed `url`.
const UPLOAD_TIMEOUT_MS = 120000; // the backend relays the bytes to storage before answering

export async function uploadRecordFile(moduleKey, recordId, field, file) {
  const form = new FormData();
  form.append('field', field);
  form.append('file', file);
  // axios sets the multipart Content-Type (with boundary) automatically for FormData.
  return (await client.post(`${base(moduleKey)}/records/${enc(recordId)}/files`, form, { timeout: UPLOAD_TIMEOUT_MS })).data;
}

export async function getRecordFile(moduleKey, fileId) {
  return (await client.get(`${base(moduleKey)}/files/${enc(fileId)}`)).data;
}

// Sites a supervisor / business admin can open a case on (the existing sites list).
export async function listSitesForCases() {
  const d = (await client.get('/sites', { params: { limit: 200 } })).data;
  return (d?.items || []).map((s) => ({ id: s.id, name: s.name, code: s.code || s.site_code || '', city: s.city || '', status: s.status }));
}

/**
 * The refusal behind an error, normalised:
 * {status, detail, code, gate, errors, findings, recordId, body}.
 */
export function problemOf(err) {
  const body = err?.cause?.response?.data ?? err?.body ?? null;
  const status = err?.status ?? err?.cause?.response?.status ?? 0;
  const raw = body?.detail ?? err?.detail ?? err?.message;
  const detail = typeof raw === 'string' ? raw
    : Array.isArray(raw) ? raw.map((d) => d?.msg || JSON.stringify(d)).join('; ')
      : raw ? JSON.stringify(raw) : 'Request failed';
  return {
    status,
    detail,
    code: body?.code ?? err?.code ?? null,
    gate: body?.gate ?? null,
    errors: Array.isArray(body?.errors) ? body.errors : [],
    findings: Array.isArray(body?.findings) ? body.findings : [],
    recordId: body?.record_id ?? null,
    body,
  };
}

/**
 * Backend form errors ("field: message", or "path.to.field: message") → rjsf extraErrors
 * ({field: {__errors: [message]}}); anything not addressed to a field lands on the form root.
 */
export function toExtraErrors(errors, schema) {
  const props = schema?.properties || {};
  const out = {};
  const add = (key, msg) => {
    if (key && props[key]) {
      out[key] = out[key] || { __errors: [] };
      out[key].__errors.push(msg);
    } else {
      out.__errors = out.__errors || [];
      out.__errors.push(key ? `${key}: ${msg}` : msg);
    }
  };
  for (const e of errors || []) {
    const text = String(e ?? '');
    const m = /^([A-Za-z0-9_.[\]-]*)\s*:\s*([\s\S]*)$/.exec(text);
    if (m && m[1]) add(m[1].split(/[.[]/)[0], m[2]);
    else add(null, text);
  }
  return out;
}

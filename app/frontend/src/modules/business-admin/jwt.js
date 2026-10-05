// Best-effort JWT payload decode. Returns `{}` on any failure — callers should
// not rely on this for security (the backend is the source of truth on every
// request); it's used purely to drive UI gating before the first API call.
//
// The backend mints JWTs in Supabase's shape: role/tenant_id/city live under
// `app_metadata`. We flatten that here so callers can read `.role` directly
// instead of every site reaching into `.app_metadata.role` on its own.

export function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return {};
  try {
    const raw = JSON.parse(atob(token.split('.')[1])) || {};
    const md = raw.app_metadata || {};
    return { ...raw, ...md };
  } catch {
    return {};
  }
}

// Workspace-code authenticity (F4b).
//
// GET /tenancy/branding?code= answers a real workspace code with {name, logo_url} and an
// unknown one with an explicit {name: null, logo_url: null} (backend routers/tenancy.py
// public_branding). Both the workspace-code dialog and the branded login page already make
// that call; this reads its answer. It reveals nothing the endpoint itself does not, and the
// endpoint stays rate limited (30/min per client). A response without a `name` key (an older
// backend with a uniform answer) is NOT treated as unknown, so the old flow is kept there.
export function isUnknownWorkspace(branding) {
  return !!branding && typeof branding === 'object' && 'name' in branding && !branding.name;
}

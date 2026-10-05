# Auth and tenancy pattern (reference)

Source: Matrix-bd `origin/main` @ `3d4f277beb22c5be02c2abacea61b6afaee7cdeb`. Every snippet below is a
**short verbatim excerpt**: Matrix-bd is a private repo, so treat these as reference, not as a licence to copy.
Each one carries a provenance header. Everything else is described and linked by path.

## 1. The tenant comes from the verified token, never from the request

`backend/app/core/security.py` verifies an HS256 JWT using the Supabase JWT secret
(`aud=authenticated`, `require: exp, sub`). It then projects `app_metadata` into the session. Both a missing
role and a missing tenant are refused with a 403:

```python
# provenance: Matrix-bd@3d4f277b backend/app/core/security.py  _session_from_claims (excerpt)
role = app_md.get("role")
if not role:
    raise AuthError("Token missing app_metadata.role", code=status.HTTP_403_FORBIDDEN)
tenant_id = app_md.get("tenant_id")
if not tenant_id:
    raise AuthError("Token missing app_metadata.tenant_id", code=status.HTTP_403_FORBIDDEN)
```

`backend/app/core/deps.py` then exposes `TenantId = Annotated[str, Depends(get_tenant)]`, which is simply
`current_user["tenant_id"]`. **No tenant-scoped route accepts a tenant id from the URL, body or headers.** The
only exceptions are platform-admin tenancy routes such as `POST /api/tenancy/tenants/{tenant_id}/branding`,
which run behind the separate platform-admin token. Other details:
* Tokens live 24 h, and `POST /api/auth/refresh` accepts a lapsed token within a 48 h grace window.
* Platform-admin tokens are separate: `aud=platform-admin` with a 30-minute TTL.

## 2. Per-request revalidation

`get_current_user` re-reads `users.role` and `users.is_active` (joined with module membership) on **every**
request. The role in the token is therefore advisory, and deactivation takes effect immediately. It then releases
the auto-begun read transaction (`await db.rollback()`) so the write path opens a real transaction. Fix #103:
without that release, every write was silently rolled back inside a savepoint.

## 3. Scoped fetch: every query carries `tenant_id`

```python
# provenance: Matrix-bd@3d4f277b backend/app/services/_common.py  fetch_site_for_update_or_404 (excerpt)
stmt = (
    select(models.Site)
    .where(models.Site.id == site_id, models.Site.tenant_id == tenant_id)
    .with_for_update()
)
```

* A cross-tenant id gets a **404**, not a 403, so it does not leak existence.
* Status-changing workflows take a row lock with `SELECT … FOR UPDATE` before calling `assert_transition`.
* `apply_role_scope` then narrows executives to `submitted_by` or `assigned_to` sites.

## 4. RLS is defence-in-depth only

The application connects as the BYPASSRLS `postgres` role. `backend/app/db/session.py` notes that tenant scoping
is enforced in application code. The RLS policies protect only the public `anon` / `authenticated` roles, in case
the Supabase Data API is ever exposed. Migration `20260802_complete_rls_defense_in_depth.sql` (#345) defined the
resolver that older policies referenced but no migration had created:

```sql
-- provenance: Matrix-bd@3d4f277b backend/database/migrations/20260802_complete_rls_defense_in_depth.sql (excerpt)
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(auth.jwt() #>> '{app_metadata,tenant_id}', '')::uuid;
$$;
-- per table (example from 20260803_rls_site_budgets.sql):
--   ALTER TABLE public.site_budgets ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY tenant_isolation ON public.site_budgets
--     USING (tenant_id = public.current_tenant_id())
--     WITH CHECK (tenant_id = public.current_tenant_id());
```

Policies live in these migrations:
* `202605241_role_canonicalization_and_lifecycle.sql`
* `202606231_supervisor_executive_requests.sql`
* `20260802_…`
* `20260803_rls_site_budgets.sql`
* `20260804_quality_audit_reports.sql`

## 5. Tenant lifecycle

* `workspace_requests`: landing page → pending → a **platform admin** approves.
  `tenancy_service.approve_workspace_request` then creates the tenant and its business admin, retrying slug or
  workspace-code collisions up to 5 times.
* `tenants` has `slug` (unique), `workspace_code`, `seat_limit` and `logo_url`, which gives branded login.
* People join through codes: department, supervisor or observer (see `rbac.md`). Password resets also go through
  the platform admin.

## 6. Lessons for the configurator

* **Derive the tenant from the credential, everywhere.** The configurator's own API (`/cfg/*` in `docs/CONTRACT.md`)
  is single-operator today. If it becomes multi-operator, it should take the operator and tenant scope from a
  verified token, the same way Matrix-bd does.
* **Prefer 404 to 403 across tenants**, and row-lock before any transition.
* **Do not count RLS as the primary control** unless the app really connects as a non-bypass role. Matrix-bd is
  honest about this, and the configurator should be too.
* NocoBase's equivalent comes from its ACL (roles, strategies, scopes) plus app-level data-source isolation. See
  `../from-nocobase/concept-map.md`.

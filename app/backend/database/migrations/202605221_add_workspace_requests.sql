-- Workspace-request capture + employee-join enablement.
--
-- Flow:
--   1. Anyone posts to POST /api/tenancy/request-workspace from the landing
--      page → row inserted here with status='pending' and the team_size
--      parsed into seat_limit.
--   2. Platform admin (Shrey) calls POST /api/tenancy/requests/{id}/approve
--      with the X-Platform-Admin-Key header. That creates the tenants row
--      (carrying seat_limit + a generated workspace_code), creates the
--      Supabase auth user as the workspace supervisor, and marks this row
--      approved.
--   3. Employees join via POST /api/tenancy/join {email, workspace_code}.
--      The backend looks up tenants.workspace_code, checks live user count
--      against tenants.seat_limit, and creates the Supabase user with
--      is_active=false (no role yet).
--   4. The workspace supervisor opens /team in the dashboard, sees pending
--      users, and assigns each a role via POST /api/users/{id}/assign-role.

-- ── workspace_requests (public capture surface) ────────────────────────────
CREATE TYPE workspace_request_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE public.workspace_requests (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company         text NOT NULL,
    admin_email     text NOT NULL,
    -- Free-text bucket the user picked on the landing form (e.g. "11 to 50 users").
    team_size       text,
    -- Parsed numeric upper bound. Becomes the tenants.seat_limit on approve.
    seat_limit      integer NOT NULL DEFAULT 10,
    status          workspace_request_status NOT NULL DEFAULT 'pending',
    notes           text,
    decided_at      timestamp with time zone,
    decided_by      uuid REFERENCES public.users(id),
    provisioned_tenant_id uuid REFERENCES public.tenants(id),
    created_at      timestamp with time zone NOT NULL DEFAULT now(),
    source_ip       inet
);

CREATE INDEX workspace_requests_status_created_idx
    ON public.workspace_requests (status, created_at DESC);
CREATE INDEX workspace_requests_admin_email_idx
    ON public.workspace_requests (lower(admin_email));

ALTER TABLE public.workspace_requests ENABLE ROW LEVEL SECURITY;
-- No policies on `authenticated` — only the backend (service-role) touches this.


-- ── tenants — extend with seat cap + shareable code ────────────────────────
-- seat_limit: hard cap on active+pending users in the tenant. Set at approve
-- time from workspace_requests.seat_limit; defaults to 10 for the existing
-- tenants seeded before this migration.
ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS seat_limit integer NOT NULL DEFAULT 10;

-- workspace_code: a short, human-shareable identifier the supervisor gives to
-- their team so they can self-join via /api/tenancy/join. Distinct from the
-- tenant's UUID so we can rotate it if it leaks.
ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS workspace_code text;

UPDATE public.tenants
   SET workspace_code = upper(substring(replace(slug, '-', '') from 1 for 6))
                         || '-'
                         || upper(substring(md5(id::text) from 1 for 4))
 WHERE workspace_code IS NULL;

ALTER TABLE public.tenants
    ALTER COLUMN workspace_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_workspace_code_uidx
    ON public.tenants (upper(workspace_code));

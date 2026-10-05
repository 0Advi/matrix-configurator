-- 20261004_7 — Platform registry of configurator-managed workspaces (F4a; NOT part of F2's set).
--
-- PURPOSE
--   The Workspace Configurator (platform-admin portal) provisions a real tenant through the app's
--   own provisioning path (workspace_requests -> approve -> tenants + business admin + setup token)
--   and then publishes releases to it. The app needs to know which tenant a configurator workspace
--   became, BEFORE its first release exists:
--     * tenant_config_live.workspace_ref (20261004_1) can only be written together with a live
--       release (release_id is NOT NULL), so it cannot hold the link between provisioning and the
--       first publish, and cannot make provisioning idempotent on the configurator's id.
--   public.platform_workspaces is that link: one row per configurator workspace id, claimed first
--   (status 'provisioning'), activated once the tenant exists ('active'), or marked 'failed'.
--   The claim row is what serialises two concurrent "provision ref X" calls (primary key).
--   tenant_config_live.workspace_ref is still filled on every publish (same value).
--
-- CONVENTIONS: runner semantics as in 20261004_1 (one statement per transaction, idempotent).
--
-- ROLLBACK
--   DROP TABLE IF EXISTS public.platform_workspaces;

CREATE TABLE IF NOT EXISTS public.platform_workspaces (
    workspace_ref        text PRIMARY KEY,
    tenant_id            uuid UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE,
    workspace_request_id uuid REFERENCES public.workspace_requests(id) ON DELETE SET NULL,
    status               text NOT NULL DEFAULT 'provisioning',
    claimed_by           text NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    provisioned_at       timestamptz,
    last_error           text,
    CONSTRAINT chk_pw_ref CHECK (workspace_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    CONSTRAINT chk_pw_status CHECK (status IN ('provisioning', 'active', 'failed')),
    CONSTRAINT chk_pw_active_has_tenant CHECK (status <> 'active' OR tenant_id IS NOT NULL)
);

-- Platform data (no tenant scope, like workspace_requests / module_catalog): RLS on, no policy ->
-- default-deny for anon/authenticated; the app's BYPASSRLS role is unaffected.
ALTER TABLE public.platform_workspaces ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON public.platform_workspaces FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON public.platform_workspaces FROM authenticated;
    END IF;
END $$;

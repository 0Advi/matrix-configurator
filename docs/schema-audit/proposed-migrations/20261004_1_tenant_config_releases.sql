-- 20261004_1 — Immutable per-tenant configuration releases + the live pointer.
--
-- PURPOSE
--   The Workspace Configurator publishes a workspace as a versioned manifest (modules, gates,
--   tiers, stages, fields, roll-ups, navigation, permissions). Today the app DB has nowhere to
--   keep it: no table holds per-tenant configuration at all. This file adds
--     * public.tenant_config_releases — append-only ledger, one row per published version
--       (version unique per tenant; the manifest is stored verbatim as jsonb). UPDATE is refused;
--       DELETE is refused unless it arrives through the tenant ON DELETE CASCADE.
--     * public.tenant_config_live     — which release is live for a tenant (one row per tenant),
--       plus the configurator workspace it is managed by (workspace_ref).
--   The app reads these at request time; NocoBase stays a design-time store (decision D2).
--   A tenant WITHOUT a live row keeps today's hard-coded behaviour (legacy mode) — nothing in the
--   existing app reads these tables, so this file changes no current behaviour.
--
-- CONVENTIONS (backend/app/main.py runner)
--   Each statement runs in its own transaction; BEGIN/COMMIT are stripped; only double-dollar
--   quoting is recognised; every statement is idempotent so a partial apply converges on retry.
--   Depends on public.current_tenant_id() (20260802) for the RLS policy, exactly like 20260803/04.
--
-- ROLLBACK (only while no later file / no data depends on it)
--   DROP TABLE IF EXISTS public.tenant_config_live;
--   DROP TABLE IF EXISTS public.tenant_config_releases;
--   DROP FUNCTION IF EXISTS public.cfg_release_fill_sha();
--   DROP FUNCTION IF EXISTS public.cfg_forbid_mutation();
--   (and DELETE FROM public.schema_migrations WHERE filename = '20261004_1_tenant_config_releases.sql')

CREATE TABLE IF NOT EXISTS public.tenant_config_releases (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    version              integer NOT NULL,
    manifest             jsonb NOT NULL,
    manifest_sha256      text NOT NULL,
    schema_version       text NOT NULL DEFAULT 'configurator-v5',
    reason               text,
    published_by         text NOT NULL,
    published_by_user_id uuid,
    source               text NOT NULL DEFAULT 'configurator',
    source_ref           text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_tcr_tenant_version UNIQUE (tenant_id, version),
    CONSTRAINT uq_tcr_tenant_id      UNIQUE (tenant_id, id),
    CONSTRAINT chk_tcr_version       CHECK (version >= 1),
    CONSTRAINT chk_tcr_manifest      CHECK (jsonb_typeof(manifest) = 'object'
                                            AND coalesce(jsonb_typeof(manifest -> 'modules'), 'missing') = 'array'),
    CONSTRAINT chk_tcr_sha256        CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_tcr_source        CHECK (source IN ('configurator', 'baseline', 'import'))
);

-- published_by is text on purpose: the publisher is usually the PLATFORM admin, who has no
-- users row (X-Platform-Admin-Key). published_by_user_id is a provenance snapshot, not an FK,
-- so an append-only row can never block a user delete.

CREATE TABLE IF NOT EXISTS public.tenant_config_live (
    tenant_id     uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
    release_id    uuid NOT NULL,
    workspace_ref text,
    activated_at  timestamptz NOT NULL DEFAULT now(),
    activated_by  text NOT NULL,
    CONSTRAINT fk_tcl_release FOREIGN KEY (tenant_id, release_id)
        REFERENCES public.tenant_config_releases (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tcl_workspace_ref
    ON public.tenant_config_live (workspace_ref)
    WHERE workspace_ref IS NOT NULL;

-- Shared guard for append-only tables (also used by 20261004_5 on module_approvals).
-- A DELETE that arrives through an FK cascade runs at trigger depth > 1 and is allowed, so
-- deleting a tenant (or a parent row) still works; a direct UPDATE/DELETE is refused.
CREATE OR REPLACE FUNCTION public.cfg_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '%.% is append-only: % refused', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

-- Fill manifest_sha256 when the caller omits it (hash of the jsonb canonical text form).
CREATE OR REPLACE FUNCTION public.cfg_release_fill_sha()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.manifest_sha256 IS NULL THEN
        NEW.manifest_sha256 := encode(sha256(convert_to(NEW.manifest::text, 'UTF8')), 'hex');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tcr_fill_sha ON public.tenant_config_releases;
CREATE TRIGGER trg_tcr_fill_sha
    BEFORE INSERT ON public.tenant_config_releases
    FOR EACH ROW EXECUTE FUNCTION public.cfg_release_fill_sha();

DROP TRIGGER IF EXISTS trg_tcr_append_only ON public.tenant_config_releases;
CREATE TRIGGER trg_tcr_append_only
    BEFORE UPDATE OR DELETE ON public.tenant_config_releases
    FOR EACH ROW EXECUTE FUNCTION public.cfg_forbid_mutation();

-- RLS: same posture as every tenant table since 20260802 — the app's BYPASSRLS role is
-- unaffected; anon/authenticated (PostgREST) see only their own tenant, and get no grants.
-- ENABLE is its own statement so the table is default-deny even if the policy statement fails.
ALTER TABLE public.tenant_config_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_config_live ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    DROP POLICY IF EXISTS tenant_isolation ON public.tenant_config_releases;
    CREATE POLICY tenant_isolation ON public.tenant_config_releases
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id());
    DROP POLICY IF EXISTS tenant_isolation ON public.tenant_config_live;
    CREATE POLICY tenant_isolation ON public.tenant_config_live
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id());
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON public.tenant_config_releases, public.tenant_config_live FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON public.tenant_config_releases, public.tenant_config_live FROM authenticated;
    END IF;
END $$;

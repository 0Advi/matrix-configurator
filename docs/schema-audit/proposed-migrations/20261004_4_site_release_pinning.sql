-- 20261004_4 — Version pinning: a site finishes on the configuration release it started under.
--
-- PURPOSE
--   The configurator promises "sites always finish on the version they started under". The DB has
--   no notion of a flow version (the repo's own plan, docs/14-dynamic-platform, calls for
--   "sites.flow_definition_id stamped at creation"). This file adds
--     * sites.config_release_id (nullable)  — FK to tenant_config_releases, NOT VALID then VALIDATE
--       (sites is the hottest table: no long ACCESS EXCLUSIVE scan).
--     * trigger trg_sites_pin_release (BEFORE INSERT, BEFORE UPDATE OF config_release_id):
--         INSERT: a NULL pin is filled from tenant_config_live (the tenant's live release) — so the
--                 EXISTING create-site code path pins new sites without any app change; tenants with
--                 no live release keep NULL = legacy (today's hard-coded flow).
--                 A supplied pin must belong to the site's tenant.
--         UPDATE: NULL -> release is allowed (adopting a legacy site, same-tenant only);
--                 release -> different release is refused unless the session sets
--                 matrix.allow_repin = 'on' (explicit, auditable operator action).
--   NULL is deliberately allowed: every existing site is legacy and stays on the hard-coded flow.
--
-- APP IMPACT: none required. The ORM does not map the column (extra columns are ignored);
--   _verify_schema only checks for the presence of other sites columns. SQLAlchemy only issues
--   UPDATE for changed mapped attributes, so the UPDATE branch never fires from existing code.
--
-- ROLLBACK
--   DROP TRIGGER IF EXISTS trg_sites_pin_release ON public.sites;
--   DROP FUNCTION IF EXISTS public.cfg_sites_pin_release();
--   ALTER TABLE public.sites DROP COLUMN IF EXISTS config_release_id;

ALTER TABLE public.sites
    ADD COLUMN IF NOT EXISTS config_release_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.sites'::regclass
                      AND conname = 'fk_sites_config_release') THEN
        ALTER TABLE public.sites
            ADD CONSTRAINT fk_sites_config_release
            FOREIGN KEY (config_release_id) REFERENCES public.tenant_config_releases (id) NOT VALID;
    END IF;
END $$;

ALTER TABLE public.sites VALIDATE CONSTRAINT fk_sites_config_release;

CREATE INDEX IF NOT EXISTS idx_sites_config_release
    ON public.sites (config_release_id)
    WHERE config_release_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.cfg_sites_pin_release()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    rel_tenant uuid;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.config_release_id IS NULL THEN
        SELECT l.release_id INTO NEW.config_release_id
          FROM public.tenant_config_live l
         WHERE l.tenant_id = NEW.tenant_id;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.config_release_id IS NOT DISTINCT FROM OLD.config_release_id THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.config_release_id IS NOT NULL
       AND coalesce(current_setting('matrix.allow_repin', true), '') <> 'on' THEN
        RAISE EXCEPTION 'site % is pinned to release % and finishes on it (set matrix.allow_repin=on to override)',
            OLD.id, OLD.config_release_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.config_release_id IS NOT NULL THEN
        SELECT r.tenant_id INTO rel_tenant
          FROM public.tenant_config_releases r
         WHERE r.id = NEW.config_release_id;
        IF rel_tenant IS DISTINCT FROM NEW.tenant_id THEN
            RAISE EXCEPTION 'release % does not belong to tenant %', NEW.config_release_id, NEW.tenant_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sites_pin_release ON public.sites;
CREATE TRIGGER trg_sites_pin_release
    BEFORE INSERT OR UPDATE OF config_release_id ON public.sites
    FOR EACH ROW EXECUTE FUNCTION public.cfg_sites_pin_release();

-- 20261005_1 — Audited "migrate running cases": move in-flight custom-module cases (and the site
--              pin they share) from release vN to vM, through ONE controlled, journaled path.
--
-- PURPOSE (Phase 2b, G3 #2 — idea from the user's operaton-plat `op_migrate_running`)
--   20261004_4/_5 pin a site and its module records to the release they started on and REFUSE a
--   re-pin unless the session sets `matrix.allow_repin = 'on'` — a free switch any session can flip,
--   leaving no trace. Hot-fixing a flow needs an explicit admin action instead. This file adds:
--     * public.module_release_migrations       — one row per executed migration (header): tenant,
--                                                target release, which releases it moves from
--                                                ('v<N>' | 'all_older'), scope, mandatory reason, the
--                                                platform admin who ran it, status running|done|failed,
--                                                summary. Only status/summary/finished_at may change,
--                                                and only while it is running.
--     * public.module_release_migration_items  — APPEND-ONLY, one row per moved site pin
--                                                (record_id NULL) and per moved record: from/to
--                                                release, before/after stage, the FULL pre-migration
--                                                runtime_state (never lose data), the plan applied.
--     * public.cfg_release_migration_authorizes(tenant, site, record, from, to) — true only when the
--       transaction-local setting `matrix.release_migration` names a RUNNING migration of that tenant
--       AND an item row of it authorises exactly this site/record moving from -> to.
--     * cfg_sites_pin_release / cfg_module_records_guard (from _4/_5) replaced: a pinned site or a
--       record may change release ONLY when cfg_release_migration_authorizes() says so. The
--       `matrix.allow_repin` switch is no longer honoured. NULL -> release (adopting a legacy site)
--       is unchanged. The "record release = site pin" check now runs on INSERT and on a release
--       change only, so a FINISHED case may stay on the release it finished on after its site moved.
--   The migration service sets the setting with set_config(..., true) (transaction-local) inside the
--   per-site transaction, after inserting the item rows; every other UPDATE is refused.
--
-- CONVENTIONS: idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS), function bodies
--   in $$, each statement independent (the ledger runner runs each in its own transaction).
--   Sorts after 20261004_7 ('5' > '4' at position 8).
--
-- ROLLBACK
--   Re-run the CREATE OR REPLACE FUNCTION bodies of 20261004_4 (cfg_sites_pin_release) and
--   20261004_5 (cfg_module_records_guard), then
--   DROP TABLE IF EXISTS public.module_release_migration_items, public.module_release_migrations;
--   DROP FUNCTION IF EXISTS public.cfg_release_migration_authorizes(uuid, uuid, uuid, uuid, uuid),
--     public.cfg_mrm_guard(), public.cfg_mrmi_guard();

CREATE TABLE IF NOT EXISTS public.module_release_migrations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    to_release_id uuid NOT NULL,
    from_spec     text NOT NULL,
    scope         jsonb NOT NULL DEFAULT '{}'::jsonb,
    reason        text NOT NULL,
    actor         text NOT NULL,
    status        text NOT NULL DEFAULT 'running',
    summary       jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    CONSTRAINT fk_mrm_to_release FOREIGN KEY (tenant_id, to_release_id)
        REFERENCES public.tenant_config_releases (tenant_id, id),
    CONSTRAINT chk_mrm_status CHECK (status IN ('running', 'done', 'failed')),
    CONSTRAINT chk_mrm_reason CHECK (length(btrim(reason)) >= 3),
    CONSTRAINT chk_mrm_from_spec CHECK (from_spec ~ '^(all_older|v[0-9]+)$'),
    CONSTRAINT chk_mrm_scope CHECK (jsonb_typeof(scope) = 'object'),
    CONSTRAINT chk_mrm_actor CHECK (length(btrim(actor)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_mrm_tenant_created
    ON public.module_release_migrations (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.module_release_migration_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    migration_id    uuid NOT NULL REFERENCES public.module_release_migrations(id) ON DELETE CASCADE,
    tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    site_id         uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    record_id       uuid REFERENCES public.module_records(id) ON DELETE CASCADE,
    module_key      text,
    from_release_id uuid NOT NULL,
    to_release_id   uuid NOT NULL,
    before_stage    jsonb,
    after_stage     jsonb,
    before_state    jsonb,
    after_state     jsonb,
    plan            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_mrmi_from_release FOREIGN KEY (tenant_id, from_release_id)
        REFERENCES public.tenant_config_releases (tenant_id, id),
    CONSTRAINT fk_mrmi_to_release FOREIGN KEY (tenant_id, to_release_id)
        REFERENCES public.tenant_config_releases (tenant_id, id),
    CONSTRAINT chk_mrmi_record_module CHECK ((record_id IS NULL) = (module_key IS NULL)),
    CONSTRAINT chk_mrmi_moves CHECK (from_release_id <> to_release_id),
    CONSTRAINT chk_mrmi_plan CHECK (jsonb_typeof(plan) = 'object'),
    CONSTRAINT chk_mrmi_before_state CHECK (before_state IS NULL OR jsonb_typeof(before_state) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mrmi_site_pin
    ON public.module_release_migration_items (migration_id, site_id)
    WHERE record_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mrmi_record
    ON public.module_release_migration_items (migration_id, record_id)
    WHERE record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mrmi_record
    ON public.module_release_migration_items (record_id)
    WHERE record_id IS NOT NULL;

-- Header: immutable except status/summary/finished_at while running; deletes only via cascade.
CREATE OR REPLACE FUNCTION public.cfg_mrm_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF pg_trigger_depth() > 1 THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'module_release_migrations is an audit journal: DELETE refused'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.to_release_id IS DISTINCT FROM OLD.to_release_id OR NEW.from_spec IS DISTINCT FROM OLD.from_spec
       OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.actor IS DISTINCT FROM OLD.actor OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'module_release_migrations: only status, summary and finished_at may change'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status <> 'running' THEN
        RAISE EXCEPTION 'migration % is %, it can no longer change', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mrm_guard ON public.module_release_migrations;
CREATE TRIGGER trg_mrm_guard
    BEFORE UPDATE OR DELETE ON public.module_release_migrations
    FOR EACH ROW EXECUTE FUNCTION public.cfg_mrm_guard();

-- Items: only into a RUNNING migration of the same tenant, towards its target release, for a
-- site/record of that tenant that currently runs on from_release_id.
CREATE OR REPLACE FUNCTION public.cfg_mrmi_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    mig record;
    cur uuid;
BEGIN
    SELECT m.tenant_id, m.to_release_id, m.status INTO mig
      FROM public.module_release_migrations m WHERE m.id = NEW.migration_id;
    IF mig.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'migration item tenant does not match its migration'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF mig.status <> 'running' THEN
        RAISE EXCEPTION 'migration % is %, it takes no more items', NEW.migration_id, mig.status
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.to_release_id <> mig.to_release_id THEN
        RAISE EXCEPTION 'migration item must move to the migration target %', mig.to_release_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.record_id IS NULL THEN
        SELECT s.config_release_id INTO cur
          FROM public.sites s WHERE s.id = NEW.site_id AND s.tenant_id = NEW.tenant_id;
    ELSE
        SELECT r.release_id INTO cur
          FROM public.module_records r
         WHERE r.id = NEW.record_id AND r.site_id = NEW.site_id AND r.tenant_id = NEW.tenant_id
           AND r.module_key = NEW.module_key;
    END IF;
    IF cur IS DISTINCT FROM NEW.from_release_id THEN
        RAISE EXCEPTION 'migration item: % runs on release %, not %',
            coalesce(NEW.record_id, NEW.site_id), cur, NEW.from_release_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mrmi_guard ON public.module_release_migration_items;
CREATE TRIGGER trg_mrmi_guard
    BEFORE INSERT ON public.module_release_migration_items
    FOR EACH ROW EXECUTE FUNCTION public.cfg_mrmi_guard();

DROP TRIGGER IF EXISTS trg_mrmi_append_only ON public.module_release_migration_items;
CREATE TRIGGER trg_mrmi_append_only
    BEFORE UPDATE OR DELETE ON public.module_release_migration_items
    FOR EACH ROW EXECUTE FUNCTION public.cfg_forbid_mutation();

-- The ONE authorisation the pin triggers accept. Compared as text so a junk setting is simply
-- "not authorised" (never a cast error).
CREATE OR REPLACE FUNCTION public.cfg_release_migration_authorizes(
    p_tenant uuid, p_site uuid, p_record uuid, p_from uuid, p_to uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.module_release_migration_items i
          JOIN public.module_release_migrations m ON m.id = i.migration_id
         WHERE m.id::text = coalesce(current_setting('matrix.release_migration', true), '')
           AND m.status = 'running'
           AND m.tenant_id = p_tenant
           AND i.tenant_id = p_tenant
           AND i.site_id = p_site
           AND i.record_id IS NOT DISTINCT FROM p_record
           AND i.from_release_id = p_from
           AND i.to_release_id = p_to
    );
$$;

-- Replaces 20261004_4: a pinned site moves only through an authorised migration item.
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

    IF TG_OP = 'UPDATE' AND OLD.config_release_id IS NOT NULL THEN
        IF NEW.config_release_id IS NULL
           OR NOT public.cfg_release_migration_authorizes(NEW.tenant_id, NEW.id, NULL,
                                                          OLD.config_release_id, NEW.config_release_id) THEN
            RAISE EXCEPTION 'site % is pinned to release % and finishes on it; only an audited release migration may move it',
                OLD.id, OLD.config_release_id
                USING ERRCODE = 'check_violation';
        END IF;
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

-- Replaces 20261004_5: a record changes release only through an authorised migration item, and
-- must then land on its site's (already moved) pin.
CREATE OR REPLACE FUNCTION public.cfg_module_records_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    s_tenant uuid;
    s_pin    uuid;
    live_rel uuid;
    moving   boolean;
BEGIN
    SELECT s.tenant_id, s.config_release_id INTO s_tenant, s_pin
      FROM public.sites s WHERE s.id = NEW.site_id;
    IF s_tenant IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'site % does not belong to tenant %', NEW.site_id, NEW.tenant_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    moving := TG_OP = 'UPDATE' AND NEW.release_id IS DISTINCT FROM OLD.release_id;
    IF moving AND NOT public.cfg_release_migration_authorizes(NEW.tenant_id, NEW.site_id, NEW.id,
                                                              OLD.release_id, NEW.release_id) THEN
        RAISE EXCEPTION 'module record % runs on release % and finishes on it; only an audited release migration may move it',
            OLD.id, OLD.release_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.release_id IS NULL THEN
        SELECT l.release_id INTO live_rel FROM public.tenant_config_live l WHERE l.tenant_id = NEW.tenant_id;
        NEW.release_id := coalesce(s_pin, live_rel);
        IF NEW.release_id IS NULL THEN
            RAISE EXCEPTION 'tenant % has no published configuration release', NEW.tenant_id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF (TG_OP = 'INSERT' OR moving) AND s_pin IS NOT NULL AND NEW.release_id <> s_pin THEN
        RAISE EXCEPTION 'site % is pinned to release %; module record may not use release %',
            NEW.site_id, s_pin, NEW.release_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.tenant_config_releases r
         CROSS JOIN LATERAL jsonb_array_elements(r.manifest -> 'modules') AS m(value)
         WHERE r.id = NEW.release_id
           AND (m.value ->> 'key' = NEW.module_key
                OR m.value ->> 'key' = (SELECT c.config_key FROM public.module_catalog c
                                         WHERE c.key = NEW.module_key))
    ) THEN
        RAISE EXCEPTION 'module % is not part of release %', NEW.module_key, NEW.release_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.runtime_state ? 'release' AND NEW.runtime_state ->> 'release' <> NEW.release_id::text THEN
        RAISE EXCEPTION 'runtime_state belongs to release %, record is pinned to %',
            NEW.runtime_state ->> 'release', NEW.release_id
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

ALTER TABLE public.module_release_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_release_migration_items ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['module_release_migrations','module_release_migration_items']
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
        EXECUTE format('CREATE POLICY tenant_isolation ON public.%I '
                       'USING (tenant_id = public.current_tenant_id()) '
                       'WITH CHECK (tenant_id = public.current_tenant_id())', t);
    END LOOP;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON public.module_release_migrations, public.module_release_migration_items FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON public.module_release_migrations, public.module_release_migration_items FROM authenticated;
    END IF;
END $$;

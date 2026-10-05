-- 20261004_2 — Module registry: platform catalog of built-ins + per-tenant module enablement.
--
-- PURPOSE
--   "Module" is hard-coded today: five CHECK constraints spell out module IN ('bd','legal',...),
--   and the backend/frontend each keep their own lists. The configurator needs (a) built-in
--   modules switched on/off, relabelled and re-ordered PER TENANT and (b) CUSTOM modules whose
--   keys exist only in one tenant. This file adds the registry those need:
--     * public.module_catalog  — platform-owned list of BUILT-IN modules and scopes (global; seeded
--       here; changes only with a code deploy). Carries the configurator alias (pex ->
--       project_excellence), which scopes a key is valid in today, where its raw status lives, an
--       advisory raw-status -> configurator-outcome map and a raw-status -> CUMULATIVE reached-outcomes
--       map (both used by the gate-input view in _5).
--     * public.tenant_modules  — per-tenant registry: every module key a tenant may reference
--       (built-in or custom), with label / position / enabled / supervisor-only / delegation flags.
--       It is the materialised projection of the tenant's LIVE release; rows are never deleted
--       (disable instead), so historic rows that reference a key stay valid.
--     * public.is_valid_module_key(text) — the configurator's key rule
--       (building-blocks vocabularies.json moduleKeyPattern + reservedModuleKeys).
--     * public.cfg_activate_release(release, actor) — the publish step: projects a release manifest
--       onto tenant_modules (enable/label/order/supervisor-only/delegation, custom keys registered)
--       and repoints tenant_config_live, in one transaction.
--   Backfill: every existing tenant gets every non-retired built-in, enabled (= exactly today's
--   behaviour: every tenant has every module). Retired keys ('payment') get a DISABLED row only for
--   tenants whose existing rows still reference them. New tenants get the same seed from an
--   AFTER INSERT trigger on tenants, so tenancy_service's INSERT INTO tenants needs no change.
--
-- CONVENTIONS: runner semantics as in 20261004_1. Seeds use ON CONFLICT DO NOTHING (re-runs never
--   overwrite operator edits).
--
-- ROLLBACK (before 20261004_3 is applied)
--   DROP TRIGGER IF EXISTS trg_tenants_seed_modules ON public.tenants;
--   DROP TABLE IF EXISTS public.tenant_modules; DROP TABLE IF EXISTS public.module_catalog;
--   DROP FUNCTION IF EXISTS public.cfg_activate_release(uuid, text), public.cfg_seed_tenant_modules(),
--                           public.cfg_tenant_modules_guard(), public.is_valid_module_key(text);

CREATE OR REPLACE FUNCTION public.is_valid_module_key(k text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT k IS NOT NULL
       AND k ~ '^[a-z][a-z0-9_]{1,38}$'
       AND k <> ALL (ARRAY['admin','api','new','site','sites','user','users',
                           'module','modules','settings','auth','report','reports']);
$$;

CREATE TABLE IF NOT EXISTS public.module_catalog (
    key              text PRIMARY KEY,
    name             text NOT NULL,
    config_key       text,
    surface          text NOT NULL DEFAULT 'module',
    implementation   text NOT NULL,
    has_membership   boolean NOT NULL,
    has_delegation   boolean NOT NULL,
    supervisor_only  boolean NOT NULL DEFAULT false,
    default_position integer NOT NULL DEFAULT 0,
    status_source    text,
    outcome_map      jsonb,
    reached_map      jsonb,
    retired_at       timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_mc_key        CHECK (public.is_valid_module_key(key)),
    CONSTRAINT chk_mc_config_key CHECK (config_key IS NULL OR public.is_valid_module_key(config_key)),
    CONSTRAINT chk_mc_surface    CHECK (surface IN ('module', 'scope')),
    CONSTRAINT chk_mc_outcome_map CHECK (outcome_map IS NULL OR jsonb_typeof(outcome_map) = 'object'),
    CONSTRAINT chk_mc_reached_map CHECK (reached_map IS NULL OR jsonb_typeof(reached_map) = 'object'),
    CONSTRAINT uq_mc_config_key  UNIQUE (config_key)
);

-- Built-ins as they exist in origin/main (3d4f277). has_membership / has_delegation reproduce
-- the CURRENT CHECK lists (membership: module_codes, supervisor_invite_codes,
-- user_module_memberships, supervisor_executive_requests; delegation: site_delegations).
-- outcome_map (raw status -> CURRENT configurator outcome) and reached_map (raw status -> EVERY
-- outcome reached to get there, i.e. the cumulative list gates evaluate: "has X reached done?")
-- are ADVISORY and INFERRED from the built-in FSMs (building-blocks/from-matrix-bd/
-- matrix-bd-flow.json statusVocabulary/exitSignal). Production's own gates read the CURRENT mirror
-- column (workflow_unlocks.design_unlock_ready), so deriving "reached" from the current status
-- reproduces production semantics; a status absent from a map passes through unchanged.
INSERT INTO public.module_catalog
    (key, name, config_key, surface, implementation, has_membership, has_delegation,
     supervisor_only, default_position, status_source, outcome_map, reached_map, retired_at)
VALUES
    ('bd', 'BD', 'bd', 'module', 'builtin:bd', true, true, false, 10, 'sites.status',
     '{"draft_submitted":"submitted","shortlisted":"in progress","details_submitted":"submitted","approved":"approved","loi_uploaded":"done","legal_review":"done","legal_approved":"done","legal_rejected":"done","pushed_to_payments":"done","rejected":"rejected","archived":"skipped"}',
     '{"draft_submitted":["submitted"],"shortlisted":["submitted","in progress"],"details_submitted":["submitted","in progress"],"approved":["submitted","in progress","approved"],"loi_uploaded":["submitted","in progress","approved","done"],"legal_review":["submitted","in progress","approved","done"],"legal_approved":["submitted","in progress","approved","done"],"legal_rejected":["submitted","in progress","approved","done"],"pushed_to_payments":["submitted","in progress","approved","done"],"rejected":["submitted","rejected"],"archived":["submitted","skipped"]}', NULL),
    ('legal', 'Legal & Compliance', 'legal', 'module', 'builtin:legal', true, true, false, 20, 'sites.legal_dd_status (+ licensing_status=complete -> done)',
     '{"in_review":"in progress","positive":"approved","negative":"rejected"}',
     '{"in_review":["in progress"],"positive":["in progress","approved"],"negative":["in progress","rejected"]}', NULL),
    ('finance_ca', 'Finance / CA approval', 'finance_ca', 'module', 'builtin:bd-finance-tab+business-admin', false, false, false, 25, 'sites.finance_status',
     '{"awaiting_supervisor":"submitted","awaiting_admin":"submitted"}',
     '{"awaiting_supervisor":["submitted"],"awaiting_admin":["submitted"],"approved":["submitted","approved"]}', NULL),
    ('design', 'Design', 'design', 'module', 'builtin:design', true, true, false, 30, 'sites.design_status',
     '{"in_progress":"in progress","gfc_pending":"submitted"}',
     '{"allocated":["allocated"],"in_progress":["allocated","in progress"],"gfc_pending":["allocated","in progress","submitted"],"approved":["allocated","in progress","submitted","approved"],"rejected":["allocated","in progress","submitted","rejected"]}', NULL),
    ('project_excellence', 'Project Excellence', 'pex', 'module', 'builtin:project_excellence', true, true, false, 40, 'sites.project_excellence_status',
     '{"budgeting":"in progress"}',
     '{"allocated":["allocated"],"budgeting":["allocated","in progress"],"approved":["allocated","in progress","approved"],"done":["allocated","in progress","approved","done"]}', NULL),
    ('project', 'Project execution', 'project', 'module', 'builtin:project', true, true, false, 50, 'sites.project_status',
     '{"budgeting":"in progress","in_progress":"in progress"}',
     '{"allocated":["allocated"],"budgeting":["allocated","in progress"],"in_progress":["allocated","in progress"],"done":["allocated","in progress","done"]}', NULL),
    ('nso', 'NSO', 'nso', 'module', 'builtin:nso', true, true, true, 60, 'nso_reviews.nso_status',
     '{"in_progress":"in progress","complete":"done"}',
     '{"in_progress":["in progress"],"complete":["in progress","done"]}', NULL),
    ('launch_approval', 'Launch approval', 'launch_approval', 'module', 'builtin:launch', false, false, false, 70, 'launch_approvals.status',
     '{"pending_admin_review":"in progress","under_exec_review":"in progress","under_supervisor_review":"in progress","pending_admin_final":"in progress","ready_to_launch":"approved","launched":"done"}',
     '{"pending_admin_review":["in progress"],"under_exec_review":["in progress","submitted"],"under_supervisor_review":["in progress","submitted"],"pending_admin_final":["in progress","submitted"],"ready_to_launch":["in progress","submitted","approved"],"launched":["in progress","submitted","approved","done"]}', NULL),
    ('financial_closure', 'Financial closure', 'financial_closure', 'module', 'builtin:financial_closure', false, true, false, 80, 'sites.financial_closure_status',
     '{"open":"pending","budgeting":"in progress","closed":"done"}',
     '{"allocated":["allocated"],"budgeting":["allocated","in progress"],"closed":["allocated","in progress","done"]}', NULL),
    ('quality_audit', 'Quality audit reports', NULL, 'scope', 'builtin:project_excellence(qa)', false, true, false, 90, NULL, NULL, NULL, NULL),
    ('payment', 'Payment (retired)', NULL, 'module', 'retired', true, false, false, 99, NULL, NULL, NULL, '2026-06-13T00:00:00Z')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.tenant_modules (
    tenant_id             uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    module_key            text NOT NULL,
    kind                  text NOT NULL,
    catalog_key           text REFERENCES public.module_catalog(key),
    config_key            text,
    label                 text NOT NULL,
    position              integer NOT NULL DEFAULT 0,
    enabled               boolean NOT NULL DEFAULT true,
    supervisor_only       boolean NOT NULL DEFAULT false,
    delegation_enabled    boolean NOT NULL DEFAULT true,
    route                 text,
    introduced_release_id uuid,
    updated_release_id    uuid,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenant_modules_pkey PRIMARY KEY (tenant_id, module_key),
    CONSTRAINT chk_tm_key        CHECK (public.is_valid_module_key(module_key)),
    CONSTRAINT chk_tm_kind       CHECK (kind IN ('builtin', 'custom')),
    CONSTRAINT chk_tm_catalog    CHECK ((kind = 'builtin') = (catalog_key IS NOT NULL)
                                        AND (catalog_key IS NULL OR catalog_key = module_key)),
    CONSTRAINT chk_tm_config_key CHECK (config_key IS NULL OR public.is_valid_module_key(config_key)),
    CONSTRAINT fk_tm_introduced_release FOREIGN KEY (tenant_id, introduced_release_id)
        REFERENCES public.tenant_config_releases (tenant_id, id),
    CONSTRAINT fk_tm_updated_release FOREIGN KEY (tenant_id, updated_release_id)
        REFERENCES public.tenant_config_releases (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tm_tenant_config_key
    ON public.tenant_modules (tenant_id, config_key)
    WHERE config_key IS NOT NULL;

-- A custom module may not take a built-in's key (or alias); keeps updated_at honest.
CREATE OR REPLACE FUNCTION public.cfg_tenant_modules_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.kind = 'custom' AND EXISTS (
        SELECT 1 FROM public.module_catalog c
         WHERE c.key = NEW.module_key OR c.config_key = NEW.module_key
    ) THEN
        RAISE EXCEPTION 'custom module key "%" collides with a built-in module', NEW.module_key
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.module_key <> OLD.module_key OR NEW.kind <> OLD.kind THEN
            RAISE EXCEPTION 'tenant_modules.module_key / kind are immutable (disable the row instead)'
                USING ERRCODE = 'check_violation';
        END IF;
        NEW.updated_at := now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_modules_guard ON public.tenant_modules;
CREATE TRIGGER trg_tenant_modules_guard
    BEFORE INSERT OR UPDATE ON public.tenant_modules
    FOR EACH ROW EXECUTE FUNCTION public.cfg_tenant_modules_guard();

-- Seed for a NEW tenant: every non-retired built-in, enabled (today's behaviour). The first
-- configurator publish then rewrites enabled/label/position from the manifest.
CREATE OR REPLACE FUNCTION public.cfg_seed_tenant_modules()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO public.tenant_modules
        (tenant_id, module_key, kind, catalog_key, config_key, label, position,
         enabled, supervisor_only, delegation_enabled)
    SELECT NEW.id, c.key, 'builtin', c.key, c.config_key, c.name, c.default_position,
           true, c.supervisor_only, c.has_delegation
      FROM public.module_catalog c
     WHERE c.retired_at IS NULL
    ON CONFLICT (tenant_id, module_key) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenants_seed_modules ON public.tenants;
CREATE TRIGGER trg_tenants_seed_modules
    AFTER INSERT ON public.tenants
    FOR EACH ROW EXECUTE FUNCTION public.cfg_seed_tenant_modules();

-- Backfill 1: existing tenants x non-retired built-ins.
INSERT INTO public.tenant_modules
    (tenant_id, module_key, kind, catalog_key, config_key, label, position,
     enabled, supervisor_only, delegation_enabled)
SELECT t.id, c.key, 'builtin', c.key, c.config_key, c.name, c.default_position,
       true, c.supervisor_only, c.has_delegation
  FROM public.tenants t
 CROSS JOIN public.module_catalog c
 WHERE c.retired_at IS NULL
ON CONFLICT (tenant_id, module_key) DO NOTHING;

-- Backfill 2: retired catalog keys that existing rows still reference (e.g. 'payment', which
-- 202606142 re-admitted in module_codes / supervisor_invite_codes / user_module_memberships)
-- — registered DISABLED so historic rows stay valid under the FK added by 20261004_3.
INSERT INTO public.tenant_modules
    (tenant_id, module_key, kind, catalog_key, config_key, label, position,
     enabled, supervisor_only, delegation_enabled)
SELECT DISTINCT x.tenant_id, c.key, 'builtin', c.key, c.config_key, c.name, c.default_position,
       false, c.supervisor_only, c.has_delegation
  FROM (
        SELECT tenant_id, module FROM public.module_codes
        UNION SELECT tenant_id, module FROM public.supervisor_invite_codes
        UNION SELECT tenant_id, module FROM public.user_module_memberships
        UNION SELECT tenant_id, module FROM public.site_delegations
        UNION SELECT tenant_id, module FROM public.supervisor_executive_requests
       ) x
  JOIN public.module_catalog c ON c.key = x.module AND c.retired_at IS NOT NULL
ON CONFLICT (tenant_id, module_key) DO NOTHING;

-- Publish/activate: project a release manifest onto tenant_modules and make it live, atomically
-- (one function call = one statement = one transaction). Built-in manifest keys are resolved
-- through module_catalog (key or configurator alias); anything else is a custom module. Modules
-- registered earlier but absent from the release are DISABLED, never deleted (historic rows keep
-- their FK target); delegation-only scopes (surface='scope') are left alone.
CREATE OR REPLACE FUNCTION public.cfg_activate_release(p_release uuid, p_actor text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    rel   record;
    m     jsonb;
    pos   integer := 0;
    rkey  text;
    rkind text;
    seen  text[] := ARRAY[]::text[];
BEGIN
    SELECT r.id, r.tenant_id, r.manifest INTO rel
      FROM public.tenant_config_releases r WHERE r.id = p_release;
    IF rel.id IS NULL THEN
        RAISE EXCEPTION 'release % not found', p_release USING ERRCODE = 'no_data_found';
    END IF;
    FOR m IN SELECT value FROM jsonb_array_elements(rel.manifest -> 'modules')
    LOOP
        pos := pos + 1;
        IF m ->> 'type' = 'builtin' THEN
            SELECT c.key INTO rkey FROM public.module_catalog c
             WHERE c.config_key = m ->> 'key' OR c.key = m ->> 'key'
             ORDER BY (c.config_key = m ->> 'key') DESC NULLS LAST
             LIMIT 1;
            IF rkey IS NULL THEN
                RAISE EXCEPTION 'release % names unknown built-in module %', p_release, m ->> 'key'
                    USING ERRCODE = 'check_violation';
            END IF;
            rkind := 'builtin';
        ELSE
            rkey := m ->> 'key';
            rkind := 'custom';
        END IF;
        INSERT INTO public.tenant_modules AS tm
            (tenant_id, module_key, kind, catalog_key, config_key, label, position, enabled,
             supervisor_only, delegation_enabled, route, introduced_release_id, updated_release_id)
        VALUES (rel.tenant_id, rkey, rkind, CASE WHEN rkind = 'builtin' THEN rkey END, m ->> 'key',
                coalesce(m ->> 'name', rkey), pos * 10,
                coalesce((m ->> 'enabled')::boolean, true),
                NOT coalesce((m -> 'tiers' ->> 'executive')::boolean, true),
                coalesce((m -> 'tiers' ->> 'delegation')::boolean, true),
                m ->> 'route', p_release, p_release)
        ON CONFLICT (tenant_id, module_key) DO UPDATE
           SET config_key = EXCLUDED.config_key, label = EXCLUDED.label,
               position = EXCLUDED.position, enabled = EXCLUDED.enabled,
               supervisor_only = EXCLUDED.supervisor_only,
               delegation_enabled = EXCLUDED.delegation_enabled,
               route = EXCLUDED.route, updated_release_id = p_release;
        seen := seen || rkey;
    END LOOP;
    UPDATE public.tenant_modules tm
       SET enabled = false, updated_release_id = p_release
     WHERE tm.tenant_id = rel.tenant_id
       AND tm.enabled
       AND NOT (tm.module_key = ANY (seen))
       AND NOT EXISTS (SELECT 1 FROM public.module_catalog c
                        WHERE c.key = tm.module_key AND c.surface = 'scope');
    INSERT INTO public.tenant_config_live (tenant_id, release_id, activated_by)
    VALUES (rel.tenant_id, p_release, p_actor)
    ON CONFLICT (tenant_id) DO UPDATE
       SET release_id = EXCLUDED.release_id, activated_at = now(),
           activated_by = EXCLUDED.activated_by;
    RETURN pos;
END;
$$;

-- RLS: module_catalog is global platform data (no tenant_id) -> RLS on with no policy
-- (default-deny for anon/authenticated, like workspace_requests); tenant_modules is a tenant table.
ALTER TABLE public.module_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_modules ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    DROP POLICY IF EXISTS tenant_isolation ON public.tenant_modules;
    CREATE POLICY tenant_isolation ON public.tenant_modules
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id());
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON public.module_catalog, public.tenant_modules FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON public.module_catalog, public.tenant_modules FROM authenticated;
    END IF;
END $$;

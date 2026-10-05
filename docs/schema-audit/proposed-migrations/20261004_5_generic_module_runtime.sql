-- 20261004_5 — Generic module runtime: records, stage progress, field values, tier approvals,
--              and the gate-input read model.
--
-- PURPOSE
--   Every built-in module owns bespoke tables (legal_dd_checklist, design_reviews, project_reviews,
--   nso_reviews, site_budgets, launch_approvals …) with hard-coded columns and status CHECKs. A
--   CUSTOM module designed in the configurator has no tables at all. This file adds ONE generic,
--   tenant-scoped runtime that executes any module described by a release manifest:
--     * public.module_records       — one per (site, module): status, current stage, exit outcome,
--                                     assignee/supervisor, the RELEASE it runs on (pinned), and
--                                     runtime_state (jsonb) — the interpreter's own state (step, pass,
--                                     verdicts, reached outcomes, audit hash-chain head), persisted
--                                     atomically with the queryable columns (F3 runtime.py).
--                                     For CUSTOM modules this is the whole state. For BUILT-INs it is
--                                     optional and only carries configurator-added extension fields
--                                     (their real state stays in the bespoke tables).
--     * public.module_stage_states  — per record and stage: stage status + field values (jsonb,
--                                     keyed by the manifest's field keys; file fields store the
--                                     storage key/name/size/mime object).
--     * public.module_approvals     — APPEND-ONLY: who acted, in which tier, with which verdict, on
--                                     which release ("approved-by" provenance), and whether it was a
--                                     business-admin OVERRIDE (acting outside the stage's tier chain,
--                                     production's guard bypass) — recorded, never inferred.
--     * view public.site_module_outcomes — gate-evaluation inputs: one row per (site, module) with the
--                                     raw status, the current configurator outcome and `reached` — the
--                                     CUMULATIVE list of outcomes reached so far (built-ins: via
--                                     module_catalog.reached_map over the mirror column; custom modules:
--                                     runtime_state.reached, falling back to the current outcome).
--   Integrity is enforced in the DB against the PINNED release manifest (manifest.schema.json
--   shape: modules[].key, modules[].stages[].order / .name / .approvers):
--     - a record's release must be the site's pin (or the tenant's live release for a legacy site),
--       must belong to the tenant, and must contain the module;
--     - a stage row must exist in that module's manifest stages;
--     - an approval row's tier must belong to the stage's TIER CHAIN = its approvers ordered
--       executive < supervisor < business_admin, minus tiers the module switches off
--       (tiers.executive / tiers.business_admin_signoff = false), default [supervisor] — exactly
--       runtime.py ModuleRuntime.chain(); 'submitted' only by the FIRST tier of the chain (so an
--       admin-only stage with fields — Design GFC, PEx admin review, Launch admin review — is a
--       business_admin 'submitted' row, recorded as such);
--     - the actor must be entitled to that tier: actor_role = tier, or a higher tier that is itself in
--       the chain (a supervisor doing the executive step); anything else is accepted ONLY as a
--       business-admin override with is_override = true — and is_override must be truthful (it is
--       refused on rows that did not need it).
--   Outcome vocabulary = configurator stageOutcomes (platform-owned, not tenant-defined, so a CHECK
--   is the right tool): pending, allocated, in progress, submitted, rejected, approved, done, skipped.
--
-- ROLLBACK (drops runtime data!)
--   DROP VIEW IF EXISTS public.site_module_outcomes;
--   DROP TABLE IF EXISTS public.module_approvals, public.module_stage_states, public.module_records;
--   DROP FUNCTION IF EXISTS public.cfg_release_stage(uuid, text, integer),
--     public.cfg_release_stage_chain(uuid, text, integer),
--     public.cfg_module_records_guard(), public.cfg_module_stage_states_guard(),
--     public.cfg_module_approvals_guard();

-- Stage definition from a release manifest (NULL if absent). Accepts the runtime key or the
-- configurator alias of a built-in (project_excellence <-> pex).
CREATE OR REPLACE FUNCTION public.cfg_release_stage(p_release uuid, p_module text, p_stage integer)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT s.value
      FROM public.tenant_config_releases r
     CROSS JOIN LATERAL jsonb_array_elements(r.manifest -> 'modules') AS m(value)
     CROSS JOIN LATERAL jsonb_array_elements(coalesce(m.value -> 'stages', '[]'::jsonb)) AS s(value)
     WHERE r.id = p_release
       AND (m.value ->> 'key' = p_module
            OR m.value ->> 'key' = (SELECT c.config_key FROM public.module_catalog c WHERE c.key = p_module))
       AND (s.value ->> 'order') = p_stage::text
     LIMIT 1;
$$;

-- The stage's tier chain, mirroring third_party/matrix-adapters/runtime.py ModuleRuntime.chain():
-- approvers (default [supervisor]) ordered executive < supervisor < business_admin, without the
-- tiers the module switches off. NULL when the stage does not exist in the release.
CREATE OR REPLACE FUNCTION public.cfg_release_stage_chain(p_release uuid, p_module text, p_stage integer)
RETURNS text[]
LANGUAGE sql
STABLE
AS $$
    WITH mod AS (
        SELECT m.value AS module
          FROM public.tenant_config_releases r
         CROSS JOIN LATERAL jsonb_array_elements(r.manifest -> 'modules') AS m(value)
         WHERE r.id = p_release
           AND (m.value ->> 'key' = p_module
                OR m.value ->> 'key' = (SELECT c.config_key FROM public.module_catalog c WHERE c.key = p_module))
         LIMIT 1
    ), stg AS (
        SELECT s.value AS stage, mod.module
          FROM mod
         CROSS JOIN LATERAL jsonb_array_elements(coalesce(mod.module -> 'stages', '[]'::jsonb)) AS s(value)
         WHERE (s.value ->> 'order') = p_stage::text
         LIMIT 1
    ), roles AS (
        SELECT DISTINCT a.role,
               CASE a.role WHEN 'executive' THEN 0 WHEN 'supervisor' THEN 1
                           WHEN 'business_admin' THEN 2 ELSE 1 END AS rnk
          FROM stg
         CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(stg.stage -> 'approvers') = 'array'
                         AND jsonb_array_length(stg.stage -> 'approvers') > 0
                    THEN stg.stage -> 'approvers' ELSE '["supervisor"]'::jsonb END) AS a(role)
         WHERE NOT (a.role = 'business_admin'
                    AND coalesce(stg.module -> 'tiers' ->> 'business_admin_signoff', 'true') = 'false')
           AND NOT (a.role = 'executive'
                    AND coalesce(stg.module -> 'tiers' ->> 'executive', 'true') = 'false')
    )
    SELECT CASE
             WHEN NOT EXISTS (SELECT 1 FROM stg) THEN NULL
             WHEN EXISTS (SELECT 1 FROM roles) THEN (SELECT array_agg(role ORDER BY rnk, role) FROM roles)
             ELSE ARRAY['supervisor']
           END;
$$;

CREATE TABLE IF NOT EXISTS public.module_records (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    site_id       uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    module_key    text NOT NULL,
    release_id    uuid NOT NULL,
    status        text NOT NULL DEFAULT 'pending',
    current_stage integer,
    exit_outcome  text,
    assigned_to   uuid REFERENCES public.users(id),
    supervisor_id uuid REFERENCES public.users(id),
    opened_by     uuid REFERENCES public.users(id),
    opened_at     timestamptz NOT NULL DEFAULT now(),
    closed_at     timestamptz,
    runtime_state jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_module_records_site_module UNIQUE (site_id, module_key),
    CONSTRAINT fk_mr_tenant_module FOREIGN KEY (tenant_id, module_key)
        REFERENCES public.tenant_modules (tenant_id, module_key),
    CONSTRAINT fk_mr_release FOREIGN KEY (tenant_id, release_id)
        REFERENCES public.tenant_config_releases (tenant_id, id),
    CONSTRAINT chk_mr_status CHECK (status IN ('pending','allocated','in progress','submitted',
                                               'rejected','approved','done','skipped')),
    CONSTRAINT chk_mr_exit_outcome CHECK (exit_outcome IS NULL OR exit_outcome IN
                                          ('pending','allocated','in progress','submitted',
                                           'rejected','approved','done','skipped')),
    CONSTRAINT chk_mr_current_stage CHECK (current_stage IS NULL OR current_stage >= 1),
    CONSTRAINT chk_mr_closed CHECK ((closed_at IS NULL) = (exit_outcome IS NULL)),
    CONSTRAINT chk_mr_runtime_state CHECK (jsonb_typeof(runtime_state) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_module_records_tenant_module_status
    ON public.module_records (tenant_id, module_key, status);
CREATE INDEX IF NOT EXISTS idx_module_records_assigned
    ON public.module_records (assigned_to) WHERE assigned_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.module_stage_states (
    record_id    uuid NOT NULL REFERENCES public.module_records(id) ON DELETE CASCADE,
    stage_order  integer NOT NULL,
    tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    stage_name   text NOT NULL,
    status       text NOT NULL DEFAULT 'pending',
    field_values jsonb NOT NULL DEFAULT '{}'::jsonb,
    submitted_by uuid REFERENCES public.users(id),
    submitted_at timestamptz,
    decided_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT module_stage_states_pkey PRIMARY KEY (record_id, stage_order),
    CONSTRAINT chk_mss_stage_order CHECK (stage_order >= 1),
    CONSTRAINT chk_mss_status CHECK (status IN ('pending','allocated','in progress','submitted',
                                               'rejected','approved','done','skipped')),
    CONSTRAINT chk_mss_field_values CHECK (jsonb_typeof(field_values) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_module_stage_states_tenant
    ON public.module_stage_states (tenant_id);

CREATE TABLE IF NOT EXISTS public.module_approvals (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    record_id          uuid NOT NULL,
    stage_order        integer NOT NULL,
    release_id         uuid NOT NULL,
    tier               text NOT NULL,
    actor_id           uuid NOT NULL REFERENCES public.users(id),
    actor_role         text NOT NULL,
    acting_as_delegate boolean NOT NULL DEFAULT false,
    is_override        boolean NOT NULL DEFAULT false,
    verdict            text NOT NULL,
    comment            text,
    decided_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_ma_stage FOREIGN KEY (record_id, stage_order)
        REFERENCES public.module_stage_states (record_id, stage_order) ON DELETE CASCADE,
    CONSTRAINT fk_ma_release FOREIGN KEY (tenant_id, release_id)
        REFERENCES public.tenant_config_releases (tenant_id, id),
    CONSTRAINT chk_ma_tier CHECK (tier IN ('executive','supervisor','business_admin')),
    CONSTRAINT chk_ma_actor_role CHECK (actor_role IN ('executive','supervisor','business_admin')),
    CONSTRAINT chk_ma_verdict CHECK (verdict IN ('submitted','approved','rejected','sent_back')),
    CONSTRAINT chk_ma_override_by_admin CHECK (NOT is_override OR actor_role = 'business_admin')
);

CREATE INDEX IF NOT EXISTS idx_module_approvals_record
    ON public.module_approvals (record_id, stage_order, decided_at);
CREATE INDEX IF NOT EXISTS idx_module_approvals_tenant
    ON public.module_approvals (tenant_id, decided_at DESC);

-- Guards ---------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cfg_module_records_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    s_tenant uuid;
    s_pin    uuid;
    live_rel uuid;
BEGIN
    SELECT s.tenant_id, s.config_release_id INTO s_tenant, s_pin
      FROM public.sites s WHERE s.id = NEW.site_id;
    IF s_tenant IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'site % does not belong to tenant %', NEW.site_id, NEW.tenant_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.release_id IS DISTINCT FROM OLD.release_id
       AND coalesce(current_setting('matrix.allow_repin', true), '') <> 'on' THEN
        RAISE EXCEPTION 'module record % runs on release % and finishes on it', OLD.id, OLD.release_id
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

    IF s_pin IS NOT NULL AND NEW.release_id <> s_pin
       AND coalesce(current_setting('matrix.allow_repin', true), '') <> 'on' THEN
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

DROP TRIGGER IF EXISTS trg_module_records_guard ON public.module_records;
CREATE TRIGGER trg_module_records_guard
    BEFORE INSERT OR UPDATE ON public.module_records
    FOR EACH ROW EXECUTE FUNCTION public.cfg_module_records_guard();

CREATE OR REPLACE FUNCTION public.cfg_module_stage_states_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    rec   record;
    stage jsonb;
BEGIN
    SELECT r.tenant_id, r.release_id, r.module_key INTO rec
      FROM public.module_records r WHERE r.id = NEW.record_id;
    IF rec.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'stage row tenant does not match its module record'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    stage := public.cfg_release_stage(rec.release_id, rec.module_key, NEW.stage_order);
    IF stage IS NULL THEN
        RAISE EXCEPTION 'stage % does not exist in module % of release %',
            NEW.stage_order, rec.module_key, rec.release_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.stage_name IS NULL THEN
        NEW.stage_name := stage ->> 'name';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_module_stage_states_guard ON public.module_stage_states;
CREATE TRIGGER trg_module_stage_states_guard
    BEFORE INSERT OR UPDATE ON public.module_stage_states
    FOR EACH ROW EXECUTE FUNCTION public.cfg_module_stage_states_guard();

CREATE OR REPLACE FUNCTION public.cfg_module_approvals_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    rec      record;
    chain    text[];
    entitled boolean;
BEGIN
    SELECT r.tenant_id, r.release_id, r.module_key INTO rec
      FROM public.module_records r WHERE r.id = NEW.record_id;
    IF rec.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'approval tenant does not match its module record'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.release_id IS NULL THEN
        NEW.release_id := rec.release_id;
    ELSIF NEW.release_id <> rec.release_id THEN
        RAISE EXCEPTION 'approval must be recorded against the record''s pinned release %', rec.release_id
            USING ERRCODE = 'check_violation';
    END IF;
    chain := public.cfg_release_stage_chain(rec.release_id, rec.module_key, NEW.stage_order);
    IF chain IS NULL THEN
        RAISE EXCEPTION 'stage % does not exist in module % of release %',
            NEW.stage_order, rec.module_key, rec.release_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (NEW.tier = ANY (chain)) THEN
        RAISE EXCEPTION 'tier % is not in the tier chain % of stage % in release %',
            NEW.tier, chain, NEW.stage_order, rec.release_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.verdict = 'submitted' AND NEW.tier <> chain[1] THEN
        RAISE EXCEPTION 'stage % is submitted by its first tier (%), not %', NEW.stage_order, chain[1], NEW.tier
            USING ERRCODE = 'check_violation';
    END IF;
    -- runtime.py _authorize: the tier itself, or a HIGHER tier that is part of the same chain.
    entitled := NEW.actor_role = NEW.tier
                OR (NEW.actor_role = ANY (chain)
                    AND (CASE NEW.actor_role WHEN 'executive' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END)
                      > (CASE NEW.tier WHEN 'executive' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END));
    IF entitled AND NEW.is_override THEN
        RAISE EXCEPTION 'is_override must be false: % is entitled to the % step', NEW.actor_role, NEW.tier
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT entitled AND NOT NEW.is_override THEN
        RAISE EXCEPTION '% may not act on the % step of stage % (only a flagged business-admin override may)',
            NEW.actor_role, NEW.tier, NEW.stage_order
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_module_approvals_guard ON public.module_approvals;
CREATE TRIGGER trg_module_approvals_guard
    BEFORE INSERT ON public.module_approvals
    FOR EACH ROW EXECUTE FUNCTION public.cfg_module_approvals_guard();

DROP TRIGGER IF EXISTS trg_module_approvals_append_only ON public.module_approvals;
CREATE TRIGGER trg_module_approvals_append_only
    BEFORE UPDATE OR DELETE ON public.module_approvals
    FOR EACH ROW EXECUTE FUNCTION public.cfg_forbid_mutation();

-- Gate-evaluation inputs ------------------------------------------------------------------------
-- security_invoker: callers see only what their own RLS allows (cf. 202606122 #106).
CREATE OR REPLACE VIEW public.site_module_outcomes
WITH (security_invoker = true) AS
WITH builtin_raw AS (
    SELECT s.tenant_id, s.id AS site_id, v.module_key, v.raw_status, v.extra_reached
      FROM public.sites s
     CROSS JOIN LATERAL (VALUES
            ('bd', s.status, '{}'::text[]),
            ('legal', s.legal_dd_status,
                      CASE WHEN s.licensing_status = 'complete' THEN ARRAY['done'] ELSE '{}'::text[] END),
            ('finance_ca', s.finance_status, '{}'::text[]),
            ('design', s.design_status, '{}'::text[]),
            ('project', s.project_status, '{}'::text[]),
            ('project_excellence', s.project_excellence_status, '{}'::text[]),
            ('financial_closure', s.financial_closure_status, '{}'::text[])
          ) AS v(module_key, raw_status, extra_reached)
    UNION ALL
    SELECT n.tenant_id, n.site_id, 'nso', n.nso_status, '{}'::text[] FROM public.nso_reviews n
    UNION ALL
    SELECT l.tenant_id, l.site_id, 'launch_approval', l.status, '{}'::text[] FROM public.launch_approvals l
)
SELECT b.tenant_id, b.site_id, b.module_key, b.raw_status,
       coalesce(c.outcome_map ->> b.raw_status, b.raw_status) AS outcome,
       ARRAY(SELECT DISTINCT x
               FROM unnest(
                      coalesce(ARRAY(SELECT jsonb_array_elements_text(c.reached_map -> b.raw_status)),
                               '{}'::text[])
                      || CASE WHEN c.reached_map ? b.raw_status THEN '{}'::text[]
                              WHEN b.raw_status = 'pending' THEN '{}'::text[]
                              ELSE ARRAY[coalesce(c.outcome_map ->> b.raw_status, b.raw_status)] END
                      || b.extra_reached) AS x
              ORDER BY x) AS reached,
       'builtin'::text AS source,
       NULL::uuid AS release_id
  FROM builtin_raw b
  LEFT JOIN public.module_catalog c ON c.key = b.module_key
UNION ALL
SELECT r.tenant_id, r.site_id, r.module_key, r.status,
       coalesce(r.exit_outcome, r.status) AS outcome,
       CASE WHEN jsonb_typeof(r.runtime_state -> 'reached') = 'array'
            THEN ARRAY(SELECT jsonb_array_elements_text(r.runtime_state -> 'reached'))
            WHEN coalesce(r.exit_outcome, r.status) = 'pending' THEN '{}'::text[]
            ELSE ARRAY[coalesce(r.exit_outcome, r.status)] END AS reached,
       'module_record'::text AS source,
       r.release_id
  FROM public.module_records r
  JOIN public.tenant_modules tm
    ON tm.tenant_id = r.tenant_id AND tm.module_key = r.module_key AND tm.kind = 'custom';

-- RLS ------------------------------------------------------------------------------------------
ALTER TABLE public.module_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_stage_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_approvals ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['module_records','module_stage_states','module_approvals']
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
        REVOKE ALL ON public.module_records, public.module_stage_states, public.module_approvals,
                      public.site_module_outcomes FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON public.module_records, public.module_stage_states, public.module_approvals,
                      public.site_module_outcomes FROM authenticated;
    END IF;
END $$;

-- 20261005_2 — "Only for sites they created": a stage-level creator rule, enforced by the
--              append-only approvals guard too (not only by the app).
--
-- PURPOSE (Phase 2b, G3 #3 — idea from operaton-plat `"assignee": "initiator"`, semantics from the
--   real app: launch_service._assert_is_site_creator / _common.assert_executive_owns_site, see
--   docs/catalogue-crosscheck/for-G3.md §1)
--   A release manifest stage may carry `"restricted_to": "site_creator"`. Absent = today's
--   behaviour. The rule narrows the stage's FIRST step (its tier-chain head — normally the
--   executive step) to the site's creator:
--       owns(site, user) := sites.submitted_by = user OR sites.assigned_to = user
--   (the real app's two-person "creator": the submitter and the current BD assignee).
--   An executive or supervisor who does not own the site is not entitled to that step at all; a
--   business admin who does not own it may act ONLY as a flagged override (is_override = true).
--   This replaces cfg_module_approvals_guard (20261004_5): identical except that `entitled` also
--   requires owns() on the creator step of a creator-scoped stage. is_override stays truthful in
--   both directions.
--
-- ROLLBACK: re-run the CREATE OR REPLACE FUNCTION public.cfg_module_approvals_guard() of 20261004_5.

-- The stage's creator rule in a release (NULL when absent / stage missing).
CREATE OR REPLACE FUNCTION public.cfg_release_stage_restriction(p_release uuid, p_module text, p_stage integer)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT nullif(public.cfg_release_stage(p_release, p_module, p_stage) ->> 'restricted_to', '');
$$;

-- owns(site, user): the real app's creator identity (submitted_by OR assigned_to).
CREATE OR REPLACE FUNCTION public.cfg_user_owns_site(p_site uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.sites s
         WHERE s.id = p_site
           AND p_user IS NOT NULL
           AND (s.submitted_by = p_user OR s.assigned_to = p_user)
    );
$$;

CREATE OR REPLACE FUNCTION public.cfg_module_approvals_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    rec      record;
    chain    text[];
    entitled boolean;
    restrict text;
BEGIN
    SELECT r.tenant_id, r.release_id, r.module_key, r.site_id INTO rec
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
    -- G3: the creator step of a creator-scoped stage belongs to the site's creator only.
    restrict := public.cfg_release_stage_restriction(rec.release_id, rec.module_key, NEW.stage_order);
    IF restrict = 'site_creator' AND NEW.tier = chain[1]
       AND NOT public.cfg_user_owns_site(rec.site_id, NEW.actor_id) THEN
        entitled := false;
    END IF;
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

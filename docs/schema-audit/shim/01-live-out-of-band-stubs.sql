-- 01-live-out-of-band-stubs.sql — objects the LIVE database has but no file in the repo defines,
-- and which in-repo migrations reference. Loaded ONLY into the `m_live` model (verified.sql +
-- migration replay) so that replaying the migrations does not fail on statements that succeed
-- against the real database. STATUS: INFERRED (existence is evidenced by the migrations
-- themselves; bodies are NOT known and are stubs).
--
--   object                          evidence that live has it
--   public.get_current_tenant_id()  202605241 CREATE POLICY ... USING (tenant_id = get_current_tenant_id());
--                                   20260802 header: "They exist on the live DB"
--   public.current_tenant_id()      202606231 policy; 20260802 header (same)
--   public.pipeline_summary (view)  202606122 ALTER VIEW ... SET (security_invoker = true)
--   public.stuck_sites (view)       202606122 (same)
--   public.handle_new_auth_user()   202606122 REVOKE EXECUTE ...  (SECURITY DEFINER trigger fn)
--
-- 20260802 later CREATE OR REPLACEs both tenant functions with the canonical auth.jwt() body,
-- so the stub bodies below are overwritten during replay exactly as on live.
-- Deliberately NOT stubbed: the RLS policies the base Supabase tables (sites, approvals,
-- audit_logs, notification_outbox, stage_events) are said to carry (202605241 comment) — no
-- migration statement depends on them, so inventing them would only add unverified state.
-- `live-db-drift-check.sql` query D5 lists the real ones.

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(auth.jwt() #>> '{app_metadata,tenant_id}', '')::uuid;
$$;

CREATE OR REPLACE FUNCTION public.get_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT public.current_tenant_id();
$$;

CREATE OR REPLACE VIEW public.pipeline_summary AS
  SELECT tenant_id, status, count(*) AS n FROM public.sites GROUP BY tenant_id, status;

CREATE OR REPLACE VIEW public.stuck_sites AS
  SELECT id, tenant_id, status, updated_at FROM public.sites
   WHERE updated_at < now() - interval '14 days';

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN NEW;  -- stub: real body unknown (it inserts into public.users on auth signup)
END;
$$;

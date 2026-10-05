-- 20261005_3 — Role-scoped saved views for custom-module pages.
--
-- PURPOSE (Phase 2b, G3 #4 — idea from operaton-plat's Tasklist filters "My tasks / Team queue /
--   Admin approvals" with per-group READ grants; the real app has no saved views, see
--   docs/catalogue-crosscheck/for-G3.md §2)
--     * public.module_views — named list views per tenant and custom module (module_key NULL = every
--       custom module of the tenant): a filter (jsonb; validated by the app — only NARROWS the
--       server-side visibility scope, never widens it), the columns to show, the AUDIENCE (roles
--       that see the view in their menu — audience is not access), position, is_default (the view a
--       role opens first: the first default by position whose audience has the role), seed_key
--       (defaults), created_by, soft delete (deleted_at) so a removed default is not re-seeded.
--     * public.cfg_seed_module_views(tenant, module) — inserts the default set for one custom module
--       (ON CONFLICT DO NOTHING on (tenant, module, seed_key): re-seeding never overwrites edits).
--     * trigger on tenant_modules: a custom module that is (re-)enabled — i.e. on publish, through
--       cfg_activate_release() — gets its defaults. Backfill for existing enabled custom modules.
--   Defaults (filter keys are documented in docs/G3-API.md):
--     awaiting_me   "Awaiting my approval"  {"awaiting":"my_tier","actionable":true}  executive, supervisor        default
--     admin_signoff "Admin sign-off"        {"awaiting":"business_admin"}             business_admin                default
--     my_cases      "My cases"              {"mine":true,"closed":false}              executive, supervisor
--     team_queue    "Team queue"            {"closed":false,"assigned":false}         supervisor, business_admin
--     all           "All cases"             {}                                        everyone                      default (observer)
--     closed        "Closed"                {"closed":true}                           everyone
--
-- ROLLBACK
--   DROP TRIGGER IF EXISTS trg_tenant_modules_seed_views ON public.tenant_modules;
--   DROP FUNCTION IF EXISTS public.cfg_tenant_modules_seed_views(), public.cfg_seed_module_views(uuid, text);
--   DROP TABLE IF EXISTS public.module_views;

CREATE TABLE IF NOT EXISTS public.module_views (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    module_key text,
    name       text NOT NULL,
    filter     jsonb NOT NULL DEFAULT '{}'::jsonb,
    columns    jsonb NOT NULL DEFAULT '[]'::jsonb,
    audience   text[] NOT NULL DEFAULT ARRAY['executive','supervisor','business_admin','observer']::text[],
    position   integer NOT NULL DEFAULT 100,
    is_default boolean NOT NULL DEFAULT false,
    seed_key   text,
    created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT fk_mv_tenant_module FOREIGN KEY (tenant_id, module_key)
        REFERENCES public.tenant_modules (tenant_id, module_key) ON DELETE CASCADE,
    CONSTRAINT chk_mv_name CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    CONSTRAINT chk_mv_filter CHECK (jsonb_typeof(filter) = 'object'),
    CONSTRAINT chk_mv_columns CHECK (jsonb_typeof(columns) = 'array'),
    CONSTRAINT chk_mv_audience CHECK (cardinality(audience) >= 1
        AND audience <@ ARRAY['executive','supervisor','business_admin','observer']::text[]),
    CONSTRAINT chk_mv_position CHECK (position BETWEEN 0 AND 10000),
    CONSTRAINT chk_mv_seed_key CHECK (seed_key IS NULL OR seed_key ~ '^[a-z][a-z0-9_]{0,39}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_module_views_seed
    ON public.module_views (tenant_id, module_key, seed_key)
    WHERE seed_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_module_views_tenant_module
    ON public.module_views (tenant_id, module_key, position)
    WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.cfg_seed_module_views(p_tenant uuid, p_module text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    n integer;
BEGIN
    INSERT INTO public.module_views
        (tenant_id, module_key, name, filter, columns, audience, position, is_default, seed_key)
    SELECT p_tenant, p_module, d.name, d.filter, d.cols, d.audience, d.pos, d.is_default, d.seed_key
      FROM (VALUES
        ('awaiting_me', 'Awaiting my approval', '{"awaiting":"my_tier","actionable":true}'::jsonb,
         '["site","stage","next_step","assigned_to","opened_at"]'::jsonb,
         ARRAY['executive','supervisor']::text[], 10, true),
        ('admin_signoff', 'Admin sign-off', '{"awaiting":"business_admin"}'::jsonb,
         '["site","stage","next_step","assigned_to","opened_at","release"]'::jsonb,
         ARRAY['business_admin']::text[], 15, true),
        ('my_cases', 'My cases', '{"mine":true,"closed":false}'::jsonb,
         '["site","stage","next_step","status","opened_at"]'::jsonb,
         ARRAY['executive','supervisor']::text[], 20, false),
        ('team_queue', 'Team queue', '{"closed":false,"assigned":false}'::jsonb,
         '["site","stage","next_step","assigned_to","opened_at"]'::jsonb,
         ARRAY['supervisor','business_admin']::text[], 30, false),
        ('all', 'All cases', '{}'::jsonb,
         '["site","stage","next_step","status","assigned_to","opened_at","release"]'::jsonb,
         ARRAY['executive','supervisor','business_admin','observer']::text[], 50, true),
        ('closed', 'Closed', '{"closed":true}'::jsonb,
         '["site","status","closed_at","release"]'::jsonb,
         ARRAY['executive','supervisor','business_admin','observer']::text[], 60, false)
      ) AS d(seed_key, name, filter, cols, audience, pos, is_default)
    ON CONFLICT (tenant_id, module_key, seed_key) WHERE seed_key IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.cfg_tenant_modules_seed_views()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.kind = 'custom' AND NEW.enabled THEN
        PERFORM public.cfg_seed_module_views(NEW.tenant_id, NEW.module_key);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_modules_seed_views ON public.tenant_modules;
CREATE TRIGGER trg_tenant_modules_seed_views
    AFTER INSERT OR UPDATE OF enabled ON public.tenant_modules
    FOR EACH ROW EXECUTE FUNCTION public.cfg_tenant_modules_seed_views();

SELECT public.cfg_seed_module_views(tm.tenant_id, tm.module_key)
  FROM public.tenant_modules tm
 WHERE tm.kind = 'custom' AND tm.enabled;

ALTER TABLE public.module_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.module_views;
CREATE POLICY tenant_isolation ON public.module_views
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON public.module_views FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON public.module_views FROM authenticated;
    END IF;
END $$;

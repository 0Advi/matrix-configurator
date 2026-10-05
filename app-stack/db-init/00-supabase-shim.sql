-- 00-supabase-shim.sql — the minimum Supabase surface the Matrix schema needs,
-- recreated on vanilla Postgres 16 for the LOCAL SANDBOX ONLY.
--
-- Idempotent and per-database: docker runs it once on first volume init (for
-- $POSTGRES_DB) and app-stack/reset-db.sh re-runs it on every freshly created
-- app database before loading the schema.
--
-- What the Matrix schema/migrations reference, and where it comes from here:
--   * uuid_generate_v4()            -> "uuid-ossp" extension (Supabase installs it
--                                      in schema `extensions`, on the search_path)
--   * gen_random_uuid()             -> core Postgres >= 13 (pgcrypto added anyway,
--                                      as on Supabase)
--   * roles anon / authenticated / service_role
--                                   -> REVOKE/GRANT targets in 202606122,
--                                      20260804; NOLOGIN, service_role BYPASSRLS,
--                                      same attributes as Supabase
--   * auth.jwt()                    -> RLS helper public.current_tenant_id()
--                                      (20260802) reads app_metadata.tenant_id
--   * auth.uid()/auth.role()/auth.email()  -> same family, for completeness
--   * default privileges            -> Supabase grants ALL on new public objects
--                                      to anon/authenticated/service_role;
--                                      202606122 then revokes them. Mirrored so
--                                      that lockdown migration means the same.
--
-- Function bodies are copied from Supabase's own definitions
-- (supabase/postgres init scripts): claims come from the GUC that PostgREST sets
-- per request, `request.jwt.claims` (JSON), with the legacy `request.jwt.claim`
-- / `request.jwt.claim.<name>` GUCs as fallbacks. Outside PostgREST (e.g. the
-- FastAPI backend, which connects as `postgres` and bypasses RLS) they return
-- NULL — exactly as on hosted Supabase.
--
-- Deliberately NOT recreated (live-only objects with no definition in the repo,
-- and not used by the backend): auth.users + trigger fn public.handle_new_auth_user(),
-- views public.pipeline_summary / public.stuck_sites, Supabase Storage schema.

-- ── Roles (cluster-wide; guarded) ────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

-- ── Extensions (Supabase keeps them in schema `extensions`) ─────────────────
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto   WITH SCHEMA extensions;

-- Supabase's database search_path: "$user", public, extensions — so unqualified
-- uuid_generate_v4() resolves. Applies to every NEW session on this database.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = "$user", public, extensions',
                 current_database());
END
$$;
SET search_path = "$user", public, extensions;

-- ── auth schema + JWT helpers (Supabase semantics) ──────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

CREATE OR REPLACE FUNCTION auth.email()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

GRANT USAGE ON SCHEMA auth       TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public     TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role(), auth.email()
  TO anon, authenticated, service_role;

-- ── Supabase default privileges on public (later narrowed by 202606122) ─────
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

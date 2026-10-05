-- 00-supabase-shim.sql — the minimum of Supabase that the Matrix-bd schema needs
-- to load on vanilla PostgreSQL 16. Used ONLY in the throwaway audit container.
--
-- Faithfulness notes (each item is something the real schema/migrations reference):
--   * uuid_generate_v4()          — schema.sql / verified.sql / migrations column defaults.
--                                   Supabase ships uuid-ossp (in schema `extensions`, which is on
--                                   the search_path); here it is installed in `public`.
--   * gen_random_uuid()           — built into PostgreSQL >= 13, nothing to do.
--   * roles anon / authenticated / service_role
--                                 — 202606122 REVOKEs from them, 20260804 checks pg_roles for them.
--   * auth.jwt()                  — 20260802 defines public.current_tenant_id() on top of it.
--                                   Body is Supabase's own definition: the PostgREST request
--                                   claims GUC, as jsonb.
-- Nothing else is shimmed. In particular the app's DB role is NOT emulated: in the container we
-- connect as the superuser `postgres`, which (like Supabase's BYPASSRLS `postgres` role the app
-- uses) bypasses RLS. RLS behaviour is tested separately with a non-bypass role.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

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
END $$;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated, service_role;
-- Supabase grants the API roles usage on public; mirror it so the REVOKEs in 202606122 are meaningful.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

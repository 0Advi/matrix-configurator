-- 20261004_3 — Module columns reference the registry instead of hard-coded IN-lists.
--
-- PURPOSE
--   Five columns hold a module key behind a hard-coded CHECK, so no custom module can ever get a
--   department code, a supervisor/executive membership, an executive invite, a delegation or an
--   executive-access request:
--     module_codes.module                   chk_module_codes_module                (202606142)
--     supervisor_invite_codes.module        chk_supervisor_invite_codes_module     (202606142)
--     user_module_memberships.module        chk_user_module_memberships_module     (202606142)
--     site_delegations.module               chk_site_delegations_module            (20260805)
--     supervisor_executive_requests.module  supervisor_executive_requests_module_check (202606231, inline)
--   (names as created by the migrations; on a given database they are DISCOVERED, not assumed —
--   see 20260816 / 20260818 for why guessing names is unsafe.)
--   For each table this file, in this order:
--     1. adds   chk_<t>_module_key  CHECK (public.is_valid_module_key(module))      — shape
--     2. adds   fk_<t>_tenant_module FOREIGN KEY (tenant_id, module)
--                 REFERENCES tenant_modules (tenant_id, module_key)               — existence, per tenant
--        NOT VALID first (enforced for new rows at once, no long lock), then VALIDATEd separately.
--     3. drops  the old IN-list CHECK(s) on `module` — only once step 2 exists, so the column is
--        never left unconstrained, and never touching the new key CHECK.
--   Result: built-in keys stay valid for every tenant (20261004_2 registered them), a custom key
--   (e.g. vendor_onboarding) is valid exactly in the tenant whose registry holds it, and junk is
--   rejected twice (shape + registry).
--
-- BEHAVIOUR CHANGE (deliberate, documented): the per-table SCOPE lists are no longer enforced by
--   the database — e.g. a membership row for 'financial_closure' or a delegation row for 'payment'
--   becomes storable. Scope stays an application rule (module_catalog.has_membership /
--   has_delegation describe it). No existing code path writes such rows.
--
-- FAILURE MODE: if a step 2 VALIDATE finds a (tenant, module) pair that is not registered, that
--   statement fails, the runner logs it, and the file stays unrecorded (retried next boot). The
--   NOT VALID FK and the old CHECK both remain in force, so nothing is loosened. Fix by inserting
--   the missing tenant_modules row (disabled) and redeploy.
--
-- ROLLBACK
--   For each table: ALTER TABLE ... DROP CONSTRAINT fk_<t>_tenant_module, DROP CONSTRAINT
--   chk_<t>_module_key; re-add the previous IN-list CHECK (as NOT VALID if custom rows exist).

-- 0. Diagnostics: list (tenant, module) pairs that the registry does not cover (expected: none).
DO $$
DECLARE
    orphans text;
BEGIN
    SELECT string_agg(format('%s:%s/%s', t, tenant_id, module), ', ')
      INTO orphans
      FROM (
            SELECT 'module_codes' AS t, tenant_id, module FROM public.module_codes
            UNION SELECT 'supervisor_invite_codes', tenant_id, module FROM public.supervisor_invite_codes
            UNION SELECT 'user_module_memberships', tenant_id, module FROM public.user_module_memberships
            UNION SELECT 'site_delegations', tenant_id, module FROM public.site_delegations
            UNION SELECT 'supervisor_executive_requests', tenant_id, module FROM public.supervisor_executive_requests
           ) x
     WHERE NOT EXISTS (SELECT 1 FROM public.tenant_modules tm
                        WHERE tm.tenant_id = x.tenant_id AND tm.module_key = x.module);
    IF orphans IS NOT NULL THEN
        RAISE WARNING 'module rows not covered by tenant_modules (FK validation will fail until registered): %', orphans;
    END IF;
END $$;

-- 1 + 2. Key-shape CHECK and registry FK, added NOT VALID (idempotent).
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['module_codes','supervisor_invite_codes','user_module_memberships',
                             'site_delegations','supervisor_executive_requests']
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conrelid = format('public.%I', t)::regclass
                          AND conname = format('chk_%s_module_key', t)) THEN
            EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (public.is_valid_module_key(module)) NOT VALID',
                           t, format('chk_%s_module_key', t));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conrelid = format('public.%I', t)::regclass
                          AND conname = format('fk_%s_tenant_module', t)) THEN
            EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, module) '
                           'REFERENCES public.tenant_modules (tenant_id, module_key) NOT VALID',
                           t, format('fk_%s_tenant_module', t));
        END IF;
    END LOOP;
END $$;

-- 2b. Validate (separate statements: SHARE UPDATE EXCLUSIVE lock, writes keep flowing).
ALTER TABLE public.module_codes VALIDATE CONSTRAINT chk_module_codes_module_key;
ALTER TABLE public.module_codes VALIDATE CONSTRAINT fk_module_codes_tenant_module;
ALTER TABLE public.supervisor_invite_codes VALIDATE CONSTRAINT chk_supervisor_invite_codes_module_key;
ALTER TABLE public.supervisor_invite_codes VALIDATE CONSTRAINT fk_supervisor_invite_codes_tenant_module;
ALTER TABLE public.user_module_memberships VALIDATE CONSTRAINT chk_user_module_memberships_module_key;
ALTER TABLE public.user_module_memberships VALIDATE CONSTRAINT fk_user_module_memberships_tenant_module;
ALTER TABLE public.site_delegations VALIDATE CONSTRAINT chk_site_delegations_module_key;
ALTER TABLE public.site_delegations VALIDATE CONSTRAINT fk_site_delegations_tenant_module;
ALTER TABLE public.supervisor_executive_requests VALIDATE CONSTRAINT chk_supervisor_executive_requests_module_key;
ALTER TABLE public.supervisor_executive_requests VALIDATE CONSTRAINT fk_supervisor_executive_requests_tenant_module;

-- 3. Drop the hard-coded IN-list CHECK(s) on `module` — discovered, whatever their names, and
--    only on tables whose registry FK exists. Our own key-shape CHECK is excluded by name.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT rel.relname, con.conname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace ns ON ns.oid = rel.relnamespace
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
         WHERE ns.nspname = 'public'
           AND rel.relname IN ('module_codes','supervisor_invite_codes','user_module_memberships',
                               'site_delegations','supervisor_executive_requests')
           AND con.contype = 'c'
           AND array_length(con.conkey, 1) = 1
           AND att.attname = 'module'
           AND con.conname <> format('chk_%s_module_key', rel.relname)
           AND EXISTS (SELECT 1 FROM pg_constraint fk
                        WHERE fk.conrelid = con.conrelid
                          AND fk.conname = format('fk_%s_tenant_module', rel.relname))
    LOOP
        RAISE NOTICE 'dropping hard-coded module CHECK %.%', r.relname, r.conname;
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.relname, r.conname);
    END LOOP;
END $$;

-- No new indexes: the referenced side is tenant_modules' PK; referencing-side lookups only happen
-- when a tenant_modules row is deleted, which the design never does (rows are disabled instead).

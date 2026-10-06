-- 0003_access.sql — principal storage for manifest-driven RBAC (Task 6). Applies after 0002_store.sql. Idempotent.
--
-- Replaces the one-primary-module model (users.role + one JWT `module` claim + user_module_memberships with a
-- CHECK on three module keys and two role names) with:
--   workspace_role_assignments   (workspace, user, workspace-scope role)        — any number per user
--   module_memberships           (workspace, user, module, module-scope role)   — any number per user
--   workspace_access_versions    one counter per (workspace, user): bumped on every change, so caches and
--                                sessions notice grants/revocations immediately (no 24 h stale token).
-- Role keys are NOT constrained by CHECK: they are validated against the LIVE release's manifest by
-- access_assert_role() at write time, so a workspace can add a role without a migration.

-- Access changes join the hash-chained workspace audit trail.
ALTER TABLE workspace_activity DROP CONSTRAINT IF EXISTS chk_wa_action;
ALTER TABLE workspace_activity ADD CONSTRAINT chk_wa_action CHECK (action IN (
    'draft_saved', 'draft_reset', 'draft_validated', 'release_published', 'release_rolled_back',
    'release_imported', 'module_added', 'module_changed', 'module_removed', 'module_enabled', 'module_disabled',
    'migration_planned', 'migration_started', 'migration_finished', 'migration_failed',
    'migration_cancelled', 'migration_recovered', 'access_granted', 'access_revoked', 'access_changed'));

CREATE TABLE IF NOT EXISTS workspace_role_assignments (
    workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL,
    role_key     text        NOT NULL CHECK (role_key ~ '^[a-z][a-z0-9_]{1,62}$'),
    granted_by   uuid,
    granted_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id, role_key)
);

CREATE TABLE IF NOT EXISTS module_memberships (
    workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL,
    module_key   text        NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,62}$'),
    role_key     text        NOT NULL CHECK (role_key ~ '^[a-z][a-z0-9_]{1,62}$'),
    reports_to   uuid,                         -- optional line manager inside the module (was supervisor_id)
    granted_by   uuid,
    granted_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id, module_key, role_key)
);
CREATE INDEX IF NOT EXISTS module_memberships_by_module ON module_memberships (workspace_id, module_key, role_key);

CREATE TABLE IF NOT EXISTS workspace_access_versions (
    workspace_id uuid    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      uuid    NOT NULL,
    version      bigint  NOT NULL DEFAULT 1,
    PRIMARY KEY (workspace_id, user_id)
);

-- A role key must exist in the live release with the right scope; a module key must be a module of it.
CREATE OR REPLACE FUNCTION access_assert_role() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    m     jsonb;
    scope text;
    want  text := CASE WHEN TG_TABLE_NAME = 'module_memberships' THEN 'module' ELSE 'workspace' END;
BEGIN
    SELECT manifest INTO m FROM workspace_releases WHERE workspace_id = NEW.workspace_id AND status = 'live';
    IF m IS NULL THEN
        PERFORM store_raise('no_live_release', 'roles can be assigned only once a release is live');
    END IF;
    SELECT r->>'scope' INTO scope FROM jsonb_array_elements(m->'roles') r WHERE r->>'key' = NEW.role_key;
    IF scope IS NULL THEN
        PERFORM store_raise('unknown_role', format('role %s is not in the live release', NEW.role_key));
    ELSIF scope <> want THEN
        PERFORM store_raise('role_scope', format('role %s has scope %s, not %s', NEW.role_key, scope, want));
    END IF;
    IF TG_TABLE_NAME = 'module_memberships' AND NOT EXISTS (     -- via to_jsonb: NEW has no module_key on the other table
        SELECT 1 FROM jsonb_array_elements(m->'modules') x
         WHERE x->>'key' = to_jsonb(NEW)->>'module_key' AND (x->'members') ? NEW.role_key) THEN
        PERFORM store_raise('not_a_member_role', format('role %s is not a member role of module %s', NEW.role_key, to_jsonb(NEW)->>'module_key'));
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION access_bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record := COALESCE(NEW, OLD);
BEGIN
    INSERT INTO workspace_access_versions AS v (workspace_id, user_id) VALUES (r.workspace_id, r.user_id)
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET version = v.version + 1;
    INSERT INTO workspace_activity (workspace_id, action, actor_id, actor, module_key, detail)
    VALUES (r.workspace_id,
            CASE TG_OP WHEN 'INSERT' THEN 'access_granted' WHEN 'DELETE' THEN 'access_revoked' ELSE 'access_changed' END,
            r.granted_by, COALESCE(nullif(current_setting('app.actor', true), ''), 'system'),
            to_jsonb(r) ->> 'module_key',
            jsonb_build_object('user_id', r.user_id, 'role', r.role_key, 'scope',
                               CASE WHEN TG_TABLE_NAME = 'module_memberships' THEN 'module' ELSE 'workspace' END));
    RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['workspace_role_assignments', 'module_memberships'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS access_assert_role ON %I', t);
        EXECUTE format('CREATE TRIGGER access_assert_role BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION access_assert_role()', t);
        EXECUTE format('DROP TRIGGER IF EXISTS access_bump_version ON %I', t);
        EXECUTE format('CREATE TRIGGER access_bump_version AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION access_bump_version()', t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['workspace_role_assignments', 'module_memberships', 'workspace_access_versions'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'ws_isolation') THEN
            EXECUTE format($p$CREATE POLICY ws_isolation ON %I
                USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
                WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
        END IF;
    END LOOP;
END $$;

-- The principal, in one read per request: workspace roles + memberships + access version.
CREATE OR REPLACE FUNCTION access_principal(p_ws uuid, p_user uuid)
RETURNS TABLE (workspace_roles text[], memberships jsonb, access_version bigint) LANGUAGE sql STABLE AS $$
    SELECT ARRAY(SELECT role_key FROM workspace_role_assignments WHERE workspace_id = p_ws AND user_id = p_user ORDER BY 1),
           COALESCE((SELECT jsonb_agg(jsonb_build_array(module_key, role_key) ORDER BY module_key, role_key)
                       FROM module_memberships WHERE workspace_id = p_ws AND user_id = p_user), '[]'::jsonb),
           COALESCE((SELECT version FROM workspace_access_versions WHERE workspace_id = p_ws AND user_id = p_user), 0)
$$;

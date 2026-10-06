-- 0002_store.sql — first-party draft & release store (Task 3)
--
-- The single store for workspace drafts, releases, the live module projection, running-case migrations
-- and the activity log (what replaces what: docs/store/README.md §2). PostgreSQL 13+ core only: no
-- extension, no third-party service.
--
-- Depends on 0001_identity.sql for:
--   workspaces (id uuid PRIMARY KEY, key text UNIQUE, …)
-- Runtime (0003_runtime.sql) later adds the FK workspace_release_migration_items.case_id → cases(id).
--
-- Idempotent: every object is CREATE … IF NOT EXISTS / CREATE OR REPLACE; safe to re-run.
-- Conventions:
--   * every row carries workspace_id; RLS restricts rows to current_setting('app.workspace_id');
--     the platform operator connects with a BYPASSRLS role;
--   * actors are recorded as (actor_id uuid NULL, actor_label text NOT NULL) — the platform operator
--     has no users row;
--   * immutable rows are guarded by triggers, not just by convention;
--   * the store never interprets a manifest beyond format + projection; validation is the job of
--     packages/manifest (run by the API before it calls these functions).

-- ───────────────────────────────────────────────────────────── helpers ──
CREATE OR REPLACE FUNCTION store_sha256_jsonb(j jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT encode(sha256(convert_to(j::text, 'UTF8')), 'hex');   -- jsonb::text is canonical (sorted keys)
$$;

CREATE OR REPLACE FUNCTION store_raise(code text, msg text, detail jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    -- SQLSTATE P0001 with a machine code in MESSAGE prefix and JSON in DETAIL: the API maps it 1:1.
    RAISE EXCEPTION '%: %', code, msg USING ERRCODE = 'P0001', DETAIL = detail::text;
END $$;

-- ───────────────────────────────────────────────────── workspace_drafts ──
-- Append-only: every save is a new revision. The head = highest revision. Optimistic concurrency:
-- a save names the revision it was based on (HTTP If-Match) and fails if the head moved.
CREATE TABLE IF NOT EXISTS workspace_drafts (
    workspace_id          uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    revision              integer     NOT NULL,
    base_release_version  integer,                         -- live version the editor started from
    manifest              jsonb       NOT NULL,
    manifest_sha256       text        NOT NULL,
    note                  text,
    validation            jsonb,                           -- last validator report for THIS revision
    validated_at          timestamptz,
    saved_by_id           uuid,
    saved_by              text        NOT NULL,
    saved_via             text        NOT NULL DEFAULT 'ui',
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workspace_drafts_pkey PRIMARY KEY (workspace_id, revision),
    CONSTRAINT chk_wd_revision  CHECK (revision >= 1),
    CONSTRAINT chk_wd_manifest  CHECK (jsonb_typeof(manifest) = 'object'),
    CONSTRAINT chk_wd_sha       CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_wd_via       CHECK (saved_via IN ('ui', 'agent', 'api', 'import', 'reset')),
    CONSTRAINT chk_wd_validation CHECK (validation IS NULL OR jsonb_typeof(validation) = 'object'),
    CONSTRAINT chk_wd_note      CHECK (note IS NULL OR length(note) <= 500)
);

-- ─────────────────────────────────────────────────── workspace_releases ──
-- Immutable except the lifecycle columns (status live → superseded, superseded_at). Exactly one live
-- release per workspace. A rollback is a NEW version whose manifest equals an older one.
CREATE TABLE IF NOT EXISTS workspace_releases (
    id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
    workspace_id         uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    version              integer     NOT NULL,
    format               text        NOT NULL,
    manifest             jsonb       NOT NULL,
    manifest_sha256      text        NOT NULL,
    from_draft_revision  integer,
    rollback_of_version  integer,
    validation           jsonb       NOT NULL,             -- report at publish time (warnings accepted)
    reason               text        NOT NULL,
    published_by_id      uuid,
    published_by         text        NOT NULL,
    status               text        NOT NULL DEFAULT 'live',
    created_at           timestamptz NOT NULL DEFAULT now(),
    superseded_at        timestamptz,
    imported_from        jsonb,                            -- provenance when imported (v5 release id, sha)
    CONSTRAINT workspace_releases_pkey PRIMARY KEY (id),
    CONSTRAINT uq_wr_version   UNIQUE (workspace_id, version),
    CONSTRAINT uq_wr_ws_id     UNIQUE (workspace_id, id),
    CONSTRAINT chk_wr_version  CHECK (version >= 1),
    CONSTRAINT chk_wr_format   CHECK (format = 'workspace-manifest/1'),
    CONSTRAINT chk_wr_manifest CHECK (jsonb_typeof(manifest) = 'object'
                                      AND manifest ->> 'format' = format
                                      AND jsonb_typeof(manifest -> 'modules') = 'array'),
    CONSTRAINT chk_wr_sha      CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_wr_valid    CHECK (jsonb_typeof(validation) = 'object' AND (validation ->> 'ok')::boolean IS TRUE),
    CONSTRAINT chk_wr_reason   CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
    CONSTRAINT chk_wr_status   CHECK (status IN ('live', 'superseded')),
    CONSTRAINT chk_wr_superseded CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
    CONSTRAINT chk_wr_rollback CHECK (rollback_of_version IS NULL OR rollback_of_version < version),
    CONSTRAINT fk_wr_draft     FOREIGN KEY (workspace_id, from_draft_revision)
                               REFERENCES workspace_drafts (workspace_id, revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wr_one_live ON workspace_releases (workspace_id) WHERE status = 'live';

-- ──────────────────────────────────────────────────── workspace_modules ──
-- Projection of the LIVE release, one row per module key ever published. Used for navigation, guards and
-- lookups without parsing the manifest. Rebuilt by store_project_modules() in the publish transaction.
CREATE TABLE IF NOT EXISTS workspace_modules (
    workspace_id          uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    module_key            text        NOT NULL,
    name                  text        NOT NULL,
    subject               text        NOT NULL,
    position              integer     NOT NULL,
    enabled               boolean     NOT NULL,
    in_live_release       boolean     NOT NULL,             -- false = removed from the live manifest
    members               text[]      NOT NULL DEFAULT '{}',
    delegation            boolean     NOT NULL DEFAULT false,
    adapter_key           text,
    adapter_version       text,
    stage_keys            text[]      NOT NULL DEFAULT '{}',
    definition            jsonb       NOT NULL,             -- the module's slice of the live manifest
    definition_sha256     text        NOT NULL,
    release_id            uuid        NOT NULL,             -- release this row was last projected from
    introduced_release_id uuid        NOT NULL,
    changed_release_id    uuid        NOT NULL,             -- last release whose definition differed
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workspace_modules_pkey PRIMARY KEY (workspace_id, module_key),
    CONSTRAINT chk_wm_key CHECK (module_key ~ '^[a-z][a-z0-9_]{1,38}$'),
    CONSTRAINT chk_wm_enabled CHECK (in_live_release OR NOT enabled),
    CONSTRAINT fk_wm_release     FOREIGN KEY (workspace_id, release_id)            REFERENCES workspace_releases (workspace_id, id),
    CONSTRAINT fk_wm_introduced  FOREIGN KEY (workspace_id, introduced_release_id) REFERENCES workspace_releases (workspace_id, id),
    CONSTRAINT fk_wm_changed     FOREIGN KEY (workspace_id, changed_release_id)    REFERENCES workspace_releases (workspace_id, id)
);

-- ──────────────────────────────────────── workspace_release_migrations ──
-- Moving running cases from older releases to a newer one. Dry run first (status 'planned', plan_sha256
-- returned to the caller); execution must quote that sha so the executed plan is exactly the reviewed one.
CREATE TABLE IF NOT EXISTS workspace_release_migrations (
    id              uuid        NOT NULL DEFAULT gen_random_uuid(),
    workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    to_release_id   uuid        NOT NULL,
    from_versions   integer[]   NOT NULL,                 -- resolved list (the request may say 'all_older')
    modules         text[],                               -- NULL = every module present in both releases
    stage_map       jsonb       NOT NULL DEFAULT '{}'::jsonb, -- {module: {old_stage_key: new_stage_key}}
    include_idle    boolean     NOT NULL DEFAULT false,   -- also re-pin subjects with no running case
    plan            jsonb       NOT NULL,                 -- per-case plan from the dry run
    plan_sha256     text        NOT NULL,
    reason          text        NOT NULL,
    requested_by_id uuid,
    requested_by    text        NOT NULL,
    status          text        NOT NULL DEFAULT 'planned',
    summary         jsonb       NOT NULL DEFAULT '{}'::jsonb, -- counts; progress while running
    heartbeat_at    timestamptz,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    finished_at     timestamptz,
    CONSTRAINT workspace_release_migrations_pkey PRIMARY KEY (id),
    CONSTRAINT uq_wrm_ws_id     UNIQUE (workspace_id, id),
    CONSTRAINT fk_wrm_to        FOREIGN KEY (workspace_id, to_release_id) REFERENCES workspace_releases (workspace_id, id),
    CONSTRAINT chk_wrm_from     CHECK (cardinality(from_versions) >= 1),
    CONSTRAINT chk_wrm_status   CHECK (status IN ('planned', 'running', 'done', 'failed', 'cancelled', 'expired')),
    CONSTRAINT chk_wrm_reason   CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
    CONSTRAINT chk_wrm_plan     CHECK (jsonb_typeof(plan) = 'object' AND plan_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_wrm_map      CHECK (jsonb_typeof(stage_map) = 'object'),
    CONSTRAINT chk_wrm_started  CHECK ((status IN ('planned', 'cancelled', 'expired')) OR started_at IS NOT NULL),
    CONSTRAINT chk_wrm_finished CHECK ((status IN ('done', 'failed', 'cancelled', 'expired')) = (finished_at IS NOT NULL))
);

-- At most one migration running per workspace (the API also takes an advisory lock).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wrm_one_running ON workspace_release_migrations (workspace_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_wrm_ws_created ON workspace_release_migrations (workspace_id, created_at DESC);

-- Per-case journal (child of the migration): the full before/after so a migration is auditable and
-- reversible by a counter-migration. Written by the runtime, one row per moved case, in that case's txn.
CREATE TABLE IF NOT EXISTS workspace_release_migration_items (
    migration_id    uuid        NOT NULL,
    workspace_id    uuid        NOT NULL,
    case_id         uuid        NOT NULL,                 -- FK to cases(id) added by 0003_runtime.sql
    module_key      text        NOT NULL,
    from_release_id uuid        NOT NULL,
    before_state    jsonb       NOT NULL,
    after_state     jsonb       NOT NULL,
    outcome         text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workspace_release_migration_items_pkey PRIMARY KEY (migration_id, case_id),
    CONSTRAINT fk_wrmi_migration FOREIGN KEY (workspace_id, migration_id)
        REFERENCES workspace_release_migrations (workspace_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_wrmi_from FOREIGN KEY (workspace_id, from_release_id) REFERENCES workspace_releases (workspace_id, id),
    CONSTRAINT chk_wrmi_outcome CHECK (outcome IN ('moved', 'repinned', 'skipped_incompatible', 'skipped_closed'))
);

-- ─────────────────────────────────────────────────── workspace_activity ──
-- Append-only, hash-chained log of everything the store does. Written in the same transaction as the
-- change it describes, so no event can be missed by an asynchronous workflow.
CREATE TABLE IF NOT EXISTS workspace_activity (
    id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    seq              integer     NOT NULL,                -- per-workspace sequence, 1, 2, 3 …
    action           text        NOT NULL,
    actor_id         uuid,
    actor            text        NOT NULL,
    draft_revision   integer,
    release_version  integer,
    migration_id     uuid,
    module_key       text,
    detail           jsonb       NOT NULL DEFAULT '{}'::jsonb,
    prev_hash        text,
    hash             text        NOT NULL,
    at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_wa_seq UNIQUE (workspace_id, seq),
    CONSTRAINT chk_wa_action CHECK (action IN (
        'draft_saved', 'draft_reset', 'draft_validated', 'release_published', 'release_rolled_back',
        'release_imported', 'module_added', 'module_changed', 'module_removed', 'module_enabled', 'module_disabled',
        'migration_planned', 'migration_started', 'migration_finished', 'migration_failed',
        'migration_cancelled', 'migration_recovered')),
    CONSTRAINT chk_wa_detail CHECK (jsonb_typeof(detail) = 'object'),
    CONSTRAINT chk_wa_hash   CHECK (hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_wa_ws_at ON workspace_activity (workspace_id, at DESC);

-- ─────────────────────────────────────────────────────────── guards ──
CREATE OR REPLACE FUNCTION store_forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN RETURN COALESCE(OLD, NEW); END IF;   -- FK cascades (workspace delete) pass
    PERFORM store_raise('immutable', TG_TABLE_NAME || ' rows are append-only');
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION store_release_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
    IF TG_OP = 'DELETE' THEN
        PERFORM store_raise('immutable', 'releases cannot be deleted');
    END IF;
    -- Only live → superseded is allowed; every other column is frozen.
    IF NOT (OLD.status = 'live' AND NEW.status = 'superseded' AND NEW.superseded_at IS NOT NULL)
       OR (to_jsonb(NEW) - 'status' - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'superseded_at') THEN
        PERFORM store_raise('immutable', 'a release can only move from live to superseded');
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION store_migration_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
    IF TG_OP = 'DELETE' THEN
        PERFORM store_raise('immutable', 'migrations cannot be deleted');
    END IF;
    -- The reviewed plan and its scope are frozen; only lifecycle columns move, and only forward.
    IF (to_jsonb(NEW) - ARRAY['status','summary','heartbeat_at','error','started_at','finished_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','summary','heartbeat_at','error','started_at','finished_at']) THEN
        PERFORM store_raise('immutable', 'a migration plan cannot be edited; plan a new migration');
    END IF;
    IF NOT ((OLD.status = NEW.status)
            OR (OLD.status = 'planned' AND NEW.status IN ('running', 'cancelled', 'expired'))
            OR (OLD.status = 'running' AND NEW.status IN ('done', 'failed'))) THEN
        PERFORM store_raise('bad_transition', format('migration cannot go from %s to %s', OLD.status, NEW.status));
    END IF;
    RETURN NEW;
END $$;

-- Activity: seq + hash chain are computed here, so callers cannot forge them.
CREATE OR REPLACE FUNCTION store_activity_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    last_row workspace_activity%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('workspace_activity:' || NEW.workspace_id::text, 0));
    SELECT * INTO last_row FROM workspace_activity WHERE workspace_id = NEW.workspace_id ORDER BY seq DESC LIMIT 1;
    NEW.seq := COALESCE(last_row.seq, 0) + 1;
    NEW.prev_hash := last_row.hash;
    NEW.at := COALESCE(NEW.at, now());
    NEW.hash := encode(sha256(convert_to(concat_ws('|', NEW.workspace_id, NEW.seq, NEW.action, NEW.actor,
                    NEW.draft_revision, NEW.release_version, NEW.migration_id, NEW.module_key,
                    NEW.detail::text, COALESCE(NEW.prev_hash, '-')), 'UTF8')), 'hex');
    RETURN NEW;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_wd_append_only') THEN
        CREATE TRIGGER trg_wd_append_only BEFORE UPDATE OR DELETE ON workspace_drafts
            FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION store_forbid_change();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_wr_guard') THEN
        CREATE TRIGGER trg_wr_guard BEFORE UPDATE OR DELETE ON workspace_releases
            FOR EACH ROW EXECUTE FUNCTION store_release_guard();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_wrm_guard') THEN
        CREATE TRIGGER trg_wrm_guard BEFORE UPDATE OR DELETE ON workspace_release_migrations
            FOR EACH ROW EXECUTE FUNCTION store_migration_guard();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_wrmi_append_only') THEN
        CREATE TRIGGER trg_wrmi_append_only BEFORE UPDATE OR DELETE ON workspace_release_migration_items
            FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION store_forbid_change();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_wa_chain') THEN
        CREATE TRIGGER trg_wa_chain BEFORE INSERT ON workspace_activity
            FOR EACH ROW EXECUTE FUNCTION store_activity_chain();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_wa_append_only') THEN
        CREATE TRIGGER trg_wa_append_only BEFORE UPDATE OR DELETE ON workspace_activity
            FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION store_forbid_change();
    END IF;
END $$;

-- ───────────────────────────────────────────────────── operations ──
-- Save a draft revision. p_expected = the revision the editor loaded (NULL only for the very first save).
CREATE OR REPLACE FUNCTION store_save_draft(p_ws uuid, p_expected integer, p_manifest jsonb, p_actor text,
                                            p_actor_id uuid DEFAULT NULL, p_note text DEFAULT NULL,
                                            p_via text DEFAULT 'ui', p_validation jsonb DEFAULT NULL)
RETURNS workspace_drafts
LANGUAGE plpgsql AS $$
DECLARE
    head workspace_drafts%ROWTYPE;
    live_v integer;
    out_row workspace_drafts%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('workspace_drafts:' || p_ws::text, 0));
    SELECT * INTO head FROM workspace_drafts WHERE workspace_id = p_ws ORDER BY revision DESC LIMIT 1;
    IF COALESCE(head.revision, 0) <> COALESCE(p_expected, 0) THEN
        PERFORM store_raise('revision_conflict', 'the draft changed since you loaded it',
                            jsonb_build_object('head_revision', head.revision, 'expected', p_expected,
                                               'saved_by', head.saved_by, 'saved_at', head.created_at));
    END IF;
    IF head.revision IS NOT NULL AND head.manifest = p_manifest AND p_validation IS NULL THEN
        RETURN head;                                            -- no-op save: no new revision, no activity
    END IF;
    SELECT version INTO live_v FROM workspace_releases WHERE workspace_id = p_ws AND status = 'live';
    INSERT INTO workspace_drafts (workspace_id, revision, base_release_version, manifest, manifest_sha256, note,
                                  validation, validated_at, saved_by_id, saved_by, saved_via)
    VALUES (p_ws, COALESCE(head.revision, 0) + 1, live_v, p_manifest, store_sha256_jsonb(p_manifest), p_note,
            p_validation, CASE WHEN p_validation IS NULL THEN NULL ELSE now() END, p_actor_id, p_actor, p_via)
    RETURNING * INTO out_row;
    INSERT INTO workspace_activity (workspace_id, action, actor_id, actor, draft_revision, detail)
    VALUES (p_ws, CASE p_via WHEN 'reset' THEN 'draft_reset' ELSE 'draft_saved' END, p_actor_id, p_actor, out_row.revision,
            jsonb_build_object('sha256', out_row.manifest_sha256, 'via', p_via, 'note', p_note,
                               'validation_ok', p_validation -> 'ok'));
    RETURN out_row;
END $$;

-- Project the live release onto workspace_modules and log module-level changes. Called by store_publish.
CREATE OR REPLACE FUNCTION store_project_modules(p_release uuid, p_actor text, p_actor_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    rel workspace_releases%ROWTYPE;
    m jsonb;
    pos integer := 0;
    prev workspace_modules%ROWTYPE;
    sha text;
    n integer := 0;
    keys text[] := '{}';
BEGIN
    SELECT * INTO rel FROM workspace_releases WHERE id = p_release;
    FOR m IN SELECT value FROM jsonb_array_elements(rel.manifest -> 'modules') LOOP
        pos := pos + 10;
        sha := store_sha256_jsonb(m);
        keys := keys || (m ->> 'key');
        SELECT * INTO prev FROM workspace_modules WHERE workspace_id = rel.workspace_id AND module_key = m ->> 'key';
        INSERT INTO workspace_modules AS wm (workspace_id, module_key, name, subject, position, enabled, in_live_release,
                members, delegation, adapter_key, adapter_version, stage_keys, definition, definition_sha256,
                release_id, introduced_release_id, changed_release_id, updated_at)
        VALUES (rel.workspace_id, m ->> 'key', m ->> 'name', m ->> 'subject', pos, COALESCE((m ->> 'enabled')::boolean, true), true,
                ARRAY(SELECT jsonb_array_elements_text(COALESCE(m -> 'members', '[]'))),
                COALESCE((m ->> 'delegation')::boolean, false), m #>> '{adapter,key}', m #>> '{adapter,version}',
                ARRAY(SELECT s ->> 'key' FROM jsonb_array_elements(COALESCE(m -> 'stages', '[]')) s),
                m, sha, rel.id, rel.id, rel.id, now())
        ON CONFLICT (workspace_id, module_key) DO UPDATE SET
                name = EXCLUDED.name, subject = EXCLUDED.subject, position = EXCLUDED.position,
                enabled = EXCLUDED.enabled, in_live_release = true, members = EXCLUDED.members,
                delegation = EXCLUDED.delegation, adapter_key = EXCLUDED.adapter_key,
                adapter_version = EXCLUDED.adapter_version, stage_keys = EXCLUDED.stage_keys,
                definition = EXCLUDED.definition, definition_sha256 = EXCLUDED.definition_sha256,
                release_id = EXCLUDED.release_id,
                changed_release_id = CASE WHEN wm.definition_sha256 = EXCLUDED.definition_sha256 AND wm.in_live_release
                                          THEN wm.changed_release_id ELSE EXCLUDED.release_id END,
                updated_at = now();
        IF prev.module_key IS NULL OR NOT prev.in_live_release THEN
            INSERT INTO workspace_activity (workspace_id, action, actor_id, actor, release_version, module_key, detail)
            VALUES (rel.workspace_id, 'module_added', p_actor_id, p_actor, rel.version, m ->> 'key', jsonb_build_object('sha256', sha));
        ELSIF prev.definition_sha256 <> sha THEN
            INSERT INTO workspace_activity (workspace_id, action, actor_id, actor, release_version, module_key, detail)
            VALUES (rel.workspace_id,
                    CASE WHEN prev.enabled AND NOT COALESCE((m ->> 'enabled')::boolean, true) THEN 'module_disabled'
                         WHEN NOT prev.enabled AND COALESCE((m ->> 'enabled')::boolean, true) THEN 'module_enabled'
                         ELSE 'module_changed' END,
                    p_actor_id, p_actor, rel.version, m ->> 'key',
                    jsonb_build_object('from_sha256', prev.definition_sha256, 'to_sha256', sha));
        END IF;
        n := n + 1;
    END LOOP;
    -- Modules no longer in the live manifest are kept (cases may reference them) but switched off.
    FOR prev IN SELECT * FROM workspace_modules
                WHERE workspace_id = rel.workspace_id AND in_live_release AND NOT (module_key = ANY (keys)) LOOP
        UPDATE workspace_modules SET in_live_release = false, enabled = false, release_id = rel.id, updated_at = now()
         WHERE workspace_id = rel.workspace_id AND module_key = prev.module_key;
        INSERT INTO workspace_activity (workspace_id, action, actor_id, actor, release_version, module_key, detail)
        VALUES (rel.workspace_id, 'module_removed', p_actor_id, p_actor, rel.version, prev.module_key, '{}'::jsonb);
    END LOOP;
    RETURN n;
END $$;

-- Publish draft revision p_revision as the next release. The API validates the manifest with
-- packages/manifest first and passes the report; the DB refuses a report that is not ok.
-- p_expected_live = the live version the publisher saw (NULL = none yet) → 409 if someone published meanwhile.
CREATE OR REPLACE FUNCTION store_publish(p_ws uuid, p_revision integer, p_expected_live integer, p_reason text,
                                         p_validation jsonb, p_actor text, p_actor_id uuid DEFAULT NULL,
                                         p_rollback_of integer DEFAULT NULL)
RETURNS workspace_releases
LANGUAGE plpgsql AS $$
DECLARE
    d workspace_drafts%ROWTYPE;
    live workspace_releases%ROWTYPE;
    head integer;
    rel workspace_releases%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('workspace_releases:' || p_ws::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('workspace_drafts:' || p_ws::text, 0));
    SELECT * INTO live FROM workspace_releases WHERE workspace_id = p_ws AND status = 'live' FOR UPDATE;
    IF live.version IS DISTINCT FROM p_expected_live THEN
        PERFORM store_raise('live_changed', 'another release was published meanwhile',
                            jsonb_build_object('live_version', live.version, 'expected', p_expected_live));
    END IF;
    SELECT * INTO d FROM workspace_drafts WHERE workspace_id = p_ws AND revision = p_revision;
    IF d.revision IS NULL THEN
        PERFORM store_raise('draft_not_found', format('draft revision %s does not exist', p_revision));
    END IF;
    SELECT max(revision) INTO head FROM workspace_drafts WHERE workspace_id = p_ws;
    IF head <> p_revision THEN
        PERFORM store_raise('draft_changed', 'the draft has newer revisions; review them before publishing',
                            jsonb_build_object('head_revision', head, 'requested', p_revision));
    END IF;
    IF p_validation IS NULL OR (p_validation ->> 'ok')::boolean IS NOT TRUE THEN
        PERFORM store_raise('manifest_invalid', 'the manifest has validation errors', COALESCE(p_validation, '{}'::jsonb));
    END IF;
    IF live.version IS NOT NULL AND live.manifest_sha256 = d.manifest_sha256 THEN
        PERFORM store_raise('nothing_to_publish', 'the draft is identical to the live release',
                            jsonb_build_object('live_version', live.version));
    END IF;
    IF live.id IS NOT NULL THEN
        UPDATE workspace_releases SET status = 'superseded', superseded_at = now() WHERE id = live.id;
    END IF;
    INSERT INTO workspace_releases (workspace_id, version, format, manifest, manifest_sha256, from_draft_revision,
                                    rollback_of_version, validation, reason, published_by_id, published_by)
    VALUES (p_ws, COALESCE(live.version, 0) + 1, d.manifest ->> 'format', d.manifest, d.manifest_sha256, d.revision,
            p_rollback_of, p_validation, p_reason, p_actor_id, p_actor)
    RETURNING * INTO rel;
    INSERT INTO workspace_activity (workspace_id, action, actor_id, actor, draft_revision, release_version, detail)
    VALUES (p_ws, CASE WHEN p_rollback_of IS NULL THEN 'release_published' ELSE 'release_rolled_back' END,
            p_actor_id, p_actor, d.revision, rel.version,
            jsonb_build_object('sha256', rel.manifest_sha256, 'reason', p_reason, 'previous_version', live.version,
                               'rollback_of_version', p_rollback_of, 'warnings', COALESCE(p_validation -> 'warnings', '0'::jsonb)));
    PERFORM store_project_modules(rel.id, p_actor, p_actor_id);
    RETURN rel;
END $$;

-- Module-level diff between two releases (field-level diffs are computed by the API; see API.md §6).
CREATE OR REPLACE FUNCTION store_release_diff(p_ws uuid, p_from integer, p_to integer)
RETURNS TABLE (module_key text, change text, from_sha256 text, to_sha256 text)
LANGUAGE sql STABLE AS $$
    WITH a AS (SELECT m ->> 'key' AS k, store_sha256_jsonb(m) AS sha
                 FROM workspace_releases r, jsonb_array_elements(r.manifest -> 'modules') m
                WHERE r.workspace_id = p_ws AND r.version = p_from),
         b AS (SELECT m ->> 'key' AS k, store_sha256_jsonb(m) AS sha
                 FROM workspace_releases r, jsonb_array_elements(r.manifest -> 'modules') m
                WHERE r.workspace_id = p_ws AND r.version = p_to)
    SELECT COALESCE(a.k, b.k),
           CASE WHEN a.k IS NULL THEN 'added' WHEN b.k IS NULL THEN 'removed'
                WHEN a.sha = b.sha THEN 'unchanged' ELSE 'changed' END,
           a.sha, b.sha
      FROM a FULL JOIN b ON a.k = b.k
     ORDER BY 1;
$$;

-- Stale-migration recovery (run at startup and periodically): a running migration whose heartbeat is
-- older than p_stale is marked failed; its journal says exactly which cases moved.
CREATE OR REPLACE FUNCTION store_recover_stale_migrations(p_stale interval DEFAULT interval '10 minutes')
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    r workspace_release_migrations%ROWTYPE;
    n integer := 0;
BEGIN
    FOR r IN SELECT * FROM workspace_release_migrations
              WHERE status = 'running' AND COALESCE(heartbeat_at, started_at) < now() - p_stale FOR UPDATE SKIP LOCKED LOOP
        UPDATE workspace_release_migrations
           SET status = 'failed', finished_at = now(),
               error = 'recovered: no heartbeat since ' || COALESCE(heartbeat_at, started_at)::text,
               summary = summary || jsonb_build_object('moved_before_failure',
                         (SELECT count(*) FROM workspace_release_migration_items i WHERE i.migration_id = r.id))
         WHERE id = r.id;
        INSERT INTO workspace_activity (workspace_id, action, actor, migration_id, detail)
        VALUES (r.workspace_id, 'migration_recovered', 'system', r.id, jsonb_build_object('last_heartbeat', COALESCE(r.heartbeat_at, r.started_at)));
        n := n + 1;
    END LOOP;
    RETURN n;
END $$;

-- ───────────────────────────────────────────────── row-level security ──
-- Workspace users see only their workspace; the API sets app.workspace_id per request (SET LOCAL).
-- The platform operator's connection uses a BYPASSRLS role.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['workspace_drafts', 'workspace_releases', 'workspace_modules',
                             'workspace_release_migrations', 'workspace_release_migration_items', 'workspace_activity'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'ws_isolation') THEN
            EXECUTE format($p$CREATE POLICY ws_isolation ON %I
                USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
                WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
        END IF;
    END LOOP;
END $$;

-- 20261004_6 — Provenance on audit events: which release and which policy produced an action.
--
-- PURPOSE
--   audit_logs is the app's single activity feed (write_audit_event, ~89 call sites). Once a
--   workspace runs on a published configuration, an auditor must be able to answer "under which
--   version of the rules did this happen, and which rule allowed it?" — e.g. a gate that opened a
--   module, a tier approval, a release publish/activation, a re-pin. This adds three NULLABLE
--   columns (existing writers are untouched — every INSERT in the app names its columns):
--     config_release_id  uuid  -> tenant_config_releases(id)   the release in force for the action
--     module_key         text                                    module the event belongs to (built-in or custom)
--     provenance         jsonb                                   policy facts: {"policy":"gate|tier|publish|repin",
--                                                                 "rule": ..., "inputs": {...}, "manifest_sha256": ...}
--   The FK is added NOT VALID then VALIDATEd (all-NULL column: the scan is cheap and does not block
--   writes). A partial index serves "events under release X".
--
-- APP IMPACT: none (ORM AuditLog does not map the columns; raw INSERTs name their columns).
--
-- ROLLBACK
--   ALTER TABLE public.audit_logs DROP COLUMN IF EXISTS provenance,
--                                  DROP COLUMN IF EXISTS module_key,
--                                  DROP COLUMN IF EXISTS config_release_id;

ALTER TABLE public.audit_logs
    ADD COLUMN IF NOT EXISTS config_release_id uuid,
    ADD COLUMN IF NOT EXISTS module_key        text,
    ADD COLUMN IF NOT EXISTS provenance        jsonb;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.audit_logs'::regclass
                      AND conname = 'fk_audit_logs_config_release') THEN
        ALTER TABLE public.audit_logs
            ADD CONSTRAINT fk_audit_logs_config_release
            FOREIGN KEY (config_release_id) REFERENCES public.tenant_config_releases (id) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.audit_logs'::regclass
                      AND conname = 'chk_audit_logs_provenance') THEN
        ALTER TABLE public.audit_logs
            ADD CONSTRAINT chk_audit_logs_provenance
            CHECK (provenance IS NULL OR jsonb_typeof(provenance) = 'object') NOT VALID;
    END IF;
END $$;

ALTER TABLE public.audit_logs VALIDATE CONSTRAINT fk_audit_logs_config_release;
ALTER TABLE public.audit_logs VALIDATE CONSTRAINT chk_audit_logs_provenance;

CREATE INDEX IF NOT EXISTS idx_audit_logs_config_release
    ON public.audit_logs (config_release_id, created_at)
    WHERE config_release_id IS NOT NULL;

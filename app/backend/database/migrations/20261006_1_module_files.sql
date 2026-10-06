-- 20261006_1 — Files for configurator-built (custom) modules: uploads behind `kind: file` fields.
--
-- PURPOSE (Phase 2c, F5a)
--   A custom module's stage field of kind "file" compiles to a string holding a FILE ID
--   (module_runtime/forms.py, file_mode "ref"), but nothing stored the bytes: the UI asked users
--   to type a document reference instead (F4b gap 13). This file adds the metadata table behind
--   POST /api/m/{module_key}/records/{record_id}/files; the bytes go to the app's existing
--   storage path (Supabase Storage bucket, `storage_service.upload_bytes`, the same one LOI /
--   photos / design deliverables use) under module-files/<tenant>/<module>/<record>/<file id>/.
--     * public.module_files — one row per uploaded file: tenant, site, record, module, the stage
--       and field it was uploaded for, storage key, original name, type, size, sha256, uploader.
--       APPEND-ONLY (a replaced file is a new row; nothing an approver saw can change under them);
--       deleted only by cascade with its record / site / tenant.
--     * public.cfg_module_files_guard() — the record must be a case of that module, site and
--       tenant (a forged cross-tenant / cross-record row is refused by the DB, not only the app).
--   Submitting a stage verifies each file-field value is a module_files id of THIS record, stage
--   and field (module_runtime_service), so a value can never point at another tenant's file.
--
-- CONVENTIONS: idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS), function bodies
--   in $$, each statement independent (the ledger runner runs each in its own transaction).
--   Sorts after 20261005_4 ('6' > '5' at position 8).
--
-- ROLLBACK
--   DROP TABLE IF EXISTS public.module_files;
--   DROP FUNCTION IF EXISTS public.cfg_module_files_guard();
--   (storage objects under module-files/ are orphaned; delete them from the bucket if wanted)

CREATE TABLE IF NOT EXISTS public.module_files (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    site_id       uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    record_id     uuid NOT NULL REFERENCES public.module_records(id) ON DELETE CASCADE,
    module_key    text NOT NULL,
    stage_order   integer NOT NULL,
    field_key     text NOT NULL,
    storage_path  text NOT NULL,
    file_name     text NOT NULL,
    content_type  text NOT NULL,
    size_bytes    bigint NOT NULL,
    sha256        text NOT NULL,
    uploaded_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_mf_tenant_module FOREIGN KEY (tenant_id, module_key)
        REFERENCES public.tenant_modules (tenant_id, module_key),
    CONSTRAINT uq_mf_storage_path UNIQUE (storage_path),
    CONSTRAINT chk_mf_stage CHECK (stage_order >= 1),
    CONSTRAINT chk_mf_field CHECK (field_key ~ '^[A-Za-z0-9_]{1,64}$'),
    CONSTRAINT chk_mf_name CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
    CONSTRAINT chk_mf_size CHECK (size_bytes > 0),
    CONSTRAINT chk_mf_sha CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_mf_path CHECK (storage_path LIKE 'module-files/%')
);

CREATE INDEX IF NOT EXISTS idx_module_files_record
    ON public.module_files (record_id, stage_order, field_key);
CREATE INDEX IF NOT EXISTS idx_module_files_tenant
    ON public.module_files (tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.cfg_module_files_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.module_records r
         WHERE r.id = NEW.record_id AND r.tenant_id = NEW.tenant_id
           AND r.site_id = NEW.site_id AND r.module_key = NEW.module_key
    ) THEN
        RAISE EXCEPTION 'module file: record % is not a % case of site % in this tenant',
            NEW.record_id, NEW.module_key, NEW.site_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_module_files_guard ON public.module_files;
CREATE TRIGGER trg_module_files_guard
    BEFORE INSERT ON public.module_files
    FOR EACH ROW EXECUTE FUNCTION public.cfg_module_files_guard();

DROP TRIGGER IF EXISTS trg_module_files_append_only ON public.module_files;
CREATE TRIGGER trg_module_files_append_only
    BEFORE UPDATE OR DELETE ON public.module_files
    FOR EACH ROW EXECUTE FUNCTION public.cfg_forbid_mutation();

ALTER TABLE public.module_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.module_files;
CREATE POLICY tenant_isolation ON public.module_files
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON public.module_files FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON public.module_files FROM authenticated;
    END IF;
END $$;

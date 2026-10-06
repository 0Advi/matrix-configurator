# File field system plan

Task 12. How file uploads become first-class, typed fields of the generic module runtime. This is a plan only: no code
has changed. `svc.py` means `app/backend/app/services/module_runtime_service.py`. Finding IDs `RT-*` come from
`docs/runtime/HARDENING.md` (Task 7). Component and state names come from `docs/frontend/GENERIC-RUNTIME-SPEC.md`
(Task 8). The event envelope is shared with `docs/events/EVENT-BUS.md`, which another agent is writing in parallel.

**Files inspected**

| Area | Files |
|---|---|
| Upload/storage core | `app/backend/app/core/uploads.py`, `app/backend/app/services/storage_service.py`, `app/backend/app/core/config.py:100-107,162`, `app/backend/app/main.py:491-538` |
| Generic runtime | `svc.py:39-43,449-510,689-778,796-973`, `app/backend/app/services/module_runtime/forms.py`, `app/backend/app/routers/module_runtime.py:14-15,108-124`, `app/backend/database/migrations/20261006_1_module_files.sql`, `20261004_1_tenant_config_releases.sql:71-82,107` |
| Built-in uploads | `loi_service.py:50-100`, `photo_service.py:55-150`, `design_service.py:163-172`, `business_admin_documents_service.py:40-54`, `business_admin_service.py:975-1014`, `site_documents_service.py` |
| Frontend | `custom-module/widgets.jsx`, `custom-module/GenericRecordPage.jsx`, `services/api/moduleRuntimeApi.js`, `custom-module/__tests__/f5aFiles.test.jsx` |
| Target design | `packages/manifest/workspace_manifest.schema.json:457-474`, `workspace_manifest/validate.py:544-575`, `packages/access/workspace_access/{authorize,model}.py`, `platform_ceiling.json`, `docs/store/API.md §5`, `packages/store/sql/0002_store.sql:510-512` |
| Tests | `app/backend/tests/test_f5a_fixes.py:356-490`, `tests/test_batch_c_infra.py:124-135` |

## 1. Current upload implementation

| Step | What happens today | Where |
|---|---|---|
| Transport | One multipart POST (`field`, `file`). The backend reads the whole body into memory in 1 MB chunks, up to a 25 MB cap, then relays it to storage. The frontend waits up to 120 s. | `uploads.py:87-121`, `config.py:107`, `moduleRuntimeApi.js:99-107` |
| Type check | The client-declared `Content-Type` must be in `ALLOWED_MIME` (images, PDF, doc/docx, xls/xlsx, CSV). The upload is refused (400) if that header is missing. | `uploads.py:21-33,96-104` |
| Magic bytes | Checked only for "strong" types, and only when `filetype.guess` recognises the bytes (`kind is not None`). Weak types (doc, xls, csv) are never checked. A docx/xlsx that sniffs as zip is allowed with a warning. | `uploads.py:36-58,124-140` |
| Field rules | Size and type come from the field's **free-text hint**, parsed by regex (`max 5MB`, `pdf`). The extension **and** the declared MIME must match `accept`. The size is capped by `MAX_UPLOAD_BYTES`. | `forms.py:26-27,83-94`, `svc.py:825-845` |
| Who may upload | Only someone the runtime lets `submit` the **current** form step, and only for a `file` field of that step. | `svc.py:812-823,870-872` |
| Storage | A single Supabase bucket from `SUPABASE_STORAGE_BUCKET` (default `site-files`), shared with LOI, photos and design files. The service-role key is used. The key is `module-files/<tenant>/<module>/<record>/<file_id>/<sanitised name>`. The PUT always sends `x-upsert: true`. | `config.py:102`, `storage_service.py:94-115`, `svc.py:882-885` |
| Metadata | `module_files` holds one row per upload: tenant, site, record, module, `stage_order`, `field_key`, path, name, the **declared** content_type, size and sha256. The table is append-only, and a guard trigger checks that the record belongs to the tenant, site and module. The RLS policy is `tenant_isolation`. | `20261006_1:28-92`, `svc.py:879,886-894` |
| Audit | One `audit_logs` row, `module_file_uploaded`, written with the metadata insert. If that insert fails, the storage object is deleted. The row sits outside the case hash chain (RT-F11). | `svc.py:895-906` |
| Download | `GET /m/{key}/files/{id}` returns a signed URL valid for 300 s. The visibility check is `_executive_sees` for executives only; every other role sees all files. **No audit.** The frontend opens the URL inline in a new tab. | `svc.py:911-935`, `storage_service.py:136-154`, `GenericRecordPage.jsx:129-137` |
| Delete | No endpoint. Rows are append-only and cascade with the record, site or tenant. Deleting a site purges its objects best-effort after commit, with no retry. | `20261006_1:30-32,82-85`, `business_admin_service.py:990-994,1011-1014` |
| Bucket privacy | Not enforced in code. The only instruction is a runbook line, "create bucket … (Private)". | `left_out_tasks.md:125` |
| Built-ins | **LOI**: deterministic key `loi/<t>/<site>/<name>` written with upsert, so a re-upload with the same name overwrites the bytes behind the demoted older row. **Photos/site docs**: random-prefixed keys and an advisory-lock count cap (`photo_service.py:84-85,96-113`). **Design**: `file_url` mixes storage keys (`design/…`) and free-text http links (`business_admin_documents_service.py:40-54`). | `loi_service.py:63-66,78-99` |

## 2. Current module file-field behavior

| Aspect | Behavior | Where |
|---|---|---|
| Field → schema | `kind: file` compiles to `{"type":"string"}` with `ui:widget: MatrixFileWidget` (file_mode `ref`). `accept` is a list of extensions and `maxSize` is a string, both taken from the hint. | `forms.py:83-94`, `runtime.py:87` |
| Value | A single string holding the file id. There is no array form, so a field holds at most one file. | `widgets.jsx:80,89`, `svc.py:960` |
| Required | Only key presence is checked: `""` passes the schema, and `_check_file_values` skips `""`/`None` (RT-B07). | `forms.py:130`, `svc.py:957` |
| Submit check | Each non-empty value must be a UUID present in `module_files` for **this** tenant, record, `stage_order` and field. Otherwise the submit fails with 422 `invalid_form`. | `svc.py:474-476,948-973` |
| Not checked at submit | Whether the file was deleted (no deletes exist), still uploading (impossible today because the upload is synchronous), or unscanned (no scanner exists). | — |
| Resubmit after send-back | The same id can be submitted again. `module_stage_states.field_values` is **overwritten** (`ON CONFLICT … DO UPDATE`), so the file an approver saw in pass 1 survives only in the audit provenance. | `svc.py:340-366` (`:354`) |
| Listing | `GET …/records/{id}` returns `files{}` with **every** upload of the case, including abandoned uploads that were never submitted. | `svc.py:729,777,938-945` |
| Widget | Accepts one file. The client checks extension and size, then uploads immediately and sets the value to the id. **Remove** only clears the value; the row and object stay. A non-UUID value shows as "Earlier reference …". | `widgets.jsx:25-35,68-121` |
| Migration | `module_files.stage_order` is not re-keyed by `_migrate_site`, so a renumbered stage orphans its files (RT-B14). Renaming a field has the same effect, and the manifest has no rename mapping (store diff = `field_removed` + `field_added_optional`, `docs/store/API.md:186`). | `release_migration_service.py:284` |
| Tests | Compiler limits; hint size cap; accept check; current-step-only upload; submit binding; routes mounted; migration text; site-delete purge. Frontend: upload-and-submit, wrong-type refusal, open via signed URL. | `test_f5a_fixes.py:356-490`, `f5aFiles.test.jsx:59-105` |

## 3. Gaps

| # | Gap | Label | Evidence | Fixed in |
|---|---|---|---|---|
| G1 | A required file field accepts `""` (RT-B07). | bug | `forms.py:130`, `svc.py:957` | §5 schema, §5 verify |
| G2 | The magic-byte check **fails open**: if sniffing returns `None` for a declared strong type, the upload passes, and weak types are never sniffed. The **client-declared** type is stored and later served. A CSV sent by a browser as `application/vnd.ms-excel` fails `check_file_type`. | bug | `uploads.py:58,124-126`; `svc.py:879,885`; `svc.py:843` | §5 finalize, §7 |
| G3 | Upload race: the read transaction is released (`svc.py:873`) and the step is never re-checked before the insert (`:886`). A file can therefore be bound to a stage the case has already left. The upload also neither checks nor bumps `seq` (RT-F14). | bug | `svc.py:862-894` | §5 create/finalize locks |
| G4 | A migration does not re-key files: they are keyed by `stage_order` (RT-B14, RT-D01), and a field rename loses them. | bug | `20261006_1:34`, `release_migration_service.py:284-396` | §4 keys, §8 |
| G5 | LOI re-upload overwrites earlier bytes: the key is deterministic and the PUT upserts. This is a built-in path, but the same `upload_bytes` default is used for module files. | bug | `loi_service.py:63-66`, `storage_service.py:102` | §7 S10 |
| G6 | Abandoned or unsubmitted uploads are listed to every case viewer. The schema has no "attached" state. | missing feature | `svc.py:938-945` | §4 `attached_at`, §5 list |
| G7 | Only single-file fields exist: no `max_files` or `min_files`, no array value. | missing feature | `forms.py:84`, `widgets.jsx:80` (RT-F16) | §4–§6 |
| G8 | Accept and size limits come from a regex over free text, and only 8 extensions are known. The manifest's typed `accept`/`max_size_mb`/`max_files` are not used. | missing feature | `forms.py:26-27,89-94`; schema `:457-474` | §5 compiler |
| G9 | Downloads are not audited. | missing feature | `svc.py:911-935` | §5 download, §7 |
| G10 | Files cannot be deleted or redacted. **Remove** only clears the form value. | missing feature | `20261006_1:82-85`, `widgets.jsx:105` | §5 DELETE, §8 |
| G11 | No orphan GC (RT-F16). The site-delete purge is best-effort with no retry queue, and a crash between PUT and INSERT leaves an object with no row. | missing feature | `business_admin_service.py:1011-1014`, `svc.py:885-906` | §8 jobs |
| G12 | No virus/malware scan hook. | missing feature | — | §7 S7 |
| G13 | Bytes are buffered in the API process and relayed to storage, with a 25 MB in-memory cap and a 120 s client timeout. | design decision | `uploads.py:111-121`, `moduleRuntimeApi.js:99` | two-phase upload (§5) |
| G14 | Bucket privacy is not enforced. One bucket is shared by built-ins and modules across all tenants. | design decision | `config.py:102`, `left_out_tasks.md:125` | §7 S1-S2 |
| G15 | Download visibility is role-named (`_executive_sees`), not `authorize(case.view)` (RT-B13). | design decision | `svc.py:924-927,632-638` | §5 download |
| G16 | Signed URLs last 300 s, are served inline, and the user filename is part of the object key. | design decision | `svc.py:882,929`, `GenericRecordPage.jsx:133` | §7 S4-S6 |
| G17 | The app DB role is BYPASSRLS, so tenant isolation rests on `tenant_id = :tid` in each query. | design decision | `20261004_1:107` | §7 S3 |
| G18 | Size ceilings disagree: the schema allows `max_size_mb` up to 100, the runtime cap is 25 MB, and there is no platform ceiling for files. | design decision | schema `:465-468`, `config.py:107` | §4 R8, §7 S8 |
| G19 | Legacy values (typed references, design http links) sit in fields with no migration path. | missing feature | `widgets.jsx:108-111`, `business_admin_documents_service.py:50-54` | §4 data migration |
| G20 | Uploads have no idempotency. A retry creates a second row and object. | missing feature | RT-F14 | §5 `Idempotency-Key` |

## 4. DB changes

The new tables live in a new migration, `packages/store/sql/0007_files.sql`. It applies after `0003_runtime.sql`, which defines `cases`,
`case_events`, `case_stage_states` and the outbox (HARDENING §4, EVENT-BUS.md). It follows store conventions: a `workspace_id` on
every row, `ws_isolation` RLS on `app.workspace_id` (`0002_store.sql:510-512`), and stage and field identified by **key** (RT-D01).

```sql
-- 4.1 one row per upload (the blob + its binding + its lifecycle)
CREATE TABLE case_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL,
  module_key      text NOT NULL,
  case_id         uuid NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,     -- no silent cascade (see §8)
  release_id      uuid NOT NULL REFERENCES workspace_releases(id),          -- release whose field rules validated it
  stage_key       text NOT NULL,
  form            text NOT NULL DEFAULT 'submit' CHECK (form IN ('submit','approval')),
  tier_index      int,                                                       -- approval-form fields only
  field_key       text NOT NULL CHECK (field_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  pass_no         int  NOT NULL CHECK (pass_no >= 1),                        -- stage pass at upload (send-back => +1)
  state           text NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','verifying','ready','rejected','expired','deleted','legacy_reference')),
  reject_code     text,                                                      -- file_type | file_too_large | checksum_mismatch | infected | …
  scan_status     text NOT NULL DEFAULT 'pending'
                  CHECK (scan_status IN ('pending','clean','infected','error','skipped','legacy_unscanned')),
  scan_engine     text, scanned_at timestamptz,
  storage_bucket  text,
  storage_key     text UNIQUE,                                               -- ws/{ws}/m/{module}/c/{case}/f/{id}; no filename
  file_name       text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  declared_mime   text, declared_size bigint CHECK (declared_size > 0), client_sha256 text,
  content_type    text,                                                      -- SNIFFED type; the only type ever served
  size_bytes      bigint CHECK (size_bytes > 0),
  sha256          text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  legacy_ref      text,                                                      -- migrated typed reference / URL (display only)
  uploaded_by     uuid,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  upload_expires_at timestamptz, finalized_at timestamptz,
  attached_at     timestamptz,                                               -- first attachment (set by trigger)
  deleted_at      timestamptz, deleted_by uuid, delete_mode text, delete_reason text, purged_at timestamptz,
  CONSTRAINT chk_cf_tier   CHECK ((form = 'approval') = (tier_index IS NOT NULL)),
  CONSTRAINT chk_cf_key    CHECK (storage_key IS NULL OR storage_key LIKE 'ws/' || workspace_id::text || '/%'),
  CONSTRAINT chk_cf_ready  CHECK (state <> 'ready' OR (sha256 IS NOT NULL AND size_bytes IS NOT NULL
                                  AND content_type IS NOT NULL AND scan_status IN ('clean','skipped','legacy_unscanned'))),
  CONSTRAINT chk_cf_legacy CHECK ((state = 'legacy_reference') = (legacy_ref IS NOT NULL AND storage_key IS NULL)),
  CONSTRAINT uq_cf_idem    UNIQUE (workspace_id, uploaded_by, idempotency_key)
);
CREATE INDEX idx_cf_case    ON case_files (case_id, stage_key, field_key, pass_no);
CREATE INDEX idx_cf_gc      ON case_files (state, created_at) WHERE attached_at IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_cf_pending ON case_files (upload_expires_at) WHERE state IN ('pending','verifying');

-- 4.2 which files a SUBMITTED value referenced, per pass (append-only; the pass history / versioning)
CREATE TABLE case_file_attachments (
  workspace_id uuid NOT NULL,
  case_id      uuid NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  stage_key    text NOT NULL, form text NOT NULL, tier_index int, field_key text NOT NULL,
  pass_no      int  NOT NULL,
  file_id      uuid NOT NULL REFERENCES case_files(id),
  position     smallint NOT NULL CHECK (position >= 0),
  event_id     uuid NOT NULL,                     -- the submit event (case_events / outbox id)
  attached_by  uuid NOT NULL,
  attached_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_cfa ON case_file_attachments
  (case_id, stage_key, form, COALESCE(tier_index, 0), field_key, pass_no, file_id);
CREATE INDEX idx_cfa_file ON case_file_attachments (file_id);

-- 4.3 download audit (envelope-shaped; see §5 events)
CREATE TABLE case_file_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL, module_key text NOT NULL, case_id uuid NOT NULL, file_id uuid NOT NULL,
  actor_id uuid NOT NULL, actor_kind text NOT NULL, on_behalf_of uuid, as_override boolean NOT NULL DEFAULT false,
  release_id uuid NOT NULL, release_version int NOT NULL, decision_via text NOT NULL,
  url_expires_at timestamptz NOT NULL, client_ip inet, user_agent text,
  correlation_id text, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cfal_file ON case_file_access_log (file_id, occurred_at DESC);

-- 4.4 durable object purge (replaces best-effort delete_object loops)
CREATE TABLE storage_purge_queue (
  storage_bucket text NOT NULL, storage_key text NOT NULL, workspace_id uuid NOT NULL, file_id uuid,
  reason text NOT NULL, attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text, done_at timestamptz,
  PRIMARY KEY (storage_bucket, storage_key)
);
```

**Triggers and RLS**

| Object | Rule |
|---|---|
| `case_files_guard` (BEFORE INSERT) | The case is in `workspace_id` and `module_key`. `release_id` = the case's pinned release. The pinned manifest has `stage_key`, with `field_key` of `type: "file"` in the submit fields, or in `approvals[tier_index].fields` for an approval form (a jsonb path lookup). The successor of `cfg_module_files_guard` (`20261006_1:59-80`). |
| `case_files_transition` (BEFORE UPDATE) | State moves only forward: `pending→verifying→ready\|rejected`, `pending→expired`, `ready→deleted`, `legacy_reference→deleted`. After `ready`, `sha256`, `size_bytes`, `content_type`, `storage_key`, `case_id` and `uploaded_by` are immutable. `stage_key`/`field_key`/`form`/`tier_index` may change **only** when `current_setting('app.release_migration', true)` names a running migration (the RT-D02 pattern). DELETE is refused (`cfg_forbid_mutation` semantics). |
| `case_file_attachments_guard` (BEFORE INSERT) | The file's `state = 'ready'`, `deleted_at IS NULL`, and `scan_status <> 'infected'`. The file's `(case_id, stage_key, form, tier_index, field_key)` equals the attachment row's. `workspace_id` is equal on both. Sets `case_files.attached_at` if null. Rows are append-only, but re-keying under `app.release_migration` is allowed (§8). |
| `case_file_access_log` | Append-only (UPDATE and DELETE refused). |
| RLS | `ws_isolation` on all four tables, plus `REVOKE ALL FROM anon, authenticated`. The runtime connects with a role **without** BYPASSRLS and sets `app.workspace_id` per transaction (G17). |

**Manifest and validator changes** (`workspace_manifest.schema.json`, `validate.py` R8)

| Change | Detail |
|---|---|
| `field.validation.min_files` (new) | Integer from 0 to 20. The default is 1 when `required`, otherwise 0. |
| Multiple files | No separate `multiple` key: **multiple ⇔ `max_files > 1`** (default 1), which rules out contradictory configurations. The value shape follows from `max_files` (§5). |
| `workspace.files` (new, optional) | `{retain_after_close_days: int\|null, unattached_ttl_hours: 1..720 (default 168)}`. |
| Grant enum + `platform_ceiling.json` | Add `redact_files` (holder scope `workspace`, not read-only). Add `files: {allowed_mime: [...], max_size_mb: 25, max_files: 20, min_retain_days: 0}`. `ALLOWED_MIME` moves there from `uploads.py:21-33`. |
| R8 `field_validation` | Error when `min_files > max_files`, or when `min_files` is set on a non-file field. |
| R8 `file_type_not_allowed` (E) | An `accept` entry, with wildcards like `image/*` expanded, is not in the ceiling's `allowed_mime`. |
| R8 `file_size_over_ceiling` (E) | `max_size_mb` > the ceiling's `max_size_mb`. This resolves G18: the schema keeps 100 as an absolute bound and the ceiling decides. |
| R8 `file_accept_missing` (W) | No `accept` means the whole platform allowlist is accepted. |
| R8 `file_required_min_files` (E) | `required: true` with `min_files: 0`. |

The `from_v5.py` converter keeps the hint regex (`forms.py:26-27`) and only uses it to emit typed `accept`/`max_size_mb`.

**Data migration** (one script, `0007_files_backfill`, run under `app.release_migration`)

| Source | Target |
|---|---|
| `module_files` rows | `case_files`: `state='ready'`, `scan_status='legacy_unscanned'` (queued for a rescan), `stage_key` from the pinned release's `stages[order-1].key`, `content_type` re-sniffed from the object (a mismatch sets `state='rejected'`). The object is copied to the new key and the old one is queued for purge. |
| Stage values holding a UUID of `module_files` | Values are unchanged (same id). `case_file_attachments` rows come from `audit_logs.provenance.event` submit events, falling back to the current `field_values` as pass 1. |
| Non-UUID values (typed references, `http(s)` links, `data:` URLs) | A `data:` URL is decoded and uploaded through the normal finalize path. Any other value becomes `state='legacy_reference'` with `legacy_ref=<text>`. The value is **rewritten to the new id**, so every file value is an id. Legacy references are display-only: no signed URL, never attachable to a new submission. |
| Built-ins moved onto templates (design `file_url`, LOI, photos) | Storage keys (`design/…`, `loi/…`) are imported as real `case_files`. Free-text links become `legacy_reference`. |

After cut-over, `module_files` and `cfg_module_files_guard` are dropped. If the port is delayed, the sandbox gets an interim migration `20261007_1`
that adds `state`, `attached_at`, `pass_no`, `content_type_detected`, `scan_status`, `deleted_at` to `module_files` and replaces the
append-only trigger with the transition trigger above.

## 5. API changes

New routes follow HARDENING §5 (`/modules/{key}/cases/{case_id}/…` behind `Guard.check()`). The `/m/{key}/…` routes stay as
deprecated aliases for one release. All POST routes take `Idempotency-Key`. Errors use `application/problem+json` with a stable `code`.

| Method + path | Authorize | Request → response | Errors (code) |
|---|---|---|---|
| `POST …/cases/{case_id}/files` (create intent) | `stage.submit` (or `stage.approve` for `form:"approval"`) on the **current** step of the pinned release. `stage_key` must equal the current stage. `as_override` is recorded. | `{stage_key, field_key, form?, tier_index?, file_name, size_bytes, declared_mime, sha256?}` → `201 {file:{id, state:"pending", …}, upload:{method:"PUT", url, headers:{"Content-Type","x-upsert":"false"}, expires_at}}`. The URL is a storage **signed upload URL** valid 10 min, for `storage_key`. | `wrong_step`, `unknown_field` (not a file field), `file_too_large` (declared > limit), `file_type` (declared ∉ accept), `too_many_files` (pending + ready-unattached + this pass's kept files ≥ `max_files` + 2), `rate_limited` (> 20 pending per user) |
| `PUT …/files/{id}/content` (fallback) | Same as create, and only the uploader. | Streamed body, capped at the limit + 1 byte. For dev or storage without signed uploads (`FILES_UPLOAD_MODE=proxy`). | `file_too_large` |
| `POST …/files/{id}/finalize` | Uploader only. The case row is locked `FOR UPDATE`, and the step and `seq` are re-checked (fixes G3). | `{}` → `200 {file}`. The server HEADs the object and streams it once: size = `declared_size` and ≤ limit; computes sha256 and compares it with `client_sha256`; **sniffs** the type (§7 S5); requires detected ∈ accept ∩ ceiling; runs the scan hook. `state` becomes `ready`, or `verifying` while an async scan runs. Emits `module.file.uploaded` on `ready`. | `file_not_uploaded` 409, `file_too_large` 413, `file_type` 415, `checksum_mismatch` 422, `infected` 422 (state `rejected`), `scanner_unavailable` 503 (retryable), `wrong_step` 409 |
| `GET …/cases/{case_id}/files` | `case.view` | `{files:[{id, stage_key, field_key, form, tier_index, pass_no, state, scan_status, file_name, content_type, size, sha256, uploaded_by, created_at, attached:[{pass_no, event_id, at}], superseded_in_pass?, deleted?:{at, by, mode, reason}}]}`. Unattached files are visible only to their uploader and to holders of `stage.submit` on the current step (G6). | — |
| `GET …/files/{id}` | `case.view` (+ the unattached rule) | Metadata only; **no URL**. | `404 not_found` (also for other workspaces and invisible cases) |
| `POST …/files/{id}/download` | `authorize(p, "case.view", CaseResource(case), policy_of(case.release_id))`. The file must be `ready` and not deleted. | `200 {url, expires_in:60, disposition:"attachment"\|"inline"}`. The `case_file_access_log` row is written **before** the URL is returned. POST rather than GET because the call has a side effect and must not be prefetched. | `404`, `409 file_not_ready`, `410 file_deleted`, `503 storage_unavailable` |
| `DELETE …/files/{id}` | Unattached: the uploader, or a holder of `stage.submit` on the current step. Attached: `?mode=redact` + grant `redact_files` (new authorize action `file.redact`), with a required `reason`. | `200 {file}`. Unattached: `state='deleted'`, `delete_mode='discard'`. Redact: tombstone, metadata kept, bytes purged. Both enqueue the purge and emit `module.file.deleted`. | `409 file_attached` (no redact), `422 reason_required`, `403` |
| `POST …/cases/{case_id}/actions` (submit) | Unchanged authorization. | File values are verified by `files.verify_submission()` (table below), and `case_file_attachments` rows are inserted **in the submit transaction**. The `stage.submitted` payload carries `files:{field_key:[ids]}` and `files_diff:{added, kept, removed}` against the previous pass. | `422 invalid_form` with per-field `errors[]` codes |
| `GET …/cases/{id}` (detail) | `case.view` | `files{}` is replaced by the list shape above, without unattached files of others. Stage `values` hold an id (single) or an array of ids (multiple). | — |

**Field schema compiled by `forms.field_schema`** (replaces `forms.py:83-94`)

| Field | JSON Schema | `ui:options` |
|---|---|---|
| single (`max_files` = 1) | `{"type":"string","format":"uuid","minLength":1}`. `required` puts the key in `required`. `""` fails `minLength` (G1). | `{accept:[mime…], acceptExt:[".pdf",…], maxBytes, maxFiles:1, minFiles}` |
| multiple (`max_files` > 1) | `{"type":"array","items":{"type":"string","format":"uuid"},"uniqueItems":true,"maxItems":max_files,"minItems":min_files}` | same, with `maxFiles` > 1 |

**Submit verification** (`files.verify_submission(session, case, step, values)`: one query over `id = ANY(:ids)` with `FOR SHARE`)

| Value refers to | Result (`errors[].code`) |
|---|---|
| A non-UUID string, `""`, or an empty array on a required field | `file_required` / `file_invalid_ref` |
| An id not in this workspace, or not of **this case** | `file_unknown`. One code for both, so the error does not reveal that another workspace's file exists. |
| A file of this case but another stage, form, tier or field | `file_wrong_field` |
| `state` `pending`/`verifying`, or `scan_status` `pending` | `file_not_ready` |
| `rejected` / `infected` / `expired` | `file_rejected` |
| `deleted` / `legacy_reference` | `file_deleted` / `file_legacy` |
| The same id twice in one value | `file_duplicate` |
| Count outside `[min_files, max_files]` | `too_few_files` / `too_many_files` |
| A size or type that violates the **current** pinned release (after a migration tightened it) | `file_too_large` / `file_type`. Re-checked from stored metadata; nothing is re-sniffed. |

A file is bound to a single case, stage and field at creation, so it cannot be attached anywhere else. Carrying a file over to a new
pass of the **same** field is allowed (§8 versioning).

**Events** (envelope from EVENT-BUS.md, written through the transactional outbox in the same transaction as the state change)

| Type | When | `payload` | `idempotency_key` |
|---|---|---|---|
| `module.file.uploaded` (bus) | Finalize, or the async scan, moves the file to `ready` | `{file_id, field_key, form, tier_index, pass_no, file_name, content_type, size_bytes, sha256, scan_status}`. No URL, no key, no bytes. | `file:{id}:ready` |
| `module.file.deleted` (bus) | discard, redact, orphan GC, retention, subject deletion | `{file_id, field_key, pass_no, mode:"discard"\|"redact"\|"orphan_gc"\|"retention"\|"subject_deleted", reason?, was_attached, sha256}`. `actor.kind = "system"` for jobs. | `file:{id}:deleted` |
| `module.file.downloaded` | **audit record only**: one `case_file_access_log` row per signed URL issued | The same envelope fields as columns. | — |

The common fields are `record_id = case_id`, `subject = the case subject`, `stage_key`, `release = the case's pinned release`, and `actor.as_override` from the `Decision`.
Downloads stay off the bus for four reasons. A download is a read with no state change, so no projection or consumer needs to react. Volume is high. IP and user agent are PII that should not fan out to subscribers or webhooks. And issuing a URL does not prove a download happened. The row uses envelope-shaped columns, so promoting it to a bus event later is a mechanical change.

## 6. Frontend changes

| File / component | Change | Refs |
|---|---|---|
| `services/api/moduleRuntimeApi.js` (`:96-111`) | Add `createFileUpload`, `putFileContent(upload, file, {onProgress, signal})` (axios PUT straight to `upload.url`, no auth header), `finalizeFile`, `listCaseFiles`, `issueFileDownload` (POST), `deleteFile(id, {mode, reason})`. `uploadRecordFile` becomes a wrapper that hashes, creates, puts and finalizes. Retries use the same `Idempotency-Key`. `UPLOAD_TIMEOUT_MS` applies only to the PUT. | RT-F14 |
| `widgets/useFileUpload.js` (new) | State machine: `idle → hashing` (`crypto.subtle.digest('SHA-256')`, ≤ 25 MB) `→ uploading(progress) → verifying → ready \| scan_pending \| error`. Supports cancel through `AbortController`. Exposes `inFlight` to the form. | Spec "Upload error" |
| `widgets.jsx` `MatrixFileWidget` (`:68-121`) → `FileFieldWidget` | Driven by `ui:options.{accept, acceptExt, maxBytes, minFiles, maxFiles}` instead of `maxSize`/extension strings. `checkFile` (`:25-35`) also checks MIME. **Remove** calls `DELETE` for unattached files of this pass and only clears the value for files carried over from an earlier pass. Shows progress, "Checking file…" (verifying or scan pending) and a legacy-reference note for `state:'legacy_reference'`. | G1, G7, G10 |
| `widgets.jsx` `MultiFileWidget` (new, spec #15) | A list of chips with reorder; adding stops at `maxFiles`; value is an array of ids; "Keep from previous pass" lists files attached in pass N-1. | G7 |
| `RecordContext` → `FileUploadContext` | `{moduleKey, caseId, files, inFlight, register(field, promise)}`. StageForm disables **Submit** while `inFlight > 0`. | Spec "Upload error" row |
| `GenericRecordPage.jsx` `openFile` (`:129-137`) | Uses `issueFileDownload`. Keeps the pre-opened window trick. `disposition:"attachment"` downloads in place. `410` and `409` map to Notices. | G9, G16 |
| `GenericRecordPage.jsx` `StageRow.fileLink` (`:427-433`) | Renders a single id or an array. Shows a pass badge ("v2, replaces report.pdf"). Deleted files render as tombstones. | §8 |
| `FilesPanel` (spec #25, route `/m/:moduleKey/cases/:caseId/files`) | Groups by stage → field → pass. Shows state and scan badges, superseded and deleted entries, and image preview through the signed URL. "Delete" for unattached files; "Redact…" only when `can.redact_files`. | G6, G10 |
| `AuditTimeline` provenance registry (`GenericRecordPage.jsx:304-306`) | Renderers for `module.file.uploaded` and `module.file.deleted`. Holders of `audit.view` get a "Downloads" tab fed by `case_file_access_log`. | G9 |
| Error copy map | `file_not_ready`, `file_wrong_field`, `file_unknown`, `checksum_mismatch`, `infected`, `too_many_files`, `scanner_unavailable`, `file_deleted`: an inline alert under the field. The previous file stays. | Spec "Upload error" |

## 7. Security rules

| # | Rule | Enforcement |
|---|---|---|
| S1 | **Private buckets only.** One dedicated bucket, `workspace-files` (`FILES_BUCKET`), created with `public=false`, `file_size_limit` = ceiling, and `allowed_mime_types` = ceiling allowlist, as defense in depth. | `files/bucket_guard.assert_private_buckets()` in `lifespan` (`main.py:491`) calls `GET /storage/v1/bucket/{id}` for every configured bucket (`FILES_BUCKET`, `SUPABASE_STORAGE_BUCKET`). The app **refuses to start** if any is `public`, unless `ALLOW_INSECURE_DEFAULTS` (the `config.py:162` pattern). CI job `scripts/check_storage_buckets.py` runs against the deploy project. Static test: no `/object/public/` or `getPublicUrl` anywhere. Migration asserts `NOT EXISTS (SELECT 1 FROM storage.buckets WHERE public)` when the `storage` schema exists. |
| S2 | Workspace scoping by key prefix. | `storage_key = ws/{workspace_id}/m/{module}/c/{case_id}/f/{file_id}`, CHECK `chk_cf_key`. Signing and deleting go only through a `case_files` row looked up with `workspace_id = :ws`. Callers can never pass a raw key. |
| S3 | Workspace scoping in the DB. | `ws_isolation` RLS with a non-BYPASSRLS runtime role, `app.workspace_id` set per transaction, and guard triggers (§4). Any cross-workspace reference resolves to `404` / `file_unknown`. |
| S4 | Downloads need the record's visibility. | `authorize("case.view")` with the policy compiled from the case's **pinned** release (`authorize.py:16`), plus the unattached-file rule. Only then is the access-log row written and a URL issued. |
| S5 | Never trust the client's type. | Finalize sniffs the first 8 KB plus container contents (`files/sniff.py`), failing closed. Strong types must match `filetype`, and `None` is a rejection (fixes `uploads.py:126`). doc/xls need the OLE2 magic `D0CF11E0`. docx/xlsx need a valid zip with `[Content_Types].xml` and `word/` or `xl/`, and macro parts (`vbaProject.bin`) are rejected. CSV must decode as UTF-8 or Latin-1 with no NUL bytes. HTML, SVG, XML and JS are never allowed. The **detected** type is stored and served. The extension must agree with the detected type. |
| S6 | Short-lived, non-rendering URLs. | 60 s TTL. `download=<file_name>` (Content-Disposition: attachment) for everything except images and PDF. Storage objects carry `X-Content-Type-Options: nosniff`. The frontend sets `opener = null`. |
| S7 | Virus scan hook (decision). | A `files/scan.Scanner` protocol with `ClamdScanner` (clamd `INSTREAM`) and `NoopScanner`. Production requires a real scanner (`FILE_SCAN_REQUIRED=true`; a startup check refuses `noop`). Files ≤ 25 MB are scanned synchronously in finalize (20 s timeout); larger files or timeouts move to `verifying` and a worker finishes the scan. **Fail closed**: a file is never `ready`, attachable or downloadable before `clean`. `scan_status='error'` retries 3×. Legacy files are rescanned in the background and stay downloadable meanwhile (`legacy_unscanned`), but can't be newly attached. |
| S8 | Size limits. | Effective limit = `min(field.max_size_mb, ceiling.max_size_mb)`, checked at create (declared size), on the PUT (bucket `file_size_limit`; proxy caps the stream) and at finalize (actual size). The ceiling is lowered or raised only by platform config. Publish (R8) refuses fields above it. |
| S9 | Abuse limits. | At most 20 pending uploads per user. Per-field count caps at create. Signed upload URLs expire after 10 min. Pending rows expire after 1 h. |
| S10 | Immutability. | `x-upsert: false` on every PUT. The key includes the file id. Rows are immutable after `ready`. This also fixes the LOI overwrite (G5): `loi_service.py:63` uses `{uuid}_{name}` like `photo_service.py:84`. |
| S11 | No URLs in values. | Values are ids (schema `format: uuid`). URLs are generated per request and never stored. |
| S12 | Logging. | Log file ids and sha256, never signed URLs or tokens. `storage_service.upload_bytes` stops echoing `r.text` into the 502 detail (`storage_service.py:111-115`). |

## 8. Retention/deletion rules

| Situation | Rule | Mechanism |
|---|---|---|
| Upload never PUT or finalized | After `upload_expires_at` + 1 h, `state='expired'` and the key is queued for purge in case a partial object exists. | `files/jobs.expire_pending` every 5 min |
| `ready` but never attached | After `workspace.files.unattached_ttl_hours` (default 168), `deleted` with `delete_mode='orphan_gc'`, purged, `module.file.deleted`. Files of the **current** open pass are kept while the case is open and the step is unchanged, so a draft upload in progress is not collected. | `jobs.gc_unattached` hourly (`idx_cf_gc`) |
| Object with no row (crash between PUT and INSERT, or old prefixes) | Objects under `ws/` older than 24 h with no `case_files` row are deleted. | `jobs.reconcile_bucket` daily (list by prefix) |
| User removes an unattached file | `DELETE` → `discard` → purge. | §5 |
| Attached file | **Immutable evidence.** It cannot be deleted while the case is open or closed, only redacted with `redact_files` and a reason. A redaction tombstones the row (name, sha256, size, who and why kept), purges the bytes, keeps values and attachments, and shows "removed by … on …: reason" in the UI. | §5 `mode=redact` |
| Resubmit after send-back (versioning) | Each submit writes attachments for `pass_no = current pass`. Pass N may **keep** (re-attach the same id), **replace** (new upload) or **drop** files of pass N-1. Earlier passes' attachments and bytes stay, so approvers' history is exact. `files_diff` goes in the submit event. Superseded files are never GC'd while the case exists, because they are attached. | `case_file_attachments` |
| Record migration / stage or field rename | Bytes never move: the key has no stage or field. The migration plan (store API §5.1) adds `field_map: {module: {stage_key: {old: new}}}` next to `stage_map`. Execute re-keys `case_files` and `case_file_attachments` under `SET LOCAL app.release_migration`, journaled before/after per case (fixes G4/RT-B14). A removed field keeps its files as history under "Removed fields". A type change from file to non-file makes the case **incompatible** in the dry run. Tightened `accept`/size/count leaves completed passes alone; open-pass unattached files that break the new rules are listed in the dry-run notes and fail at submit (§5). | `release_migration_service._migrate_site` (`:284`), store migration |
| Case closed | Kept by default (current behavior). If `retain_after_close_days` is set, attached and unattached files are purged that many days after `closed_at` (`mode='retention'`), unless `cases.legal_hold`. Metadata rows stay as tombstones for the audit trail. | `jobs.retention_sweep` daily |
| Subject (site) or workspace deleted | No FK cascade (`ON DELETE RESTRICT`). The service tombstones the files (`mode='subject_deleted'`) and enqueues the purge in the **same** transaction. This replaces the post-commit best-effort loop at `business_admin_service.py:1011-1014`. | `storage_purge_queue` |
| Purge execution | `jobs.drain_purge_queue` every minute with exponential backoff. A `404` from storage counts as done. After 10 attempts it alerts. `case_files.purged_at` is set when done. | — |

## 9. Tests to add

| Test file | Cases | Gaps |
|---|---|---|
| `app/backend/tests/test_files_sniff.py` | Unknown bytes declared as PNG/PDF are rejected (fail-closed); HTML sent as `text/csv` is rejected; xlsm with `vbaProject.bin` is rejected; docx sniffed as zip passes only with `[Content_Types].xml`; CSV sent as `application/vnd.ms-excel` is accepted as `text/csv`; the detected type is stored. | G2 |
| `test_files_upload_flow.py` | create → PUT → finalize happy path; size mismatch → 413; sha mismatch → 422; finalize after the case moved stage → 409 `wrong_step`; the same `Idempotency-Key` returns the same file; > 20 pending → 429; `module.file.uploaded` is in the outbox exactly once. | G3, G13, G20 |
| `test_files_schema.py` | Single and multiple compile; `""` and `[]` fail for required fields; `min_files`/`max_files`/`uniqueItems`; `ui:options` come from typed validation, not hints. | G1, G7, G8 |
| `test_files_verify_submission.py` | Every row of the §5 verification table: other workspace, other case, wrong stage/field/tier, pending, unscanned, infected, deleted, legacy, duplicate, too few/many; carry-over from pass N-1 allowed. | AC3 |
| `test_files_download.py` | `case.view` denied → 404 and no log row; allowed → a log row written before the URL; TTL 60; attachment disposition; deleted → 410; an unattached file of another user → 404; a view-as-narrowed principal is denied. | G9, G15, AC4 |
| `test_files_delete_retention.py` | Discarding an unattached file; an attached file → 409; redact needs the grant and a reason; GC skips current-pass drafts; the retention sweep respects legal hold; the purge queue retries and treats 404 as done. | G10, G11 |
| `test_files_migration.py` | Stage renumber and field rename via `field_map` keep downloads and resubmits working; file → text type change is incompatible; a re-key outside `app.release_migration` is refused by the trigger. | G4 |
| `packages/store/tests/test_files_sql.py` (real PG, skipped without DSN) | Guard refuses a non-file field, a wrong release or a cross-workspace case; transition trigger (no backwards move, immutable after ready); attachment guard; RLS isolation between two workspaces; `chk_cf_key`. | AC2 |
| `test_storage_buckets.py` | Startup refuses a public bucket (mock `GET /bucket`); a static grep finds no `/object/public/` or `getPublicUrl`; `upload_bytes` never sends `x-upsert: true` for new keys; LOI keys are unique per upload. | G5, G14, AC5 |
| `test_files_backfill.py` | `module_files` → `case_files` with `stage_key`; non-UUID values → `legacy_reference` with the value rewritten to the id; `data:` URLs → real files. | G19, AC1 |
| `packages/manifest/tests/test_r8_files.py` | `file_type_not_allowed`, `file_size_over_ceiling`, `min_files > max_files`, `file_required_min_files`, `file_accept_missing` warning. | G18 |
| Frontend `custom-module/__tests__/files.test.jsx` (spec T13, extends `f5aFiles.test.jsx`) | Three-step upload with progress; Submit disabled while in flight; MultiFileWidget max reached; Remove calls DELETE only for unattached files; 413/415/422/503/`file_not_ready` messages; download via POST; FilesPanel groups by pass; tombstone rendering. | §6 |

## 10. Acceptance criteria

| ✓ | Criterion | How the design satisfies it |
|---|---|---|
| [ ] | **AC1: File field values reference uploaded file ids, not raw URLs.** | The schema is `format: uuid` (single) or an array of uuids (multiple) (§5). `verify_submission` rejects non-ids (`file_invalid_ref`). URLs are minted per request and never stored (S11). Existing typed references, http links and `data:` URLs are backfilled into `case_files` (`legacy_reference` or real files) and the values **rewritten to the new ids** (§4 data migration). |
| [ ] | **AC2: Files are tenant/workspace scoped.** | `workspace_id` on every row; `ws_isolation` RLS with a non-BYPASSRLS role (S3); `chk_cf_key` prefix `ws/{workspace_id}/` (S2); guard triggers tie each file to a case of the same workspace; signing and deleting only via a workspace-filtered row lookup. |
| [ ] | **AC3: Submit rejects files from the wrong record, stage or field, and also files from another workspace, already attached elsewhere, deleted, still uploading or unscanned.** | §5 verification table: `file_unknown`, `file_wrong_field`, `file_deleted`, `file_not_ready`, `file_rejected`. A file is bound to one case, stage and field at creation, so "attached elsewhere" is impossible by construction, and the attachment trigger re-checks this in the DB. |
| [ ] | **AC4: Downloads require the same visibility as the record.** | `POST …/download` calls `authorize("case.view")` with the policy compiled from the case's **pinned** release. Only after that is the access-log row written and a 60 s signed URL issued (S4, S6). Unattached files of others stay hidden. |
| [ ] | **AC5: Public buckets are forbidden.** | The startup guard refuses to boot on a public bucket, a CI script checks the deploy project, a static test bans public-URL APIs, and a migration asserts `storage.buckets` (S1). |
| [ ] | Single, multiple and required file fields | `max_files` = 1 vs > 1, `min_files`, `required`: schema `minLength`/`minItems` (§4, §5); `FileFieldWidget` and `MultiFileWidget` (§6). |
| [ ] | Max file size and allowed MIME types | Typed `max_size_mb`/`accept` checked against the platform ceiling at publish (R8), at create, on the PUT and at finalize (S8). The sniffed type must be in accept ∩ ceiling (S5). |
| [ ] | Signed download URL, private bucket only | S1, S6, §5 download. |
| [ ] | File linked to workspace, module, record, stage and field | `case_files.(workspace_id, module_key, case_id, stage_key, form, tier_index, field_key, pass_no)` + `case_file_attachments` (§4). |
| [ ] | Audit on upload, download and delete | `module.file.uploaded` and `module.file.deleted` through the outbox in the same transaction. Download writes an append-only `case_file_access_log` row before the URL is issued (§5 events). |
| [ ] | Two-phase upload verified server-side | create → signed PUT → finalize, which checks size, sha256, sniffed type and scan (§5, S5, S7). |
| [ ] | Orphan cleanup, versioning, migration/rename, virus hook | §8 jobs; `pass_no` attachments; `field_map` re-key under `app.release_migration`; fail-closed `Scanner` (S7). |

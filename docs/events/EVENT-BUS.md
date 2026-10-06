# Cross-module event bus plan

**Task 10** · 2026-10-06 · design only, no code changed. Owner of the **shared event contract** (§2–§3) used by the
notifications/SLA, file-field and release-migration designs.

Inspected (paths under `app/backend/` unless noted): `app/services/{workflow_unlocks, site_stage_status_service,
project_service, project_excellence_service, nso_service, finance_service, legal_service, design_service,
launch_service, financial_closure_service, change_request_service, business_admin_service, audit_service,
notification_service, module_runtime_service, release_migration_service}.py`, `app/services/module_runtime/runtime.py`,
`database/migrations/20261004_5_generic_module_runtime.sql` (+ every `CREATE TRIGGER` in `database/migrations/`: none
writes across modules — all are guards/seeders), `packages/store/sql/0002_store.sql`, `docs/{adapters,manifest,store,rbac}/README.md`,
`docs/runtime/HARDENING.md` (IDs `RT-…`), `docs/independence/AUDIT.md` (IDs `AS-…`), `templates/matrix-bd/*.template.json`.

Vocabulary: **owner** = the module whose state a row/column describes. **Subject** = the site (`subject {type:"site", id}`).
`sites` is the *subject* table: identity + BD's own lifecycle (`status`, rent terms) — but today it also stores every
module's status "mirror" (#134). A write by module A into a column describing module B is a cross-module write.

## 1. Current direct coupling points

All paths relative to `app/backend/app/services/`. "Sync" = same request transaction, in-process call.

| # | `path:line` — function | Writer → owner (state / table touched) | Kind | Replaced by |
|---|---|---|---|---|
| C1 | `workflow_unlocks.py:32` `maybe_unlock_design` (writes `:58`, `:64-68`) | Finance/Legal → **Design** (`sites.design_status='pending'`) and → **BD** (`sites.status=pushed_to_payments`, `pushed_to_payments_at`) | sync write | `module.outcome.reached` (legal `approved`, finance_ca `approved`) → Design entry gate reads facts (§7); BD status = `subject_pipeline` projection |
| C2 | `finance_service.py:354` in `svc_finance_approve` (`:305`) | Finance → Design/BD via C1 | sync call | same as C1 |
| C3 | `legal_service.py:826` in `svc_save_due_diligence` (`:713`) | Legal → Design/BD via C1 | sync call | same as C1 |
| C4 | `legal_service.py:1000` in `svc_save_licensing` (`:924`) | Legal → Design/BD via C1 | sync call | same as C1 |
| C5 | `legal_service.py:745-747, 758-761` `svc_save_due_diligence` | Legal → **BD** lifecycle (`sites.status` legal_review/legal_rejected, `legal_rejected_at`) | sync write | `module.stage.rejected` / `module.outcome.reached(legal, rejected)` → `subject_pipeline` projection |
| C6 | `legal_service.py:997-999` `svc_save_licensing` | Legal → **BD** (`sites.status=legal_approved`, `legal_approved_at`) | sync write | `module.outcome.reached(legal, done)` → projection |
| C7 | `change_request_service.py:250` `_maybe_recover_dd_verdict` (called `:409` from `svc_approve_change_request`) | Change request → **Legal** (`legal_dd_checklist.final_verdict`) + **BD** (`sites.status`, `legal_dd_status`) | sync write | BD emits `matrix_bd.bd.change_request_approved`; Legal's `syncExternalState` issues `reopen_case` command (adapters README §2; RT-D06) |
| C8 | `design_service.py:1665-1669` `svc_gfc_decision` (`:1619`) | Design → **Project Excellence** (`site_budgets` phase `gfc` via `budget_service.fetch_or_create_budget`) | sync write | `module.outcome.reached(design, approved)`; PE creates its own budget lazily on open (already does in `svc_allocate_pe:369`) |
| C9 | `design_service.py:1688-1700` `svc_gfc_decision` | Design → PE's audience (`notify_enqueue pe_budget_opened` to PE supervisors) | sync outbox | notification subscriber on `module.outcome.reached(design, approved)` (notifications design) |
| C10 | `project_excellence_service.py:575` `svc_admin_review_pe_budget` (`:546`) → `project_service.py:129` `seed_initialization_from_pe` | PE → **Project** (`project_reviews.initialization_date/status`, may INSERT the row) | sync write | PE adapter `afterApprove` emits `matrix_bd.pex.initialization_proposed`; Project `syncExternalState` → `submit_stage` command (template doc §PEx/§Project) |
| C11 | `project_service.py:1142` `svc_pe_complete_quality_audit` (writes `:1159-1168`) | PE supervisor → **Project** (`project_reviews.quality_audit_status`, `project_status=done`) | sync write | Project stage `quality_audit` with borrowed approver `approval.module: project_excellence` → `module.stage.approved` on Project's own case |
| C12 | `project_service.py:1302` `svc_push_qa_report` (writes `:1336-1345`) | PE/QA delegate → **Project** (`project_reviews` completion) + `sites.project_status` | sync write | PE `module.stage.approved(quality_audit_reports)` → Project reactor command |
| C13 | `project_service.py:1035` `svc_push_to_nso` → `nso_service.py:174` `svc_open_nso_at_stage_three` | Project → **NSO** (`nso_reviews` INSERT, `handover_pushed_at`, `stage_one/two_completed_at`, rollups) | sync write | `module.outcome.reached(project, done)` → NSO stage gate `launch_readiness` (`project` reached `done`) |
| C14 | `nso_service.py:757` `svc_final_approval` (`:729`) → `launch_service.py:430` `svc_create_launch_approval` | NSO → **Launch** (`launch_approvals` INSERT, seeded from `sites`/`site_details`) | sync, best-effort (try/except) | `module.record.completed(nso)` → launch `syncExternalState` → `open_case` command (template: auto-open) |
| C15 | `launch_service.py:897` `svc_admin_final_confirm` → `:824` `_commit_rent_to_canonical` | Launch → **BD/subject** (`sites` rent columns ×9, `site_details` rent terms) | sync write | `matrix_bd.launch.rent_terms_committed` → subject service applies `SubjectUpdate` → `subject.updated` |
| C16 | `launch_service.py:943-944` `svc_launch` (`:923`) | Launch → **subject** (`sites.is_launched`, `launched_at`) | sync write | `module.outcome.reached(launch_approval, done)`; FC gate reads facts |
| C17 | `module_runtime_service.py:417` `svc_open_record` | Runtime → **subject** (`sites.config_release_id` pin) | sync write | pin moves to the case (RT-D02); `module.record.opened.release` |
| C18 | `release_migration_service.py:346, 523` | Migration → **subject** (`sites.config_release_id`) | sync write | `module.record.migrated` per case (RT-F15) |
| C19 | `finance_service.py:138-353` (`kyc_verified`, `ca_code`, `finance_amount`, `finance_status`) | Finance → own state stored **in `sites`** | sync write (mirror) | Finance case fields; NSO reads via facts/case-read API |
| C20 | `legal_service.py:611, 644, 758, 789, 905, 910, 995, 1029` | Legal → own mirrors in `sites` (`legal_dd_status`, `agreement_status`, `licensing_status`) | sync write (mirror) | Legal case + facts |
| C21 | `design_service.py:505, 633, 659-660, 681, 725, 937, 1029, 1242, 1549, 1665, 1708` | Design → own mirror `sites.design_status` | sync write (mirror) | Design case + facts |
| C22 | `project_service.py:606, 672, 686-687, 959-960, 1167-1168, 1344-1345` | Project (and PE via C11/C12) → `sites.project_status/project_completed_at` | sync write (mirror) | Project case + facts |
| C23 | `project_excellence_service.py:371, 461, 572` | PE → `sites.project_excellence_status` | sync write (mirror) | PE case + facts |
| C24 | `financial_closure_service.py:316, 501, 567, 675` | FC → `sites.financial_closure_status` | sync write (mirror) | FC case + facts |
| C25 | `financial_closure_service.py:295-315` `svc_send_for_financial_closure` | FC **reads PE** `site_budgets` gfc (status + items) and seeds its closure items | sync read | `module.stage.approved(project_excellence, gfc_budget, stage_completed)` payload values → FC prefill (adapter / `field.prefill_from`) |
| C26 | `business_admin_service.py:1020, 1035` `approve_finance`/`reject_finance` (approval center) | Admin center → Finance service in-process | sync call | `Guard.check` + Finance's own command endpoint (owner write; no event needed); approval-center lists = projection |
| C27 | `business_admin_service.py:698` `_fetch_optional_admin_sources` (`list_admin_sites` `:835`) | Admin timeline **reads** Project/NSO/Launch/Budget tables | sync read | `subject_pipeline` projection |
| C28 | `site_stage_status_service.py:323` `build_stage_status_response` (join `:351-375`) | BD status page **reads** 6 module tables + `sites` mirrors | sync read | `subject_pipeline` projection |
| G1 | `design_service.py:230` `_assert_design_unlocked` (used `:341, 452, 923, 983`) | Design gate **reads** `sites.legal_dd_status`, `sites.finance_status` | sync read | facts: `legal ⊇ approved ∧ finance_ca ⊇ approved` |
| G2 | `project_excellence_service.py:56` `_assert_pe_unlocked` | PE gate reads `sites.design_status` | sync read | facts: `design ⊇ approved` |
| G3 | `project_service.py:67` `_assert_project_unlocked` | Project gate reads `sites.design_status` | sync read | facts: `design ⊇ approved` |
| G4 | `nso_service.py:206` `_trigger_one_unlocked` (+ `svc_nso_queue :475` filter) | NSO gate reads `sites.finance_status`, `ca_code` | sync read | facts: `finance_ca ⊇ approved` |
| G5 | `nso_service.py:218, 258, 318` `_project_done`, `_stage_three_unlocked`, `_sync_rollups` | NSO reads `project_reviews`, `site_licensing`, `sites.licensing_status` | sync read | stage gate `project ⊇ done`; licensing via facts `{source: legal, stage: licensing}` |
| G6 | `financial_closure_service.py:57` `_assert_launched` | FC gate reads `sites.is_launched` | sync read | facts: `launch_approval ⊇ done` |
| G7 | `module_runtime_service.py:231` `build_facts` → view `site_module_outcomes` (`mig_5:372-418`, `builtin_raw` over 7 `sites` columns + `nso_reviews` + `launch_approvals`) | Generic gates read hard-coded columns (RT-F02) | sync read | `record_facts` table (§4, §7) |
| A1 | `audit_service.py:17` `write_audit_event` (co-writes `stage_events` `:66-68`) — called by every service above | Each module writes the shared audit/SLA ledger directly, no event id, no release | sync write | audit projector over events (§8) |

**Totals: 37 coupling points** — 18 direct cross-module writes/calls (C1–C18), 6 own-state mirrors in the subject
table (C19–C24), 4 cross-module reads for lists/read models (C25–C28), 7 gate reads (G1–G7), 1 audit side-channel (A1).

## 2. Events needed

Canonical, platform-owned types (the runtime and store emit them; no module code names another module's type).

| Type | Emitted by (target) | Emitted by (today's code, shadow phase) | Main consumers |
|---|---|---|---|
| `module.record.opened` | runtime `svc_open_record` (`case_created` + `gate_opened`) | first write creating a module row (e.g. `nso_service._fetch_nso_or_create :151`) | facts, audit, notifications, SLA |
| `module.stage.submitted` | runtime `submitted` | `svc_finance_request_approval`, `svc_request_gfc_approval`, `svc_save_pe_budget`, … | audit, SLA, notifications |
| `module.stage.approved` | runtime `approved`/`auto_approved` (+ `stage_completed`) | `svc_finance_approve`, `svc_gfc_decision`, `svc_admin_review_pe_budget`, `svc_push_to_nso`, … | facts (stage/fields), audit, SLA |
| `module.stage.rejected` | runtime `rejected` / `rejected_forward` | `svc_finance_reject`, `svc_save_due_diligence` (negative), GFC reject | facts (exit `on_reject`, fixes RT-B03), audit |
| `module.stage.sent_back` | runtime `sent_back` | design undo / bounce-to-3D in `svc_gfc_decision` | audit, SLA, notifications |
| `module.record.completed` | runtime `module_completed` / closing reject | `svc_final_approval` (NSO), `svc_launch`, `svc_admin_finalize_fc` | auto-open reactors (C14), audit |
| `module.outcome.reached` | runtime whenever `reached` grows | every C1–C16 site | **facts (gates)**, subject projection, notifications |
| `module.assignment.changed` | runtime `svc_assign` | `svc_allocate_{design,pe,project,fc}`, revoke functions | audit, notifications, SLA owner |
| `module.file.uploaded` | runtime `svc_upload_file` | `svc_submit_deliverable`, QA report upload | audit, file GC (file-field design) |
| `release.published` | store `store_publish` | `tenant_config_releases` insert | gate re-evaluation, adapters cache, audit |
| `release.migration.completed` | store migration `running → done/failed` | `release_migration_service` finish | audit, notifications |

**Additions** (defined here, payloads in §3.3; their owners refine them additively):
`module.record.migrated` (per case), `module.record.reopened` (RT-D06, CR loop C7), `module.sla.warning`,
`module.sla.breached` (SLA design), `module.file.deleted` (file design), `signal.recorded` (manifest `signals[]`, M7),
`subject.updated` (applied `SubjectUpdate`, C15). Adapter events stay **namespaced** (`<adapter namespace>.<name>`,
adapters README §2), e.g. `matrix_bd.pex.initialization_proposed` (C10), `matrix_bd.launch.rent_terms_committed`
(C15), `matrix_bd.bd.change_request_approved` (C7), `matrix_bd.bd.loi_deadline_set` (existing example).

Runtime → bus mapping (`runtime.py` `_emit` kinds): `case_created`+`gate_opened` → `record.opened`; `submitted` →
`stage.submitted`; `approved`, `auto_approved` → `stage.approved` (`auto:true`); `rejected`, `rejected_forward` →
`stage.rejected`; `sent_back` → `stage.sent_back`; `stage_completed` → flag on the approving event +
`outcome.reached`; `module_completed` → `record.completed` (+ `outcome.reached` for the exit).

## 3. Event payload schema

### 3.1 Envelope (`schema_version` 1) — JSON Schema (draft 2020-12)

```json
{ "$id": "workspace-event/1", "type": "object", "additionalProperties": false,
  "required": ["id","type","schema_version","workspace_id","module_key","record_id","subject","actor","release",
               "occurred_at","recorded_at","correlation_id","causation_id","idempotency_key","payload"],
  "properties": {
    "id":             {"type": "string", "format": "uuid"},
    "type":           {"type": "string", "pattern": "^(module|release|signal|subject)\\.[a-z_.]+$|^[a-z][a-z0-9_]*\\.[a-z0-9_.]+$"},
    "schema_version": {"type": "integer", "minimum": 1},
    "workspace_id":   {"type": "string", "format": "uuid"},
    "module_key":     {"type": ["string","null"], "pattern": "^[a-z][a-z0-9_]{0,38}$"},
    "record_id":      {"type": ["string","null"], "format": "uuid", "description": "case id"},
    "subject":        {"oneOf": [{"type": "null"}, {"type": "object", "additionalProperties": false,
                        "required": ["type","id"], "properties": {"type": {"type": "string"}, "id": {"type": "string"}}}]},
    "stage_key":      {"type": ["string","null"]},
    "actor": {"type": "object", "additionalProperties": false, "required": ["id","kind"],
      "properties": {"id": {"type": ["string","null"], "description": "user id; adapter key@version; timer/job name"},
                     "kind": {"enum": ["user","system","adapter","timer"]},
                     "on_behalf_of": {"type": ["string","null"], "format": "uuid"},
                     "as_override":  {"type": "boolean", "default": false}}},
    "release": {"type": "object", "additionalProperties": false, "required": ["id","version"],
      "properties": {"id": {"type": "string", "format": "uuid"}, "version": {"type": "integer", "minimum": 1}}},
    "occurred_at":     {"type": "string", "format": "date-time"},
    "recorded_at":     {"type": "string", "format": "date-time"},
    "correlation_id":  {"type": "string", "format": "uuid"},
    "causation_id":    {"type": ["string","null"], "format": "uuid"},
    "idempotency_key": {"type": "string", "minLength": 8, "maxLength": 200},
    "payload":         {"type": "object"} },
  "allOf": [{"if": {"properties": {"type": {"pattern": "^module\\."}}},
             "then": {"properties": {"module_key": {"type": "string"}, "record_id": {"type": "string"},
                                     "subject": {"type": "object"}}}},
            {"if": {"properties": {"type": {"pattern": "^release\\."}}},
             "then": {"properties": {"module_key": {"type": "null"}, "record_id": {"type": "null"}}}}] }
```

Rules: `release` is the record's **pinned** release (`cases.release_id`), never the live one; for `release.*` it is
the release published / migrated *to*. `subject` for Matrix-bd = `{type:"site", id:<sites.id>}`. Workspace-scope
events (`release.*`) carry `module_key/record_id = null` by design; their per-case effects are `module.record.migrated`
events which carry every field. `occurred_at` = when the state changed (txn time); `recorded_at` = insert time.
Max serialized size 64 KiB; files by reference (`file_id`), never bytes or signed URLs.

### 3.2 Payloads of the 11 required events (all objects `additionalProperties: false` unless noted)

| Type | Required payload fields (type) | Optional |
|---|---|---|
| `module.record.opened` | `opened_via` (`user`\|`command`\|`auto_open`), `initial_stage_key` (str), `record_seq` (int), `entry_gate` {`match`, `conditions[]` {…condition, `met` bool}, `fact_event_ids` (uuid[]) — the facts rows' `last_event_id` used} | `assignee_id` (uuid), `reopened_from` (uuid) |
| `module.stage.submitted` | `stage_key`, `step_index` (int), `role` (str), `record_seq`, `values` (object: this stage's own fields; files as `{file_id}`), `stage_completed` (bool) | `stage_outcome` (when completed), `attempt` (int) |
| `module.stage.approved` | `stage_key`, `step_index`, `role`, `record_seq`, `auto` (bool, self-collapse), `stage_completed` (bool) | `approval_values` (approver fields), `comment`, `stage_outcome`, `stage_values` (completed stage snapshot — what field gates read), `next_stage_key` |
| `module.stage.rejected` | `stage_key`, `step_index`, `role`, `record_seq`, `reason` (str), `record_closed` (bool) | `exit_outcome` (= `exit.on_reject` when closed), `forward_only` (bool) |
| `module.stage.sent_back` | `from` {`stage_key`, `step_index`}, `to` {`stage_key`, `step_index`}, `record_seq`, `reason` | — |
| `module.record.completed` | `result` (`completed`\|`rejected`\|`parked`), `exit_outcome` (str\|null), `reached` (str[] cumulative), `record_seq`, `closed_at` | `verdict` (roll-up result) |
| `module.outcome.reached` | `outcome` (str, manifest `outcomes[].key`), `outcome_kind` (`open`\|`progress`\|`positive`\|`negative`\|`neutral`), `cause` (`stage`\|`exit`\|`rollup`), `reached` (str[] after), `record_seq` | `stage_key` (when `cause=stage`) |
| `module.assignment.changed` | `scope` (`record`\|`stage`), `assignee_before` (uuid\|null), `assignee_after` (uuid\|null), `revoked` (uuid[]), `record_seq` | `stage_key`, `note` |
| `module.file.uploaded` | `file_id` (uuid), `stage_key`, `field_key`, `name`, `size_bytes` (int), `mime`, `sha256` | `replaces_file_id` |
| `release.published` | `manifest_sha256`, `previous` {`id`,`version`}\|null, `reason`, `modules` [{`module_key`, `change`: `added`\|`changed`\|`removed`\|`enabled`\|`disabled`}], `activity_seq` (int) | `rollback_of_version` |
| `release.migration.completed` | `migration_id`, `plan_sha256`, `from` {`id`,`version`}, `to` {`id`,`version`}, `status` (`done`\|`failed`), `counts` {`migrated`,`skipped`,`failed`}, `activity_seq` | `error` |

### 3.3 Additions (minimum payloads; owners may add optional fields without a version bump)

| Type | Required payload |
|---|---|
| `module.record.migrated` | `migration_id`, `plan_sha256`, `from_release` {id,version}, `stage_map` {old_key: new_key}, `record_seq` (envelope `release` = new pin) |
| `module.record.reopened` | `reason`, `cause_event_id`, `to_stage_key`, `record_seq` |
| `module.sla.warning` / `module.sla.breached` | `stage_key`, `sla_id`, `due_at`, `elapsed_s` (actor.kind = `timer`) |
| `module.file.deleted` | `file_id`, `stage_key`, `field_key`, `reason` (`replaced`\|`gc`\|`user`) |
| `signal.recorded` | `signal_key`, `outcome` (∈ `signals[].outcomes`), `external_ref`, `source` (module_key = signal key, record_id = null allowed, subject required) |
| `subject.updated` | `fields` {key: {before, after}}, `cause_event_id` (actor.kind = `adapter`/`system`) |

Versioning: additive optional fields keep `schema_version`; renames/removals/semantic changes bump it, and the
publisher dual-emits both versions until every subscriber declares the new one (§6 S11).

## 4. Tables needed

New migration `packages/store/sql/0004_events.sql` (after `0003_runtime.sql`, which adds `cases`/`case_events`
per HARDENING §4). Same conventions as `0002_store.sql`: `workspace_id` on every row, `FORCE ROW LEVEL SECURITY`
with policy `ws_isolation` on `current_setting('app.workspace_id')`, workers use the same per-batch `SET LOCAL`.

```sql
-- 1. Event log = transactional outbox (append-only; one row per event).
CREATE TABLE workspace_events (
  position        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- global order
  tx_id           xid8        NOT NULL DEFAULT pg_current_xact_id(),  -- visibility watermark (S2)
  id              uuid        NOT NULL UNIQUE,
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id),     -- no cascade from subjects (RT-F11)
  type            text        NOT NULL,
  schema_version  integer     NOT NULL CHECK (schema_version >= 1),
  module_key      text,
  record_id       uuid,                                               -- cases.id
  record_seq      integer,                                            -- = cases.seq after the change
  subject_type    text,
  subject_id      text,
  stage_key       text,
  actor_id        text,
  actor_kind      text        NOT NULL CHECK (actor_kind IN ('user','system','adapter','timer')),
  on_behalf_of    uuid,
  as_override     boolean     NOT NULL DEFAULT false,
  release_id      uuid        NOT NULL,
  release_version integer     NOT NULL,
  occurred_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id  uuid        NOT NULL,
  causation_id    uuid        REFERENCES workspace_events(id),
  idempotency_key text        NOT NULL,
  payload         jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536),
  case_event_hash text,                                               -- link to case_events.hash (§8)
  CONSTRAINT fk_we_release FOREIGN KEY (workspace_id, release_id) REFERENCES workspace_releases (workspace_id, id),
  CONSTRAINT uq_we_idem    UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT uq_we_rec_seq UNIQUE (record_id, record_seq, type),
  CONSTRAINT chk_we_module CHECK (type NOT LIKE 'module.%'
                                  OR (module_key IS NOT NULL AND record_id IS NOT NULL AND record_seq IS NOT NULL
                                      AND subject_type IS NOT NULL AND subject_id IS NOT NULL)),
  CONSTRAINT chk_we_ws_scope CHECK (type NOT LIKE 'release.%' OR (module_key IS NULL AND record_id IS NULL))
);
CREATE INDEX idx_we_ws_pos      ON workspace_events (workspace_id, tx_id, position);
CREATE INDEX idx_we_record      ON workspace_events (record_id, record_seq) WHERE record_id IS NOT NULL;
CREATE INDEX idx_we_subject     ON workspace_events (workspace_id, subject_type, subject_id, position);
CREATE INDEX idx_we_type        ON workspace_events (workspace_id, type, position);
CREATE INDEX idx_we_correlation ON workspace_events (correlation_id);
-- triggers: trg_we_append_only (store_forbid_change), trg_we_release_pin (§5 P5), trg_we_project_facts (§7)

-- 2. Subscribers and their per-workspace cursors.
CREATE TABLE event_subscriptions (
  workspace_id    uuid    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscriber_key  text    NOT NULL,              -- e.g. 'facts', 'audit', 'notifications', 'adapter:matrix_bd.launch'
  handler_version text    NOT NULL,
  types           text[]  NOT NULL,              -- filter; '*' allowed for audit
  cursor_tx_id    xid8    NOT NULL DEFAULT '0',
  cursor_position bigint  NOT NULL DEFAULT 0,
  status          text    NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','rebuilding')),
  lease_owner     text,
  lease_until     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, subscriber_key)
);

-- 3. Inbox = dedupe + retry state; written in the SAME txn as the handler's effect.
CREATE TABLE event_inbox (
  workspace_id    uuid   NOT NULL,
  subscriber_key  text   NOT NULL,
  event_id        uuid   NOT NULL REFERENCES workspace_events(id),
  record_id       uuid,                          -- per-record ordering (S4)
  status          text   NOT NULL CHECK (status IN ('done','retrying','waiting','dead')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error      text,
  processed_at    timestamptz,
  PRIMARY KEY (subscriber_key, event_id),
  FOREIGN KEY (workspace_id, subscriber_key) REFERENCES event_subscriptions (workspace_id, subscriber_key)
);
CREATE INDEX idx_ei_due     ON event_inbox (next_attempt_at) WHERE status = 'retrying';
CREATE INDEX idx_ei_blocked ON event_inbox (subscriber_key, record_id) WHERE status IN ('retrying','waiting','dead');

-- 4. Dead letters (operator view; resolution is audited).
CREATE TABLE event_dead_letters (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL,
  subscriber_key  text NOT NULL,
  event_id        uuid NOT NULL REFERENCES workspace_events(id),
  attempts        integer NOT NULL,
  error_class     text NOT NULL,                 -- 'retry_exhausted' | 'non_retryable' | 'unsupported_schema' | 'adapter_rejected'
  last_error      text NOT NULL,
  first_failed_at timestamptz NOT NULL,
  dead_at         timestamptz NOT NULL DEFAULT now(),
  resolution      text CHECK (resolution IN ('requeued','discarded')),
  resolved_by     uuid, resolved_at timestamptz, resolution_note text,
  UNIQUE (subscriber_key, event_id)
);
CREATE INDEX idx_edl_open ON event_dead_letters (workspace_id, dead_at DESC) WHERE resolution IS NULL;

-- 5. Facts = the ONLY thing gates read (one row per subject × source module/signal).
CREATE TABLE record_facts (
  workspace_id     uuid    NOT NULL,
  subject_type     text    NOT NULL,
  subject_id       text    NOT NULL,
  source_key       text    NOT NULL,             -- module key or signal key
  record_id        uuid,                          -- latest case of that module on the subject
  release_id       uuid,  release_version integer,
  reached          text[]  NOT NULL DEFAULT '{}', -- cumulative, append-only (RT-B04)
  completed_stages text[]  NOT NULL DEFAULT '{}', -- stage KEYS (RT-D01), append-only
  fields           jsonb   NOT NULL DEFAULT '{}', -- {stage_key: {field_key: value}} from COMPLETED stages (RT-B08)
  closed           boolean NOT NULL DEFAULT false,
  last_event_id    uuid    NOT NULL,
  last_position    bigint  NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, subject_type, subject_id, source_key)
);
CREATE INDEX idx_rf_reached ON record_facts USING gin (reached);
```

Plus `ALTER TABLE workspace_activity ADD event_id uuid, ADD release_id uuid` (appended to the hash input after
`detail`; `concat_ws` skips NULLs so existing hashes stay valid) and `ALTER TABLE audit_logs ADD event_id uuid UNIQUE,
ADD release_version integer` (legacy table; `config_release_id`, `module_key`, `provenance` already exist per
`write_provenance_audit`). RLS: all five new tables get `ENABLE` + `FORCE ROW LEVEL SECURITY` + `ws_isolation`.

**Relation to existing logs.** `case_events` (HARDENING RT-F11) is the per-case hash chain and the runtime's source of
truth; `workspace_activity` is the workspace/config hash chain. `workspace_events` is the *distribution* log: every
`module.*` event is inserted in the same transaction as its `case_events` row and stores `case_event_hash`; every
`release.*` event is inserted by the store function that writes the matching `workspace_activity` row (`activity_seq`
in payload, `event_id` on the activity row). Neither chain is duplicated; the bus adds ids, routing and cursors.

## 5. Publisher rules

| # | Rule | Enforcement |
|---|---|---|
| P1 | **Only the owner emits.** `module.*` events are emitted by the runtime for the case whose state changed; `release.*` by store functions; adapter events only as `Event` effects returned to the host (namespace-checked); `signal.recorded` via the signals endpoint. No service emits an event whose `module_key` is another module. | single API `events.append(tx, event)` in the runtime package; `module_key` taken from the locked case row, not a parameter; lint rule forbids `events.append` outside runtime/store/host |
| P2 | **Transactional outbox.** The `workspace_events` INSERT happens in the same transaction as the state change (and its `case_events` / `workspace_activity` row). No network I/O, no handler call inside that transaction. Rollback ⇒ no event; commit ⇒ event durable. | `append()` requires an open txn holding `FOR UPDATE` on the case (as `svc_act` already does, `module_runtime_service.py:458-462`) |
| P3 | **Ordering per record.** `record_seq` = the case's `seq` after the change (incremented under the row lock); `UNIQUE (record_id, record_seq, type)`; events derived from one runtime event (e.g. `record.completed` + `outcome.reached` from `module_completed`) share its seq and are ordered by `position`. Cross-record order is only "commit order" — no subscriber may rely on it. | DB unique; subscribers order by `(record_id, record_seq, position)` |
| P4 | **Idempotency.** Key = `"{record_id}:{record_seq}:{type}"` for runtime events; `"{Idempotency-Key header}:{type}"` for retried HTTP commands (RT-F14); `effect_key(ctx.event_id, suffix)` for adapter effects; `"release:{id}:published"`, `"migration:{id}:{status}"` for store. Duplicate ⇒ `ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`, caller gets the original event id. | `uq_we_idem` |
| P5 | **Release pinning.** `release` = `cases.release_id` (+ its version) of the record, never the live release; a migrated case's events after `module.record.migrated` carry the new pin. Adapters cannot set it (host `release_override`). | `trg_we_release_pin` BEFORE INSERT: for `module.*`, `NEW.release_id = (SELECT release_id FROM cases WHERE id = NEW.record_id)` else raise `release_mismatch` |
| P6 | **Complete envelope.** workspace, module, record, subject, actor, release, `occurred_at` always present for `module.*` (§3.1). | `chk_we_module`, NOT NULLs, JSON Schema in `append()` |
| P7 | **Facts, not commands.** Payload states what happened in the owner's terms; never "please open X". Requests to another module are `Command`s to *that* module's runtime by its own subscriber/adapter. | review + adapters host `cross_module_write` |
| P8 | **Actor truth.** `actor.kind=user` for people; `adapter` with `on_behalf_of` = the person who caused the trigger (adapters README §2); `timer` for SLA; `as_override` copied from `authorize()`'s `Decision` (rbac README §3). | runtime builds actor from the `Decision`, not from request input |
| P9 | **Causality.** `correlation_id` = request id (or the root event's id); `causation_id` = the event a reactor/adapter handled. | `append()` signature |
| P10 | **Minimal data.** Own stage fields only, files by `file_id`, no signed URLs, ≤ 64 KiB. | CHECK + schema |

## 6. Subscriber rules

| # | Rule |
|---|---|
| S1 | **Declared subscribers.** Each subscriber is code-declared: `key`, `handler_version`, `types`, `mode` (`projector` = rebuildable read model; `reactor` = side effects / commands; `adapter` = `syncExternalState`; `external` = webhooks/notifications). Registered per workspace in `event_subscriptions`. |
| S2 | **At-least-once delivery.** A worker leases a subscription row (`FOR UPDATE SKIP LOCKED`, `lease_until`), reads `workspace_events` with `(tx_id, position) > cursor AND tx_id < pg_snapshot_xmin(pg_current_snapshot())` (never skips a late-committing txn), processes, then advances the cursor. A crash before cursor advance re-delivers. |
| S3 | **Idempotent handlers.** Each event is handled in one txn that INSERTs `event_inbox (subscriber_key, event_id)` first (`ON CONFLICT DO NOTHING` ⇒ already done ⇒ skip) and then applies the effect. Effects themselves are keyed by `event.id` (commands get `idempotency_key = effect_key(event.id, …)`). |
| S4 | **Per-record ordering.** If the inbox holds a `retrying`/`dead` row for `(subscriber, record_id)`, later events for that record are stored `waiting` and replayed in `record_seq` order once it clears; other records continue. |
| S5 | **Retries/backoff.** Retryable errors: `next_attempt_at = now() + min(2^attempts s, 15 min) ± 20 % jitter`; max 10 attempts. Non-retryable (validation, `unsupported_schema`, adapter `Effects` rejected by host) go straight to dead letter. |
| S6 | **Dead letter.** Exhausted/non-retryable ⇒ `event_dead_letters` + inbox `dead` + alert. Operators `requeue` or `discard` with a note via API (grant `manage_events`); each resolution writes `workspace_activity` (`event_dead_letter_resolved`, with `event_id`). The original user action is never rolled back (adapters README: "the human action stands"). |
| S7 | **Replay / rebuild.** Projectors (`facts`, `audit`, `subject_pipeline`, `approval_center`, `stage_status`) are pure functions of the log: `status='rebuilding'` → delete own rows for the workspace → cursor 0 → replay → `active`. Reactors are **never** rebuilt by replay; re-running from a position relies on the inbox + effect keys so no command repeats. A nightly verify job rebuilds `record_facts` into a shadow table and diffs it. |
| S8 | **No synchronous cross-module writes.** A handler may only (a) write its own projection, (b) issue a `Command` to **its own module** through the runtime (`open_case`, `submit_stage`, `record_signal`, `reopen_case`), which re-authorizes the `on_behalf_of` person and emits that module's own events, or (c) call an external system. It never writes another module's case, stage values or tables, and never runs inside the publisher's transaction. |
| S9 | **Adapters as subscribers.** For every module whose pinned manifest declares `syncExternalState`, the host registers subscriber `adapter:<key>`; `types` = descriptor `consumes`. On delivery the host finds the module's case on the same subject (or none), loads the adapter **version pinned by that case's release**, calls `syncExternalState(SyncContext{event})` and appends returned `Event`/`Command`/`SubjectUpdate` effects with `causation_id = event.id`. Host refusals ⇒ dead letter `adapter_rejected`. |
| S10 | **Reads.** Handlers read only the event, their own state, `record_facts`, and the runtime's read-only case API for the same subject — never another module's tables. |
| S11 | **Schema versions.** Handlers declare accepted `schema_version`s per type; anything else ⇒ dead letter `unsupported_schema` (never silently ignored). |
| S12 | **Isolation.** Workers set `app.workspace_id` per batch (`SET LOCAL`) so RLS applies; the platform BYPASSRLS role is only for the lease scan. |

## 7. How gates consume events

1. **Facts projection, same transaction.** `trg_we_project_facts` (AFTER INSERT on `workspace_events`) calls
   `events_apply_fact(NEW)`, a deterministic platform function that only touches `record_facts`. Gates therefore
   see a fact as soon as the owner's transaction commits (no lag), yet the projection stays derived and
   rebuildable (S7). It is not a module write: `record_facts` belongs to the bus, no module owns or writes it.

| Event | Effect on `record_facts(subject, source_key = module_key)` |
|---|---|
| `module.record.opened` | upsert row; `record_id`, `release_*`; `closed=false` |
| `module.outcome.reached` | `reached := reached ∪ {outcome}` (never removes — RT-B04, RT-D05) |
| `module.stage.submitted` / `.approved` with `stage_completed` | `completed_stages ∪= stage_key`; `fields[stage_key] := stage_values` |
| `module.stage.rejected` with `record_closed` | `closed=true`; exit `on_reject` arrives as `outcome.reached` (**fixes RT-B03**) |
| `module.stage.sent_back` | no change to `reached`/`completed_stages` (gates open doors, never close them) |
| `module.record.completed` | `closed=true` |
| `module.record.migrated` | `release_*`; rename keys in `completed_stages`/`fields` per `stage_map` |
| `signal.recorded` | row with `source_key = signal_key`; `reached ∪= {outcome}` |

2. **Evaluation.** `build_facts(subject)` (replacing `module_runtime_service.py:231`) =
   `SELECT source_key, reached, completed_stages, fields FROM record_facts WHERE subject = $1` → the F3 facts shape
   (`reached`, `stages`, `fields`) that `gates.check_gate` already consumes. `site_module_outcomes` and its
   `builtin_raw` column list (RT-F02) are retired. Entry gates are checked on open, stage gates on submit (and in
   `next_step`, RT-B12). The `module.record.opened` payload records the conditions and the `last_event_id` of each
   facts row used, so audit can prove which events opened the door.
3. **Re-evaluation / auto-open.** Reactor `gate_watcher` consumes `module.outcome.reached` and `signal.recorded`;
   for each module whose pinned entry gate references the source and now passes, it (a) emits a notification
   ("Design is open"), or (b) when the module declares auto-open (today: launch after NSO, C14) issues `open_case`
   **as that module's own command**.
4. **Matrix-bd unlocks re-expressed** (gates from `templates/matrix-bd/*.template.json`):

| Today (hard-coded) | Gate on facts |
|---|---|
| G1 `_assert_design_unlocked` / C1 `maybe_unlock_design` | design `entry_gate`: `legal ⊇ approved` ∧ `finance_ca ⊇ approved` |
| G2/G3 PE, Project unlock on `sites.design_status` | `design ⊇ approved` |
| G4 `_trigger_one_unlocked` (finance + `ca_code`) | NSO `entry_gate`: `finance_ca ⊇ approved` (ca_code is a required finance field) |
| G5 + C13 `handover_pushed_at`, `_project_done` | NSO stage `launch_readiness` gate: `project ⊇ done` (Project's last stage `push_to_nso` reaches `done`). Today's code also requires Legal licensing complete (`nso_service.py:270`) — template gap: add `{source: legal, stage: licensing}` |
| G6 `_assert_launched` | FC `entry_gate`: `launch_approval ⊇ done` |

## 8. How audit consumes events

| Layer | Written by | Contains event id? | Release id? |
|---|---|---|---|
| `case_events` (RT-F11) | runtime, same txn, hash by trigger | yes (`event_id` column) | yes (pinned) |
| `workspace_activity` | store functions, same txn, `store_activity_chain` | yes (new column) | yes (new column; `release_version` exists) |
| `workspace_events` | publisher, same txn | is the id | yes (NOT NULL, FK) |
| `audit_logs` (+ `stage_events`) | **`audit` projector subscriber** (types `*`) | yes (`event_id UNIQUE` = dedupe) | yes (`config_release_id`, `release_version`) |

* The `audit` projector maps each event to one `audit_logs` row: `action = type`, `entity_id = record_id`,
  `module_key`, `config_release_id`, `actor_id` / `actor_name`, `provenance = {event_id, correlation_id, causation_id,
  as_override, on_behalf_of, record_seq, case_event_hash}`. `stage_events` (SLA ledger, `audit_service.py:66`) is fed
  from `module.stage.*` by the SLA design's projector. `write_audit_event` direct calls (A1) are removed per §9.
* **Integrity.** Truth is in the two hash chains; `audit_logs` is a view-model. The record audit endpoint
  (`svc_get_record`) verifies `case_events` with the head anchored to `cases.seq/last_hash` (RT-B09) and checks
  that `workspace_events` for the record has `record_seq` 1…`cases.seq` with matching `case_event_hash`.
  Tail anchoring for the bus: an hourly job appends `workspace_activity` action `events_anchored`
  `{through_position, count, sha256(ids)}` (new `chk_wa_action` value), so a deleted/truncated tail is detectable.
* **Retention.** Events have no FK to `sites`; `business_admin_service.delete_site` (`:943`) becomes an owner action
  emitting `subject.updated {deleted:true}` instead of cascading audit away (RT-F11).

## 9. Migration path from current code

Strangler, one coupling at a time; each phase is flag-guarded per workspace and reversible by flag.

| Phase | What changes (exact functions) | Exit criterion |
|---|---|---|
| **0 Infra** | `0004_events.sql`; `events.append()`; worker + `facts`/`audit` projectors; envelope JSON Schema; `ALTER workspace_activity/audit_logs`. No behaviour change. | DB + unit tests green (§10) |
| **1 Shadow — generic runtime** | `module_runtime_service._write_events` (`:294`) also appends bus events per the §2 mapping; `svc_assign` (`:513`) → `module.assignment.changed`; `svc_upload_file` (`:848`) → `module.file.uploaded`; `release_migration_service` finish → `module.record.migrated` / `release.migration.completed`; store `store_publish` → `release.published`. Comparator job: `record_facts` vs `site_module_outcomes` (`source='module_record'` rows). | zero diff 14 days; replay rebuild equals live projection |
| **2 Shadow — built-ins** | Add `legacy_emit(session, site, module_key, type, …)` next to the existing `write_audit_event` in: `finance_service.svc_finance_request_approval/approve/reject`; `legal_service.svc_save_due_diligence/svc_save_licensing`; `design_service.svc_allocate_design/_advance_stage_after_approval/svc_request_gfc_approval/svc_gfc_decision`; `project_excellence_service.svc_allocate_pe/svc_review_pe_budget/svc_admin_review_pe_budget`; `project_service.svc_allocate_project/svc_submit_milestone/svc_admin_confirm_quality_audit/svc_pe_complete_quality_audit/svc_push_qa_report/svc_push_to_nso`; `nso_service.svc_save_stage_one/svc_final_approval`; `launch_service.svc_admin_final_confirm/svc_launch`; `financial_closure_service.svc_send_for_financial_closure/svc_admin_finalize_fc`; `change_request_service._maybe_recover_dd_verdict`. Built-ins have no `cases` row: record id = `uuid5(site_id, module_key)` in a `legacy_records` map with its own `seq`; release = `sites.config_release_id` or live. Comparator: `record_facts` vs `site_module_outcomes.builtin_raw`. | zero unexplained diff 14 days per module |
| **3 Cut gate reads** | `build_facts` → `record_facts` (G7). Replace G1–G6 bodies with `gate_service.require(subject, module_key[, stage_key])`; old column check kept as logged comparator for one release, then deleted. | no comparator divergence; `site_module_outcomes` unused |
| **4 Cut writes** (lowest risk first) | **4a** C14: delete `svc_create_launch_approval` call in `nso_service.svc_final_approval`; Launch reactor on `module.record.completed(nso)` calls it (already idempotent + isolated). **4b** C13: `svc_push_to_nso` stops calling `svc_open_nso_at_stage_three`; NSO reactor on `module.outcome.reached(project, done)` runs it (idempotent on `handover_pushed_at`). **4c** C8/C9: drop budget creation + PE notify in `svc_gfc_decision`; PE reactor / notifications. **4d** C10: `svc_admin_review_pe_budget` emits `matrix_bd.pex.initialization_proposed`; Project reactor calls `seed_initialization_from_pe` on its own table. **4e** C11/C12: PE QA completion becomes a PE event; Project reactor completes its own review. **4f** C1–C6: delete `maybe_unlock_design` and the `sites.status` writes in `legal_service`; `subject_pipeline` reactor (owned by BD/subject) maintains `sites.status`/`design_status='pending'` from outcomes. **4g** C15/C16: `_commit_rent_to_canonical` and `svc_launch`'s `sites` writes become `SubjectUpdate` via subject service. **4h** C7: CR emits event; Legal reactor reopens. **4i** C19–C24 mirrors: written only by the `subject_pipeline` projector (one owner); modules stop writing them. **4j** C26–C28: approval center + stage-status page read projections. | per sub-phase: shadow parity, then flag on, 7 days clean, then delete old code |
| **5 Converge** | Built-ins run as templates on the generic runtime (RT-F02); `legacy_emit` deleted; adapters (`syncExternalState`) replace the 4b–4h reactors; drop `site_module_outcomes`, `workflow_unlocks.py`, mirror columns. | independence checker: zero `sites.*_status` reads in services |

Behaviour change to communicate: handoffs in 4a–4h become asynchronous (seconds, not same-request). Gates stay
synchronous (facts trigger), so "can I open Design?" is never stale; only side effects (budget row, NSO row,
launch row) can lag, and the UI shows "handoff pending" until the reactor's event arrives.

## 10. Tests to add

| Area | Tests |
|---|---|
| Envelope | JSON Schema accepts each §3 example, rejects missing workspace/module/record/subject/actor/release/`occurred_at`; `release.*` with a record id rejected |
| Outbox (DB) | rollback of the state change ⇒ no event; commit ⇒ exactly one; duplicate idempotency key ⇒ one row, same id; `trg_we_release_pin` refuses live-release id on a pinned case; UPDATE/DELETE refused; RLS hides other workspace |
| Ordering | concurrent actions on one case ⇒ contiguous `record_seq`; late-committing txn is not skipped by the `pg_snapshot_xmin` watermark (two-session test) |
| Subscribers | redelivery after crash before cursor advance ⇒ effect once (inbox); retry backoff schedule; non-retryable ⇒ dead letter immediately; per-record `waiting` then ordered drain; requeue/discard audited; unknown `schema_version` ⇒ dead letter |
| Facts / gates | property test: random event sequences ⇒ `reached` monotone; rebuild-from-zero equals incremental; reject with `on_reject` opens a gate on `rejected` (RT-B03); send-back never re-locks (RT-B04); field gate ignores unapproved values (RT-B08); migrated stage keys remapped |
| Matrix-bd parity | for each G1–G6: gate result on facts == legacy column check over a recorded dataset; for each C1–C16: shadow events produce the same downstream state as the legacy write |
| Adapters | `syncExternalState` subscriber loads the pinned adapter version; `Command(module ≠ own)` ⇒ dead letter `adapter_rejected`; replay yields identical effect keys |
| Audit | every `audit_logs` row from the projector has `event_id` and `config_release_id`; truncating the bus tail is detected by `events_anchored`; record audit fails when `case_event_hash` mismatches |
| Lint | `events.append` only in runtime/store/host; no service writes another module's table (AST rule over `app/services` against an owner map) |

### Acceptance checklist

| Criterion | Where satisfied |
|---|---|
| No module directly updates another module's private tables | §1 (inventory C1–C18), §5 P1/P7, §6 S8, §9 Phase 4, §10 Lint |
| Gates read event-derived facts, not other modules' tables nor `sites` columns | §4 `record_facts`, §7 (steps 1–2, G1–G7 table), §9 Phase 3 |
| Audit includes event id and release id | §4 (`workspace_activity`/`audit_logs` columns), §8 layer table, §10 Audit |
| Every payload includes workspace, module, record, site/case id, actor, release, timestamp | §3.1 envelope + `allOf`, §4 `chk_we_module`, §5 P5/P6 |
| Transactional outbox, per-record ordering, idempotency, release pinning | §5 P2–P5 |
| At-least-once, idempotent handlers, offsets, retries, dead letter, replay, adapters as subscribers | §6 S2–S9 |
| Shadow mode before each cut | §9 Phases 1–2, 3, 4 exit criteria |

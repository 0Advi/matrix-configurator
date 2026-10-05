# For F4 — make the sandbox (`app/`) == the F2 proposal, and what code must stop hard-coding modules

Audience: F4 (configurator ↔ app integration). Source of truth for the DDL is
`docs/schema-audit/proposed-migrations/20261004_{1..6}_*.sql` — **copy those six files verbatim into
`app/backend/database/migrations/`**; do not re-type them. Everything below is the contract they
implement, plus the code that has to change for a configurator-designed workspace to really run.
All file:line references are to Matrix-bd `origin/main` 3d4f277 (identical in the `app/` sandbox copy
unless F1 edited them).

## 0. How to land the migrations in the sandbox (ordering hazards — read first)

1. **Never bundle these files into the sandbox's first boot of a DB that has `public.tenants` but an
   empty `schema_migrations`.** The runner's baseline branch (`backend/app/main.py:309-336`) records
   every file present as applied **without executing it** — the six files would be silently skipped
   (demonstrated in `VALIDATION.md` P5a). Boot once without them (baseline), then add them.
2. If the sandbox DB was built from `schema.sql`, it **lacks**: `public.current_tenant_id()` /
   `get_current_tenant_id()` (20260802), `auth.jwt()` (Supabase), `quality_audit_reports`,
   `sites.project_excellence_status`, `sites.financial_closure_status`,
   `project_reviews.qa_reports_viewed_by_project_at`, `password_reset_requests.reset_token_hash/
   token_expires_at`, and has the pre-20260801 `sites.area_sqft integer`. The ORM maps the first five
   → the app 500s on those models regardless of F2 (see `VALIDATION.md` M5). Build the sandbox from the
   **live model** instead (`tools/run_all.sh` step M3: shim + `verified.sql` made executable + stubs +
   replay), or replay all 63 migrations over `schema.sql` once with the always-run emulation
   (`tools/audit_db.py replay`). Without `current_tenant_id()` the `CREATE POLICY` statements in
   20261004_1/2/5 fail (RLS stays ENABLED = default-deny; the file stays unrecorded and is retried).
3. Filenames: `20261004_<n>_…` sort after `20260819_…` (latest on main) and among themselves by `<n>`.
   Do **not** add a 9-digit `2026100Xn_` file later — `'202610041' < '20261004_'` (digit < underscore)
   would sort it *before* these.
4. Only `$$` dollar quotes, every statement idempotent, no `CREATE INDEX CONCURRENTLY`, no reliance on
   `BEGIN/COMMIT` (the runner strips them and runs each statement in its own transaction).

## 1. Tables / columns / constraints to implement (exact)

| Object | Columns (type, null) | Keys / constraints | Triggers / RLS |
|---|---|---|---|
| `tenant_config_releases` (new) | `id uuid pk default gen_random_uuid()`, `tenant_id uuid NN → tenants ON DELETE CASCADE`, `version int NN`, `manifest jsonb NN`, `manifest_sha256 text NN`, `schema_version text NN default 'configurator-v5'`, `reason text`, `published_by text NN`, `published_by_user_id uuid` (no FK), `source text NN default 'configurator'`, `source_ref text`, `created_at timestamptz NN default now()` | `uq_tcr_tenant_version (tenant_id, version)`, `uq_tcr_tenant_id (tenant_id, id)`, `chk_tcr_version ≥1`, `chk_tcr_manifest` (object with array `modules`), `chk_tcr_sha256 ^[0-9a-f]{64}$`, `chk_tcr_source ∈ {configurator, baseline, import}` | `trg_tcr_fill_sha` (fills sha256 of `manifest::text` if NULL); `trg_tcr_append_only` → `cfg_forbid_mutation()` (UPDATE/DELETE refused unless FK-cascade); RLS + `tenant_isolation` |
| `tenant_config_live` (new) | `tenant_id uuid pk → tenants CASCADE`, `release_id uuid NN`, `workspace_ref text`, `activated_at`, `activated_by text NN` | `fk_tcl_release (tenant_id, release_id) → tenant_config_releases (tenant_id, id)`; unique partial `uq_tcl_workspace_ref` | RLS + `tenant_isolation` |
| `module_catalog` (new, global) | `key text pk`, `name`, `config_key` (configurator alias, unique), `surface ∈ {module, scope}`, `implementation`, `has_membership`, `has_delegation`, `supervisor_only`, `default_position`, `status_source`, `outcome_map jsonb`, `reached_map jsonb` (raw status → cumulative outcomes), `retired_at` | `chk_mc_key is_valid_module_key(key)` | seeded with 11 rows (bd, legal, finance_ca, design, project_excellence(pex), project, nso, launch_approval, financial_closure, quality_audit(scope), payment(retired)); RLS on, **no policy** |
| `tenant_modules` (new) | `tenant_id → tenants CASCADE`, `module_key`, `kind ∈ {builtin, custom}`, `catalog_key → module_catalog`, `config_key`, `label NN`, `position`, `enabled`, `supervisor_only`, `delegation_enabled`, `route`, `introduced_release_id`, `updated_release_id`, timestamps | `pk (tenant_id, module_key)`, `chk_tm_key`, `chk_tm_kind`, `chk_tm_catalog` (builtin ⇔ catalog_key = module_key), composite FKs to releases, unique partial `(tenant_id, config_key)` | `trg_tenant_modules_guard` (custom may not reuse a built-in key/alias; key/kind immutable); **`trg_tenants_seed_modules` AFTER INSERT ON tenants** seeds the 10 non-retired built-ins; backfill for existing tenants; RLS + `tenant_isolation` |
| function `is_valid_module_key(text)` | IMMUTABLE: `^[a-z][a-z0-9_]{1,38}$` and not in the 13 reserved words | — | — |
| function `cfg_activate_release(release uuid, actor text) → int` | publish step: project manifest → `tenant_modules` (resolve built-in keys via catalog/alias; others custom; absent modules disabled, never deleted; scopes untouched) + upsert `tenant_config_live` | — | — |
| `module_codes`, `supervisor_invite_codes`, `user_module_memberships`, `site_delegations`, `supervisor_executive_requests` (existing) | — | **add** `chk_<t>_module_key CHECK (is_valid_module_key(module))` and `fk_<t>_tenant_module (tenant_id, module) → tenant_modules (tenant_id, module_key)` (NOT VALID → VALIDATE); **drop** the hard-coded `module IN (…)` CHECK(s), discovered by column, after the FK exists | — |
| `sites` (existing) | **add** `config_release_id uuid NULL` | `fk_sites_config_release → tenant_config_releases(id)` (NOT VALID → VALIDATE); partial index | `trg_sites_pin_release` BEFORE INSERT / UPDATE OF config_release_id: NULL pin ← live release on insert; re-pin refused unless `SET LOCAL matrix.allow_repin='on'`; release must belong to the site's tenant |
| `module_records` (new) | `id`, `tenant_id → tenants CASCADE`, `site_id → sites CASCADE`, `module_key`, `release_id NN`, `status` (outcome vocab), `current_stage`, `exit_outcome`, `assigned_to/supervisor_id/opened_by → users`, `opened_at`, `closed_at`, **`runtime_state jsonb NN default '{}'`** (F3 interpreter state), timestamps | `uq (site_id, module_key)`, `fk_mr_tenant_module (tenant_id, module_key) → tenant_modules`, `fk_mr_release (tenant_id, release_id) → releases(tenant_id, id)`, outcome CHECKs, `chk_mr_closed (closed_at NULL) = (exit_outcome NULL)`, `chk_mr_runtime_state` (object) | `trg_module_records_guard`: site∈tenant; release ← site pin or live; pin must match; module must be in the release manifest; release immutable; `runtime_state.release` (if present) must equal the pin; RLS |
| `module_stage_states` (new) | `record_id → module_records CASCADE`, `stage_order`, `tenant_id`, `stage_name NN` (filled from manifest), `status`, `field_values jsonb NN default '{}'`, `submitted_by/at`, `decided_at`, timestamps | `pk (record_id, stage_order)`, `chk_mss_field_values` object | `trg_module_stage_states_guard`: stage must exist in pinned manifest; RLS |
| `module_approvals` (new, append-only) | `id`, `tenant_id`, `record_id`, `stage_order`, `release_id NN`, `tier ∈ {executive, supervisor, business_admin}`, `actor_id → users NN`, `actor_role`, `acting_as_delegate`, **`is_override boolean NN default false`**, `verdict ∈ {submitted, approved, rejected, sent_back}`, `comment`, `decided_at` | `fk_ma_stage (record_id, stage_order) → module_stage_states CASCADE`, `fk_ma_release`, `chk_ma_override_by_admin` | `trg_module_approvals_guard` (uses `cfg_release_stage_chain()` = runtime.py `chain()`): release = record's pin; `tier` ∈ stage chain; `submitted` only by the chain's first tier (admin-only stages with fields ⇒ business_admin `submitted`); actor entitled = same tier or a higher tier in the chain, otherwise accepted only with `is_override = true` by a business_admin; `is_override` refused when not needed. `trg_module_approvals_append_only`. RLS |
| view `site_module_outcomes` (security_invoker) | `tenant_id, site_id, module_key, raw_status, outcome, reached text[], source, release_id` | built-ins from `sites.status / legal_dd_status / finance_status / design_status / project_status / project_excellence_status / financial_closure_status`, `nso_reviews.nso_status`, `launch_approvals.status` mapped through `module_catalog.outcome_map`; **`reached` = cumulative** (`reached_map`, + legal `done` when `licensing_status='complete'`); custom from `module_records` (`runtime_state.reached`, else current outcome) | gate-evaluation input (`facts.reached`) |
| `audit_logs` (existing) | **add** `config_release_id uuid → releases (NOT VALID→VALIDATE)`, `module_key text`, `provenance jsonb` (object) | `chk_audit_logs_provenance`; partial index | — |

Outcome vocabulary (platform-owned): `pending, allocated, in progress, submitted, rejected, approved, done, skipped`
(configurator `stageOutcomes`). Manifest shape relied on by the DB guards: `modules[].key`,
`modules[].type`, `modules[].enabled`, `modules[].tiers.executive|delegation`, `modules[].stages[].order|name|approvers`.

ORM: add models for the new tables only if the backend uses the ORM for them; **remove the stale
`CheckConstraint` in `backend/app/db/models.py:443`** (`chk_site_delegations_module`) — after
20261004_3 it no longer exists in the DB and would be re-created by any `create_all`-based test.

## 2. Runtime contract (what the backend must do with the tables)

* **Publish** (platform-admin, D3): `INSERT tenant_config_releases (tenant_id, version = max+1, manifest, published_by='platform_admin', source_ref=<NocoBase cfg_releases id>)` then `SELECT cfg_activate_release(id, 'platform_admin')` in the same transaction; write an `audit_logs` row with `action='config_release_published'`, `config_release_id`, `provenance={"policy":"publish","manifest_sha256":…}`.
* **New site**: nothing — the trigger pins it to the live release. Read `sites.config_release_id` to pick the manifest that governs the site (NULL ⇒ legacy hard-coded flow).
* **Custom module** (F3 `runtime.py`, see `docs/oss/for-F4.md`): open a `module_records` row (release defaults to the site pin) and build `ModuleRuntime` from **that** release; after every `act()` in one `SELECT … FOR UPDATE` transaction write `runtime_state` (the whole state dict) + `runtime.module_record_row()` columns, upsert `module_stage_states` (`field_values` keyed by manifest field keys; file fields store `{storage_path, file_name, size_kb, mime}` — do not widen `site_files.file_type`), insert `runtime.approval_row(ev)` into `module_approvals` **with `is_override = ev['override']`**, and every event into `audit_logs.provenance`. Proven end-to-end by `tools/f3_runtime_fit.py` (VALIDATION P6). F3's `approval_row()` workaround that rewrites an admin `submitted` to `approved` is **no longer needed** — record `submitted`.
* **Gates**: `facts.reached[<module>] = site_module_outcomes.reached` for that site (built-in and custom, already cumulative); evaluate the pinned release's `entry_gate` with F3's `gates.py`; write the decision to `audit_logs.provenance` (`{"policy":"gate","inputs":[…]}`) when it opens a module. Built-in `reached` is derived from the CURRENT mirror status through an FSM map — the same information production's own gates use (`workflow_unlocks.design_unlock_ready` reads the current column); a built-in that later moves *backwards* (e.g. DDR re-opened) drops outcomes, exactly as production would.
* **Navigation / permissions**: read from the **live** release manifest (`navigation`, `permissions`) and `tenant_modules.enabled/position/label`; stage rules (approvers, fields) come from the **pinned** release.

## 2b. F3's three findings — resolved in the proposal (re-validated: VALIDATION P4 161/161, P6 PASS)

| F3 finding | Decision | Where |
|---|---|---|
| 1. runtime state has nowhere to live | **Accepted**: `module_records.runtime_state jsonb NOT NULL DEFAULT '{}'` (object CHECK; its `release` must equal the record's pin). Queryable columns stay CHECK-constrained; the opaque state rides along atomically. | 20261004_5 |
| 2. admin override vs the approvals guard; admin-only stages with fields | **Relax the guard, record the override** (F3's alternative), not `admin_override=False`: production's business admin *does* act anywhere (`READ_ALL_ROLES` bypass, `backend/app/rbac/guards.py:20-33`), so refusing it would make built-ins and custom modules behave differently and hide real actions. The DB now accepts an out-of-chain action **only** as `is_override = true` by a `business_admin`, refuses a false flag on either side, and still refuses tiers outside the stage chain. Tier chain = `runtime.py chain()`; `submitted` belongs to the chain's first tier, so Design GFC / PEx admin review / Launch admin review are plain business_admin `submitted` rows (tested on the real `matrix-bd-flow.json` release). Run the runtime with its default `admin_override=True`. | 20261004_5 (`is_override`, `cfg_release_stage_chain`, guard) |
| 3. gate inputs must be cumulative | **Accepted**: `site_module_outcomes.reached text[]` — built-ins via `module_catalog.reached_map` (seeded FSM prefixes, INFERRED) + legal `done` on licensing complete; custom via `runtime_state.reached`. F4 uses it directly as `facts.reached`. | 20261004_2 (`reached_map`), 20261004_5 (view) |

## 3. Code that hard-codes module vocabularies and must become data-driven

Backend (validation / listing — must read `tenant_modules` or the release):

| file:line | what | change |
|---|---|---|
| `backend/app/domain/schemas/business_admin.py:10` | `Module = Literal["bd","legal","design","project","nso","project_excellence"]` | `str` validated with `is_valid_module_key` + membership in the tenant's `tenant_modules` |
| `backend/app/domain/schemas/supervisor_codes.py:9` | same `Literal` | same |
| `backend/app/services/business_admin_service.py:40` | `_VALID_MODULES` (parses `pending_module:` marker, incl. retired `payment`) | look up `tenant_modules` (enabled, `has_membership`) |
| `backend/app/services/business_admin_service.py:1029` | `_ORG_MODULES` (Departments org tree) | enabled `tenant_modules` with membership, ordered by `position` |
| `backend/app/services/business_admin_service.py:1034` | `_SUPERVISOR_ONLY_MODULES = {"nso"}` | `tenant_modules.supervisor_only` |
| `backend/app/services/supervisor_code_service.py:98` | `if module == "nso"` refuse executives | `tenant_modules.supervisor_only` |
| `backend/app/services/delegation_service.py:255` | `_VALID_MODULES` (delegation scopes) | `tenant_modules` (`delegation_enabled`) |
| `backend/app/db/models.py:443` | ORM `CheckConstraint` module IN-list | delete |
| `backend/app/rbac/guards.py:63-90` (`require_module`) + `backend/app/core/deps.py:161` | module = single JWT claim; `X-Override-Module` only for business_admin/observer (`deps.py:103-112`) | generic runtime routes need a membership check per request (`user_module_memberships` for the record's module), not the primary-module claim |
| `backend/app/services/auth_repo.py:89-111` | `get_primary_membership`: ONE module per user (alphabetical) baked into the JWT | let users in several modules (built-in + custom) pick/switch module |
| `backend/app/routers/audit.py:52`, `backend/app/services/site_tracker_service.py:55`, `backend/app/services/site_stage_status_service.py:339` | missing module ⇒ `'bd'` | keep for legacy; custom modules need their own branch |
| `backend/app/services/site_stage_status_service.py:143-146, 154, 164, 311-317` | site tracker blocks for a fixed built-in list | append blocks for enabled custom modules from `site_module_outcomes` |
| `backend/app/services/query_service.py:219-230` | module → queue mapping | add generic `module_records` queue |
| `backend/app/services/workflow_unlocks.py:25-32` (+ per-service `_assert_*_unlocked`) | built-in gates hard-coded (configurator G2) | evaluate the pinned release's `entry_gate` against `site_module_outcomes` |
| `backend/app/domain/state_machine.py:11-55` | BD lifecycle (11 statuses; DB CHECK has 12 incl. `launched`) | unchanged for BD; custom modules use `module_records` |
| `backend/app/rbac/permissions.py:10-37` | `PERMISSIONS` map — **dead code** (`can()` is never called); route guards are the real matrix | configurator permission matrix → evaluate `manifest.permissions` in the guards |
| `backend/app/services/notification_service.py:58-77` | legal/design supervisor recipients by literal module | resolve recipients from `user_module_memberships` for any module |
| `backend/app/services/business_admin_documents_service.py:34` | label map incl. `quality_audit` | catalog/tenant labels |

Frontend (lists, labels, routes):

| file:line | what |
|---|---|
| `frontend/src/modules/shared/workspaceModules.js:12-19` | `WORKSPACE_MODULES` (6 built-ins, labels, routes) — the shared list; drive it from `tenant_modules` (+ `/m/<key>` for custom) |
| `frontend/src/App.jsx:282` and `:293-298` | admin "switch as" module routes map + `<option>`s |
| `frontend/src/modules/shared/chrome/Sidebar.jsx:83-92, 116, 167, 208, 242, 297, 331` | per-module sidebar sections hard-coded — render `manifest.navigation` |
| `frontend/src/router/AppRouter.jsx:75-79, 131-135` (+ `RequireModule modules={[…]}` per route from `:204`) | module → landing route; add a generic `/m/:moduleKey` route |
| `frontend/src/modules/business-admin/departments/OrgModuleCard.jsx:10-16` | `MODULE_META` labels/icons |
| `frontend/src/modules/business-admin/PendingSupervisorsList.jsx:25-32` | filters derived from `WORKSPACE_MODULES` (fixes itself once that list is data-driven) |
| `frontend/src/modules/team/TeamPage.jsx:32`, `frontend/src/modules/business-admin/WorkspaceSwitcherPanel.jsx:47`, `frontend/src/modules/shared/chrome/TopBar.jsx:16`, `frontend/src/modules/business-admin/sites/historyMeta.js:8-19` | default module `'bd'`, BD-only "New pipeline", history colour/labels by module |
| `frontend/src/rbac/permissions.js:19-23` | frontend `PERMISSIONS` (legal_* actions) |

## 4. What F4 can rely on (validated by F2 — see VALIDATION.md for the exact runs)

See VALIDATION.md §P2–P6 for: apply-twice idempotency, existing-style rows still accepted, `_verify_schema`
still passing, RLS on every new tenant table, `vendor_onboarding` accepted only where registered,
junk keys rejected, version pinning across two releases, tier-chain guard incl. flagged admin override and admin-only stages with fields, `runtime_state`, cumulative
`reached`, append-only ledgers, tenant-delete cascade, and F3's `runtime.py` persisting into the tables (P6).

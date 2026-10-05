# VALIDATION — F2 schema audit: commands and real outputs

Everything below was executed on 2026-10-04 against a **throwaway** container
(`matrix-schema-audit`, `postgres:16` = PostgreSQL 16.15, tmpfs data dir, `127.0.0.1:54339`, password
from a scratchpad `--env-file`, never printed). No remote database was contacted; `Matrix-bd` was
read only through `git --no-optional-locks show origin/main:<path>` (3d4f277). The container, its
network and every database in it were removed at the end (see §T).

Raw outputs live in `docs/schema-audit/evidence/` (catalog snapshots, replay logs, runner logs,
matrices). The whole run is reproducible in ~13 s:

```bash
# §0 inputs: copies of the real files, read-only
for f in $(git --no-optional-locks -C Matrix-bd ls-tree -r --name-only origin/main -- backend/database backend/app); do
  mkdir -p "$SRC/$(dirname $f)"; git --no-optional-locks -C Matrix-bd show "origin/main:$f" > "$SRC/$f"; done
docker create --name matrix-schema-audit --network matrix-schema-audit-net --env-file "$SCRATCH/.audit.env" \
  --tmpfs /var/lib/postgresql/data:rw,size=1g -p 127.0.0.1:54339:5432 postgres:16 && docker start matrix-schema-audit
SRC=... AUDIT_PGPASS_FILE=... bash docs/schema-audit/tools/run_all.sh
```

Fidelity of the harness (why these results speak for the real app):

* migrations are split by **the app's own parser** — `_sql_code_before_comment` / `_parse_sql_statements`
  lifted verbatim from `backend/app/main.py` with `ast` (tools/audit_db.py `_load_runner_parser`);
* the proposal apply and `_verify_schema` use **the app's real functions** `_apply_pending_migrations()`
  and `_verify_schema()` lifted verbatim (tools/run_app_runner.py), with the app's driver stack
  SQLAlchemy 2.0.50 + asyncpg 0.31.0 (= `backend/requirements.lock.txt`);
* ORM fit uses the app's real `backend/app/db/models.py` metadata (tools/orm_check.py).

Status tags: **verified** = observed in this run; **inferred** = reasoned, not observable here.

---

## M — the actual database, modelled three ways

| Model | Built from | Result |
|---|---|---|
| `m_schema` | shim + `schema.sql` | loads cleanly: 32 tables, 491 columns, 218 constraints, **0 policies**, 1 function (verified) |
| `m_fresh` | shim only → real ledger runner (fresh-DB branch) | **301 failing statements in 56 of 63 files**; only 7 files apply; `_verify_schema: FAIL (SystemExit 1)` — the migrations cannot build a database on their own (verified; `evidence/m_fresh.*`) |
| `m_live` | shim + `verified.sql` (live export 2026-06-23, made executable by edits E1–E5) + out-of-band stubs + **always-run replay of all 63 migrations ×2** + ledger baseline | 520 columns / 240 constraints / 94 indexes / 5 policies; pass 1 == pass 2 catalog (**converged**); ORM fully satisfied; `_verify_schema: PASS` (verified) |

`m_live` is the audit's model of the real DB. Construction details: `shim/00-supabase-shim.sql`
(uuid-ossp, roles anon/authenticated/service_role, `auth.jwt()` = Supabase's own body);
`shim/01-live-out-of-band-stubs.sql` (INFERRED stubs for objects migrations reference but no repo
file defines: `current_tenant_id()`, `get_current_tenant_id()`, views `pipeline_summary` /
`stuck_sites`, `handle_new_auth_user()`); `tools/make_verified_executable.py` edits: E1 declare
`workspace_request_status`, E2 fix the export's `public.tenents` typo, E3 `completion_pct` is a
generated column, **E4 restore 19 CHECK names the export loses** (without it a stale
`sites.rent_type` CHECK lacking `'staggered'` survives — a modelling artefact found and removed in
this run), **E5 re-add 7 multi-column UNIQUEs the export omits** (without them the app's
`ON CONFLICT (tenant_id, module)` fails — found in this run).

### M3 — replay of the 63 migrations over the live export (runner semantics)

```
replay pass 1: 63 files, 58 clean, 5 with failing statements
  FAIL 202605221 #0,#1   type "workspace_request_status" / relation "workspace_requests" already exists   (non-idempotent CREATE)
  FAIL 202606033 #13     column "budget_status" does not exist   (index on a column 202606145 dropped)
  FAIL 202606133 #0..#5  CREATE INDEX CONCURRENTLY cannot run inside a transaction block
  FAIL 202606141 #1      cannot alter type of a column used by a view or rule      (sites.status vs pipeline_summary — stub view, inferred)
  FAIL 202606141 #10     cannot alter type of a column used by a generated column (site_details.rent_type vs completion_pct)
  FAIL 202606231 #5      column "schemaname" does not exist   (DO block queries pg_policy.schemaname — a pg_policies column)
replay pass 2 (convergence): 63 files, 57 clean, 6 with failing statements   (+ duplicate-object errors only)
catalog pass1 vs pass2: columns/constraints/indexes/rls/policies/functions/views/types/triggers identical
                        (evidence/m_live_convergence_pass1_vs_pass2.md)
```

Consequences (verified in the model; confirm on live with `live-db-drift-check.sql`):
* **202606133's six FK indexes are never created by the runner** (CONCURRENTLY inside its per-statement txn) → D8.
* **202606231's `tenant_isolation` policy is never created** — the guard queries `pg_policy.schemaname`
  (which only `pg_policies` has); `supervisor_executive_requests` ends with RLS on and **0 policies** → D5.
* All failing files pre-date the ledger (d1e99c6, 2026-07-11) → on live they were **baselined**, so the
  runner does not retry them (the model's ledger is baselined the same way: `m_live.baseline.txt`, 5 files).

### H — hazard: re-running an unledgered pre-ledger file is destructive

Clone of `m_live` **before** baselining (5 files unledgered), 35 representative rows inserted, then the
real runner:

```
[ERROR] 202606033_project_execution_foundation.sql had failing statement(s); NOT recording ...
module_codes | 0          <- module CHECK constraints left on each table afterwards
site_delegations | 0
supervisor_invite_codes | 0
```
202606033's `DROP CONSTRAINT IF EXISTS chk_*_module` statements succeed, its `ADD CONSTRAINT` (5-module list)
fails on today's data → the module columns end up **unconstrained**, and it repeats every boot. Any live
DB whose ledger is missing an old file is exposed (D1 lists missing files). (verified)

### M4 — drift: `schema.sql` vs the live model (`evidence/drift_schema_vs_live.md`)

| Area | schema.sql says | live model (migrations) | Impact |
|---|---|---|---|
| `sites.status` CHECK | 7 values | **12** (+ `legal_review`, `legal_approved`, `legal_rejected`, `pushed_to_payments`, `launched`) NOT VALID (202606141) | a schema.sql DB rejects the state machine's own `legal_review` (BD "send to legal" 500s); `launched` is admitted by the DB but unused by `state_machine.py` |
| module CHECKs | sic/umm/ser 6 modules; site_delegations 7 | sic/umm **+ `payment`** (202606142); site_delegations **+ `quality_audit`** (20260805) | QA self-delegation 500s on a schema.sql DB |
| `sites.project_excellence_status`, `sites.financial_closure_status`, `project_reviews.qa_reports_viewed_by_project_at`, table `quality_audit_reports` | absent | present | **ORM-mapped** → every `Site` query 500s on a schema.sql DB — yet `_verify_schema` PASSES there (it checks other columns) |
| `sites.area_sqft` | integer | numeric(12,2) (20260801) | decimals truncated |
| dropped columns | `sites.address/notes/spoc_email/spoc_phone`, `site_files.onedrive_*`, `project_reviews.budget_*` present | dropped (20260815, 202606145) | — |
| `password_reset_requests.reset_token_hash/token_expires_at` | absent | present (202606123) | reset flow |
| RLS | off everywhere, 0 policies, no `current_tenant_id()` | 11 tables RLS on, 5 policies, `current_tenant_id()` | schema.sql DB can't run any RLS migration |
| indexes | lacks `tenants_workspace_code_uidx` (upper(workspace_code)), `site_delegations_unique_active`, `shortlist_delegations_active_uidx` | present | workspace-code uniqueness + delegation inference |
| `notification_outbox.tenant_id` | NOT NULL | nullable (export) | — |
| `site_details.completion_pct` | absent | generated column (out-of-band) | blocks `ALTER TYPE` of its inputs |
| `sites.finance_status` / `design_status` CHECKs | none | present (out-of-band, export) | — |
| `project_excellence_reviews/_items` | absent | present (created by 202606134 during the 07-10 always-run window), PE items **without RLS** | — |
| numeric precision on launch/site_budget amounts | numeric(14,2)… | `numeric` | **export artefact** (the dashboard export drops precision) — confirm with D2/D3 |
| `is_valid_staggered_escalation` | — | same logic (comments/whitespace differ only) | none |

### M5 — ORM fit and `_verify_schema`

```
orm_check m_schema: missing_tables ["quality_audit_reports"], missing_columns ["project_reviews.qa_reports_viewed_by_project_at",
                    "sites.project_excellence_status", "sites.financial_closure_status"]
orm_check m_live:   missing_tables [], missing_columns []
_verify_schema m_schema: PASS     _verify_schema m_live: PASS
```

### M6 — vocabularies the database enforces today (module-bearing tables)

`evidence/vocab_m_live.md` (live model). ✅ accepted, ❌ 23514 rejected by CHECK:

| key | module_codes | supervisor_invite_codes | user_module_memberships | site_delegations | supervisor_executive_requests |
|---|---|---|---|---|---|
| bd, legal, design, project, nso, project_excellence | ✅ | ✅ | ✅ | ✅ | ✅ |
| financial_closure | ❌ | ❌ | ❌ | ✅ | ❌ |
| quality_audit | ❌ | ❌ | ❌ | ✅ | ❌ |
| payment (retired) | ✅ | ✅ | ✅ | ❌ | ❌ |
| finance_ca, launch_approval (configurator built-ins) | ❌ | ❌ | ❌ | ❌ | ❌ |
| **vendor_onboarding, store_design (custom)** | ❌ | ❌ | ❌ | ❌ | ❌ |

`sites.status` = `launched` / `legal_review` / `pushed_to_payments`: accepted on `m_live`, rejected on `m_schema`.
The same matrix for `m_schema` is in `evidence/vocab_m_schema.md` (payment only in module_codes,
quality_audit nowhere). **Custom module keys are rejected everywhere today** (verified).

### M3c — the drift-check SQL runs as written

`docker exec -i matrix-schema-audit psql -U postgres -d m_live -X -v ON_ERROR_STOP=1 -f - < live-db-drift-check.sql`
→ `drift-check: OK (265 lines)`; D1 prints no rows (ledger == origin/main checksums), D9 shows
`postgres | rolsuper t | rolbypassrls t` (`evidence/drift_check_on_m_live.txt`).

---

## P — the proposed change set (`proposed-migrations/20261004_{1..6}`)

### P1 — existing-style data before the proposals
`m_prop` = clone of `m_live`. A tenant is provisioned with the app's own SQL (`INSERT INTO tenants (slug,
name, plan, seat_limit, workspace_code)…`, business admin + `business_admins`), plus supervisor,
executive, a site. One row per (table, module) **accepted today** is persisted: **35 rows** (incl. the
retired `payment` rows). `vendor_onboarding` is rejected by all five CHECKs (5/5 PASS).

### P2 — (a) applies with the real ledger runner; (c) `_verify_schema` holds
```
[INFO] startup-migrations: applied 20261004_1_tenant_config_releases.sql (13 statement(s))
[INFO] startup-migrations: applied 20261004_2_module_catalog_and_tenant_modules.sql (18 statement(s))
[INFO] startup-migrations: applied 20261004_3_module_columns_reference_registry.sql (14 statement(s))
[INFO] startup-migrations: applied 20261004_4_site_release_pinning.sql (7 statement(s))
[INFO] startup-migrations: applied 20261004_5_generic_module_runtime.sql (27 statement(s))
[INFO] startup-migrations: applied 20261004_6_audit_provenance.sql (5 statement(s))
[INFO] startup-migrations: 6 new migration file(s), 84 statement(s) applied; 63 already in ledger
_verify_schema: PASS
--- second boot ---
[INFO] startup-migrations: 0 new migration file(s), 0 statement(s) applied; 69 already in ledger
_verify_schema: PASS
```

### P3 — (a) idempotent: every statement re-executed twice more
```
replay proposals re-run #1: 6 files, 6 clean, 0 with failing statements
replay proposals re-run #2: 6 files, 6 clean, 0 with failing statements
catalog after re-runs vs after first apply: all 9 categories identical; tenant_modules rows unchanged (11)
```

### P4 — behaviour after the proposals: **161 PASS, 0 FAIL** (`evidence/p4_after.md`)

(b) existing data / constraints
* 10 new module constraints present (5 key-shape CHECK + 5 registry FK), **all `convalidated = true`** over the existing rows; no hard-coded module IN-list CHECK left; the 35 persisted rows survive.
* Backfill registered every built-in for the pre-existing tenant (`bd … quality_audit`, `payment(off)`).
* The app's provisioning `INSERT INTO tenants` seeds 10 `tenant_modules` rows via trigger; the app's exact
  `INSERT INTO module_codes … ON CONFLICT (tenant_id, module) DO UPDATE …` still works.
* ORM fit on `m_prop`: no missing table/column. Catalog diff before→after (`diff_before_after_proposals.md`):
  **only additions**, except the 5 module IN-list CHECKs that were deliberately replaced.

(e) custom module keys — acceptance matrix for the existing tenant T1:

| key | before registration (all 5 tables) | after release v1 (Starbucks seed + vendor_onboarding) is live |
|---|---|---|
| bd, legal, design, project, nso, project_excellence | ✅ | ✅ |
| financial_closure, quality_audit, payment, finance_ca, launch_approval | ✅ (registered built-ins — documented widening) | ✅ |
| `vendor_onboarding`, `store_design` | ❌ 23503 (not registered) | **✅** |
| `pex` (configurator alias, not a runtime key) | ❌ 23503 | ❌ 23503 |
| `Vendor`, `x`, `admin`, `9lives`, `a-b`, `vendor onboarding`, `''` | ❌ 23514 | ❌ 23514 |

plus: T1's custom key refused for another tenant T2 in all 5 tables (23503); a custom module may not
take a built-in key/alias (`pex` → 23514).

Releases & pinning
* v1 stored (sha256 filled by trigger); `cfg_activate_release` projected 14 modules — Starbucks switches
  **design** and **project_excellence** off, registers 5 custom modules, `nso.supervisor_only = true`.
* Release UPDATE/DELETE refused (append-only, 23001); duplicate version refused; manifest without
  `modules[]` refused (this test caught a NULL-passes-CHECK bug in `chk_tcr_manifest`, fixed in file 1).
* Legacy site keeps `config_release_id = NULL`; a site created with the app's columns only is
  **auto-pinned** to v1; after publishing v2 the in-flight S1 stays on v1, a new S2 gets v2; re-pin
  refused (only with `SET LOCAL matrix.allow_repin='on'`); pin to another tenant's release refused; an
  ordinary ORM-style `UPDATE sites SET status=…` is unaffected.

Generic runtime
* module record inherits the site's pin; a record on S1 with release v2 refused; a module not in the
  release refused; cross-tenant record refused.
* stage rows validated against the pinned manifest (stage name filled: "Vendor KYC"); stage 9 refused;
  `field_values` must be an object.
* `module_records.runtime_state` (F3 finding 1): state for the pinned release stored; state carrying another
  release refused; non-object refused.
* approvals = the runtime's **tier chain** (F3 finding 2). Stage 1 chain `[executive, supervisor]`, stage 2
  `[business_admin]` (v1) / `[supervisor, business_admin]` (v2):
  executive submits ✅; supervisor does the executive step (higher in-chain tier, no override) ✅;
  `submitted` by a non-first tier ❌; supervisor approves ✅; business_admin on stage 1 **without** the
  override flag ❌; business_admin on stage 1 **as a flagged override** ✅ (and submitting the executive
  step as override ✅); override flag on a non-admin ❌; a tier outside the chain ❌ even as override;
  supervisor on stage 2 of S1 ❌ (v1) but ✅ on S2 (v2 rules); business_admin tier with a supervisor actor ❌;
  **admin-only stage with fields → business_admin `submitted` ✅**; override flag on an entitled actor ❌
  (the flag must be truthful); approvals UPDATE/DELETE ❌ (append-only).
* Production's admin-only stages with fields, loaded from `matrix-bd-flow.json` as a real release for T2:
  **PEx Admin review, Design GFC approval, Launch Admin review** — business_admin `submitted` ✅;
  a supervisor submitting them (no override) ❌.
* `exit_outcome` without `closed_at` ❌; an outcome outside the configurator vocabulary ❌.
* `site_module_outcomes` (F3 finding 3) returns `reached` — cumulative — next to the current outcome:
  custom `vendor_onboarding reached=[submitted, approved]` (from `runtime_state.reached`); built-ins after
  moving S1 to design `approved`, legal `positive` + licensing `complete`, BD `loi_uploaded`:
  `design=[allocated, approved, in progress, submitted]`, `legal=[approved, done, in progress]`,
  `bd=[approved, done, in progress, submitted]`.

Audit provenance: `audit_logs` accepts `config_release_id/module_key/provenance`; a legacy-style insert
without the new columns still works; non-object provenance refused.

(d) RLS on every new table

| table | RLS | tenant_isolation | authenticated + T1 claims | no claims | app role (BYPASSRLS) |
|---|---|---|---|---|---|
| tenant_config_releases | on | 1 | 2 rows, 0 foreign | 0 | 3 |
| tenant_config_live | on | 1 | 1 | 0 | 2 |
| tenant_modules | on | 1 | 16 | 0 | 26 |
| module_records | on | 1 | 2 | 0 | 5 |
| module_stage_states | on | 1 | 3 | 0 | 6 |
| module_approvals | on | 1 | 1 | 0 | 1 |
| module_catalog (global) | on | 0 (default-deny) | — | — | — |

`anon` → `42501 permission denied for table module_records` (REVOKE). Deleting a tenant cascades
through the append-only release ledger, the live pointer and the registry (✅).

### P6 — F3's reference interpreter persists into these tables (`evidence/p6_f3_runtime_fit.txt`)

`tools/f3_runtime_fit.py` drives `third_party/matrix-adapters/runtime.py` (read-only, unmodified) for the
custom `vendor_onboarding` module of T1's live release and writes everything it emits: every event →
`audit_logs` (`config_release_id`, `module_key`, `provenance` = the event incl. `seq/prev/hash/override`),
every approval event → `module_approvals` (`runtime.approval_row` + `is_override = event.override`),
state → `module_records` (`runtime.module_record_row` + `runtime_state`). Gate facts come from
`site_module_outcomes.reached`.

```
[F3 runtime, normal chain] gate with bd reached=['submitted']: status=locked
[F3 runtime, normal chain] gate with bd reached=['approved', 'done', 'in progress', 'submitted']: status=open
[F3 runtime, normal chain] executive submit -> submitted
[F3 runtime, normal chain] supervisor approve -> approved, stage_completed
[F3 runtime, normal chain] supervisor submit -> submitted
[F3 runtime, normal chain] business_admin approve -> approved, stage_completed, module_completed
[F3 runtime, normal chain] persisted: 9 audit events (hash chain verified from DB: True), 4 approvals (0 override), view outcome=approved reached=['submitted', 'approved']
[F3 runtime, admin override] business_admin submit -> submitted(override)
...
[F3 runtime, admin override] persisted: 9 audit events (hash chain verified from DB: True), 4 approvals (1 override), view outcome=approved reached=['submitted', 'approved']
RESULT: PASS
```
The runtime runs with its default `admin_override=True`; the DB accepted the override row only because it
carried `is_override = true` (verified: the same row without the flag is refused in P4).

### P5 — the same files on a `schema.sql`-shaped database (what a sandbox built from schema.sql gets)

* **Hazard reproduced:** first boot with the proposals present → `BASELINED 69 existing migration(s)
  … none were re-executed`; ledgered proposals = 6, `tenant_modules` exists = **False**.
* Correct order (boot without them, then with them): files 3, 4, 6 apply; files 1, 2, 5 stay
  unrecorded because `public.current_tenant_id()` does not exist (policy DO blocks) and
  `sites.project_excellence_status` does not exist (view). Tables are created and RLS is **enabled**
  (default-deny), so nothing is loosened; they converge once the DB has 20260802 + the PE/FC mirror
  columns (`for-F4.md` §0). Probe: `current_tenant_id=None | pe_status_col=0 | tenant_modules RLS=True | view=None`.

---

## T — teardown

```
docker rm -f matrix-schema-audit && docker network rm matrix-schema-audit-net
```
`evidence/tmp/` (regenerable copies: executable verified.sql, migration dir copies, scratch state) was
deleted; everything else in `evidence/` is output of the run above (`evidence/run_all.log` = the full console).

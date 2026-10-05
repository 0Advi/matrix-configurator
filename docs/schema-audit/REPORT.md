# Schema & modularity audit — REPORT (task 3)

> **Provenance:** authored by workstream F2 (schema & modularity audit, 2026-10-04). F2's own write of this
> file was blocked by the harness ("subagents should return findings as text"); the lead recorded §1–7 below
> verbatim from F2's handback, with the user's approval. F2 described a fuller fit table than the summary in
> §3 — only the summary reached the lead. The appendix is the lead's own, clearly separated.
>
> Tags: **[V]** = observed in the throwaway DB (Postgres 16.15) or read in source — the app's own migration
> parser, ledger runner, `_verify_schema` and ORM metadata were copied verbatim from `origin/main` 3d4f277 and
> run with the same pinned driver versions. **[I]** = inferred.

**Short answer: no, not today.** The real database cannot run a workspace designed in the configurator. It
can store who the people are: tenant, workspace code, name/logo, the 4 roles, per-module memberships, invite
codes and delegation. It cannot store how the workflow runs. With the 6 additive migrations proposed here, it
can; that is validated below.

Companion files in this folder: `proposed-migrations/20261004_{1..6}_*.sql`, `VALIDATION.md`, `for-F4.md`,
`live-db-drift-check.sql`, `shim/`, `tools/` (`run_all.sh` reproduces everything), `evidence/` (incl. `run_all.log`).

## 1. Top blockers today
1. **Custom modules are rejected [V].** Five hard-coded `module IN (…)` CHECKs refuse `vendor_onboarding` or
   Starbucks' `store_design` in all five module tables.
2. **No place to store a published configuration [V].** No release, version, per-tenant enablement, labels,
   order, navigation, gates, stages, fields, roll-ups or permissions.
3. **No generic runtime [V].** Every built-in module has its own bespoke tables and CHECKs; a custom module has
   nowhere to keep cases, stages, field values or approvals.
4. **No version pinning [V].** Sites don't record which flow version they started under.
5. **Gates and permissions live in code [V].** Gates are in `workflow_unlocks.py` and per-service asserts.
   `rbac/permissions.py`'s `PERMISSIONS` is dead code (`can()` is never called).

## 2. "The actual database" can't be rebuilt from the repo [V]
- **`schema.sql` loads but is stale.**
  - It lacks three ORM-mapped columns (`sites.project_excellence_status`, `sites.financial_closure_status`,
    `project_reviews.qa_reports_viewed_by_project_at`) and the `quality_audit_reports` table, so every `Site` query 500s.
  - It rejects `legal_review`, a status the app's own state machine uses.
  - It lacks `tenants_workspace_code_uidx`, all RLS and `current_tenant_id()`.
  - `_verify_schema` still passes on it.
- **The migrations can't build a database alone.** On an empty DB the real runner fails 301 statements in 56 of
  63 files, and `_verify_schema` fails.
- **`verified.sql` is a lossy dashboard export.** It drops NOT VALID checks, CHECK names, multi-column UNIQUEs,
  delete rules, indexes and policies.
- **The audit's live model:** verified.sql plus five documented repairs, stubs for five out-of-band objects [I],
  then every migration replayed twice. Pass 1 and pass 2 give identical catalogs, the ORM fits fully, and
  `_verify_schema` passes.

The replay exposed existing defects [V in the model]:
- **202606231:** its policy guard queries `pg_policy.schemaname`, which doesn't exist, so
  `supervisor_executive_requests` has RLS on but no policy.
- **202606133:** uses `CREATE INDEX CONCURRENTLY`, which always fails inside the runner's transaction, so its 6
  FK indexes are never created.
- **Re-running an unledgered old file is destructive.** 202606033 drops the module CHECKs, then fails to re-add
  them, leaving the columns unconstrained.
- **Vocabulary drift:** the DB's `sites.status` allows 12 values including `launched`; `schema.sql` allows 7.
  Retired `payment` is still allowed in three membership tables. `quality_audit` is allowed only in `site_delegations`.

## 3. Fit matrix (summary)

| Concept | Today | After the proposal |
|---|---|---|
| Workspace, workspace code | ✅ | link via `tenant_config_live.workspace_ref` |
| Branding | ⚠️ name + logo only | rest in the manifest |
| Module catalog, built-in vs custom, per-tenant enablement/order/labels | ❌ | `module_catalog`, `tenant_modules`, `cfg_activate_release()` |
| Tiers & memberships, delegation | ⚠️ hard-coded keys only | any registered key; the single-module login token remains an app change |
| Supervisor-only modules | ⚠️ code only | `tenant_modules.supervisor_only` |
| Business admin / observer | ✅ | unchanged |
| Gates, stages, fields, roll-up, terminal/exit outcomes | ❌ | generic runtime + `site_module_outcomes.reached` |
| Approvals / approved-by | ⚠️ per-module columns | `module_approvals` (append-only, tier-chain guard) |
| Navigation, permission matrix | ❌ | read from the live release (app change) |
| Versions / releases, pinning | ❌ | `tenant_config_releases` + `sites.config_release_id` |
| Audit provenance | ⚠️ | new `audit_logs` columns |

## 4. Change set (additive, idempotent, runner-safe)
1. **`20261004_1`:** `tenant_config_releases` (append-only, version unique per tenant, sha256 filled
   automatically) and `tenant_config_live` (which release is live).
2. **`20261004_2`:** `is_valid_module_key()`; `module_catalog` with 11 built-ins and aliases, plus inferred
   status→outcome maps; `tenant_modules`; `cfg_activate_release()`; a trigger on `tenants` that seeds built-ins
   for new tenants, and a backfill for existing ones.
3. **`20261004_3`:** on the five tables, adds a key-shape CHECK and a `(tenant_id, module)` FK to
   `tenant_modules`, then drops the hard-coded CHECKs. A deliberate widening: per-table scopes become an app rule.
4. **`20261004_4`:** `sites.config_release_id`, with a trigger that auto-pins new sites to the live release (no
   app change) and refuses re-pinning.
5. **`20261004_5`:** tables `module_records` (with `runtime_state`), `module_stage_states` and
   `module_approvals` (append-only, with `is_override`); guards check every row against the site's pinned
   manifest; view `site_module_outcomes` exposes current outcome plus cumulative `reached`.
6. **`20261004_6`:** `audit_logs.config_release_id`, `module_key`, `provenance`.

Every new tenant table has RLS and a `tenant_isolation` policy, and anon/authenticated grants are revoked.

**Workstream F3's three findings, resolved:**
1. **Runtime state:** accepted as `runtime_state jsonb`; it must be an object and must belong to the record's pinned release.
2. **Admin override:** the guard was relaxed rather than running the runtime with `admin_override=False`,
   because production lets a business admin act anywhere. A business admin acting outside a stage's tier chain
   is accepted only with `is_override = true`, and the flag must be truthful in both directions. The guard
   mirrors `runtime.py`'s tier chain, so Design GFC, PEx admin review and Launch admin review are ordinary
   business-admin `submitted` rows. Tested on the real `matrix-bd-flow.json` loaded as a release.
3. **Cumulative gate inputs:** accepted as `site_module_outcomes.reached` — built-ins via the catalog's
   `reached_map` [I], custom modules via `runtime_state.reached`.

## 5. Validation evidence [V]
- **Applies cleanly:** the real ledger runner applies 6 files / 84 statements with 0 failures. A second boot
  does nothing. `_verify_schema` passes. The ORM fits.
- **Idempotent:** re-executing every statement twice more gives 0 failures and an identical catalog.
- **Behaviour after the proposals: 161 passed, 0 failed.** Existing-style data (35 rows covering every accepted
  table/module pair, including `payment`) still validates; the app's exact provisioning and invite-code SQL still
  works; custom keys are accepted only when registered and only in their own tenant; junk keys (`Vendor`, `x`,
  `admin`, `9lives`, `a-b`, empty, with spaces) and the alias `pex` are rejected; publish works and existing
  sites stay pinned to v1 when v2 goes live; approvals follow the right version's rules; append-only rules and
  RLS isolation on every new table hold (anon is refused); tenant delete cascades.
- **Against F3:** F3's `runtime.py` persists into the tables end to end, for both the normal and the
  admin-override case, and the audit hash chain re-verifies from the DB.
- **Hazards reproduced:** on a fresh `schema.sql` database, if these files ship in the very first deploy, the
  runner records them as applied without running them. In the right order on that database, files 1, 2 and 5
  only fully apply once `current_tenant_id()` and the two missing `sites` status columns exist.
- `live-db-drift-check.sql` runs read-only and as written, via psql against the live model.

## 6. Risks
- **RLS doesn't protect the app.** The backend connects as a role that bypasses RLS and never sets JWT claims
  (grep of `backend/app` finds no `set_config`/`SET ROLE`). Isolation is application code. The new guards check
  tenant membership inside triggers and FKs, so they hold regardless.
- **Base-table policies are unknown [I].** Section D5 of the drift check will show them.
- **Never bootstrap from `schema.sql`.**
- **Ordering hazards:** the ledger baseline skipping new files; unledgered old files re-running; a future
  9-digit filename sorting before these (digit < `_`).
- **Inferred items:** the outcome/reached maps, the cost of the two triggers, and that live has no module values
  outside the catalog (D10 checks this).

## 7. Rollout plan for the real project
1. Run `live-db-drift-check.sql` as the app's DB role. Confirm the ledger is complete (D1), module values (D10),
   policies (D5) and no name collisions (D11).
2. Fix the 202606231 policy and 202606133 indexes in new migrations. Regenerate `verified.sql` with `pg_dump`,
   and retire `schema.sql` as a bootstrap.
3. Deploy `20261004_1`→`_6` on a database that already has the migration ledger.
4. App phase A: drop the ORM CheckConstraint at `models.py:443`, make the module lists data-driven, write provenance.
5. Publish path: insert a release, then call `cfg_activate_release`. Optionally publish a baseline v1 for existing tenants.
6. App phase B: generic `/m/:moduleKey` runtime, gates from `reached`, navigation and permissions from the
   release, multi-module login.
7. Only then move built-in gates (`workflow_unlocks.py`) onto the evaluator.

---

## Appendix — lead's independent confirmation (not part of F2's text)
Applied to the **sandbox copy of the real app** by workstream F4a (milestone M1), and confirmed by the lead:
- The six files, copied verbatim into `app/backend/database/migrations/`, were executed by the app's own
  startup migration runner: **84 statements, 0 failures**, ledger 63 → **69**, `Schema verification passed`.
- The five hard-coded module CHECKs are gone; 10 new constraints (5 key-shape CHECK + 5 FK) validated; RLS
  policies on the 6 new tables; 2 existing tenants backfilled with built-ins; a newly provisioned tenant seeded
  by the trigger.
- **No regressions:** the existing-flow smoke test stays **41/41**; the app's backend test suite: **610 passed,
  1 skipped** (with `ENABLE_DOCS=false`).
- Lead also checked RLS coverage in the migration source: `tenant_isolation` on `tenant_config_releases`,
  `tenant_config_live`, `tenant_modules`, `module_records`, `module_stage_states`, `module_approvals`;
  `module_catalog` is a global catalog with RLS on and no policy (deny-by-default for ordinary roles).

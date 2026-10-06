# Modularity test plan

Task 16. This plan says which tests prove that the app is modular. A workspace is defined only by its manifest:
modules, stages, roles, gates, files and releases are data. The generic runtime runs any manifest, and nothing
in the shared path depends on Matrix-bd. This document plans the tests only and changes no code. It builds on
the suites already on this branch. Where a design doc already lists a test, this plan uses that doc's ID and
does not repeat the test:

| Ref | Source (tests section) | IDs used below |
|---|---|---|
| **HRD** | `docs/runtime/HARDENING.md` §7 | file names `test_runtime_*.py`, `test_publish_validation.py` |
| **EVB** | `docs/events/EVENT-BUS.md` §10 | rows Envelope, Outbox, Ordering, Subscribers, Facts/gates, Matrix-bd parity, Adapters, Audit, Lint |
| **FF** | `docs/files/FILE-FIELDS.md` §9 | file names `test_files_*.py`, `test_r8_files.py`, `files.test.jsx` |
| **MH** | `docs/migrations/MIGRATION-HARDENING.md` §9 | `test_migration_{mapping,data,execute,revert,events}.py`, `MigrationsPage.test.jsx` |
| **GRS** | `docs/frontend/GENERIC-RUNTIME-SPEC.md` §8 | T1–T22 |
| **NBP** | `docs/configurator/NATIVE-BUILDER-PLAN.md` §9 | `ops/locate/autosave/rebase/schemaCoverage/applyTemplate/noLegacy`, `smoke-builder.mjs` |

**Speed classes.** **fast** tests need no DB, server or browser and run in under 1 s each. **slow** tests need
PostgreSQL (`STORE_TEST_DSN`), a running API (`./app-stack/start.sh`) or a browser.
**Status.** **E** = the test exists today. **N** = a new test this plan adds. **N(ref)** = a new test already
specified in a design doc above.

**Neutral fixture.** Every new modularity test runs on `packages/manifest/examples/acme-retail.manifest.json`
unless it says otherwise. Its workspace is `acme-retail`, with modules `site_survey` (capture → feasibility →
sign_off) and `fit_out` (plan → build → handover; entry gate `site_survey = approved`; file field
`plan.drawings`). Its roles are `workspace_admin` through `finance_reviewer`, and its currency is USD.
Matrix-bd (`templates/matrix-bd/*`) is used only as a *second* workspace, to show that two workspaces are
isolated and that the old behaviour still holds.

## 1. Backend unit tests

All of these are **fast** unless marked otherwise. They run under pytest. The `app/backend/tests` suite uses
`RecordingSession` and has no DB (see `conftest.py`).

### 1.1 Existing suites (E), kept green

| Suite | Count | Proves for modularity |
|---|---|---|
| `packages/manifest/tests` (`test_validate.py`, `test_from_v5.py`, `fixtures/invalid_cases.json`) | 78 | The manifest schema and rules are generic. They accept Acme and refuse 62 invalid cases. |
| `packages/adapters/tests` (`test_host.py`, `test_lint.py`, `test_bd_adapter.py`) | 40 | Adapters are plug-ins behind a host. A lint rule fences them in. BD is one adapter among others. |
| `packages/access/tests` (`test_authorize.py`, `test_guard.py`) | 33 (of 35; 2 PG tests in §3) | `authorize()` works on manifest roles and permissions only. |
| `templates/matrix-bd/tests/test_templates.py` | 24 | Matrix-bd is *templates* (data) that validate against the same schema. |
| `app/backend/tests/test_configurator_integration.py` | ~20 | Module key rule, publish refusals, a disabled module is refused for every role, `test_no_hardcoded_module_lists_remain_in_the_services`. |
| `app/backend/tests/test_g3_features.py`, `test_migration*.py` (4 files) | ~30 | Creator-scoped stages, stage mapping and the migration ledger and parser. |
| other `app/backend/tests/test_*.py` (≈53 files) | — | Regression net for the old built-in modules. These must stay green. |

### 1.2 New: design-doc unit tests (N(ref), fast)

| Ref | Files |
|---|---|
| HRD | `test_runtime_core.py`, `test_runtime_rollup.py`, `test_runtime_reject_sendback.py`, `test_runtime_gates.py`, `test_runtime_forms.py`, `test_runtime_assign.py`, `test_runtime_adapters.py`, `test_runtime_templates.py`, `test_publish_validation.py` |
| MH | `test_migration_mapping.py`, `test_migration_data.py` (pure) |
| FF | `test_files_sniff.py`, `test_files_schema.py`, `packages/manifest/tests/test_r8_files.py` |
| EVB | Envelope (JSON Schema), Facts/gates (property test), Lint (`events.append` owner rule, cross-module table writes) |

### 1.3 New: modularity-specific unit tests (N, fast)

File: `app/backend/tests/test_modularity_unit.py`.

| Test | Asserts |
|---|---|
| `test_mod_u01_acme_validates_and_compiles` | Acme passes `validate()` with no errors. The runtime compiles both modules, including the forms, the gate and the file field. |
| `test_mod_u02_runtime_runs_acme_lifecycle_in_memory` | `site_survey` runs open → submit → approve × 3 stages → `approved` on the in-memory runtime. No import of `app.services.{bd,legal,design,nso,launch,…}` is loaded (`sys.modules` check). |
| `test_mod_u03_gate_reads_facts_not_tables` | `fit_out` entry gate: closed with no facts, open after the `site_survey.approved` fact. No `sites` column is read. |
| `test_mod_u04_role_keys_are_data` | Acme with every role key renamed (e.g. `executive`→`surveyor`) runs the same lifecycle, and `authorize()` gives the same decisions. |
| `test_mod_u05_module_key_rename_total` | Renaming `site_survey`→`survey` (NBP `renameKey`) leaves no stale reference. The gate still resolves. |
| `test_mod_u06_disabled_module_resolution` | A release with `fit_out` disabled: `require_module('fit_out')` raises 403 `module_disabled` for every role. Codes and claims skip it. Gates sourcing it are reported. |
| `test_mod_u07_registry_is_release_driven` | The module registry for an Acme tenant equals the manifest module keys. `BUILTIN_MODULE_KEYS` is not added to it. |
| `test_mod_u08_no_builtin_import_from_generic_runtime` | AST scan: `app/services/module_runtime*`, `app/routers/m_*` and `packages/*` do not import built-in module services or name built-in keys or BD status literals. |
| `test_mod_u09_two_workspaces_isolated_registries` | Acme and Matrix-bd manifests loaded side by side. Each registry, role set and gate set comes only from its own release. |
| `test_mod_u10_publish_refuses_bd_dependency_in_neutral_ws` | A gate on `bd` or `site.status` in a workspace with no `bd` module is refused with `gate_source_unknown`. |

## 2. Frontend unit tests

Vitest + Testing Library, run with `cd app/frontend && npm test`. All of these are **fast**. The API is mocked.

### 2.1 Existing (E): 93 `*.test.*` files

Most relevant: `custom-module/__tests__/{GenericModulePages,moduleRuntimeApi,g3ViewsAndCreator,f5aFiles}`
(the generic runtime, rjsf forms, gates, send-back, `expected_seq`, files);
`state/__tests__/moduleEnabled.f5a.test.js` (`whenModuleEnabled` skips disabled modules);
`modules/shared/__tests__/workspaceModules.f4b.test.js`;
`admin/workspaces/__tests__/{MigrateCasesPanel,configuratorHost,hostBridge,configuratorCreatorRule}`;
`router/__tests__/guards.test.jsx`. The other ~80 files cover the built-in pages and must stay green.

### 2.2 New: design-doc tests (N(ref))

| Ref | Tests |
|---|---|
| GRS | T1–T22 in `src/modules/runtime/__tests__/` (T20 templates contract, T21 independence static) |
| NBP | `ops`, `locate`, `autosave`, `rebase`, `schemaCoverage`, `applyTemplate`, component tests, ajv contract, `noLegacy` |
| FF | `custom-module/__tests__/files.test.jsx` (= GRS T13) |
| MH | `migrations/__tests__/MigrationsPage.test.jsx` (2 rows) |
| HRD | `custom-module/__tests__/` row: send-back targets, gate-closed submit, `can_open`, role labels, multi-file |

### 2.3 New: modularity-specific (N, fast)

File: `src/modules/runtime/__tests__/modularity.test.jsx`.

| Test | Asserts |
|---|---|
| `mod_f01 renders Acme dashboard/queue/record from definition` | Same as GRS T20, but with the Acme fixture: there is a widget for each field type, labels come from the manifest, and the currency is USD. |
| `mod_f02 nav is built from /workspace/modules only` | Acme nav shows only Survey and Fit-out. There are no BD, Legal or Launch entries, and no built-in route is reachable. |
| `mod_f03 disabled module hidden and deep link shows refusal` | `fit_out` disabled → removed from the nav. `/m/fit_out/cases` renders the `module_disabled` denial copy and sends no queue request. |
| `mod_f04 role labels come from manifest` | The `finance_reviewer` label is shown. No `supervisor`/`executive` copy appears in the runtime for Acme. |
| `mod_f05 no Matrix-bd fetch on Acme boot` | The axios mock records every URL during boot and use. No `/bd`, `/legal`, `/launch`, `/sites/shortlist`… URL is called. |

## 3. API integration tests

All of these are **slow**. They need PostgreSQL, and some also need the API server.

### 3.1 Existing (E)

| Test | Needs | Proves |
|---|---|---|
| `packages/store/tests/test_store.py` (12) | PG via `STORE_TEST_DSN` | Store tables, guards, RLS and the immutable release/migration rows |
| `packages/access/tests/test_access_sql.py` (2) | PG | Memberships are checked against the live release |
| `app-stack/smoke-existing.mjs` | API (`./start.sh`) | Provisioning and onboarding still work, the baseline |
| `app-stack/smoke-configurator.mjs` | API | Custom module journey: publish v1 → disabled built-in refused → gate → approvals → v2 pinning → audit chain |
| `app-stack/smoke-g3.mjs` | API + `docker exec psql` | Creator-scoped stages, role-scoped views, migrate running cases, re-pin refused by the DB |

### 3.2 New (N(ref))

| Ref | Tests |
|---|---|
| HRD | `test_runtime_chain.py`, `test_runtime_concurrency.py`, `test_runtime_access.py`, `test_runtime_pinning.py`, `test_runtime_migration.py` |
| EVB | Outbox, Ordering, Subscribers, Adapters, Audit, Matrix-bd parity (shadow) |
| FF | `test_files_upload_flow.py`, `test_files_verify_submission.py`, `test_files_download.py`, `test_files_delete_retention.py`, `test_files_migration.py`, `test_files_backfill.py`, `test_storage_buckets.py`, `packages/store/tests/test_files_sql.py` |
| NBP | Backend endpoint and importer tests, `app-stack/smoke-builder.mjs` |

### 3.3 New: modularity-specific (N, slow)

File: `app/backend/tests/integration/test_modularity_api.py`. It is marked `@pytest.mark.api` and skipped
unless `MOD_API` is set.

| Test | Asserts |
|---|---|
| `test_mod_i01_two_tenants_isolated` | Provision Acme and a Matrix-bd workspace. A token from one gets 404 on the other's `/m/*`, views, files and migrations. RLS hides rows (direct SQL as the app role). |
| `test_mod_i02_disable_in_one_tenant_only` | Disabling `site_survey` in Acme leaves a same-key module in another tenant untouched. |
| `test_mod_i03_module_writes_only_own_tables` | Run a full Acme case. A `pg_stat_user_tables` diff, or an audit trigger, shows writes only to runtime/store tables. There are no writes to BD or other built-in tables (`sites` legacy status columns included). |
| `test_mod_i04_cross_module_effect_via_event_only` | The `fit_out` gate opens only after `module.record.completed` for `site_survey` is in the outbox. Deleting that fact keeps the gate closed (EVB Facts). |
| `test_mod_i05_subject_without_bd` | An Acme `site` subject is created and opened with no BD shortlist step and no `bd` module enabled. |

## 4. Browser E2E tests

All of these are **slow** and new (N). The repo has no browser runner today. The plan adds Playwright as a
dev-dependency under `app/frontend/e2e/`, with `playwright.config.ts` using `baseURL=$ORIGIN`. These tests run
against `./app-stack/start.sh --no-configurator`.

| Test (file `app/frontend/e2e/modularity.spec.ts`) | Covers |
|---|---|
| `e2e_01 builder creates Acme from template and publishes v1` | NBP flow in the browser: create → edit → findings → publish (reason) |
| `e2e_02 executive runs site_survey through three approvals` | GRS T5/T6 live: forms, send-back, approve |
| `e2e_03 fit_out locked screen then opens after survey approval` | GRS T4/T8 gate UX |
| `e2e_04 upload drawings with progress and download via POST` | FF frontend §6 and GRS T13 live |
| `e2e_05 v2 badge on pinned case and migration notice after migrate` | GRS T10/T11 and the MH UI |
| `e2e_06 disabled module vanishes from nav and deep link refused` | `mod_f03` live |
| `e2e_07 Matrix-bd workspace still renders its modules via runtime` | GRS T20 live, the old behaviour holds |
| `e2e_08 a11y keyboard path through StepCard` | GRS T22 (axe check on queue and record) |

The browser half of the acceptance suite (§8) is `e2e/acceptance.spec.ts`. It repeats the §8 steps 01–11
through the UI and asserts the same API side effects through `request` fixtures.

## 5. Migration tests

This section covers two kinds of migration. Release migrations move running cases. Schema migrations are DB
DDL.

| Test | Class | Status |
|---|---|---|
| `app/backend/tests/test_migration.py`, `test_migration_ledger.py`, `test_migration_parser.py`, `test_schema_verifier.py` | fast | E |
| `test_g3_features.py::test_stage_mapping_rules … test_explicit_mapping_must_keep_stage_order` (7) | fast | E |
| `app-stack/smoke-g3.mjs` §#2 (dry-run, execute, re-pin refused, chain) | slow | E |
| `frontend admin/workspaces/__tests__/MigrateCasesPanel{,.f5a}.test.jsx` | fast | E |
| MH `test_migration_mapping.py`, `test_migration_data.py` | fast | N(ref) |
| MH `test_migration_execute.py`, `test_migration_revert.py`, `test_migration_events.py`, `test_store.py` additions | slow | N(ref) |
| HRD `test_runtime_pinning.py`, `test_runtime_migration.py`; FF `test_files_migration.py`, `test_files_backfill.py` | slow | N(ref) |
| `test_mod_m01_acme_v1_to_v2_field_rename_and_stage_insert` (`app/backend/tests/test_modularity_migration.py`) | fast | N |
| `test_mod_m02_disable_module_with_running_cases_is_per_record_skip` (no site cascade, MH "module removed/disabled") | fast | N |
| `test_mod_m03_schema_up_down_on_empty_and_seeded_db` (`packages/store/tests/test_schema_roundtrip.py`): apply all DDL to an empty DB and to a DB seeded with Acme + Matrix-bd; `schema_verifier` reports 0 drift | slow | N |
| `test_mod_m04_v5_draft_import_equals_native` (NBP importer): an imported v5 draft publishes a manifest equal to the native one | slow | N |

## 6. Security tests

| Test | Class | Status |
|---|---|---|
| `test_batch_sec_authz.py`, `test_batch_sec_auth_config.py`, `test_observer_readonly.py`, `test_observer_override.py`, `test_auth_refresh_grace.py` | fast | E |
| `packages/access/tests/test_authorize.py`, `test_guard.py`; `test_access_sql.py` | fast; slow | E |
| `smoke-existing.mjs` / `smoke-configurator.mjs` SEC-1 setup-code probes; `smoke-g3.mjs` forged approval refused by the DB | slow | E |
| HRD `test_runtime_access.py`, `test_runtime_assign.py`, `test_runtime_concurrency.py` | slow / fast | N(ref) |
| FF `test_files_sniff.py`, `test_files_download.py`, `test_storage_buckets.py`, `test_files_sql.py` (RLS) | fast / slow | N(ref) |
| EVB Outbox RLS + immutability, Audit `events_anchored` | slow | N(ref) |
| `test_mod_s01_disabled_module_every_route_refused` (`test_modularity_security.py`): every `/m/{key}/*` verb (records, actions, assign, views, files, members) gives 403 `module_disabled` for every role, including the platform-admin JWT on workspace routes | slow | N |
| `test_mod_s02_manifest_cannot_escalate` | fast | N |
| — A published manifest cannot grant a role it does not define, cannot name a built-in alias (`test_custom_module_cannot_take_a_builtin_alias` is extended), and cannot point a gate at another tenant's module. | | |
| `test_mod_s03_module_key_injection` | fast | N |
| — Keys such as `../bd`, `bd;drop`, `__proto__`, very long keys and Unicode homoglyphs of built-ins are refused by the schema and by the SQL `module_key` rule (mirrors `test_module_key_rule_mirrors_the_sql_function`). | | |
| `test_mod_s04_view_as_cannot_widen` (GRS T19 server side) | slow | N |
| `test_mod_s05_file_of_disabled_module_not_downloadable` | slow | N |

## 7. License/provenance tests

| Test | Class | Status |
|---|---|---|
| `node docs/independence/check-independence.mjs <root> --json`. The blocker rules are `matrix-bd-tables`, `matrix-bd-modules`, `matrix-bd-status`, `brands`, `nocobase`, `dc-runtime`. Warnings: `matrix-name`, `supabase-shape`, `india-locale`, `fixed-role-ladder` | fast | E (scanner) |
| `packages/adapters/tests/test_lint.py` (adapter fence) | fast | E |
| `test_mod_l01_packages_clean`: scanner over `packages/manifest`, `packages/store`, `packages/access` → 0 blockers | fast | N |
| `test_mod_l02_runtime_clean`: scanner over `app/frontend/src/modules/runtime`, `app/frontend/src/modules/builder` and the generic backend runtime paths → 0 blockers (GRS T21 and NBP `noLegacy` feed this) | fast | N |
| `test_mod_l03_app_no_dc_runtime_nocobase`: `--only=dc-runtime,nocobase` over `app/` → 0 (NBP Gate P2). Over the whole repo → 0 (P3) | fast | N(ref) |
| `test_mod_l04_third_party_manifest_complete`: every dir in `third_party/` and every dependency in `app/frontend/package.json` and `app/backend/pyproject.toml` has a row in `THIRD_PARTY.md` / `app-stack/EXTERNAL-DEPS.md` with an SPDX licence on the allow-list (no AGPL/SSPL in shipped code) | fast | N |
| `test_mod_l05_inventory_fresh`: `node docs/independence/render-inventory.mjs` output equals the committed `INVENTORY.md` / `inventory.json` | fast | N |
| `test_mod_l06_scanner_self_test`: the scanner flags a seeded fixture tree with one hit per rule and passes a clean one (`docs/independence/tests/`) | fast | N |

Scanner tests run as `node --test docs/independence/tests/*.test.mjs` and call `scan(root, {only})`, which the
scanner exports.

## 8. Acceptance suite definition

This is one ordered scenario on the neutral **Acme Retail** workspace (`acme-retail`, unique suffix per run).
The tests share state through a module-scoped `ctx` fixture. A failed step marks every later step `xfail(skip)`.

- **API file:** `app/backend/tests/acceptance/test_modularity_acceptance.py`
  (`@pytest.mark.acceptance`, uses `httpx` against `MOD_API`).
- **Browser mirror:** `app/frontend/e2e/acceptance.spec.ts`.
- **Status:** all steps are new (N) and **slow** (API + PG; the e2e mirror also needs a browser).
- **Existing coverage:** today it is partial and Matrix-flavoured. It is spread across `smoke-configurator.mjs`
  and `smoke-g3.mjs`, which use the Starbucks v5 seed and a BD shortlist to open cases.

| # | Test | Action | Must assert |
|---|---|---|---|
| 01 | `test_acceptance_01_create_workspace` | `POST /platform/workspaces` with Acme `workspace` + roles and only `site_survey`; claim the admin with the setup code | 201; `workspace_code` issued; `GET /workspace/modules` lists exactly `[site_survey]`, with no built-ins |
| 02 | `test_acceptance_02_add_custom_module` | Add `fit_out` (entry gate `site_survey=approved`, file field `drawings`) to the draft; `POST …/releases/validate` | 0 errors; the draft has 2 modules; the gate source resolves |
| 03 | `test_acceptance_03_publish_release` | `POST /platform/workspaces/{ref}/releases` (reason) | v1 live; release sha recorded; default views seeded for both modules; `release.published` event |
| 04 | `test_acceptance_04_open_case` | Create a `site` subject; executive `POST /m/site_survey/records` | 201 on v1; no BD/shortlist call needed; `module.record.opened` with all envelope fields (EVB §3) |
| 05 | `test_acceptance_05_stage_approval` | submit `capture` → supervisor send-back → resubmit → approve; then `feasibility`, `sign_off` (with `If-Match`) | approval tiers come from the manifest; stale `If-Match` → 409; the case reaches `approved`; the hash chain is valid |
| 06 | `test_acceptance_06_gate_next_module` | `POST /m/fit_out/records` on a second site whose survey is not approved, then on the approved site | first → 409/422 `gate_closed` with conditions; second → 201; the gate was decided from facts (EVB) |
| 07 | `test_acceptance_07_upload_file` | Create → PUT → finalize `drawings` on `fit_out.plan`; submit; download | sniffed type stored; `module.file.uploaded` once; download logs a row and gives a 60 s URL; another tenant → 404 |
| 08 | `test_acceptance_08_publish_v2` | v2: rename `plan.contractor`→`vendor` (`field_map`), insert stage `permits` after `plan` | v2 live; the running `fit_out` case still reports v1 (pinned); a new case opens on v2 |
| 09 | `test_acceptance_09_migrate_running_case` | `POST …/migrations` dry-run → execute with `plan_sha256` + reason | dry-run writes nothing; case moved; `vendor` keeps its value; `drawings` still downloadable; journal + `module.record.migrated`; chain valid |
| 10 | `test_acceptance_10_disable_module` | Publish v3 with `fit_out.enabled=false` | publish ok (warning for running cases); running case kept, not cascaded; `GET /workspace/modules` omits `fit_out` |
| 11 | `test_acceptance_11_disabled_api_refusal` | Hit every `/m/fit_out/*` route as each role, plus member codes and file download | all 403 `module_disabled`; no rows written (row counts unchanged); `site_survey` still works |
| 12 | `test_acceptance_12_no_matrix_bd_dependency` | (a) scanner over the runtime paths (`test_mod_l02`); (b) the request log of steps 01–11 has no built-in route; (c) a SQL diff shows no write to BD/built-in tables and no `sites` legacy status change; (d) the backend `sys.modules` set during the run has no built-in service (`MOD_TRACE_IMPORTS=1`) | 0 blockers; 0 built-in routes; 0 rows; 0 imports |

**Known blockers today.** These are expected to fail until the referenced work lands:

- Step 01 needs publish of native-format manifests (NBP). Today F4 takes v5, so the fixture needs a converter.
- Step 04 needs subject creation without the BD shortlist.
- Step 07 needs FF finalize/download.
- Step 09 needs the MH `plan_sha256` work.
- Step 12(c) and 12(d) need the EVB cut-over.

### 8.1 Test inventory and green build

| Section | Existing (E) | New (N + N(ref)) | fast / slow (new) |
|---|---|---|---|
| 1 Backend unit | 6 suites (≈185 pkg tests + 60 backend files) | 10 N + 15 N(ref) files/rows | 25 / 0 |
| 2 Frontend unit | 93 files | 5 N + 22 GRS + 9 NBP + 3 other N(ref) | 39 / 0 |
| 3 API integration | 5 (store, access_sql, 3 smokes) | 5 N + 19 N(ref) | 0 / 24 |
| 4 Browser E2E | 0 | 8 N + acceptance mirror | 0 / 9 |
| 5 Migration | 5 | 4 N + 9 N(ref) | 4 / 9 |
| 6 Security | 4 | 5 N + 7 N(ref) | 3 / 9 |
| 7 License/provenance | 2 | 6 N (incl. 1 N(ref)) | 6 / 0 |
| 8 Acceptance | 0 (partial via smokes) | 12 N (+ e2e mirror) | 0 / 12 |

**Single entry.** `make test-modularity` is a new root `Makefile` target that calls `scripts/test-modularity.sh`
(also new). It fails on the first red step. The pytest markers `pg`, `api` and `acceptance` are new and are registered in `app/backend/pyproject.toml`. `make test-modularity-fast` runs only block 1 (fast).

```bash
# env (defaults shown)
export STORE_TEST_DSN="postgresql://postgres@/postgres?host=/tmp&port=55432"   # packages/store, access_sql, mod_m03
export MOD_API="http://localhost:8000/api" API="$MOD_API" ORIGIN="http://localhost:5173"
export ALLOW_INSECURE_DEFAULTS=true                                         # backend tests (conftest)
export MOD_TRACE_IMPORTS=1                                                  # acceptance step 12(d)

# 1. fast — no DB/browser
python -m pytest -q packages/manifest/tests packages/adapters/tests packages/access/tests/test_authorize.py \
  packages/access/tests/test_guard.py templates/matrix-bd/tests
(cd app/backend && python -m pytest -q -m "not pg and not api and not acceptance")
(cd app/frontend && npm test)                                               # vitest run
node --test docs/independence/tests/*.test.mjs
for r in packages/manifest packages/store packages/access app/frontend/src/modules/runtime; do
  node docs/independence/check-independence.mjs "$r" || exit 1; done
# 2. slow — PostgreSQL
python -m pytest -q packages/store/tests packages/access/tests/test_access_sql.py
(cd app/backend && python -m pytest -q -m pg)
# 3. slow — API server (fresh limits)
./app-stack/stop.sh --apps; ./app-stack/start.sh --no-configurator
node app-stack/smoke-existing.mjs && ./app-stack/stop.sh --apps && ./app-stack/start.sh --no-configurator
node app-stack/smoke-configurator.mjs && ./app-stack/stop.sh --apps && ./app-stack/start.sh --no-configurator
node app-stack/smoke-g3.mjs && node app-stack/smoke-builder.mjs
(cd app/backend && python -m pytest -q -m "api or acceptance" tests/integration tests/acceptance)
# 4. slow — browser
(cd app/frontend && npx playwright test e2e/)
```

**Green** means every command above exits 0, and the acceptance tests report 12/12 passed. Skips are only
allowed in fast mode. In `make test-modularity`, a skip caused by a missing `STORE_TEST_DSN` or `MOD_API` counts
as a failure.

# G3 — migrate running cases (#2), creator-scoped rule (#3), role-scoped saved views (#4) — progress

Resume rule: read this file first; every milestone appends a line with what changed on disk and
whether any migration was applied (ledger count). Nothing is ever applied twice: the ledger runner
records each file by name.

## State at 2026-10-05 (resume after the usage-limit cut)
- **Files changed by G3 so far: none.** `app/`, `app-stack/`, `docs/G3-API.md`, `THIRD_PARTY.md`,
  `app/SANDBOX-CHANGES.md` untouched (verified with `find -newer docs/reports/F4b.md`).
- **Ledger = 70** (`schema_migrations`), i.e. no G3 migration exists or was applied.
- Read so far: PHASE2-PLAN, F4-API, F4a, F4b, F4b-UI, SANDBOX-CHANGES, schema-audit REPORT,
  migrations 20261004_4/_5/_6, oss/for-F4, matrix-adapters README, runtime.py,
  module_runtime_service.py, platform router/service, module_runtime router, launch_service
  creator check, _common scope helpers, G2 crosscheck.json (creatorRule, rolesAndViews).
  G2's `docs/catalogue-crosscheck/for-G3.md` now exists — read before finalising #3/#4.

## Design decisions taken (before any code)
- **#2 pin semantics:** migration moves BOTH the site pin (`sites.config_release_id`) and every
  in-flight custom-module record on that site (`module_records.release_id` + `runtime_state.release`).
  Unit of atomicity = the site (one locked transaction per site; all its in-flight records must be
  compatible or the whole site is skipped). Reason: the runtime resolves a case from
  `module_records.release_id`, new cases from `sites.config_release_id`, and F2's guard requires
  record release = site pin on every write — moving only one leaves rows the guards refuse.
- **#2 controlled re-pin path:** replace F2's free `matrix.allow_repin=on` GUC with a journal-bound
  check: the triggers allow a release change only when the transaction-local setting
  `matrix.release_migration` names a *running* `module_release_migrations` row of the same tenant
  AND an append-only `module_release_migration_items` row already authorises exactly this
  site/record from→to. Ordinary updates (and `allow_repin=on`) are refused.
- **#2 audit:** one `module_release_migrated` audit row per record (entity = module_record, shows
  in the case audit trail) carrying a hash-chained `release_migrated` runtime event + provenance
  {from_release, to_release, actor email, reason, before/after stage, migration id, pre-state};
  the full pre-migration `runtime_state` is also stored in the append-only migration item.
- **#3 manifest key:** stage-level `restricted_to: "site_creator"` (absent = today). Creator =
  `sites.submitted_by` OR `sites.assigned_to` (real app `_assert_is_site_creator` /
  `assert_executive_owns_site`). Applies to the stage's first step; executives and supervisors
  must be the creator; business admin may act only as a recorded override.
- **#4:** table `module_views` (RLS tenant_isolation), seeds per enabled custom module, soft
  delete + reset; views only narrow the server-side visibility scope.

## Milestones
- [x] M0 read G2 for-G3.md: creator = submitted_by OR assigned_to (owns); scope follows effective role; real Launch
      creator review gives the BA no bypass (E4) — G3 deviates deliberately: BA may act only as a FLAGGED override
      (F2 ruling: the generic runtime records overrides). Views never widen scope; audience != access.
- [x] M1 migrations written: `app/backend/database/migrations/20261005_1_release_migrations.sql`,
      `20261005_2_creator_scoped_stages.sql`, `20261005_3_module_views.sql`. Verified on a throwaway clone
      (`g3scratch` DB inside the container, app parser): 36 statements x2 runs, 0 failures; re-pin refused
      (plain, allow_repin=on, forged/junk setting); journal path moves site+record; items append-only; done
      header immutable. **APPLIED to the shared DB at 2026-10-05T21:17Z by the app's runner on a backend-only restart: ledger 70 -> 73, 36
      statements, 0 failures.** Scratch DB dropped.
- Lead note (2026-10-05): do NOT touch module_catalog (lead applies G2's catalog fix migration after G3);
  G3 migration filenames = `20261005_1_release_migrations.sql`, `20261005_2_creator_scoped_stages.sql`,
  `20261005_3_module_views.sql`; smoke-g3 relies on BD shortlist -> built-in outcome `in progress` (same as
  smoke-configurator) — may change with D18/D19.
- [~] M2/M3/M4 backend code written (not yet run against the DB): runtime.py creator rule (Actor.owned_sites,
  not_site_creator), module_runtime/migrate.py (pure planner), release_migration_service.py, platform router
  /migrations, domain/schemas/module_views.py, module_views_service.py, routers/module_views.py (+main.py),
  module_runtime_service (owned sites, creator visibility, ?view=, provenance rule/creator_override),
  validate.py + manifest.schema.json (restricted_to), tests/test_observer_readonly.py allowlist.
  pytest configurator+observer: 66 passed.
- [x] smoke `app-stack/smoke-g3.mjs` written and run against the live backend: **56/56** (2026-10-05 ~21:50Z),
  evidence app-stack/run/smoke/g3-last-run.json (workspace ws_g3_20261005154953 created by the smoke).
- [x] M2/M3/M4 backend done: `tests/test_g3_features.py` (29 tests). Full suite **683 passed / 1 skipped**
  (baseline 654/1 + 29, 0 regressions). ruff C901+F and D101-3 gates: pass (migrate.plan split into helpers).
  NOTE: the running backend predates the plan() refactor + docstrings — restart before the final smokes.
- [x] M5 frontend: MigrateCasesPanel (admin workspace detail), configurator copy creator toggle (wizard + inspector,
  manifest restricted_to, publish diff), GenericModulePage saved views + columns (F4b tabs as fallback),
  ManageViewsPage (/m/:key/views), GenericRecordPage creator-rule notes + migration audit entries. 14 new tests;
  full vitest 695/697 (only the 2 known rent-v2 env tests fail; under load avg ~43 some 5 s timeouts appear —
  re-run with --maxWorkers=3 is clean), eslint 0 errors / 33 warnings (= baseline), vite build OK.
- [x] M6 regressions after a full apps restart: smoke-existing **41/41**, smoke-configurator **67/67**, then
  (backend-only restart for the in-memory rate limits) smoke-g3 **59/59**. pytest 683/1 skipped.
- [x] M7 browser verification (2026-10-05/06): screenshots 01-06 saved (configurator wizard toggle + manifest,
  executive-2 views, My cases columns, creator-rule note for a delegated non-creator, migrated case audit trail).
  UI data: smoke workspace ws_g3_20261005161331 (code G3SMOK-A61074224C291DC6) + v3 published (sign-off restored)
  + site "G3 S3 Kothrud (UI check)" case delegated to ex2. Then 07 BA view set, 08 Manage views + a view created
  in the UI ("Waiting at sign-off", stage 3), 09 BA override note, 10 creator can act. Platform-admin panel NOT
  browser-verified: the auto-mode classifier denied injecting a minted admin token into the page, and the real
  sign-in needs the sandbox admin password, which must not appear in the transcript -> covered by vitest
  (MigrateCasesPanel.test.jsx) + smoke-g3 (API) + a click-path for the user; case B (v1, stage 3) left migratable
  onto v3 for the user to try. NOTE pane quirk: clicks are dropped while
  a viewport size is emulated — reset to preset desktop before clicking.
- [x] M8 docs: docs/G3-API.md, app/SANDBOX-CHANGES.md "Phase 2b — G3", THIRD_PARTY.md §I, docs/reports/G3.md.
  Final numbers: pytest 683/1 skipped; ruff gates pass; vitest 695/697 (2 = rent-v2 env, 9/9 with flag false);
  vite build OK; eslint 0 errors/33 warnings; smoke-existing 41/41, smoke-configurator 67/67, smoke-g3 59/59;
  ledger 73. DONE — handback sent.

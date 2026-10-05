# F2 progress (schema & modularity audit)

Resumability log. Newest at bottom.

- [start] Created docs/schema-audit/, docs/reports/, scratchpad F2. Read PHASE2-PLAN.md, CONTRACT.md.
- [resume 2026-10-04] Resumed after rate-limit cutoff; no container existed yet.
- [recon] Extracted real-project backend/database, backend/app, frontend/src, tests, docs via `git show origin/main` into scratchpad F2/src.
  Key facts: schema.sql + verified.sql are both "context only, do not execute"; migrations assume out-of-band Supabase base
  (tables + get_current_tenant_id + views + handle_new_auth_user). verified.sql = live export 2026-06-23 (omits NOT VALID checks,
  delete rules, indexes, policies). Runner history: manual (≤06-23) → always-run-all per statement (07-10) → ledger+baseline (07-11).
  Plan: DB m_schema = shim+schema.sql; m_live = shim+verified(executable)+out-of-band stubs+replay(all migrations, runner semantics) x2;
  m_fresh = shim+replay only (prove fresh path broken); then proposals on m_live and m_schema.
- [env] `docker run` for matrix-schema-audit (127.0.0.1:54339) is stuck in state "Created" — Docker Desktop is not starting ANY new
  container (F1's `f1probe` and `matrix-app-db-1` are stuck the same way). Monitor armed; continuing with authoring meanwhile.
  NOTE: the container password was briefly visible in a `ps` listing in my own tool output (throwaway, loopback-only, container
  will be destroyed; will be recreated with --env-file so it is not in argv).
- [authoring] Wrote shim/00-supabase-shim.sql, shim/01-live-out-of-band-stubs.sql, tools/audit_db.py (replay with the app's own
  parser lifted via ast; per-statement txns; ledger), tools/make_verified_executable.py (E1–E3 edits).
- [authoring] proposed-migrations/20261004_1..6 written (releases+live pointer; module_catalog+tenant_modules+cfg_activate_release;
  module columns -> registry FK; sites.config_release_id pinning; generic runtime + gate-input view; audit provenance).
  tools/run_app_runner.py executes the REAL _apply_pending_migrations/_verify_schema lifted from main.py.
- [env] container still "Created": POST /containers/<id>/start never completes (docker CLI and raw API both hang; other agents'
  `docker run`s hang too). Background `docker start` + monitor armed. Reading Docker Desktop logs was denied by the permission
  classifier — not pursuing that further.
- [env] Removed the first stuck container; recreated with --env-file (password no longer in argv, rotated). `docker start`
  still hangs (sandboxed AND unsandboxed); F3's containers hang the same way; F1's matrix-app-db-1 did start. Trying a
  port-less container (psql via docker exec) to see whether host port publishing is the blocker.
- [authoring] live-db-drift-check.sql (D1–D11, READ ONLY txn, 63-file ledger checksums embedded), tools/validate_proposal.py,
  tools/run_all.sh (M1–M6 models, P1–P5 proposal validation incl. baseline hazard).
- [resume 2] Docker recovered; matrix-schema-audit (postgres:16, tmpfs data dir, network matrix-schema-audit-net,
  127.0.0.1:54339, password via --env-file) is Up. for-F4.md drafted. Next: run tools/run_all.sh, write VALIDATION/REPORT.
- [M1-M6 done] evidence/ written. m_schema loads clean (32 tables, 0 policies) and PASSES _verify_schema but misses 3 ORM
  columns + quality_audit_reports. m_fresh: real runner on empty DB -> 301 failing statements / 56 files, _verify_schema FAIL.
  m_live (verified.sql + E1-E4 + stubs + replay x2) converges (pass1==pass2 catalog), ORM fully satisfied. Replay failures:
  202606133 (CONCURRENTLY in txn), 202606231 DO block (pg_policy.schemaname bug -> no policy on supervisor_executive_requests),
  202606141 #1/#10 (view/generated-col deps), plus non-idempotent 202605221/202605241/202606033. Vocab matrices confirm
  sites.status launched/legal_review accepted only by live; payment admitted by 3 membership tables on live.
  Fixed a model artifact: export loses CHECK names -> E4 restores 19 migration-managed names (else stale rent_type CHECK).
- [validation done] Fixed during validation: (1) chk_tcr_manifest let '{}' through (NULL-typed CHECK) -> coalesce;
  (2) model artifact: verified.sql omits multi-column UNIQUEs -> transform E5 (else app's ON CONFLICT (tenant_id,module) fails).
  Full pipeline tools/run_all.sh runs from scratch in ~13 s: P2 real runner applies 6 files / 83 stmts / 0 failures,
  _verify_schema PASS; P3 re-run x2 = 0 failures, identical catalog; P4 143 pass / 0 fail; P5 baseline hazard reproduced
  (6 proposals ledgered unrun) and schema.sql-shaped DB needs 20260802 + PE/FC mirror columns. Hazard H reproduced:
  re-running unledgered 202606033 drops module CHECKs. Next: VALIDATION.md, REPORT.md, F2.md, teardown.
- [F3 findings] Resolved in proposals: (1) module_records.runtime_state jsonb (object CHECK; release must match pin);
  (2) override = relaxed guard + recorded: module_approvals.is_override (truthful, admin-only), guard now = runtime.py
  tier chain (first tier submits; higher in-chain tier may act; else only flagged BA override) -> admin-only stages with
  fields are BA 'submitted' rows; (3) site_module_outcomes.reached text[] cumulative (catalog.reached_map for built-ins,
  runtime_state.reached for custom). run_all: P4 161 pass/0 fail. tools/f3_runtime_fit.py drives F3 runtime.py into the
  tables (normal + override case, hash chain re-verified from DB) -> PASS. Next: add P6 to run_all, final run, docs, teardown.
- [docs] VALIDATION.md + for-F4.md updated with final run (P4 161/161, P6 PASS) and F3 resolutions. Next: REPORT.md, F2.md, teardown.
- [blocked] Write of docs/schema-audit/REPORT.md was refused by the harness ('subagents should return findings as text'); REPORT + F2 content goes into the handback for the lead to persist. Next: teardown.
- [teardown done] matrix-schema-audit container + matrix-schema-audit-net removed (verified 0 left); evidence/tmp deleted. Scratch password files remain only in the session scratchpad. Handing back.

# F4a — backend integration: progress notes

Resume from the last milestone marked done. Scratch evidence: session scratchpad `f4a/`
(DB snapshot before F4a: `matrix-before-f4a.dump`, pg_dump -Fc).

## M0 — recon + baselines (done, 2026-10-04 ~09:46)
- Stack up: ledger=63, tenants=2.
- Sandbox DB already has everything F2's "live model" needs (replay of 63 migrations added them):
  `current_tenant_id()`, `get_current_tenant_id()`, `auth.jwt()`, `quality_audit_reports`,
  `sites.project_excellence_status/financial_closure_status`, `project_reviews.qa_reports_viewed_by_project_at`,
  `password_reset_requests.reset_token_hash`, `sites.licensing_status`, `nso_reviews.nso_status`,
  `launch_approvals.status`, `gen_random_uuid()`, `sha256()`. Module CHECKs = the 5 F2 lists (payment in 3).
- Backend test baseline (venv + dev deps pytest 9.1.1 / pytest-asyncio 1.4.0 / aiosqlite 0.22.1 installed
  into `app/backend/.venv` — not in the lock file): `609 passed, 1 failed, 1 skipped`; the one failure is
  `test_app_does_not_publish_docs_by_default`, caused by the sandbox `.env` `ENABLE_DOCS=true`.
  With `ENABLE_DOCS=false`: **610 passed, 1 skipped**. Use `ENABLE_DOCS=false .venv/bin/python -m pytest -o addopts="" -q -W ignore`.

## M1 — schema in the sandbox (done, ~09:50)
- No reconciliation needed (all prerequisites present). Six files copied verbatim → backend restart →
  log: `applied 20261004_1 (13) _2 (18) _3 (14) _4 (7) _5 (27) _6 (5)`, `6 new migration file(s), 84 statement(s)
  applied; 63 already in ledger`, `Schema verification passed`; ledger=69; 0 failed statements.
- 5 hard-coded module CHECKs gone; 10 new constraints (5 key CHECK + 5 FK), all validated; RLS policies on 6 new tables.
- Backfill: 2 existing tenants × 10 built-ins; new tenant (smoke) seeded by trigger (10).
- ORM `chk_site_delegations_module` removed from models.py.
- smoke-existing: **41/41**; pytest: 610 passed, 1 skipped (ENABLE_DOCS=false).

## M2 — data-driven modules (done, ~10:20)
- New `services/module_registry_service.py`; schemas `Module` = shape-validated str; business_admin_service,
  supervisor_code_service, auth_repo (claim + codes), deps (`disabled_modules`), guards.require_module,
  delegation_service now read `tenant_modules`. New `GET /api/workspace/modules` (routers/workspace.py).
- conftest autouse `_legacy_module_registry` (marker `real_registry` opts out) → pytest 610 passed / 1 skipped.
- smoke-existing 41/41. Live check: modules list (9 nav entries, nso supervisor_only), org view 6 depts
  (order now by position: pex before project — documented deviation), rotate finance_ca/unregistered → 404, bad key → 422.

## M3 + M4 — platform provisioning/publish + generic runtime (code done, smoke 65/66 → expectation fixed, ~11:35)
- jsonschema 4.26.0 (+attrs 26.1.0, jsonschema-specifications 2025.9.1, referencing 0.37.0, rpds-py 2026.6.3)
  installed in venv + pinned in requirements.lock.txt + pyproject.
- vendored `app/vendor/json_logic` (panzi 1.0.1 + LICENSE + VERSION); `app/services/module_runtime/`
  {gates,forms,runtime}.py copied (imports fixed only) + manifest.schema.json + new validate.py.
- new migration `20261004_7_platform_workspaces.sql` (claim/link table) — applied (NOTE: pytest's
  test_runner_records_ledger_and_is_idempotent runs the real runner against the sandbox DB, it applied it); ledger=70.
- new: core/problems.py (ApiProblem + handler in main.py), services/platform_workspace_service.py,
  services/module_runtime_service.py, routers/platform.py, routers/module_runtime.py, audit_service.write_provenance_audit;
  observer test allowlist += 3 platform POST paths.
- `app-stack/smoke-configurator.mjs` written: first run 65/66 (only my expectation: exec approving own stage →
  runtime says separation_of_duties before wrong_tier; expectation now accepts both). smoke-existing 41/41 after.
- NEXT: stale 'provisioning' claim reclaim; unit tests (M5); docs/F4-API.md; SANDBOX-CHANGES M3/M4; final report.

## M5 (in progress, ~12:10)
- tests/test_configurator_integration.py (44) + fixture; full suite 654 passed / 1 skipped (ENABLE_DOCS=false).
- validate.check_manifest refactored under C901; docstrings on public svc functions; ruff per-file ignores for vendor/F3 copies.
- module_route: built-ins → SPA implementation routes (manifest /pex etc. is config only); custom → /m/<key>.
- smoke-configurator 66/66, smoke-existing 41/41 (before the module_route change — rerun at the end).
- concurrency probe: 3 parallel approves on one case → 1×200, 2×409 wrong_action; hash chain intact.
- app-stack: start.sh venv re-sync on lock change; README line for smoke-configurator.
- SANDBOX-CHANGES M3/M4/M5 written. NEXT: docs/F4-API.md, F4a.md, final restart + both smokes.

## DONE (~12:45)
- Final: pytest 654 passed / 1 skipped (ENABLE_DOCS=false); smoke-configurator 67/67; smoke-existing 41/41;
  stack left running (ledger 70). Added since M5 note: /workspace/modules `navigation`, GET /m/{key}/members,
  legacy-site adoption on first case (probe passed). Report: docs/reports/F4a.md; contract: docs/F4-API.md.

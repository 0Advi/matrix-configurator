# W1 progress — wire `migrate_running` to G3's migrations API

- Read G1 report/conventions, `lib/app-api.mjs`, `lib/ops.mjs` stub, G3-API §1, G3 report, backend router + service (`release_migration_service.py`) for the exact shapes, operaton-plat `op_migrate_running`.
- Baseline tests: running…
- Baseline: `node --test` → 49/49 pass.
- `lib/app-api.mjs`: `migrate(ref, body)` (dry run = idempotent/retried; execute = sent once, 120 s timeout, failure hint → migration_status), `listMigrations`, `getMigration`.
- `lib/ops.mjs`: stub replaced by `migrate_running` (destructive; dry run unless confirm:true + reason ≥3; protected ids refused on execute; app-only refs accepted) + new read op `migration_status` (list / one with journal, pre-state hidden by default). Server instructions mention both.
- Live (CLI, dry run only, `CFG_PROTECTED_WORKSPACES` incl. the G3 smoke ws): `ws_g3_20261005161331` → "every older release (v1, v2) → v3: 1 running case would migrate, 0 blocked; 1 finished case stays". G3 S2 v1→v3 stage 3 “Sign-off” → 3, 3 approvals carried. Nothing executed. migration_status shows G3's own earlier run (v1→v2, migrated 1 / skipped 1).
- Next: fake migrations API in testkit, unit tests, MCP test update, README/audit row.
- Fake migrations API added to `testkit/fakes.mjs` (per-workspace history, `migrateFail` switch for 502/500/socket reset); new `test/migrate.test.mjs` (15 tests); stub tests in `ops.test.mjs` / `mcp.test.mjs` updated (28 tools, annotations, MCP dry run + confirm-without-reason refusal).
- `node --test` → 64/64 pass.
- README ops table / CLI example / retry note / tests line updated; `docs/ADOPTION-AUDIT.md` row "Process modelling by API" only (27 → 28 ops + "migrate_running live").
- Final live dry run (same result, headline counts running sites only). Done — see `W1.md`.

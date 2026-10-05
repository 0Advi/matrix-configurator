# app-stack — the Matrix sandbox app on localhost

Runs an **unmodified** copy of the Matrix retail-expansion app (`../app/`, = `git archive
origin/main` 3d4f277 of `Matrix-bd`) entirely on this machine, against a local Postgres.
No hosted Supabase, no real secrets, nothing outside loopback.

```bash
./start.sh          # idempotent: env files, venv, npm ci, db, bootstrap-if-empty, storage, backend,
                    #   configurator (NocoBase + /cfg server), frontend   (--no-configurator, --no-frontend)
./status.sh         # one screen; exit 0 only when every component is up
./stop.sh           # stop everything, keep data  (--apps keeps the db running; --with-nocobase also stops NocoBase)
./reset-db.sh       # DROP + rebuild the app database (asks; --yes to skip), restarts the backend
node smoke-existing.mjs   # 41-step proof of the existing provisioning + onboarding flow
node smoke-configurator.mjs  # 67-step proof of the configurator journey (F4a: provision, publish, custom module, pinning)
```

| Component | Where | Process / pidfile | Log |
|---|---|---|---|
| Postgres 16 (compose project `matrix-app`, container `matrix-app-db-1`, volume `matrix-app_app_db_data`) | `127.0.0.1:54330`, db `matrix`, user `postgres` | docker | `docker logs matrix-app-db-1` |
| Storage stub (Supabase Storage API subset) | `http://127.0.0.1:54331` | `run/storage.pid` | `run/logs/storage.log` |
| Backend (FastAPI/uvicorn, python3.12 venv `app/backend/.venv`) | `http://localhost:8000/api` (`/api/health`, `/api/health/db`, docs `/api/docs`) | `run/backend.pid` | `run/logs/backend.log` |
| Frontend (Vite dev server) | `http://localhost:5173` — **HashRouter**: login `/#/welcome`, workspace login `/#/login/<CODE>`, business admin `/#/business-admin`, platform admin **`/#/admin`** (→ **Workspaces** = the embedded configurator, F4b), custom modules `/#/m/<key>`; dev proxies `/api` → 8000 and `/cfg` → 4300 | `run/frontend.pid` | `run/logs/frontend.log` |
| NocoBase — the configurator's design-time store (compose project **`matrix-configurator`** of the project root, F4b) | `http://localhost:13000` | docker (`../docker-compose.yml`) | `run/logs/nocobase.log` (start-up), `docker compose logs nocobase` |
| Configurator server (`../web/server.mjs`, `/cfg` API) | `http://127.0.0.1:4300` (proxied at `http://localhost:5173/cfg`) | `run/configurator.pid` — or an "external process" when the project-root `./start.sh` already runs it | `run/logs/configurator.log` |

`BACKEND_RELOAD=1 ./start.sh` runs uvicorn with `--reload` (watch `app/backend/app`).
Since F4b the stack also starts the configurator's design-time store — NocoBase (:13000, the
project-root compose project `matrix-configurator`) and the configurator server (:4300) — because the
platform-admin portal embeds the configurator (`/#/admin` → Workspaces) and its drafts go to NocoBase
through `/cfg`. Both are reused if already running; `./stop.sh` leaves NocoBase up unless
`--with-nocobase` (the standalone configurator, `../start.sh`, uses it too). UI guide: `../docs/F4b-UI.md`.

## Secrets / config (all generated, all gitignored, never printed)
`bootstrap/gen_env.py` (run by `start.sh`) creates, only if missing:
- `app-stack/.env` — DB name/user/**random password**/port for compose.
- `app/backend/.env` — `DATABASE_URL` → 127.0.0.1:54330, random `SUPABASE_JWT_SECRET`,
  `PLATFORM_ADMIN_EMAIL=platform-admin@example.com` + random `PLATFORM_ADMIN_PASSWORD`/`TOKEN`,
  `CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173`, storage stub URL + random
  service key, `ALLOW_INSECURE_DEFAULTS=false` (the app boots in its *secure* mode),
  `ENABLE_DOCS=true`, `RESEND_API_KEY` empty.
- `app/frontend/.env.local` — `VITE_API_BASE_URL=http://localhost:8000/api` (**includes `/api`**),
  `VITE_USE_MOCK=false`, `VITE_FEATURE_RENT_V2=true`. No Supabase vars (see EXTERNAL-DEPS.md).

Platform-admin login for the browser: the email/password pair in `app/backend/.env`.
Smoke-test users' passwords: `run/smoke/last-run.secrets.json` (mode 600).

## Bootstrap path (what `reset-db.sh` does, and why)
`bootstrap/bootstrap_db.py` (run with the backend venv; it imports the app's own migration
helpers so parsing/checksums are byte-identical to the startup runner):

1. DROP/CREATE database `matrix` (refuses any non-loopback `DATABASE_URL`).
2. `db-init/00-supabase-shim.sql` — roles `anon`/`authenticated`/`service_role` (NOLOGIN,
   service_role BYPASSRLS), `uuid-ossp` + `pgcrypto` in schema `extensions` with the Supabase
   search_path, `auth.jwt()` (= `current_setting('request.jwt.claims', true)::jsonb`, with the
   legacy `request.jwt.claim` fallback), `auth.uid()/role()/email()`, Supabase default grants.
3. `app/backend/database/schema.sql`, verbatim, one transaction (it loads cleanly).
4. Replay **all 63 migration files** once, in the runner's sort order, with the app's parser
   (`app.main._parse_sql_statements`), one transaction per statement, failures tolerated —
   exactly what the pre-ledger "always-run" runner did to the live DB on every boot. Then a
   second pass over just the failed statements (the old runner re-ran everything each boot, so
   e.g. a policy that needs a function defined by a later file converged on boot 2;
   `CREATE INDEX CONCURRENTLY` from 202606133 is retried in autocommit as its header says).
   `202606145_drop_legacy_project_budget.sql` is **HOLD** ("DESTRUCTIVE, NOT YET APPLIED") →
   recorded, not run.
5. Every file is written to `public.schema_migrations` with `app.main._file_checksum`.
   On boot the runner logs `0 new migration file(s) … 63 already in ledger` and
   `_verify_schema` logs `Schema verification passed`.

**Why not one of the two "pure" paths:**
- *Migrations from zero* is impossible: the first migration (`202605221`) already references
  `public.users`/`public.tenants`; the base tables + enum types were created in the Supabase
  dashboard and never committed, so the runner's "fresh database → apply all" branch cannot
  work on a blank DB.
- *`schema.sql` + let the runner baseline* boots, but `schema.sql` (regenerated 2026-06-13,
  hand-maintained since) has drifted from the migrations. Most importantly
  `password_reset_requests` lacks `reset_token_hash`/`token_expires_at` (202606123), so
  **approving a workspace request would 500**; also missing: `tenants_workspace_code_uidx`
  (unique `upper(workspace_code)`), `quality_audit_reports` (20260804, mapped by the ORM),
  `project_reviews.qa_reports_viewed_by_project_at`, `sites.project_excellence_status` /
  `financial_closure_status`, `sites.area_sqft` still `integer` (20260801 widens to numeric),
  dropped dead columns still present (20260815), all RLS enables/policies and the
  `current_tenant_id()` helpers, the anon/authenticated REVOKEs.

Each bootstrap writes the evidence to `run/bootstrap/`: `migration-replay.json` (per-file
statement counts + every failure and its second-pass outcome),
`drift-schema-sql-vs-migrations.json` (catalog diff schema.sql → final), `catalog-final.json`.
Remaining tolerated failures (14, all benign): objects already created by schema.sql
(workspace_requests + 2 indexes, 2 named CHECKs), live-only objects with no repo definition
(views `pipeline_summary`/`stuck_sites`, fn `handle_new_auth_user()`), the retired
`project_excellence_items` table (uses `public.uuid_generate_v4()` — on Supabase the
extension lives in `extensions`), an index on the never-created `project_budget_items`, and a
bug in `202606231` (`pg_policy` has no `schemaname` column — the DO block fails everywhere).

## Rate limits (in-memory, per client IP + path; reset when the backend restarts)
`request-workspace` 3/300s · `admin/login` 10/300s · `login` 10/60s · `login/check` 20/60s ·
`password-setup` 5/300s · `password-reset/complete` 5/300s · `password-reset/request` 5/300s ·
`signup/{supervisor,executive,observer}` 5/300s · `join` 10/60s · `branding` 30/60s ·
`health/db` 30/60s. A smoke run uses 2× password-setup and 2× reset/complete, so **at most two
full runs per 5 minutes**. Cope by config/ops, not code: `./stop.sh --apps && ./start.sh`
resets every window (the limiter has no env switch). Tests that need more should use distinct
company/emails per run (the smoke does) and restart between batches.

## Docker Desktop caveat (seen 2026-10-04)
A bind mount from `~/Desktop` made Docker Desktop's API proxy wait on a file-sharing approval
that never came, after which **every** new container start hung in `created` (other agents'
containers too). The compose file therefore has no bind mounts, and `start.sh` falls back to
starting the container through the raw daemon socket
(`~/Library/Containers/com.docker.docker/Data/docker.raw.sock`), which bypasses the proxy;
host port publishing still works. If the proxy is healthy the fallback never triggers.

See also: `EXTERNAL-DEPS.md` (what the app calls outside itself + local substitutes),
`../app/SANDBOX-CHANGES.md` (diff vs origin/main: env files only).

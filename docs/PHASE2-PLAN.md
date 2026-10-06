# Phase 2 — Configurator → real, modular Matrix app (localhost)

Durable plan. If a session is interrupted, resume from the **Status** table — every phase
writes its outputs to disk and its report to `docs/reports/`.

## Goal (from the user, 2026-10-03)
1. Put the configurator inside the Matrix app's admin area. A workspace created + published in
   it must become a real workspace you can sign into from the app's login page (localhost).
   End-to-end: configurator → workspace creation → workspace-code authenticity check → login →
   onboard business admin, supervisors, executives → run the flow designed in the configurator →
   a traced proof of where the app is (and isn't) modular.
2. Audit every borrowed code piece; mine good OSS repos (NocoBase, Operaton, SpiffWorkflow,
   Cerbos, json-logic, react-jsonschema-form, React Flow, bpmn-js, …) to fill real gaps.
3. Verify the developed system against the actual project's DB schema; specify exactly the
   DB changes needed to make the real project modular. No changes to the real project.
4. Find and fix caveats so the whole thing is testable end-to-end on localhost.

## Non-negotiable constraints
- **The real project is read-only.** `/Users/aditya/Desktop/bd/Matrix-bd*` — no writes, no
  state-changing git. Read via `git --no-optional-locks -C <repo> show|ls-tree|archive origin/main`.
- **We work on a sandbox copy**: `app/` = `git archive origin/main` of Matrix-bd
  (`origin/main` = `3d4f277beb22c5be02c2abacea61b6afaee7cdeb`). Integration changes go there.
- **Never touch real data or real secrets.** Do not read/copy `Matrix-bd/backend/.env`, do not
  connect to hosted Supabase or any remote DB. All secrets for the sandbox are freshly generated,
  stored in gitignored `.env` files, never printed.
- Localhost only. Third-party code is used only under its licence, with attribution in
  `THIRD_PARTY.md`.

## Facts established by recon (origin/main)
- Backend FastAPI; login is app-native: `/auth/login` etc. mint HS256 JWTs with
  `SUPABASE_JWT_SECRET` (no hosted Supabase Auth needed). Per-request `users.is_active` + role recheck.
- Platform-admin portal already exists: frontend `/admin` → `frontend/src/modules/admin/AdminPortalPage.jsx`;
  backend `routers/tenancy.py`: `/tenancy/admin/login`, `/request-workspace`, `/requests`,
  `/requests/{id}/approve` (provisions tenant + business_admin, returns `workspace_code` + one-time
  **setup code**; the BA sets a password on the login page with it — no email needed),
  `/workspace-info` (workspace-code check), `/join`, `/branding`, password-reset confirmations.
  Guard: `X-Platform-Admin-Key` (= PLATFORM_ADMIN_TOKEN).
- Onboarding: `/auth/signup/supervisor|executive|observer` via dept/supervisor/observer codes.
- DB: `backend/database/schema.sql` + migrations; startup runner applies migrations via a ledger
  (fresh DB with existing `public.tenants` and empty ledger ⇒ *baseline without executing*).
  RLS functions use `auth.jwt()` (Supabase) — vanilla Postgres needs a shim.
  **5 hard-coded `module IN ('bd',…)` CHECK constraints** block custom modules.
- Frontend Vite + React; API base `VITE_API_BASE_URL`; `VITE_USE_MOCK`.
- Building blocks already extracted: `building-blocks/` (see CATALOG.md) incl.
  `from-matrix-bd/matrix-bd-flow.json` (+ `flow-adapter.mjs`) and SEED-VS-REALITY.md.

## Architecture decisions
- **D1 Placement:** the configurator lives in the platform-admin portal (`/admin` → "Workspaces"),
  matching the design's own header `matrix · platform admin · /admin/workspaces`. Only reachable
  after platform-admin sign-in.
- **D2 Two stores:** NocoBase = design-time store (drafts, history — already built). The **app DB**
  = run-time store: on Publish, the manifest is stored as an immutable per-tenant config release
  in the app DB. The app never calls NocoBase at request time.
- **D3 Provisioning:** first Publish of a new workspace provisions a real tenant through the app's
  own provisioning code path (tenant + workspace_code + business admin + setup code). Platform key
  stays server-side, never in the browser.
- **D4 Runtime modularity:** the app reads the tenant's published release:
  built-in modules map to existing implementations (on/off, labels, nav, gates);
  custom modules run on a **generic module runtime** (stages, fields, tier approvals, gates).
- **D5 DB changes** needed for D2–D4 are written as migrations in the sandbox AND documented as
  the proposed change set for the real project (task 3).

## Ports (localhost)
| Service | Port |
|---|---|
| App frontend (Vite) | 5173 |
| App backend (uvicorn) | 8000 |
| App Postgres | internal (loopback 54330 for debugging only) |
| NocoBase / standalone configurator | 13000 / 4300 (phase 1, unchanged) |

## Phases & ownership
| Phase | Agent | Owns (writes) | Depends on |
|---|---|---|---|
| F1 Sandbox app foundation | F1 | `app/`, `app-stack/` | — |
| F2 Schema & modularity audit (task 3) | F2 | `docs/schema-audit/` | — |
| F3 OSS gap-filling + provenance audit (task 2) | F3 | `docs/oss/`, `third_party/`, `THIRD_PARTY.md` | — |
| F4a Backend integration (task 1) | F4a | `app/backend/`, `docs/F4-API.md` | F1, F2, F3 |
| F4b Frontend integration (task 1) | F4b | `app/frontend/`, `web/` integration bits | F4a |
| F5 E2E trace + caveat hunt/fix (tasks 1 & 4) | F5 | `e2e/`, `docs/e2e/`, fixes in `app/` | F4 |
| Lead | me | `README.md`, `docs/PHASE2-PLAN.md`, `docs/reports/` | all |

## Status
| Phase | State | Report |
|---|---|---|
| F1 | **done** — lead re-verified: 4/4 services up, smoke 41/41 | `docs/reports/F1.md` |
| F2 | **done** — 6 additive migrations; 161 checks passed / 0 failed; proposals re-run clean ×2; container removed. Lead verified artifacts + RLS coverage. REPORT.md + F2.md recorded by lead from F2's handback (user approved) | `docs/reports/F2.md`, `docs/schema-audit/REPORT.md` |
| F3 | **done** — lead re-verified: 36/36 unittest OK; spike containers/images cleaned. Runtime = in-app interpreter (`runtime.py`); Operaton + SpiffWorkflow spikes both passed | `docs/reports/F3.md` |
| F4a | **done** — lead re-verified: pytest 654 pass/1 skip (+44, 0 regressions), smoke-existing 41/41, smoke-configurator 67/67, ledger 70 (+ migration `20261004_7_platform_workspaces`) | `docs/reports/F4a.md`, `docs/F4-API.md` |
| F4b | **done** — lead re-verified: vitest 681/683 (2 = rent-v2 flag tests, pass 9/9 with flag false → env-only, 0 regressions), vite build OK; browser journey end to end (DOM events); 0 backend changes | `docs/reports/F4b.md`, `docs/F4b-UI.md` |
| G1 | **done** — lead re-verified: 49/49 tests; user's `aditya-test` untouched (updatedAt == createdAt); E2E draft deleted. 27 ops, CLI + MCP server (`agent-configurator/`) | `docs/reports/G1.md` |
| G2 | **done** — lead re-verified: 16/16 completeness test; patches NOT applied (targets untouched). D01–D33; our flow = closest to real app. REPORT.md blocked by harness (content in handback) — **user decision pending**: save REPORT.md? apply patches 01/02/03? | `docs/reports/G2.md`, `docs/catalogue-crosscheck/` |
| G3 | **done** — lead re-verified: pytest 683/1 (+29), vitest 695/697 (2 env-only), build OK, smoke-existing 41/41, smoke-configurator 67/67, smoke-g3 59/59, ledger 73 (migrations 20261005_1..3) | `docs/reports/G3.md`, `docs/G3-API.md` |
| N1 | **done** — lead re-verified: provisioners idempotent; NocoBase menu Matrix Configurator → 7 read-only pages; workflow on cfg_releases → cfg_activity; role configurator_viewer (view OK, writes 403) | `docs/reports/N1.md`, `nocobase/README.md` |
| W1 | **done** — 64 tests, pushed b570312 | `docs/reports/W1.md` |
| F5a | in progress — caveat fixes: SEC-1 (first-password takeover), session/UI caveats, disabled built-ins guard, migration recovery, custom-module file fields | `docs/reports/F5a-progress.md` |
| F5b | pending (after F5a) — re-runnable Playwright E2E with REAL input + traced proof + ADOPTION-AUDIT click-path verification | — |
| Final verification + handover | pending | — |

## Phase 2b — additions from the user's own repo `Adityashandilya555/operaton-plat` (requested 2026-10-05)
Nothing from operaton-plat was used before this point (lead verified: zero references; F3's Operaton spike
predates the repo by ~7h). The user owns that repo, so reusing its code here is fine; record provenance in THIRD_PARTY.md.
| # | Item | Phase | Owns | When |
|---|---|---|---|---|
| 1 | AI-agent configurator — op_* commands as CLI + MCP server, editing the SAME drafts as the visual configurator, publishing via the app's platform API | G1 | `agent-configurator/` | now (parallel with F4b) |
| 5 | Catalogue cross-check: operaton-plat's 10-module catalogue vs our 9-module model vs real code | G2 | `docs/catalogue-crosscheck/` | now (read-only) |
| 2 | Audited "migrate running cases" admin action (alongside pinning) | G3 | `app/` | after F4b |
| 3 | "Only for sites they created" (creator-scoped) rule in the runtime + configurator | G3 | `app/` | after F4b |
| 4 | Role-scoped saved views for module pages | G3 | `app/` | after F4b |
F5 (end-to-end trace + caveats) runs last and covers all of the above.

## User decision 2026-10-06: Operaton = **ideas only** (no engine). Deliverable: `docs/ADOPTION-AUDIT.md` mapping every Operaton + NocoBase concept → implementation → how to see it on localhost.

## Approved fix queue (user approved 2026-10-05: "queue these fixes and apply them as soon as they are ready")
Source: `docs/catalogue-crosscheck/proposed-patches/` (G2). **Trigger: as soon as G3 is done** (G3 is editing the
backend; a parallel migration would collide). Applied by the lead, verified, BEFORE F5 starts.
| Patch | What | Fixes | Apply |
|---|---|---|---|
| 01 | generator diff `01-build-matrix-bd-flow.mjs.diff` → regenerate `building-blocks/from-matrix-bd/matrix-bd-flow.json` (must equal `01-…json-patch.json` result, sha256 3ee69173…); update the 10→9 approver figure in `SEED-VS-REALITY.md` | D04, D10, D11, D15, D17, D30 (+ gateTriple, creatorRule, executiveScope) | **applied 2026-10-06** — via generator; sha256 3ee69173c323 = G2's prediction; SEED-VS-REALITY 10→9 |
| 02 | `02-module_catalog-corrections.sql` as a NEW forward migration named AFTER G3's last migration (8-digit date + `_N`, see ordering hazards) | D18 (loi_uploaded→done gate bug), D19 (unreachable outcomes), D21 | **applied 2026-10-06** as `20261005_4_module_catalog_corrections.sql` via the app runner (8 stmts, ledger 74); seed diff deliberately NOT applied (runner checksums applied files; forward UPDATE also fixes fresh installs); conftest label mirror updated (D20) |
| 03 | `03-approvals.json-patch.json` (stale "supervisor drafts skip review") | D04 | **applied 2026-10-06** — 1-line text substitution (first attempt reformatted the file; reverted and redone minimally) |
| 02b | optional view change — **NOT approved / not applied** (SQL never run against Postgres) | — | skipped |
After applying: building-blocks tests, third_party adapter tests (production-flow open order may legitimately change),
agent-configurator tests, backend pytest, frontend vitest, smoke-existing, smoke-configurator, smoke-g3 — all green.
**Result (lead, 2026-10-06):** building-blocks 109/109 · third_party 36/36 (same open order) · agent-configurator 49/49 · crosscheck 16/16 (made state-aware: pre-apply = applies cleanly, post-apply = target holds every patched value) · pytest 683/1 · vitest 695/697 (2 env-only) · smokes 41/41, 67/67, 59/59.

## Findings about the REAL project (report to user; do not change the real repo)
- **SEC-1 (confirmed by lead in origin/main):** unclaimed-account takeover. `tenancy_service.approve_workspace_request`
  inserts the business admin `is_active=true` with no password (tenancy_service.py:326-331) and stores a hashed setup
  token (346-360), but `POST /auth/password-setup` (auth.py:396-456) never requires it — anyone with workspace code +
  email can set the first password during the unclaimed window (≤30 days). Same for any approved-but-unclaimed staff.
  Fix: require the setup/activation token in password-setup (or keep accounts inactive until token redemption).
- **DB-1:** the repo cannot recreate its own database. Migrations-from-zero fail (`users`/`tenants` were created in
  the Supabase dashboard, never committed); `schema.sql` is stale (e.g. `password_reset_requests` lacks
  `reset_token_hash`/`token_expires_at` → approve returns 500; no unique index on `workspace_code`; no RLS;
  `quality_audit_reports` missing). Sandbox bootstraps via shim + schema.sql + replay of 63 migrations (app-stack/bootstrap).
- **DB-2:** module CHECK constraints disagree with each other and with the Python `Module` lists (e.g. `payment`
  still allowed in 3 tables; `site_delegations` allows `financial_closure`/`quality_audit`).
- **BUG-1:** migration `202606231` queries non-existent `pg_policy.schemaname`.

## GitHub repo (user request 2026-10-05: "make a repo on 0Advi and push these new project codes there")
- **https://github.com/0Advi/matrix-configurator** — PRIVATE (it documents the unfixed SEC-1 hole in the live, public app).
- Commit 1 `ef3fe13` = unmodified Matrix-bd origin/main @ 3d4f277 under `app/` — tag `original-matrix-bd-3d4f277`.
- Commit 2 `9005da1` = snapshot (Phase 1, 2, 2b G1/G2; G3 WIP). app/ vs original: 155 files, +21,804 / −285.
- Pre-push secret scan: 12 real secret values + JWT/PEM/demo-password patterns over all staged content → 0 hits.
- Lead pushes follow-up commits at milestones: G3 done → approved fixes applied → F5 done. Agents never commit.

## Draft-store ownership (configurator workspaces in NocoBase `cfg_workspaces`)
- `aditya-test` "ADITYA TEST" — **the user's own** (created 2026-10-03 22:17 IST). Never modify/delete.
- `chai-point-retail` — created by F4b's browser journey (2026-10-05 10:05 IST); tenant code CHAIPO-0458F2543F92FE4A.
- `agent-coffee` — created by G1's E2E (2026-10-05); draft since DELETED by G1.

## Leftover sandbox tenants (app DB) for F5 to account for
- `ws_chai_point_retail` / CHAIPO-0458F2543F92FE4A — F4b journey (BA claimed).
- `ws_agent_coffee` / AGENTC-2313B9A4C05CAF00 — G1 E2E. **BA account UNCLAIMED** (setup code redacted by G1's harness, never stored) → exposed to SEC-1 until claimed or the hole is fixed.
- smoke tenants from F1/F4a runs (SMOKER-…, smoke-configurator) — test data.

## Incident log
- 2026-10-04 ~01:20–08:00: Docker Desktop API proxy wedged — new containers hung in "Created".
  F1 worked around via the raw daemon socket (`start.sh` fallback). Recovered by ~08:xx
  (verified: fresh container starts in 2s). Operaton spike deferred; SpiffWorkflow spike ran.
- Agents interrupted twice by API session limits; resumed with context intact.
- Root cause of the Docker wedge (F1): a compose bind-mount from ~/Desktop triggered a Docker Desktop file-sharing
  approval prompt; every later container start queued behind it. Bind mounts removed.

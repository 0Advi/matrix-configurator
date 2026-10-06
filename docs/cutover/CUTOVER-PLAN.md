# Cutover plan

Task 17: how to split this sandbox into a clean, standalone product repo. This is a plan only. Nothing here has
been moved, deleted or tagged yet.

**Scope.** The sandbox is everything in this repo today. The product is the first-party, clean-room code and plans
listed under **Inputs** below. The new repo must not depend on `app/`, the copy of Matrix-bd `origin/main` @
`3d4f277`, in any way: no imports, no copied files, no SQL against its tables, and no runtime calls to it.
Reasoning that is already written down is cited by section and not repeated here. The main sources are
`docs/independence/AUDIT.md` §6 (migration map) and §7 (order of work), and `docs/configurator/NATIVE-BUILDER-PLAN.md`
§3 (behaviour and files to retire).

**Working name** `workspace-platform`. The real name is still open (AUDIT §8.1). **SQL order** is
`0001_identity` → `0002_store` → `0003_runtime` → `0004_access` → `0005_events` → `0006_notify` → `0007_files`.

**Inputs that already exist on this branch** (first-party, clean-room; not re-audited here):

| Kind | Path | Status |
|---|---|---|
| Package | `packages/manifest` | universal manifest schema, validator, `from_v5` importer, tests |
| Package | `packages/store` | `sql/0002_store.sql`: drafts, releases, modules, release migrations, activity |
| Package | `packages/adapters` | adapter host, SDK and linter |
| Package | `packages/access` | `sql/0004_access.sql`, plus the guard, ceiling and authorize code |
| Templates | `templates/matrix-bd` | Matrix-bd flow as 9 templates plus `adapters.registry.json` |
| Plans | `docs/independence/AUDIT.md`, `docs/runtime/HARDENING.md`, `docs/frontend/GENERIC-RUNTIME-SPEC.md`, `docs/configurator/NATIVE-BUILDER-PLAN.md`, `docs/events/EVENT-BUS.md`, `docs/notifications/NOTIFICATIONS-SLA.md`, `docs/files/FILE-FIELDS.md`, `docs/migrations/MIGRATION-HARDENING.md` | design records |
| Specs | `docs/manifest/`, `docs/store/` (`API.md`, `openapi.yaml`), `docs/rbac/`, `docs/adapters/`, `docs/templates/` | specs |
| Not written yet | `0001_identity.sql`, `0003_runtime.sql` (HARDENING §4 and AUDIT §6), `0005`–`0007` (EVENT-BUS §4, NOTIFICATIONS-SLA §7, FILE-FIELDS §4) | to do |

**Prototype/sandbox vs product, in one line.** The product is `packages/*`, the generic layer this project wrote
(publish, runtime, gates, forms, views), the plans, and the new server, web app and identity code. Everything else is
prototype or sandbox: `app/` (Matrix-bd), `app-stack/`, `web/` (dc-runtime), `nocobase/`, `building-blocks/`,
`sources/`, `agent-configurator/` in its v5 form, and the phase reports. Prototype material is archived and never
copied into the product repo.

Column meanings: **Keep** = copied into the new repo unchanged, at the same path. **Move** = copied with a new path
and limited re-pointing. **Rewrite** = rebuilt in the new repo, with the old code used only as a spec. **Delete** = not
carried over. Section 4 splits Delete into archived and destroyed.

## 1. Keep

| Path | → Destination / action | Reason |
|---|---|---|
| `packages/manifest/` | `packages/manifest/` (copy as is) | The single contract for configurator, runtime, templates and agent. Clean-room. |
| `packages/store/` (`sql/0002_store.sql`) | `packages/store/` (copy as is) | First-party draft and release store. Replaces NocoBase and the `cfg_*`/`20261004_1`/`_7`/`20261005_1` tables (AUDIT §6). |
| `packages/access/` (`sql/0004_access.sql`) | `packages/access/` (copy as is) | Grants come from the manifest. Replaces `app/backend/app/rbac/guards.py` and its fixed role lists. |
| `packages/adapters/` | `packages/adapters/` (copy as is; not used at runtime in 1.0) | The interface that later replaces built-in modules (AUDIT §7 step 5). |
| `docs/manifest/`, `docs/store/`, `docs/rbac/`, `docs/adapters/` | same paths | These specs describe the kept packages. |
| The 8 plan docs listed under Inputs | same paths, plus a header saying "paths under `app/`, `web/`, `nocobase/` refer to the archive tag" | Design records. Post-MVP work (0005–0007, migrations hardening) is driven from them. |
| `docs/templates/README.md` | `docs/templates/README.md` | Generic template format. (`MATRIX-BD-TEMPLATES.md` moves with the customer templates; see §2.) |

## 2. Move

| Path | → Destination / action | Reason |
|---|---|---|
| `third_party/matrix-adapters/{gates,forms}.{py,mjs}` | `packages/rules/`, renamed without "matrix", with Matrix-bd keys removed from fixtures | First-party gate and form compilers (AUDIT §6 row 1). |
| `third_party/panzi-json-logic/` | `packages/rules/vendor/json_logic/` (verbatim, with `LICENSE`/`VERSION`) | MIT. The server-side gate evaluator. |
| `third_party/json-logic-compat-tables/` | `packages/rules/tests/compat/` (data only, with Apache-2.0 notice) | Cross-implementation conformance tests. |
| `third_party/json-logic-js/`, `third_party/rjsf-check/` | `web/package.json` dependencies (`json-logic-js@2.0.5`, `@rjsf/*@6.11.0` pinned); stop vendoring | Normal npm dependencies. Avoids a second vendored copy. |
| `app/backend/app/services/module_runtime/{runtime,migrate}.py`, `module_runtime_service.py`, `module_views_service.py`, `release_migration_service.py` | `server/app/runtime/`: change `site_id` to `case_id` (AS-01), take actors and roles from the manifest | Generic runtime written by this project (SANDBOX-CHANGES M4, G3). It touches Matrix-bd in about 120 lines (AUDIT §1). |
| `app/backend/app/routers/{module_runtime,module_views}.py`, `domain/schemas/module_views.py` | `server/app/runtime/api/` | Generic `/m/{key}/…` API, re-based on `/api/v1` (`docs/store/openapi.yaml`). |
| `app/backend/app/services/platform_workspace_service.py`, `routers/{platform,workspace}.py` | `server/app/platform/`: drop the `workspace_requests` and `tenancy_service` path, call the `packages/store` publish | Provisioning and publish (AUDIT §6). v5 release endpoints are not carried (NATIVE-BUILDER-PLAN §3.3 P4). |
| `app/backend/app/core/problems.py`, `audit_service.write_provenance_audit` | `server/app/core/{problems,audit}.py` | First-party (F4a M3). |
| `app/backend/tests/{test_configurator_integration,test_g3_features}.py` | `server/tests/`, with neutral fixtures and no Starbucks or Blue Tokai | Keeps regression coverage of the ported behaviour. |
| `app/frontend/src/modules/custom-module/**`, `services/api/moduleRuntimeApi.js`, `state/useWorkspaceModules.js` | `web/src/runtime/`, restyled on the new UI kit (GENERIC-RUNTIME-SPEC §2 and §5) | First-party generic pages (F4b B5, G3). |
| `app/frontend/src/modules/admin/workspaces/{WorkspacesList,MigrateCasesPanel,dialogs,ui}.jsx` | `web/src/admin/` as `WorkspacesPage`/`MigrationsPage` (NATIVE-BUILDER-PLAN §3.3) | First-party admin screens. Not the iframe host. |
| `templates/matrix-bd/` (without `__pycache__`), `docs/templates/MATRIX-BD-TEMPLATES.md` | Private customer repo `workspace-templates-matrix-bd`. The product CI may check it out as an optional acceptance fixture. | Customer flow and brand (LR-04). Never in the product repo (AUDIT §8.3). |
| `docs/independence/{check-independence.mjs,inventory.json,render-inventory.mjs}` | `tools/check-independence/`, with rules re-targeted to the new tree | Enforces "no `app/`, NocoBase, dc-runtime or brand" in CI. |

Files of Matrix-bd's own that the sandbox modified (`core/deps.py`, `rbac/guards.py`, `auth_repo.py`,
`AdminPortalPage.jsx`, `Sidebar.jsx`, `AppRouter.jsx` and others listed in `app/SANDBOX-CHANGES.md`) are **never
moved**. Only their behaviour is re-specified, under §3.

## 3. Rewrite

This section covers everything the product currently borrows from `app/` and what replaces it.

| Path (borrowed today) | → Destination / action | Reason / replacement |
|---|---|---|
| **Backend runtime host**: `app/backend/app/main.py`, `core/{config,db,rate_limit,uploads,storage}`, uvicorn bootstrap | `server/app/{main.py,core/}`: new FastAPI app factory, settings, async DB pool, problem+json, rate limiter with a shared-store option (PRODUCTION-GAPS 4.5), and an S3-compatible storage port (FILE-FIELDS §5) | The generic runtime runs inside Matrix-bd's app today. The new host is first-party. |
| **Auth / identity**: `app/backend/app/{routers,services}/{auth,tenancy,users,supervisor_codes,delegations}*`, `core/{security,passwords,deps}` | `server/app/identity/` + `server/migrations/0001_identity.sql`: tenants, members, invites, JWT login, one-time setup codes, per-person platform admins | **Spec-only clean-room rewrite** by someone who has not read the Matrix-bd auth code (AUDIT §8.4). Keeps SEC-1 semantics: a setup code is required to claim an account. |
| **Migrations**: `app/backend/database/{schema.sql,migrations/*}` (74-entry ledger), startup runner, Supabase `auth.jwt()` shim | `server/migrations/0001…0007` + a new runner. Fresh baseline, checksum ledger, one transaction per file, refuses gaps or reordering, `current_tenant_id()` from a GUC (no Supabase) | Removes the 63 Matrix-bd migrations and the "baseline without executing" path. `20261004_4/_5/_6`, `20261005_2/_3` become `0003_runtime` with FKs to `cases`. `20261006_1` becomes `0007_files`. Catalog migrations `20261004_2/_3`, `20261005_4` are dropped (AUDIT §6). |
| **Frontend shell**: `app/frontend/src/{App.jsx,router/*,state/SessionContext.jsx,modules/shared/chrome/*,modules/landing/*}`, `z-matrix-design-system/` | `web/src/{shell,auth,ui}`: new Vite + React SPA with login and workspace-code entry, a nav derived from the published release, and a neutral token set | Matrix-bd's chrome and design system are proprietary. Routes follow GENERIC-RUNTIME-SPEC §6. |
| **Configurator**: `web/` (dc-runtime server), `app/frontend/public/configurator/**`, `admin/workspaces/{WorkspacesArea.jsx,configuratorHost.js}` | `web/src/admin/builder/`: native builder (NATIVE-BUILDER-PLAN §4–§7) on the `/api/v1` store API | dc-runtime has no licence (LR-02) and needs `unsafe-eval`. With no iframe there is no `postMessage` bridge and no `/cfg`. |
| `agent-configurator/` | `agent/`: CLI + MCP ops over the store API and `packages/manifest` (post-MVP) | Today it executes the design's `class Component` in `node:vm` (LR-02). The op set idea needs the LR-06 grant. |
| `app-stack/`, `docker-compose.yml`, `start.sh`, `stop.sh` | `deploy/local/compose.yml` (Postgres, server, web, MinIO) + `Makefile`; `tests/smoke/` | Removes NocoBase, the storage stub and the Supabase shim. |
| `app-stack/smoke-{configurator,g3}.mjs` | `tests/e2e/` (Playwright) + `tests/smoke/` against `/api/v1` | Same journeys, new API. |
| `docs/PRODUCTION-GAPS.md` | `docs/deploy/SECURITY.md`, keeping only gaps that still apply: CSP (only ajv is left; use precompiled validators), private bucket, upload limits, rate limiter, per-person admins | Without the iframe, `X-Frame-Options: DENY` and the `/cfg` proxy issues no longer apply. |
| `THIRD_PARTY.md`, `README.md` | regenerated for the new tree only | No sections A, B, E, G or H (dc-runtime, NocoBase, internal material). |
| Test fixtures that name Blue Tokai, Starbucks or Burger King | neutral fixtures (`acme`, `vendor-onboarding`) | LR-04. |

## 4. Delete

**4a. Archived (read-only, never copied into the product).** The archive is this repo, `0Advi/matrix-configurator`,
which stays **private**. Before cutover, add tag `sandbox-final-<sha>` and branch `archive/sandbox-2026-10`. Keep the
existing tag `original-matrix-bd-3d4f277`, which is the unmodified Matrix-bd import. Then set the repo to
GitHub-archived (read-only). The new repo starts **without history**: no `filter-repo`, no fork, no subtree.

| Path | → Action | Reason |
|---|---|---|
| `app/` (whole tree, including the sandbox edits) | archive only | Proprietary Matrix-bd (about 90% of its files, AUDIT §1). Its generic parts are carried by §2. |
| `app/SANDBOX-CHANGES.md`, `docs/schema-audit/` | archive. The real Matrix-bd team uses them through STATUS §3.5 | They are a change set for the real app, not product docs. |
| `web/`, `sources/` | archive | dc-runtime and the v5 artifact (LR-02). NATIVE-BUILDER-PLAN §3.2's 126-file retirement is met by not carrying them, so the P2/P3 deletions do not need to run in the sandbox. |
| `nocobase/` | archive | LR-01 (NocoBase licence §5.4). |
| `building-blocks/` | archive | Mixed provenance (`from-matrix-bd`, `from-nocobase`, `from-proposal`, brand seeds). The parts worth keeping are already in `packages/*`. |
| `agent-configurator/` (v5 form), `app-stack/` | archive | Replaced by §3 rewrites. |
| `docs/{STATUS,PHASE2-PLAN,CONTRACT,F4-API,F4b-UI,G3-API,ADOPTION-AUDIT}.md`, `docs/{oss,catalogue-crosscheck,reports}/`, `docs/independence/{AUDIT,INVENTORY}.md` | archive. The new repo's `docs/HISTORY.md` links to the tag | Sandbox history and audits. |
| `third_party/matrix-adapters/runtime.py` (reference runtime) | archive | Superseded by `server/app/runtime/`. |

**4b. Deleted outright (destroyed, not archived).**

| Item | → Action | Reason |
|---|---|---|
| `app/backend/.env`, `app/frontend/.env.local`, root `.env` (`NOCOBASE_TOKEN`), `LOGINS.local.md`, `show-logins.mjs` output | wipe. Rotate nothing real, because the secrets were sandbox-only | Secrets and credentials. |
| NocoBase API key, NocoBase Postgres volume, `app-stack` Postgres volume (sandbox test tenants), storage-stub data | revoke the key, then `docker compose down -v` | Sandbox data. Contains brand demo data. |
| `**/node_modules`, `**/.venv`, `**/__pycache__` (including `templates/matrix-bd/__pycache__`, `packages/*/__pycache__`), `*.egg-info` | delete; add to `.gitignore` in the new repo | Build artefacts. |
| Vendored React UMD, `@babel/standalone`, IBM Plex woff2 copies | not re-vendored (npm or none) | Present twice in the sandbox. Not needed. |

## 5. New repo structure

```
workspace-platform/                  (no history; LICENSE per AUDIT §8.2)
├── packages/
│   ├── manifest/      keep    schema + validator + from_v5 importer (CLI tool only)
│   ├── store/         keep    sql/0002_store.sql + store service
│   ├── access/        keep    sql/0004_access.sql + guard/ceiling/authorize
│   ├── adapters/      keep    host/sdk/lint (inactive in 1.0)
│   └── rules/         move    gate + form compilers, vendor/json_logic, tests/compat
├── server/            FastAPI
│   ├── app/core/       rewrite  config, db, problems, audit, rate limit, storage port
│   ├── app/identity/   rewrite  clean-room: tenants, members, invites, login, setup codes
│   ├── app/platform/   move     provision workspace, publish (via packages/store)
│   ├── app/runtime/    move     cases, stages, approvals, gates, views, (migrate post-MVP)
│   ├── app/{events,notify,files}/   post-MVP (EVENT-BUS, NOTIFICATIONS-SLA, FILE-FIELDS)
│   ├── migrations/     0001_identity 0002_store 0003_runtime 0004_access | 0005_events 0006_notify 0007_files
│   └── tests/
├── web/               Vite + React SPA
│   └── src/{shell,auth,ui,runtime,admin/builder}
├── agent/             post-MVP: CLI + MCP over /api/v1
├── templates/examples/  neutral sample workspaces (no customer data)
├── deploy/local/      compose: postgres, server, web, minio
├── tests/{smoke,e2e}/
├── tools/check-independence/
├── docs/              kept specs + plans, deploy/SECURITY.md, DECISIONS.md, HISTORY.md (link to archive tag)
├── THIRD_PARTY.md     regenerated
└── README.md
```

**MVP (first independent release, `v1.0.0`)**: identity, store, manifest, native builder, generic runtime, access,
generic UI, local deploy, applied in SQL `0001`–`0004`. **Not in MVP**: `0005_events`, `0006_notify`, `0007_files`;
migrate running cases (MIGRATION-HARDENING); custom saved views; adapters and built-in templates; the agent; the v5
importer as a product feature; multi-instance rate limiting.

## 6. Migration order

| Step | What | Depends on | Exit check |
|---|---|---|---|
| 0 | Decisions: name, licence, LR-06 grant, who writes identity (AUDIT §8). Record them in `docs/DECISIONS.md` | — | Owner signs off |
| 1 | Freeze the sandbox: push `sandbox-final-<sha>`, branch `archive/sandbox-2026-10`, and confirm `original-matrix-bd-3d4f277` exists | 0 | Tags visible on the remote |
| 2 | Create the empty repo with a scaffold and CI: tests, secret scan, licence scan, `check-independence` (blockers = 0) from the first commit | 0 | CI green on the scaffold |
| 3 | Copy the §1 Keep items and `packages/rules` (§2) with an allow-list script run from the archive checkout | 2 | Package tests green. Checker = 0 |
| 4 | Migrations and runner: `0001_identity` (clean-room), `0002_store`, `0003_runtime` (write it per HARDENING §4), `0004_access` | 3 | Empty DB applies 0001–0004. Re-run is a no-op. Gap or reorder is refused |
| 5 | Server: core host, identity, store API (`docs/store/openapi.yaml`), platform, runtime port (`case_id`) | 4 | Ported tests and SEC-1 tests green. OpenAPI contract test passes |
| 6 | Web: shell and auth, generic runtime pages (GENERIC-RUNTIME-SPEC §5–§7), native builder (NATIVE-BUILDER-PLAN §4–§7, §10) | 5 | Component tests green. `vite build` passes. CSP has no `unsafe-eval` |
| 7 | Deploy and E2E: `deploy/local`, Playwright journey (§8) | 6 | E2E green on a clean machine |
| 8 | Data: import first-party drafts only, using `packages/manifest from_v5` with dry run, count reconciliation and a freeze window (NATIVE-BUILDER-PLAN §8). Customer drafts stay in the archive | 5 | 0 lost drafts. Every import reconciled |
| 9 | Release `v1.0.0` (§8). Archive the sandbox repo (read-only) | 7, 8 | §8 checklist complete |
| 10 | Post-MVP, in this order: `0005_events` → `0006_notify` → `0007_files` → migrate-running-cases hardening → saved views → adapters and customer templates → `agent/` | 9 | Each plan's own acceptance section |

## 7. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Matrix-bd code or snippets leak into the product through the moved files | M | H | No history. Allow-list copy. Review every §2 file diff. `check-independence` blockers = 0 in CI | Tech lead |
| R2 | The identity rewrite is contaminated by knowledge of Matrix-bd auth | M | H | Spec-only rewrite by an author who has not seen that code (AUDIT §8.4). Specs are reviewed before coding | Security lead |
| R3 | SEC-1 regresses in the new identity code | L | H | SEC-1 tests become release-blocking acceptance tests | Security lead |
| R4 | NocoBase (LR-01) or dc-runtime (LR-02) gets pulled back in | L | H | Licence scan and checker rules. No iframe and no `/cfg` in the product | Legal + frontend lead |
| R5 | Customer brand or data lands in the product repo (LR-04) | M | M | `templates/matrix-bd` goes to a private repo. A brand grep runs in CI. Neutral fixtures | Product owner |
| R6 | Writing `0003_runtime` and porting `sites`→`cases` (AS-01) breaks gate facts | M | H | Port tests before code. Golden fixtures captured from the sandbox at the archive tag | Backend lead |
| R7 | SQL order drifts between plans (`0005`–`0007` need `0003`/`0004`) | M | M | One ledger. The runner refuses gaps or reordering. Order is fixed in `server/migrations/README` | Backend lead |
| R8 | Drafts are lost or corrupted on import from NocoBase or v5 | M | M | Dry run, freeze window, per-draft reconciliation, and a NocoBase volume snapshot kept until v1.0 | DevOps |
| R9 | MVP scope creeps (events, notifications and files pulled in) | H | M | §5 MVP list is frozen. Post-MVP items go to step 10 | Product owner |
| R10 | Frontend rewrite underestimated (shell and design system replaced) | H | M | Minimal UI kit from GENERIC-RUNTIME-SPEC §2. Builder ships in its P1 scope only | Frontend lead |
| R11 | Strict CSP is blocked by ajv `new Function` | M | M | Precompiled (standalone) validators, or server-side validation only | Frontend + security |
| R12 | Name, licence or LR-06 grant undecided, which blocks the release | H | H | Step 0 is a hard gate. Decide before step 2 | Product owner |
| R13 | The private archive containing proprietary code is exposed | L | H | Keep it private and GitHub-archived. Review access. Never make it public or fork it | Tech lead |
| R14 | Sandbox users depend on the old URLs and ports (`:4300`, `:5173`, NocoBase `:13000`) | M | L | Announce the freeze date. Archive tag README points to the new repo | Tech lead |

## 8. First independent release criteria

All of these must hold before tagging `v1.0.0`:

| # | Criterion | Check |
|---|---|---|
| C1 | No dependency on `app/`, Matrix-bd tables (`sites`, …), Supabase, NocoBase or dc-runtime | `tools/check-independence`: every blocker rule = 0 in CI |
| C2 | No customer brand or data | CI grep for `Blue Tokai`, `Starbucks`, `Burger King`, `Matrix-bd` = 0 (except `docs/HISTORY.md`) |
| C3 | Fresh-DB migrations | Empty Postgres plus `0001`–`0004` in one run, idempotent re-run, checksum ledger verified |
| C4 | Package and server tests | `manifest`, `store`, `access`, `adapters`, `rules`, `server` suites green. OpenAPI contract test passes |
| C5 | Identity security | SEC-1 suite green. Per-person platform admins. Rate limiter on auth routes |
| C6 | End-to-end journey (Playwright, real input) | In the native builder, create a workspace, validate and publish → provision → workspace admin claims with the setup code → invite a member → run a case through its stages with a tier approval, a send-back and a gate → publish v2 → new cases pin v2 and old cases stay pinned |
| C7 | Web hardening | CSP without `unsafe-eval`. No iframe. `vite build` passes. No external requests at runtime |
| C8 | Licences | `LICENSE` chosen. `THIRD_PARTY.md` regenerated. Licence scan clean |
| C9 | Runs from scratch | `make -C deploy/local up` on a clean machine. README covers it in ≤ 3 commands |
| C10 | Archive done | `original-matrix-bd-3d4f277` and `sandbox-final-<sha>` exist. Sandbox repo is archived read-only. `docs/HISTORY.md` links to it |

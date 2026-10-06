# Independence inventory

_Generated from `inventory.json` by `render-inventory.mjs` — edit the JSON, not this file._

As of 2026-10-06 · repo `b9c19b0` · baseline tag `original-matrix-bd-3d4f277` · **55 items**: 19 remove · 23 rewrite · 4 replace · 4 keep_with_notice · 5 safe_dependency

| Disposition | Meaning |
|---|---|
| `remove` | Delete. Nothing in the standalone product does this job. |
| `replace` | Delete and swap in a different component (first-party or permissive OSS) that does the same job. |
| `rewrite` | Re-implement clean-room in the standalone repo. For logic this project wrote itself (git diff vs the baseline tag shows authorship) this is a PORT: copy our own code, then cut every Matrix-bd import/table. For logic that came from Matrix-bd it is a SPEC-ONLY rewrite: work from a written behaviour spec, not from the Matrix-bd source. |
| `keep_with_notice` | Keep, ship the licence/attribution file, record provenance in THIRD_PARTY.md. |
| `safe_dependency` | Permissive package installed by a package manager; nothing to do beyond the lockfile and the licence scan. |

## A. Matrix-bd backend (routes + services)

| ID | What | Where | Origin | Disposition | Target | Notes |
|---|---|---|---|---|---|---|
| MB-01 | BD site pipeline (draft → shortlist → details → approve → LOI): 21 routes | app/backend/app/routers/{bd,staging,loi}.py · services/{bd_service,bd_status_service,loi_service}.py | matrix-bd | **remove** | templates/site-rollout.manifest.json (expressed as manifest stages, optional sample) | Its behaviour becomes a manifest template, not code. |
| MB-02 | Legal & compliance DD, licensing, legal change requests: 17 routes | routers/legal.py · services/{legal_service,licensing_status,change_request_service}.py | matrix-bd | **remove** | template module 'compliance_review' |  |
| MB-03 | Design allocation, deliverables, GFC review: 15 routes, 1 746 LOC | routers/design.py · services/design_service.py | matrix-bd | **remove** | — |  |
| MB-04 | Project execution, project excellence, budgets, quality audit: 43 routes | routers/{project,project_excellence}.py · services/{project_service,project_excellence_service,budget_service}.py | matrix-bd | **remove** | — | Budget roll-ups become the manifest's rollup strategies. |
| MB-05 | NSO, launch approval loop, financial closure, finance/CA approval: 32 routes | routers/{nso,launch_approval,financial_closure}.py · services/{nso_service,launch_service,financial_closure_service,finance_service}.py | matrix-bd | **remove** | — | Launch's multi-party loop is the model for the manifest's approval tiers + send-back. |
| MB-06 | The `sites` aggregate: 22 routes, tracker, photos, reversible actions, hard-coded unlock rules | routers/sites.py · services/{site_documents_service,site_stage_status_service,site_tracker_service,photo_service,query_service,reversible_service,workflow_unlocks}.py | matrix-bd | **remove** | generic `cases` (Task 3 / runtime port) | workflow_unlocks.py = the hard-coded gates the manifest replaces. |
| MB-07 | Business-admin portal: team dashboard, finance approvals, org/departments, documents: 23 routes | routers/business_admin.py · services/{business_admin_service,business_admin_documents_service}.py | matrix-bd (modified here) | **rewrite** | server/app/identity (org, members) — spec-only | Only the org/membership/dept-code parts survive; finance and site parts go. |
| MB-08 | Tenants, users, login, workspace codes, supervisor/executive invite codes, observer codes, password reset, delegation | routers/{auth,tenancy,users,supervisor_codes,delegations}.py · services/{auth_repo,tenancy_service,supervisor_code_service,delegation_service}.py · core/{security,passwords,deps}.py | matrix-bd (SEC-1 etc. modified here) | **rewrite** | server/app/identity | Spec-only rewrite. Keep the concepts (tenant, member, invite code, one-time setup code from F5a SEC-1); role names come from the manifest, not a fixed list. |
| MB-09 | Rate limiting, upload checks (MIME + magic bytes), storage, audit log, notifications outbox, DB session | core/{ratelimit,uploads,problems,config}.py · services/{storage_service,audit_service,notification_service}.py · db/* | matrix-bd (problems.py is ours) | **rewrite** | server/app/core | Generic infrastructure. Spec-only rewrite; problems.py (ours) can be ported. |

## B. Matrix-bd database

| ID | What | Where | Origin | Disposition | Target | Notes |
|---|---|---|---|---|---|---|
| MB-10 | 36 Matrix-bd tables (sites, site_*, design_*, legal_*, nso_reviews, launch_*, project_*, quality_audit_reports, approvals, stage_events, shortlist/site_delegations…) and 63 migrations | database/schema.sql · verified.sql · migrations/2025*–20260819* | matrix-bd | **remove** | new baseline migrations 0001… | Identity tables (tenants, users, memberships, codes, password_reset_requests, audit_logs) are re-created clean in 0001_identity.sql. |

## C. Matrix-bd frontend

| ID | What | Where | Origin | Disposition | Target | Notes |
|---|---|---|---|---|---|---|
| MB-11 | Built-in module pages (≈ 55 files) | app/frontend/src/modules/{bd,loi,staging,legal,design,project,project_excellence,nso,launch,financial_closure,payment,archive,module-history,module-process-flow} | matrix-bd | **remove** | — | Replaced by the generic module pages driven by the manifest. |
| MB-12 | Business-admin portal, team pages, landing + branded login, shared chrome/primitives (≈ 108 files) | app/frontend/src/modules/{business-admin,team,landing,shared} | matrix-bd (partly modified here) | **rewrite** | web/src/{shell,identity,admin} | Spec-only for UI that came from Matrix-bd; our F4b/F5a additions (WorkspaceCodeDialog checks, setup-code step) port. |
| MB-13 | Matrix-bd's own design system, tokens and logo | app/z-matrix-design-system/ · frontend/public/{colors_and_type.css,brand-logo.jpeg} · ZM_TOKENS | matrix-bd | **replace** | web/src/theme (new tokens) or a permissive UI kit |  |
| MB-14 | Marketing/landing pages exported from Claude Design (each ships its own dc-runtime support.js) | app/frontend/public/landing/{pipeline,scale} (286 files) | matrix-bd + dc-runtime | **remove** | — | Also a dc-runtime licence item (LR-02). |
| MB-15 | API clients, session, router guards, Supabase-shaped auth client | app/frontend/src/services/api/* (except moduleRuntimeApi.js) · services/api/supabaseAuth.js · state/* · router/* | matrix-bd | **rewrite** | web/src/api, web/src/session | Router becomes data-driven from GET /workspace/modules (already proven by F4b). |

## D. Other Matrix-bd material

| ID | What | Where | Origin | Disposition | Target | Notes |
|---|---|---|---|---|---|---|
| MB-16 | Matrix-bd's own docs, agent skills, CI, deployment notes | app/{CLAUDE.md,CODEBASE_REVIEW.md,DEPLOYMENT.md,left_out_tasks.md,docs/,.claude/,.github/,.deepsource.toml,Makefile} | matrix-bd | **remove** | new docs/ + CI |  |
| MB-17 | Flow, RBAC, approvals, rent-terms, route guards, tokens extracted from Matrix-bd (each with a provenance header) | building-blocks/from-matrix-bd/* | matrix-bd | **remove** | docs/independence/MATRIX-CONCEPTS.md (concept names only) | Proprietary. The concept mapping lives on in Task 2's MAPPING.md without Matrix-bd data. |
| MB-18 | Built-in catalog: 11 Matrix-bd modules with status_source / outcome_map / reached_map pointing at Matrix-bd columns | app/backend/database/migrations/20261004_2 module_catalog rows · 20261005_4 corrections | ours, Matrix-bd data | **remove** | — | The standalone product has no built-ins; every module is manifest-defined (Task 2 rule R6). |

## E. Generic layer written in this project

| ID | What | Where | Origin | Disposition | Target | Notes |
|---|---|---|---|---|---|---|
| OW-01 | Stage FSM, JsonLogic gates, form compiler (manifest → JSON Schema/uiSchema), manifest validator, migration planner | app/backend/app/services/module_runtime/{runtime,gates,forms,validate,migrate}.py | ours | **rewrite** | server/app/runtime + packages/manifest | PORT. Coupling: 'site' wording, India-specific hint parsing (₹/lakh in forms.py), fixed tier ladder. |
| OW-02 | Case runtime, migrate running cases, saved views, module registry | services/{module_runtime_service,release_migration_service,module_views_service,module_registry_service}.py | ours | **rewrite** | server/app/runtime | PORT. Every case is keyed by sites.id (≈ 120 lines touch sites / the creator rule sites.submitted_by). Replace with cases.id + cases.subject (Task 3). |
| OW-03 | Provision workspace, publish/validate release, release history, workspace modules API, generic runtime API | services/platform_workspace_service.py · routers/{platform,workspace,module_runtime,module_views}.py | ours | **rewrite** | server/app/platform + server/app/store | PORT. Provisioning calls Matrix-bd's workspace_requests approval path (tenancy_service) — replace with a direct first-party provision. |
| OW-04 | tenant_config_releases/live, tenant_modules, module_records/stage_states/approvals, release migrations, module_views, module_files, platform_workspaces, audit provenance | migrations/20261004_1…7, 20261005_1…3, 20261006_1 | ours | **rewrite** | server/migrations/0002_store.sql (Task 3) + 0003_runtime.sql | PORT. FKs to sites/users/tenants re-pointed; module_catalog dropped; schema_version 'configurator-v5' → 'workspace-manifest/1'. |
| OW-05 | Generic module list/record/views pages, rjsf widgets, admin Workspaces area, migrate panel, re-auth | app/frontend/src/modules/{custom-module,admin}/* · services/api/moduleRuntimeApi.js · state/useWorkspaceModules.js · shared/workspaceModules.js | ours (AdminPortalPage partly Matrix-bd) | **rewrite** | web/src/{modules,admin} | PORT. Remove the configurator iframe host (configuratorHost.js) once the native editor exists. |
| OW-06 | 27–28 configurator ops as CLI + MCP server | agent-configurator/ | ours (ideas from operaton-plat, see LR-06) | **rewrite** | agent/ (ops over the Task 3 draft API) | Today it EXECUTES the design artifact's v5 class in node:vm (lib/v5.mjs → building-blocks/lib/load-dc.mjs) and stores drafts in NocoBase. Rewrite ops against the new manifest + store API. |
| OW-07 | Standalone configurator server, sync engine, storage bridge around the v5 design | web/ (server.mjs, lib/*, public/{boot,storage-bridge,sync-engine,bridge-core}.js) | ours | **replace** | web/src/configurator (native React editor) + Task 3 API | The ETag/If-Match sync idea carries over to the draft API (optimistic concurrency). |
| OW-08 | Schemas and validation rules derived from the v5 design (our port) | building-blocks/from-design/{manifest.schema.json,workspace.schema.json,vocabularies.json,validation.mjs} | ours (derived from the user's design) | **replace** | packages/manifest (Task 2 workspace_manifest.schema.json + validator) | Superseded by the universal manifest. |
| OW-09 | Local stack runner, secrets generation, storage stub, smoke tests | app-stack/ (start/stop/status, bootstrap_db.py, gen_env.py, storage-stub.mjs, smoke-*.mjs, db-init/00-supabase-shim.sql) | ours | **rewrite** | deploy/local + tests/smoke | Drop the NocoBase services and the Supabase shim; smokes re-targeted at manifest-defined modules. |
| OW-10 | Phase reports, API contracts, audits | docs/{F4-API,G3-API,F4b-UI,PRODUCTION-GAPS,schema-audit,oss,catalogue-crosscheck,reports} | ours | **rewrite** | docs/ (contracts only) | Contracts move to the new repo; Matrix-bd-specific reports stay in this sandbox repo as history. |
| OW-11 | Our gate/form adapters + reference runtime (Python) and the rjsf proof | third_party/matrix-adapters/ · third_party/rjsf-check/ | ours | **rewrite** | packages/rules | PORT; gates.py hard-codes Matrix-bd module keys in its tests/fixtures. |

## F. Licence-risk and third-party items

| ID | What | Where | Origin | Disposition | Target | Notes |
|---|---|---|---|---|---|---|
| LR-01 | NocoBase 2.2.20 as the design-time draft/release store | nocobase/ · docker-compose.yml · app-stack NocoBase services · web/lib/store.mjs · agent-configurator/lib/store.mjs · cfg_* collections | third-party (NocoBase License Agreement, non-OSI; §5.4 forbids a public low-code/no-code SaaS/PaaS built on it) | **replace** | first-party workspace_drafts / workspace_releases (Task 3) | A multi-tenant workspace builder is exactly the §5.4 use case. Cheap to remove: the app never calls NocoBase at request time (decision D2). |
| LR-02 | Claude Design dc-runtime (Anthropic-authored, 'GENERATED from dc-runtime/src/*.ts', no licence stated) | sources/design-artifact/support.js = web/public/support.js = app/frontend/public/configurator/support.js · app/frontend/public/landing/*/support.js | third-party, terms unstated | **remove** | native React configurator | Fine internally; no stated right to redistribute or sell. Removing it also removes @babel/standalone (only needed by its x-import path). |
| LR-03 | The user's Claude Design outputs (the configurator design v1–v5) | sources/ (zip, v1–v5 .dc.html, thumbnail) · web/public/configurator.dc.html · app/frontend/public/configurator/configurator.dc.html | user's own design output | **remove** | design reference only (kept in this sandbox repo, not shipped) | Ownership is low-risk, but the file only runs on the dc-runtime (LR-02). Rebuild the screens natively; keep the file as a visual reference. |
| LR-04 | Demo workspaces named after real brands | building-blocks/from-design/seed-workspaces.json · v5 seeds (bluetokai, starbucks, burger king) | design seeds | **remove** | neutral examples (Task 2 example manifest) | Trademark and customer-confidentiality risk; Blue Tokai is the real customer flow. |
| LR-05 | Proprietary Matrix-bd source @ 3d4f277 and extracts | app/ (everything not listed as ours) · building-blocks/from-matrix-bd | proprietary, internal | **remove** | — | Must not appear in the independent repo. Clean-room rule: Matrix-bd-derived behaviour is rewritten from MATRIX-CONCEPTS-style specs, by someone working from the spec. |
| LR-06 | Ideas and op shapes adapted from github.com/Adityashandilya555/operaton-plat @ fc65499 (no licence file; no code copied) | agent-configurator (op set) · G3 migrate/creator-rule/saved-views ideas | repo owned by Adityashandilya555, not by the 0Advi org | **keep_with_notice** | THIRD_PARTY.md + written permission | Ideas are not copyrightable, but get a one-line written grant (or an MIT licence on operaton-plat) from its owner before the new repo is public. |
| LR-07 | JsonLogic interpreters (MIT), byte-identical | third_party/json-logic-js · third_party/panzi-json-logic · app/backend/app/vendor/json_logic | MIT | **keep_with_notice** | packages/rules/vendor | Keep LICENSE + VERSION next to the files. |
| LR-08 | JsonLogic conformance test data | third_party/json-logic-compat-tables | Apache-2.0 | **keep_with_notice** | packages/rules/test/compat | Test data only; keep LICENSE. |
| LR-09 | IBM Plex Sans/Mono woff2 | web/public/vendor/fonts (IBM Plex) | SIL OFL 1.1 | **keep_with_notice** | web/public/fonts | Ship OFL text; do not rename modified fonts 'Plex'. |
| LR-10 | UMD builds for the dc-runtime host page | web/public/vendor/{react,react-dom,@babel/standalone} | MIT | **remove** | npm dependencies of web/ | Only needed to host the dc-runtime; React comes from npm in the new web app. |
| LR-11 | Form renderer for stage forms | @rjsf/core, @rjsf/utils, @rjsf/validator-ajv8 6.11.0 | Apache-2.0 (+ MIT/BSD transitive) | **safe_dependency** | web/package.json | No NOTICE file upstream. |
| LR-12 | MCP server for the agent | @modelcontextprotocol/sdk 1.32.0 (+93 transitive MIT/ISC/BSD) | MIT | **safe_dependency** | agent/package.json |  |
| LR-13 | Server stack | backend: FastAPI, Starlette, SQLAlchemy, asyncpg, pydantic, PyJWT, bcrypt, cryptography, uvicorn, httpx, jsonschema | MIT / BSD-3 / Apache-2.0 | **safe_dependency** | server/pyproject.toml | All permissive (census in docs/oss/PROVENANCE-AUDIT.md §4). |
| LR-14 | Dev/build-time only | frontend dev: axe-core (MPL-2.0, via eslint-plugin-jsx-a11y), caniuse-lite (CC-BY-4.0, build data) | MPL-2.0 / CC-BY-4.0 | **safe_dependency** | web dev deps | Not shipped in the bundle; MPL file-level copyleft only matters if axe-core files are modified. |
| LR-15 | Database | postgres:16 image | PostgreSQL Licence | **safe_dependency** | deploy/ | Pin by digest. |
| LR-16 | Operaton (Apache-2.0) and SpiffWorkflow (LGPL-3.0) evaluations | docs/oss/OPERATON-SPIKE.md · SpiffWorkflow spike | nothing retained | **remove** | — | Docs only; nothing to ship. Never vendor SpiffWorkflow source. |

## G. Matrix-bd assumptions baked into the generic layer

| ID | What | Where | Origin | Disposition | Target | Notes |
|---|---|---|---|---|---|---|
| AS-01 | Every case is 'a module run on a BD site'; one case per site per module; release pinned on the site | module_records.site_id (UNIQUE site_id, module_key) · sites.config_release_id pinning · creator rule sites.submitted_by/assigned_to | matrix-bd model | **rewrite** | cases(id, subject_type, subject_ref, title) — pin on the case (Task 3) | Biggest structural coupling of the generic layer. |
| AS-02 | Fixed role ladder executive < supervisor < business_admin (+ observer) | chk_ma_tier / approverRole / navRole / permRole enums; JWT role claim | matrix-bd model | **rewrite** | manifest roles[] with rank (Task 2) | Keep these three as the default role set, not as the only one. |
| AS-03 | Matrix-bd's status vocabulary as the universal outcome set | outcome enum (pending, allocated, in progress, submitted, rejected, approved, done, skipped) | matrix-bd model | **rewrite** | manifest outcomes[] (default set kept, extensible) | 'allocated' only makes sense for Matrix-bd's allocation step. |
| AS-04 | A user has ONE primary module | JWT `module` claim · homeForRoleModule | matrix-bd model | **rewrite** | memberships[] per user | Known limitation in STATUS.md §3.4. |
| AS-05 | Every module has a supervisor; approval is a fixed 3-tier chain | tiers {supervisor:true, executive, business_admin_signoff, delegation} | matrix-bd model | **rewrite** | stage.actors + stage.approvals[] (Task 2) |  |
| AS-06 | India-only money, tax ids and formatting | forms.py hint parser (₹, '25,00,000'), GST regex, city lists, en-IN formatting | matrix-bd | **rewrite** | typed field validation (min/max/pattern/currency) in the manifest | Free-text validation hints are replaced by structured validation. |
| AS-07 | Supabase-shaped auth and RLS conventions | supabaseAuth.js · 00-supabase-shim.sql · anon/authenticated RLS roles | matrix-bd | **rewrite** | first-party auth + tenant_id RLS policies |  |
| AS-08 | Onboarding is code-based and module-scoped | workspace_requests approval → provision; dept codes per module; supervisor approves executives | matrix-bd | **rewrite** | identity: invites per role per module (generic) | Keep the one-time setup code from F5a SEC-1. |
| AS-09 | A fixed BD spine above all modules | manifest.pipeline ('platform-owned BD backbone', editable:false) | design v3 / matrix-bd | **remove** | — | Already empty in v5 seeds. |
| AS-10 | Reserved words and routes from Matrix-bd's URL space | module key blocklist (site, sites, …) · built-in routes (/legal, /nso, …) · surface 'scope' (quality_audit) | matrix-bd | **rewrite** | short generic reserved list |  |


# Clean-room independence audit — `matrix-configurator`

**Task 1** · 2026-10-06 · repo `b9c19b0` · baseline `original-matrix-bd-3d4f277` (the unmodified Matrix-bd import)

**Question:** what stops `matrix-configurator` from becoming an independent product repo, and what has to be
removed, replaced or rewritten first?

| File | What it is |
|---|---|
| `AUDIT.md` (this file) | Verdict, blockers, licence risks, migration map, order of work |
| `inventory.json` | 55 items with path, origin, disposition and target — the source of truth |
| `INVENTORY.md` | Rendered tables (`node render-inventory.mjs`) |
| `check-independence.mjs` | Gate script: scans a tree for Matrix-bd / NocoBase / dc-runtime / brand identifiers; exit 1 on blockers |

---

## 1. Verdict

**Not independent today, but the part worth keeping is already cleanly separable.**

* **Almost 90% of `app/` (900 of 1 016 files) is Matrix-bd.** It came from the import commit: 9 built-in modules, 36 of the 48 tables,
  63 migrations, about 200 frontend files and Matrix-bd's own design system. None of it belongs in the
  standalone product (dispositions `remove`, or a spec-only `rewrite` for identity).
* **The generic layer this project wrote is separable.** That covers the publish API, release store, generic
  case runtime, gates, forms, saved views, migrate-running-cases, and the generic UI pages. It is about
  **4,400 lines of Python, 1,950 lines of SQL and 2,500 lines of frontend**, and it touches Matrix-bd in only
  **about 120 lines**, nearly all of them one assumption: *a case is a module run on a BD `sites` row*
  (AS-01). Porting it is mostly re-pointing foreign keys and renaming.
* **Two third-party items block any external release:**
  * **NocoBase** (LR-01): its licence §5.4 forbids a public low-code/no-code SaaS/PaaS built on it, and a
    multi-tenant workspace builder is exactly that.
  * **The Claude Design dc-runtime** (LR-02): no licence is stated. Both the configurator UI and the AI agent
    run on it. The agent goes further: it **executes the design file's own `class Component`** in `node:vm`
    (`agent-configurator/lib/v5.mjs` → `building-blocks/lib/load-dc.mjs`).
* **Brand and customer data** (LR-04): the v5 seeds and every test fixture use Blue Tokai (the real
  customer's flow), Starbucks and Burger King. That's 136 files and 650 lines.

Disposition totals across the 55 inventory items:

| remove | rewrite | replace | keep_with_notice | safe_dependency |
|---|---|---|---|---|
| 19 | 23 (12 are ports of our own code) | 4 | 4 | 5 |

## 2. How this was established

1. **Authorship.** `git diff original-matrix-bd-3d4f277 HEAD -- app/` separates what Matrix-bd shipped from what
   this project added. This project added 62 non-test source files (all F4a/F4b/G3/F5a work; 116 counting tests and the configurator's static copy) and modified 55
   Matrix-bd files. Everything else under `app/` is Matrix-bd's, byte for byte.
2. **Coupling scan.** `check-independence.mjs` was run per area, and on a copy of only our own generic files
   (§3).
3. **Licences.** Everything in `THIRD_PARTY.md` and `docs/oss/PROVENANCE-AUDIT.md` was re-read against the
   question "may this ship in an independent, possibly public, product?". That's a different question from
   the one F3 answered ("is internal use fine?").
4. **Behaviour.** Read from `docs/F4-API.md`, `docs/G3-API.md`, the `20261004_*`–`20261006_*` migrations and
   `module_catalog`.

## 3. Coupling numbers (checker output, 2026-10-06)

Files with at least one hit; ✗ = blocker rule, ! = warning rule.

| Rule | Whole repo | `app/` | `agent-configurator/` | `web/` | `building-blocks/` | **Our generic layer only** |
|---|---|---|---|---|---|---|
| ✗ matrix-bd-tables | 385 | 281 | 4 | 4 | 22 | **17 files / 120 lines** |
| ✗ matrix-bd-modules | 184 | 149 | 8 | 4 | 6 | **7 / 51** |
| ✗ matrix-bd-status | 191 | 134 | 0 | 1 | 14 | **3 / 18** (catalog rows) |
| ✗ brands | 136 | 77 | 8 | 6 | 14 | **0** |
| ✗ nocobase | 93 | 9 | 6 | 16 | 9 | **3 / 3** (comments + `source_ref` text) |
| ✗ dc-runtime | 58 | 9 | 4 | 11 | 15 | **0** |
| ! supabase-shape | 100 | 69 | 0 | 0 | 5 | 2 / 2 |
| ! india-locale | 76 | 56 | 2 | 1 | 7 | 1 / 3 (`forms.py` hint parser) |
| ! fixed-role-ladder | 58 | 31 | 7 | 1 | 7 | 5 / 13 |

"Our generic layer" = `services/module_runtime/*`, `module_runtime_service`, `release_migration_service`,
`module_views_service`, `module_registry_service`, `platform_workspace_service`, the four new routers, migrations
`20261004_1`–`20261006_1`, `modules/custom-module/*`, `modules/admin/workspaces/*`, `moduleRuntimeApi.js` and
`useWorkspaceModules.js`.

Run it yourself: `node docs/independence/check-independence.mjs <dir>`. In the new repo, `--json` output goes into CI;
**every blocker rule must report 0 files** before a release.

## 4. What is Matrix-bd-specific (summary — full list in `INVENTORY.md` A–D, G)

**Code and routes (remove):** BD/staging/LOI (21 routes), legal (17), design (15), project + project excellence +
budgets + QA (43), NSO + launch + financial closure + finance/CA (32), `/sites` aggregate (22), and the hard-coded
unlock rules in `workflow_unlocks.py`, which are exactly what the manifest's gates replace. That's 150 routes and
about 11,400 lines of service code.

**Tables (remove):** `sites`, `site_details`, `site_files`, `site_licensing`, `site_agreement`, `site_budgets`,
`site_budget_items`, `site_delegations`, `shortlist_delegations`, `design_deliverables`, `design_reviews`,
`legal_dd_checklist`, `legal_change_requests`, `nso_reviews`, `launch_approvals`, `launch_review_events`,
`project_reviews`, `project_budget_items`, `project_excellence_items`, `project_excellence_reviews`,
`quality_audit_reports`, `approvals`, `stage_events`. Identity tables (`tenants`, `users`, `business_admins`,
`workspace_requests`, `module_codes`, `supervisor_invite_codes`, `user_module_memberships`,
`supervisor_executive_requests`, `observer_codes`, `password_reset_requests`, `audit_logs`,
`notification_outbox`) are **rewritten clean**: same concepts, new schema, no Matrix-bd DDL copied.

**UI (remove / rewrite):** 14 built-in module page folders, the business-admin portal, landing pages (286 static
files, each with its own dc-runtime), `z-matrix-design-system`, `ZM_TOKENS`, `brand-logo.jpeg`.

**Assumptions baked into our generic layer (rewrite — these become Tasks 2, 3 and 6):**

| # | Assumption | Where it shows | Fix |
|---|---|---|---|
| AS-01 | A case = module × BD `site`; one per site per module; release pinned on the site | `module_records.site_id`, `uq (site_id, module_key)`, `sites.config_release_id`, creator rule `sites.submitted_by` | first-party `cases` with a generic subject; pin on the case (Task 3) |
| AS-02 | Fixed role ladder executive < supervisor < business_admin (+ observer) | CHECK constraints, schema enums, JWT `role` | manifest `roles[]` with rank and permissions (Task 2 → Task 6) |
| AS-03 | Matrix-bd's 8 statuses are the universal outcomes (`allocated`!) | `chk_mr_status`, schema `outcome` enum | manifest `outcomes[]`, default set kept |
| AS-04 | One primary module per user (JWT `module` claim) | `homeForRoleModule`, built-in pages | memberships list (Task 6) |
| AS-05 | Every module has a supervisor; a fixed 3-tier chain | `tiers.supervisor: const true` | per-stage actors and approval steps (Task 2) |
| AS-06 | India only: ₹, `25,00,000` grouping, GST regex, en-IN | `forms.py` free-text hint parser | typed validation in the manifest (Task 2) |
| AS-07 | Supabase-shaped auth and RLS roles | `supabaseAuth.js`, `00-supabase-shim.sql` | first-party auth, tenant RLS |
| AS-08 | Onboarding = Matrix-bd workspace request + dept codes per module | `platform_workspace_service` → `tenancy_service` approval path | direct provisioning + generic invites |
| AS-09 | A fixed "BD backbone" above all modules | `manifest.pipeline` | drop (already empty in v5) |
| AS-10 | Matrix-bd's URL space reserved | key blocklist, built-in routes, `surface: scope` | short generic reserved list |

## 5. Licence-risk items (summary — full list in `INVENTORY.md` F)

| ID | Item | Licence / terms | Risk for an independent product | Disposition |
|---|---|---|---|---|
| LR-01 | **NocoBase 2.2.20** (draft store) | NocoBase License Agreement — non-OSI; §5.4: no public low-code/no-code SaaS/PaaS on it; branding must stay | **High** for any customer-facing use | **replace** → first-party store (Task 3) |
| LR-02 | **dc-runtime `support.js`** (configurator, landing pages, agent via `node:vm`) | none stated (Anthropic-authored export) | **High** for redistribution / sale | **remove** → native React configurator |
| LR-03 | Configurator design v1–v5 `.dc.html` | user's own design output | low ownership risk, but it only runs on LR-02 | **remove** from product; keep as visual reference here |
| LR-04 | Seeds and fixtures named Blue Tokai / Starbucks / Burger King | trademarks; Blue Tokai = real customer flow | **High** (trademark + confidentiality) | **remove** → neutral examples |
| LR-05 | Matrix-bd source and extracts | proprietary | **Blocking** — cannot be in the new repo | **remove**; clean-room rewrite where needed |
| LR-06 | Ideas from `Adityashandilya555/operaton-plat` (agent op set, migrate/creator/views ideas) | no licence file; ideas only, no code | low; the repo owner differs from `0Advi` | **keep with notice** + one-line written grant |
| LR-07/08 | JsonLogic interpreters (MIT) + compat tables (Apache-2.0, test data) | permissive | none | **keep with notice** |
| LR-09 | IBM Plex fonts | SIL OFL 1.1 | none | **keep with notice** |
| LR-10 | React/ReactDOM/@babel/standalone UMD builds | MIT | none, but only needed to host the dc-runtime | **remove** (React via npm) |
| LR-11–15 | rjsf (Apache-2.0), MCP SDK (MIT), FastAPI stack, dev-only axe-core (MPL-2.0) / caniuse-lite (CC-BY-4.0), Postgres | permissive | none | **safe dependency** |
| LR-16 | Operaton / SpiffWorkflow spikes | Apache-2.0 / LGPL-3.0, nothing retained | none | **remove** (docs only) |

**Clean-room rule for the rewrite.** Anything whose origin is `matrix-bd` is re-implemented from a written behaviour
spec (what it does, its API contract, its invariants), not by editing or translating the Matrix-bd source.
Anything whose origin is `ours` may be copied (ported), because this project wrote it. The test is the git diff
against `original-matrix-bd-3d4f277`. Where one of our files was a *modification* of a Matrix-bd file (the
55 modified files), only our hunks count as ours.

## 6. Migration map — current sandbox → standalone repo

Proposed standalone layout (working name `workspace-platform`; the "Matrix" name is itself a warning item):

```
workspace-platform/
├── packages/manifest/      workspace_manifest.schema.json + validator + examples          (Task 2)
├── packages/rules/         JsonLogic gate compiler/linter, form compiler, vendored json-logic
├── server/                 FastAPI
│   ├── app/core/           config, db, problems, rate limit, uploads, storage, audit      (rewrite)
│   ├── app/identity/       tenants, members, invites, auth, setup codes                   (spec-only rewrite)
│   ├── app/store/          drafts, releases, diff, activity                               (Task 3)
│   ├── app/platform/       provision workspace, publish, history                          (port)
│   ├── app/runtime/        cases, stages, approvals, gates, views, files, migrations      (port)
│   ├── app/access/         permission guards from the release                             (Task 6)
│   └── migrations/         0001_identity · 0002_store · 0003_runtime (fresh baseline)
├── web/                    React app: shell, identity, generic module pages, admin, native configurator
├── agent/                  CLI + MCP ops over the store API (no dc-runtime)
├── templates/              portable module templates (Task 4) — neutral names, no customer data
├── deploy/                 local compose (Postgres + server + web), no NocoBase
└── docs/
```

| Current path | → New path | How |
|---|---|---|
| `app/backend/app/services/module_runtime/{gates,forms}.py`, `third_party/matrix-adapters` | `packages/rules/` | port; drop the Matrix-bd keys from fixtures; structured validation instead of the hint parser |
| `…/module_runtime/validate.py`, `manifest.schema.json`, `building-blocks/from-design/{manifest.schema.json,validation.mjs}` | `packages/manifest/` | **replace** with the universal manifest + validator (Task 2) |
| `…/module_runtime/{runtime,migrate}.py`, `module_runtime_service.py`, `release_migration_service.py`, `module_views_service.py` | `server/app/runtime/` | port; `site_id` → `case_id`; pin on the case; roles and actors from the manifest |
| `platform_workspace_service.py`, `routers/platform.py`, `routers/workspace.py` | `server/app/platform/` + `server/app/store/` | port; provisioning no longer goes through `workspace_requests`; drafts move in from NocoBase (Task 3) |
| migrations `20261004_1`, `_7`, `20261005_1` | `server/migrations/0002_store.sql` | rewrite as `workspace_drafts`, `workspace_releases`, `workspace_modules`, `workspace_release_migrations`, `workspace_activity` (Task 3) |
| migrations `20261004_4`, `_5`, `_6`, `20261005_2`, `_3`, `20261006_1` | `server/migrations/0003_runtime.sql` | port; FKs to `cases`, not `sites` |
| migrations `20261004_2`, `_3`, `20261005_4` (catalog) | — | remove; built-ins become templates (Task 4) |
| `app/backend/app/{routers,services}/{auth,tenancy,users,supervisor_codes,delegations}*`, `core/{security,passwords,deps}` | `server/app/identity/` | spec-only rewrite; keep F5a SEC-1 semantics (setup code required) |
| `app/frontend/src/modules/{custom-module,admin/workspaces}`, `moduleRuntimeApi.js`, `useWorkspaceModules.js` | `web/src/{modules,admin}` | port |
| `web/` (configurator server + v5 host) | `web/src/configurator/` | replace with a native editor on the Task 3 API |
| `agent-configurator/` | `agent/` | rewrite ops against manifest + store API; keep the CLI/MCP shell and tests' style |
| `nocobase/`, NocoBase services in `docker-compose.yml` / `app-stack` | — | remove |
| `sources/`, `web/public/{support.js,configurator.dc.html,vendor/react*,vendor/@babel}` | — | remove from product (stays in this sandbox repo as reference) |
| `building-blocks/from-matrix-bd`, `from-nocobase`, `from-proposal`, `seed-workspaces.json` | — | remove |
| `app-stack/` | `deploy/local/`, `tests/smoke/` | rewrite without NocoBase and the Supabase shim |
| everything else in `app/` | — | remove |

## 7. Order of work

| Step | What | Unblocks | Exit check |
|---|---|---|---|
| 0 | Decisions: product name; licence of the new repo; written grant for operaton-plat ideas (LR-06) | everything | recorded in `docs/DECISIONS.md` |
| 1 | Universal manifest + validator (**Task 2**) | runtime port, templates, agent | validator tests green; every rule has a failing fixture |
| 2 | First-party draft/release store (**Task 3**) | NocoBase removal | NocoBase not reachable and the configurator journey still works |
| 3 | Generic `cases` replaces `sites` in the runtime (AS-01) | runtime port | `check-independence --only=matrix-bd-tables` = 0 on `server/` |
| 4 | Manifest-driven permissions (**Task 6**) | identity rewrite | no fixed role list in guards |
| 5 | Built-ins → templates (**Task 4**), adapter interface (**Task 5**) | removal of built-in code | Matrix-bd's flow runs from templates only |
| 6 | Identity spec-only rewrite | new repo | auth test suite ported from the specs |
| 7 | Native configurator UI; agent rewrite | dc-runtime removal | `check-independence --only=dc-runtime` = 0 |
| 8 | Create the new repo from the target layout only (no history), run the checker in CI | release | **all blocker rules 0**, licence scan clean, THIRD_PARTY.md regenerated |

Steps 1–2 are this branch's other deliverables (`docs/manifest/`, `docs/store/`).

## 8. Open decisions for the owner

1. **Product name.** "Matrix" ties it to Matrix-bd (warning rule `matrix-name`).
2. **Licence for the new repo** (proprietary vs open source) — this decides whether LR-06 needs a formal licence
   or just a grant.
3. **Matrix-bd as a customer.** If Matrix-bd itself should later run on the platform, its flow ships as private
   templates in a customer repo, never in the product repo (Task 4 output stays outside `templates/`).
4. **Who does the spec-only rewrite of identity.** Clean-room is strongest when the rewriter has not worked on the
   Matrix-bd auth code.

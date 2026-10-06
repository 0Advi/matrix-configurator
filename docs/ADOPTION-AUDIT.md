# Adoption audit — Operaton & NocoBase in this project

**Decision (user, 2026-10-06): Operaton = ideas only.** The Matrix app stays the runtime; Operaton's *engine*
is not run. NocoBase **is** a running component. This page maps every concept we took from either project to
where it lives in the code and **exactly how to see it on localhost** — and says plainly what was *not* adopted.

Start everything first:
```bash
cd /Users/aditya/Desktop/bd/matrix-configurator && ./app-stack/start.sh
# starts everything: Postgres, storage stub, API :8000, web app :5173, NocoBase :13000 and the
# configurator server :4300 (the configurator embedded at /#/admin saves its drafts through it)
./app-stack/status.sh   # check all of it
```
Credentials: platform admin → `app/backend/.env`; NocoBase root + viewer → project-root `.env`; sandbox test
users → `app-stack/run/smoke/*.secrets.json` (all gitignored, never committed).

---

## 1. NocoBase — what we run, and where to see it

| NocoBase component | What we use it for | Code | See it on localhost |
|---|---|---|---|
| **Collections** (data modelling) | The design-time store: `cfg_workspaces` (each workspace's draft document), `cfg_releases` (append-only publish ledger), `cfg_modules` / `cfg_gates` / `cfg_stages` (projections rebuilt on every save), `cfg_activity` (workflow log) | `nocobase/lib/schema.mjs`, `nocobase/scripts/provision.mjs` | http://localhost:13000 → menu **Matrix Configurator** → Workspaces / Releases / Modules / Gates / Stages / Activity |
| **REST API + API keys** | Every draft save from the visual configurator and the AI-agent configurator goes through it | `nocobase/lib/client.mjs`; used by `web/server.mjs` and `agent-configurator/` | Edit anything in the configurator (`/#/admin` → Workspaces) → refresh NocoBase → Workspaces |
| **Pages & blocks** (2.x flow engine, `flowSurfaces` API) | Seven read-only admin pages (tables + JSON drawers, filter by workspace) | `nocobase/lib/ui-spec.mjs`, `nocobase/scripts/provision-ui.mjs` | Matrix Configurator → any page → click a row's name or **View** |
| **Workflow** (collection-event trigger, query + create nodes) | On every release: writes an entry to the activity log | `nocobase/scripts/provision-workflow.mjs` | ⚙ → Workflow → "Matrix Configurator · Release published → activity log"; then Matrix Configurator → **Activity** |
| **ACL roles** | `configurator_viewer`: can open the pages and read the `cfg_*` data, cannot change anything (writes → 403) | `nocobase/scripts/provision-acl.mjs` | ⚙ → Users & Permissions → *Configurator viewer*; or sign in as the viewer user (`NOCOBASE_VIEWER_*` in `.env`) |

**Not used, on purpose:** NocoBase as the *runtime* (decision D2 — the app's own DB runs cases); the
**Approval** plugin (commercial edition); copying any NocoBase source (bespoke non-OSI licence, §5.4 forbids a
public low-code SaaS built on it — legal review needed before any customer-facing use).

## 2. Operaton — the ideas we adopted, implemented inside the Matrix app

| Operaton concept | Our implementation | Code | See it on localhost |
|---|---|---|---|
| **Versioned deployments** (process-definition versions) | Each Publish creates an immutable, numbered release per workspace; one is live | migration `20261004_1`, `services/platform_workspace_service.py` | `/#/admin` → Workspaces → Provisioned workspaces → **Details** → release history |
| **Instances keep their version** | A site/case is pinned to the release it started under; a new release doesn't change running cases | migration `20261004_4`, `module_records.release_id` | open any case `/#/m/<module>/records/<id>` → "pinned release vN" |
| **Process-instance migration** (Operaton migration API / operaton-plat `op_migrate_running`) | Audited "migrate running cases": dry-run compatibility report, per-site locked execute, mandatory reason, full pre-state kept | migration `20261005_1`, `services/release_migration_service.py`, `MigrateCasesPanel` | `/#/admin` → Workspaces → Details → **Migrate running cases** → Dry run → reason → Migrate |
| **Assignee `${initiator}`** | Stage rule `restricted_to: "site_creator"` (creator = `submitted_by` OR `assigned_to`, the real app's rule); BA may act only as a recorded override | migration `20261005_2`, runtime + DB guard | designer: `/#/admin` → Workspaces → module wizard → step 4 Stages → "Only the site's creator can do this"; then a case page as a non-creator vs the creator |
| **Tasklist filters** (role-scoped task lists) | Saved views per module and role (My cases, Team queue, Awaiting my approval…); views can only narrow server-side scope | migration `20261005_3`, `services/module_views_service.py`, `routers/module_views.py` | `/#/m/<module>` → view switcher; business admin → **Manage views** (`/#/m/<module>/views`) |
| **User tasks with forms** | Each stage's fields render as a form generated from JSON Schema (rjsf), validated in the browser AND on the server | `services/module_runtime/forms.py`, `src/modules/custom-module/` | a case page: the current stage's form |
| **Candidate groups / lanes** | Tier approvals (executive → supervisor → business admin), delegation, separation of duties | `services/module_runtime/runtime.py` | a case page: only the buttons your role may use appear |
| **Gateways + conditions** | Module entry gates with all/any conditions, evaluated by json-logic identically in Python and JS | `app/vendor/json_logic/`, `module_runtime/gates.py` | open a case whose gate is closed → the locked screen lists each condition |
| **History service** | Hash-chained, append-only audit with provenance (release, module, actor role, override flag) | migration `20261004_6`, runtime | a case page → audit trail |
| **Deployment validation** | Publish refuses invalid manifests and returns findings | `platform_workspace_service.py` | `/#/admin` → Workspaces → **Check draft** |
| **Process modelling by API** (operaton-plat `op_*` + `mcp_server.py`) | AI-agent configurator: 28 ops as CLI + MCP server, same drafts as the visual configurator + migrate_running live (G3 migrations API: dry run by default, confirm + reason to execute; `migration_status` for history) | `agent-configurator/` | not a web page: `node agent-configurator/bin/cfg.mjs list_workspaces --json '{}'`; or add the MCP server to Claude Code (see `agent-configurator/README.md`) |
| **Catalogue of predefined nodes** (operaton-plat `catalogue.json`) | Cross-checked against the real code; corrections applied | `docs/catalogue-crosscheck/` | `docs/catalogue-crosscheck/REPORT.md` |

**Not adopted, on purpose (and where the gap stands):**
- **The engine itself** — Tasklist/Cockpit/REST engine are not run (user decision). Spikes proved it works:
  `docs/oss/OPERATON-SPIKE.md` (Operaton 2.1.5) and the in-process SpiffWorkflow run.
- **BPMN interchange** — a manifest→BPMN generator exists only as a spike (`docs/oss/spikes/operaton/`).
- **Cockpit-style monitoring** (seeing a case on a diagram) — not built; the nearest are the case lists and the
  NocoBase pages.
- **External tasks / job workers, timers, parallel branches inside a module** — not built (no async automation yet).

## 3. Ten-minute tour
1. NocoBase: http://localhost:13000 → **Matrix Configurator** → Releases (publish ledger) → Activity (written by
   the NocoBase workflow).
2. App: http://localhost:5173/#/admin → sign in as platform admin → **Workspaces** → design in the embedded
   configurator → **Check draft** → **Publish** → provisioning dialog shows the workspace code + one-time setup code.
3. **Details** on that workspace → release history → **Migrate running cases** (dry run).
4. Sign out → login page → type a fake code (refused) → the real code (company shown) → claim the business admin
   with the setup code.
5. As the business admin, onboard a supervisor and an executive into your custom module; open `/#/m/<module>` →
   switch views → open a case → fill the form → watch the approval buttons and audit trail change per role.

*Verified click-paths: this page is checked end to end with real input by phase F5 (`docs/reports/F5.md`).*

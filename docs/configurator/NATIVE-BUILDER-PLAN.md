# Native configurator replacement plan

**Task 9** · 2026-10-06 · plan only (no code changed) · replaces the Claude Design dc-runtime configurator
(licence risk LR-02) and its NocoBase draft store (LR-01) with a native React builder in this repo, built on
the first-party store API (`docs/store/API.md`) and the `workspace-manifest/1` format (`docs/manifest/README.md`).

**Inspected:** `web/server.mjs`, `web/lib/{store,projection,v5-model,static,env}.mjs`,
`web/public/{index.html,main.js,boot.js,storage-bridge.js,sync-engine.js,bridge-core.js}`, `web/README.md`,
`web/CHANGES.md`, `web/test/*`, `web/scripts/e2e-nocobase.mjs`; `app/frontend/public/configurator/*` (incl.
`host-bridge.js`, the in-app `configurator.dc.html` logic class; `support.js` and `vendor/` summarised only);
`app/frontend/src/modules/admin/{adminApi.js,AdminPortalPage.jsx}`, `…/workspaces/{WorkspacesArea.jsx,
configuratorHost.js,dialogs.jsx,WorkspacesList.jsx}` + `__tests__/`; `app/frontend/{vite.config.js,package.json,
src/router/AppRouter.jsx,src/main.jsx}`; `app/backend/app/routers/{platform,workspace}.py`,
`services/module_runtime/validate.py`, migrations `20261004_1_*`, `20261004_7_*`; `packages/{manifest,store,access}`,
`templates/matrix-bd/`, `docs/{independence,manifest,store,rbac,templates}/`, `app-stack/{start.sh,lib.sh,smoke-configurator.mjs}`.

Line references to `configurator.dc.html` are to the in-app copy (`app/frontend/public/configurator/`).

## 1. Current configurator responsibilities

Two copies of the same artifact run today: standalone on `:4300` (`web/`) and embedded in the platform-admin
portal as a same-origin iframe (`app/frontend/public/configurator/`, a byte-copy of `web/public/` plus
`host-bridge.js` and the G3 creator rule in the `.dc.html`). Both persist to the same NocoBase rows through `/cfg`.

| # | Responsibility | Where it lives today | Notes |
|---|---|---|---|
| R1 | Boot the design document | `boot.js` loads vendored React/ReactDOM UMD with the runtime's SRI, inserts `<x-dc>`, calls `__dcBoot()` (app copy `boot.js:148`), patches `componentDidUpdate` (`installPrevStateShim`, `:152`), installs host hooks (`:153`) | `support.js` (dc-runtime, 1,911 lines, no licence) + `@babel/standalone`; CSP needs `'unsafe-eval'` (`web/lib/static.mjs:32`) |
| R2 | Editor UI + domain model | `configurator.dc.html` logic class (~1,900 lines): `wsList()` `:1654` (3 hard-coded demo brands + custom), `createWorkspace()` `:1712` + `wsSlugError()` `:1705`, canvas/graph of modules with port-drag gates (`tryConnect`, `gateCycle`), 9-step module wizard (`WSTEPS` `:1987`) with 4 built-in templates (`:3172`), `addBuiltin()` from the Blue Tokai seed `:1720`, stage/field/approver/tier/nav/perm/roll-up editing, 40-step undo (`commit` `:1756`) | Model is v5 state (`modules[].stages[].approvers`, `tiers`, `gate.conds`, `nav`, `x/y`), not a manifest |
| R3 | Findings | `findings()` `:2569` — 8 client-side checks (key collision, dead gate, unreachable, no approver, …) | Advisory: "Publishing anyway is allowed" (`publishVals` `:2656`) |
| R4 | Draft vs live diff | `diffList()` `:2593` against `state.live`; `stagesNeedingDecision()` | Text lines only, client-computed |
| R5 | Manifest | `manifest()` `:2638` → configurator-v5 JSON (sent to the app) | `stageManifestRule` `:2005` adds `restricted_to` (in-app copy only) |
| R6 | Publish (local) | `onConfirmPublish` `:2694`: `liveV++`, history entry with **hard-coded** `'11 Sep 2026 · platform:ops@matrix.io'` `:2697` | No server involved in v5 itself |
| R7 | History | `historyEntries` `:2716`; "Restore as draft" `:2719` only shows a toast (no-op) | |
| R8 | Draft persistence (browser) | v5 writes `localStorage['wsconfig_v5_custom']` in `componentDidUpdate` `:1745`; `storage-bridge.js:27` wraps `Storage.prototype.setItem`; `sync-engine.js` hydrates before mount (`:128`, decision table `bridge-core.js:67`), debounces `PUT /cfg/state` with whole-blob `If-Match` (`:201`), pauses on 409 and backs up to `wsconfig_v5_custom__conflict_backup` (`:156`, `:225`), uploads offline edits (`:272`), keepalive on exit (`:304`) | Only **custom** workspaces persist; demo edits are lost on reload |
| R9 | Release detection | `detectPublishes()` `bridge-core.js:129` + `buildManifest()` `:101` → `POST /cfg/releases`, queued in `wsconfig_v5_custom__sync.pendingReleases` | Inferred from `liveV` going up |
| R10 | Server + NocoBase store | `web/server.mjs:4-9` (`/cfg/health|state|releases`), `web/lib/store.mjs:153` (`writeState`, whole-blob ETag), `:194` (`appendRelease`), `:210` (projections `cfg_modules/gates/stages`), `:243` (seed demo brands); `projection.mjs:116` (one `cfg_workspaces` row per custom workspace, `state.format = 'wsconfig_v5_custom/1'`) | Loads `nocobase/lib/client.mjs` (`server.mjs:192`); local mode = browser only |
| R11 | Iframe bridge | `host-bridge.js:9-17` protocol (`context`, `pre-publish`, `published`, `request-manifest`, `toast`); wraps `publishVals().onConfirmPublish` (`:144`) to wait for the host (`gatePublish` `:113`, 2.5 s ack); host side `configuratorHost.js:28` | Token never enters the frame |
| R12 | App panel / publish into the app | `WorkspacesArea.jsx`: pre-publish → `POST …/releases/validate` → provision if 404 (`ProvisionDialog`, `dialogs.jsx:9`) (`:105`); after v5 published → `POST /platform/workspaces/{ref}/releases` (`:133`); "Check draft" via `request-manifest` (`:165`); states `blocked/refused/live/error` incl. "canvas says live but app refused" (`:348`) | Two-phase publish that can diverge |
| R13 | Findings display | `FindingsList` `dialogs.jsx:82`, `splitFindings`/`findingWhere` `configuratorHost.js:89,98` | Shows backend findings `{severity, code, message, module, stage, field, path}` |
| R14 | Provisioned workspaces + migrations | `WorkspacesList.jsx`, `MigrateCasesPanel.jsx` over `platformApi` (`adminApi.js:86-106`) | Already native React, no iframe |
| R15 | Backend release store (v5) | `platform.py:106-118` (publish/validate), v5 validator `module_runtime/validate.py`, `tenant_config_releases` (`schema_version 'configurator-v5'`), `platform_workspaces` (`workspace_ref` = v5 id) | A second release store next to NocoBase (`docs/store/README.md` §2) |

## 2. What to preserve

| Feature (required) | Today | Native builder | Store API |
|---|---|---|---|
| Workspace list | `wsList()` (demo + custom) + "Provisioned workspaces" tab | `WorkspacesPage`: every store workspace with live version, head revision, `differs_from_live`, tenant status | `GET /api/v1/workspaces` (**new**, §6) + `GET /platform/workspaces` |
| Create workspace | v5 dialog: name, slug rules `^[a-z][a-z0-9-]{1,30}$`, reserved slugs, start = template\|empty | `CreateWorkspacePage`: name, key (same rules + validator's reserved keys), start = **any workspace template** from the catalogue, empty, or (transition) import | `POST /api/v1/workspaces` (**new**) → draft r1 |
| Edit modules | wizard + inspector, add built-in from seed | `ModuleEditor` (name, icon, subject, members, delegation, separation of duties, exit, roll-up, views, adapter, enabled); "Add module from template" | `PUT …/draft` |
| Edit stages | wizard step "Stages", inspector | `StageEditor` (key, name, submit roles + `restricted_to`/`restrict_roles`, outcome, `send_back_to`, `sla_hours`), reorder | `PUT …/draft` |
| Edit fields | wizard step "Fields", free-text validation hint | `FieldEditor` with **typed** validation (schema `$defs.field`: type, options, validation, affects_outcome) | `PUT …/draft` |
| Edit approval tiers | `approvers[]` + `tiers` flags (implicit rank) | `ApprovalTiersEditor`: ordered `approvals[] {role, module?, actions, label, fields}`; roles come from the manifest's own `roles[]` | `PUT …/draft` |
| Edit gates | port drag on canvas, `match`, refusal text | `GateEditor` for `entry_gate` and `stage.gate`: conditions on modules/signals of the same subject, outcome picker limited to producible outcomes | `PUT …/draft` |
| Validate draft | `findings()` client-side + "Check draft against the app" | Every save returns the server validation; "Validate" button for unsaved state; `packages/manifest` R0–R10 is the only authority | `PUT …/draft` (`validate: true`), `POST …/draft/validate` |
| Publish release | v5 local publish + app gate + app release | One server transaction: review diff + findings, reason, accept warnings, provision on first publish | `POST …/releases` |
| View release history | v5 history list (fake restore) | `ReleaseHistoryPage` + `ReleasePage` (manifest, validation, diff vs previous, **real** "reset draft to this release", rollback) | `GET …/releases[/{v}]`, `POST …/draft/reset`, `POST …/releases {rollback_to}` |
| Compare draft vs live | `diffList()` text in the publish dialog; live/draft toggle | `ComparePage` for any two refs (`live`, `vN`, `rN`, `draft`); breaking changes flagged; links into editors | `GET …/diff?from=&to=` |
| Show findings/errors | validation bar + panel; App-panel `FindingsList` | `FindingsPanel` (drawer) + inline badges on outline and controls, mapped by JSON path | finding shape `{severity, rule, code, message, path, module?, stage?, field?}` |
| Save drafts with conflict detection | whole-blob ETag, 409 → pause + "reload", server wins | Per-workspace revisions, `If-Match: "r<n>"`, 409 `revision_conflict` → conflict dialog with diff and rebase | `PUT …/draft`, `GET …/diff?from=rN&to=rM` |

Also kept (already first-party): tenant provisioning + one-time codes (`ProvisionDialog`, `CredentialsDialog`,
`POST /platform/workspaces`), setup-code re-issue, migrate running cases (`MigrateCasesPanel`, re-pointed to the
store's plan/execute API), 401 → re-auth → retry (`useAdminReauth`), session timer, 100-step in-session undo/redo,
a read-only manifest JSON view with copy.

## 3. What to remove

### 3.1 Behaviour removed (not ported)

| Removed | Why / replacement |
|---|---|
| dc-runtime, `<x-dc>` templates, vendored React UMD + `@babel/standalone`, `'unsafe-eval'` CSP | LR-02/LR-10; React comes from npm via Vite as for the rest of the app |
| iframe + `postMessage` protocol, pre-publish ack/timeout, "published" detection | The builder is part of the portal; it calls the API directly |
| `localStorage` as the draft store, hydration table, storage interceptor, whole-blob ETag, conflict backup key | Drafts live in `workspace_drafts` revisions; browser storage keeps only an unsent-edit recovery copy (§5) |
| `/cfg` server, NocoBase client, `cfg_*` projections, demo-workspace seeding, `cfg_releases` ledger | LR-01; the store owns drafts, releases, module projection and activity |
| Demo brands (Blue Tokai, Starbucks, Burger King), replay storyline, "planned capabilities", three-tenant Compare | Product must not hard-code a customer (LR-04); templates are data (§7.3) |
| Built-in modules, `addBuiltin()` from a seed, v5 wizard templates in code | `templates/matrix-bd/*.template.json` via the template catalogue; R7 forbids built-ins |
| Client-side findings/diff as authority; "publish anyway" with errors | Server validator + server diff; errors refuse the publish (`422 manifest_invalid`) |
| Two-phase publish ("canvas says live, app refused", retry storing) | One `store_publish` transaction |
| Hard-coded publisher/date, toast-only "Restore as draft" | Publisher from the token; real `draft/reset` |
| Canvas `x/y`, v5 `nav` / `pages` | Not part of the manifest (schema `additionalProperties: false`); navigation is derived; saved views are `modules[].views[]` |

### 3.2 Old files to retire (deleted) — 126 files

| Phase | Path | Files |
|---|---|---|
| P2 | `app/frontend/public/configurator/{boot.js, bridge-core.js, configurator.dc.html, host-bridge.js, index.html, main.js, storage-bridge.js, support.js, sync-engine.js}` | 9 |
| P2 | `app/frontend/public/configurator/vendor/**` (react, react-dom, @babel/standalone + 2 LICENSE, `VERSIONS.md`, `fonts/ibm-plex.css`, 2 font LICENSE, 36 woff2) | 43 |
| P2 | `app/frontend/src/modules/admin/workspaces/configuratorHost.js` (host half of the bridge; `splitFindings`/`findingWhere` move to `builder/findings/`) | 1 |
| P2 | `app/frontend/src/modules/admin/workspaces/WorkspacesArea.jsx` (iframe + App panel) | 1 |
| P2 | `app/frontend/src/modules/admin/workspaces/__tests__/{hostBridge.test.js, configuratorHost.test.js, configuratorCreatorRule.test.js, WorkspacesArea.test.jsx}` | 4 |
| P3 | `web/server.mjs`, `web/package.json`, `web/README.md`, `web/CHANGES.md` | 4 |
| P3 | `web/lib/{env,projection,static,store,v5-model}.mjs` | 5 |
| P3 | `web/public/{boot.js, bridge-core.js, configurator.dc.html, index.html, main.js, storage-bridge.js, support.js, sync-engine.js}` | 8 |
| P3 | `web/public/vendor/**` (same 43 files as above) | 43 |
| P3 | `web/test/{bridge,projection,server,sync-engine,vendor}.test.mjs`, `web/test/helpers/{fake-nocobase,v5-harness}.mjs` | 7 |
| P3 | `web/scripts/e2e-nocobase.mjs` | 1 |
| | **Total** | **126** (P2: 58, P3: 68) |

Before P3 deletes `web/`, P0 captures v5 fixtures from `web/lib/v5-model.mjs` (§9) so importer tests keep real data.

### 3.3 Files modified, not deleted

| Phase | File | Change |
|---|---|---|
| P1 | `app/frontend/src/router/AppRouter.jsx:173` | `/admin` → `/admin/*` (nested builder routes) |
| P1 | `app/frontend/src/modules/admin/AdminPortalPage.jsx:190,286` | Workspaces tab renders the nested routes; provides `AdminAuthContext` (`withAuth`) |
| P1 | `app/frontend/src/modules/admin/adminApi.js` | add `storeApi` (`/api/v1`, `Authorization: Bearer`, `If-Match`, `Idempotency-Key`, problem+json → `err.code`) |
| P1 | `…/workspaces/dialogs.jsx` | `FindingsList` moves to `builder/findings/`; `ProvisionDialog`, `ReauthDialog` stay |
| P1 | `…/workspaces/{WorkspacesList.jsx, MigrateCasesPanel.jsx}` | become `WorkspacesPage` / `MigrationsPage` content; migrations re-pointed to `/api/v1/…/migrations` in P2 |
| P2 | `app/frontend/vite.config.js:19` | remove the `/cfg` proxy |
| P2 | `web/server.mjs` (until P3) | `CFG_READONLY=1`: `PUT /cfg/state` → `423 frozen` during the import window |
| P3 | `start.sh:41`, `stop.sh:6`, `app-stack/{start.sh:124-147, lib.sh:19-21,88, status.sh:34-44}` | drop the `:4300` server and NocoBase (with Task 3 step 6) |
| P4 | `app/backend/app/routers/platform.py:106-118`, `adminApi.js` `validate`/`publish` | v5 release endpoints return `410 gone` → deleted with the runtime re-point task (`module_runtime/validate.py`, `manifest.schema.json` follow it) |
| P4 | `app-stack/smoke-configurator.mjs`, `docs/F4b-UI.md` | rewritten for the store API / native builder |

`sources/design-artifact/` stays in this sandbox only as reference and is excluded from the product layout
(`docs/independence/AUDIT.md`, "remove from product").

## 4. New React route/page structure

### 4.1 Architecture

```
 Browser (one SPA, HashRouter, same bundle as the app)            Backend (FastAPI, first-party)
 ┌──────────────────────────────────────────────────────┐        ┌─────────────────────────────────────┐
 │ AdminPortalPage  /admin/*   (admin token in memory)  │        │ /api/v1/workspaces/{ws}/…  (Task 3) │
 │  └ builder/                                          │ fetch  │   draft  GET/PUT(If-Match)/validate │
 │     pages/      WorkspacesPage, BuilderShell, …      │───────▶│   releases  publish/rollback/history│
 │     state/      useDraft (reducer + autosave engine) │  JSON  │   diff · migrations · activity      │
 │     editors/    schema-driven (manifest JSON Schema) │◀───────│   + NEW: workspaces, templates,      │
 │     findings/   path → route/control mapping         │        │          schema, import/v5          │
 │     templates/  catalogue client + merge             │        │  guard: packages/access (grants)    │
 │  (no iframe, no postMessage, no localStorage store)  │        │  validate: packages/manifest        │
 └──────────────────────────────────────────────────────┘        │  SQL: packages/store (PostgreSQL)   │
                                                                  │ /api/platform/workspaces (tenant    │
                                                                  │   provisioning, codes — kept)       │
                                                                  └─────────────────────────────────────┘
```

Code lives in `app/frontend/src/modules/builder/` (standalone target: `web/src/configurator/`, AUDIT §6).

### 4.2 Routes (all under the existing `HashRouter`, so URLs are `/#/admin/…`)

| Route | Page | Notes |
|---|---|---|
| `/admin/workspaces` | `WorkspacesPage` | list + "New workspace"; replaces the "Design & publish" / "Provisioned" tabs |
| `/admin/workspaces/new` | `CreateWorkspacePage` | name, key, start: template / empty |
| `/admin/workspaces/import` | `ImportV5Page` | **transition only** (P1–P3): recover v5 drafts (§8); removed in P4 |
| `/admin/workspaces/:ws` | → `/builder` | |
| `/admin/workspaces/:ws/builder` | `BuilderShell` › `WorkspaceOverview` | outline (left), editor (centre), findings drawer (bottom), save status |
| `/admin/workspaces/:ws/builder/settings/:section` | `SettingsEditor` | `section` = `subjects` \| `roles` \| `outcomes` \| `signals` \| `permissions` |
| `/admin/workspaces/:ws/builder/modules/:module` | `ModuleEditor` | `:module` = module **key** |
| `/admin/workspaces/:ws/builder/modules/:module/gate` | `GateEditor` (entry gate) | |
| `/admin/workspaces/:ws/builder/modules/:module/stages/:stage` | `StageEditor` (+ stage gate) | `:stage` = stage key |
| `/admin/workspaces/:ws/builder/modules/:module/stages/:stage/approvals/:tier` | `ApprovalTierEditor` | `:tier` = 0-based index (tiers have no key) |
| `/admin/workspaces/:ws/builder/modules/:module/stages/:stage/fields/:field` | `FieldEditor` | `:field` = field key |
| `/admin/workspaces/:ws/compare?from=live&to=draft` | `ComparePage` | any refs: `live`, `vN`, `rN`, `draft` |
| `/admin/workspaces/:ws/publish` | `PublishPage` | review diff + findings, reason, warnings, provision, publish |
| `/admin/workspaces/:ws/releases` | `ReleaseHistoryPage` | |
| `/admin/workspaces/:ws/releases/:version` | `ReleasePage` | manifest, validation, diff vs previous, reset draft / rollback |
| `/admin/workspaces/:ws/revisions` | `DraftRevisionsPage` | draft history (who/agent/import), open or reset to a revision |
| `/admin/workspaces/:ws/migrations` | `MigrationsPage` | existing `MigrateCasesPanel`, store migrations API |
| `/admin/workspaces/:ws/activity` | `ActivityPage` | hash-chained log, `chain_valid` shown |
| `/admin/workspaces/:ws/tenant` | `TenantPage` | provisioning status, workspace code, seats, business admin, re-issue setup code |

Selection is the route (deep-linkable, back button works); key-based segments survive reordering (manifest M6).
A route naming a key that no longer exists redirects to the nearest existing parent with a toast.

## 5. State model

| Layer | Holds | Owner |
|---|---|---|
| Server draft | `{revision, etag, manifest, manifest_sha256, validation, saved_by, saved_via, saved_at, base_release_version, live_version, differs_from_live}` | `GET/PUT …/draft` |
| Working copy | `working` manifest the editors render (immutable updates) | `useDraft` reducer |
| Pending ops | JSON Patch ops (RFC 6902) applied since `server.revision` — used for save, undo and conflict rebase | `useDraft` |
| Undo/redo | groups of inverse ops, 100 deep, cleared on reload (durable undo = draft revisions) | `useDraft` |
| Save state | `clean \| dirty \| saving \| conflict \| error \| offline` + `lastError`, `retryInMs`, `conflict {head_revision, saved_by, saved_at}` | autosave engine |
| Findings | `{revision, items, byPointer, stale:Set}` from the last validation | `useFindings` |
| Selection | from route params | router |
| Read models | workspaces list, releases, diff, activity, templates, tenant | small `useResource(key, fetcher)` hooks (no new library) |
| Recovery copy | `{ws, base_revision, ops, saved_at}` of edits not yet acknowledged | `sessionStorage`/`localStorage`, try/catch, per-viewer only |

**Edits.** Editors never mutate; they dispatch `op(s)` built by helpers (`setAt`, `insertAt`, `removeAt`, `move`,
`renameKey`). `renameKey(kind, pointer, newKey)` emits the cascade: renaming a module/stage/field/role/outcome key
rewrites every reference (gates, `send_back_to`, roll-up fields, views, `members`, grants, `approval.module`) so
the validator does not have to catch what the editor broke. All reference pickers list only values declared in the
same manifest — no fixed role, outcome or module list in the builder.

**Autosave.** Debounce 800 ms, max-wait 5 s (same shape as `createDebouncer`, `bridge-core.js:165`, re-written in
`builder/state/debounce.js`). `PUT …/draft` with `If-Match: "r<server.revision>"` (`"r0"` for a first save),
`{manifest: working, validate: true, note}`; response replaces `server`, findings and `etag`; ops acknowledged are
dropped. One save in flight; edits during a save re-arm the debounce. Network/5xx → `error`, exponential retry
2 s → 30 s; offline → `offline`, recovery copy kept, retried on `online`. Navigation/publish first awaits `flush()`.
`beforeunload` warns while `dirty|saving|conflict` (no keepalive PUT: the recovery copy covers it).

**Conflict (`409 revision_conflict`).** Autosave stops; `ConflictDialog` shows who saved and the diff
`GET …/diff?from=r<base>&to=r<head>`. Choices: (a) **Rebase** — load head, re-apply pending ops by key-resolved
pointers; ops whose target changed or vanished are listed and skipped; result saved with `If-Match: "r<head>"`;
(b) **Take theirs** — discard pending ops (kept as a downloadable JSON patch); (c) **Keep mine** — save working
copy on top of head (explicit overwrite, still a new revision, nothing lost in history). Never silent.

**Findings.** A finding's `path` (`modules/1/stages/0/fields/2/validation`) is resolved against the manifest it
was produced from (`server.manifest` at `findings.revision`) to keys, then to current indices in `working`, so
findings stay attached after reordering. Findings whose subtree has pending ops are marked `stale` (dimmed) until
the next save returns a fresh report.

## 6. API contract needed

Base `/api/v1`, problem+json errors, grants from `packages/access` (the platform operator token may act on any
workspace; `docs/store/API.md` §0). Existing contract (`docs/store/openapi.yaml`) used as-is:

| Builder action | Call | Grant | Handled responses |
|---|---|---|---|
| Open draft | `GET /workspaces/{ws}/draft` | `edit_draft` | `404 no_draft` → offer template / reset to live |
| Save | `PUT /workspaces/{ws}/draft` + `If-Match` | `edit_draft` | `200`+ETag; `409 revision_conflict`; `413 manifest_too_large`; `422 not_a_manifest`; `428` (bug) |
| Validate unsaved | `POST /workspaces/{ws}/draft/validate {manifest}` | `edit_draft` | always `200 {ok, errors, warnings, findings}` |
| Reset draft | `POST /workspaces/{ws}/draft/reset {to: live\|{release}\|{template}}` + `If-Match` | `edit_draft` | as save |
| Draft history | `GET /workspaces/{ws}/draft/revisions[/{n}]` | `edit_draft` | paginated |
| Publish | `POST /workspaces/{ws}/releases {draft_revision, expected_live_version, reason, accept_warnings}` + `Idempotency-Key` | `publish_release` | `201`; `409 draft_changed\|live_changed\|nothing_to_publish\|warnings_not_accepted`; `422 manifest_invalid` (findings) |
| Rollback | `POST /workspaces/{ws}/releases {rollback_to, expected_live_version, reason}` | `publish_release` | as publish |
| History / release | `GET /workspaces/{ws}/releases`, `GET …/releases/{version\|live}` | `view_audit`\|`edit_draft` | immutable, cacheable |
| Compare | `GET /workspaces/{ws}/diff?from=&to=` | `edit_draft`\|`view_audit` | `changes[] {path, op, before, after, kind, breaking, impact}` |
| Migrate | `POST …/migrations`, `POST …/migrations/{id}/execute\|cancel`, `GET …/migrations[/{id}[/items]]` | `migrate_cases` | `409 plan_changed`, `410 plan_expired`, `409 migration_in_progress` |
| Activity | `GET /workspaces/{ws}/activity` | `view_audit` | `chain_valid` |

**New endpoints this plan requires** (to add to `openapi.yaml` and the Task 3 implementation in P0):

| Endpoint | Purpose | Grant | Shape |
|---|---|---|---|
| `GET /workspaces` | workspace list | operator, or any grant in that workspace (filtered) | `{items:[{key, name, live_version, head_revision, differs_from_live, last_activity_at, tenant:{status, workspace_code}?}], next_cursor}` |
| `POST /workspaces` | create workspace + draft r1 | operator | `{key, name, start: {template:"<key>@<version>"} \| "empty"}` → `201` + draft body; `409 workspace_exists`, `422 invalid_key` |
| `GET /templates?kind=module\|workspace&workspace={ws}` | template catalogue from configured template roots (`TEMPLATE_DIRS`), honouring `template.visibility` (`customer-private` only for workspaces linked to that customer) | `edit_draft` | `{items:[{key, version, kind, title, requires:{subject, modules, roles, outcomes}, visibility}]}` |
| `GET /templates/{key}@{version}` | one template (module or composed workspace) | `edit_draft` | template JSON as in `templates/matrix-bd/*.template.json` |
| `GET /schema/workspace-manifest/1` | the JSON Schema the server validates with (`ETag` = sha256) | any | `packages/manifest/workspace_manifest.schema.json`; the builder warns if it differs from its bundled copy |
| `POST /import/v5-drafts?dry_run=` | convert a v5 blob (cfg row or browser `wsconfig_v5_custom`) to drafts (§8) | operator | per workspace: `{ref, key, action: create\|new_revision\|skip, findings, report:{builtins, notes}}` |

`/api/platform/workspaces*` stays for tenant provisioning (`POST /platform/workspaces`, `GET /platform/workspaces/{ref}`,
`POST …/admin-setup-code`) with `ref` = workspace key (legacy v5 ids resolved through the alias in §8).
`POST /platform/workspaces/{ref}/releases[/validate]` are **not** used by the builder (deprecated in P4).

## 7. Components needed

### 7.1 Pages and shell

| Component | Responsibility |
|---|---|
| `WorkspacesPage` | table of workspaces (from `GET /workspaces` + tenant status), filter, "New workspace", links to builder/releases/tenant |
| `CreateWorkspacePage` | name → suggested key, key rules (`^[a-z][a-z0-9-]{1,40}$`, reserved list from the validator), `TemplatePicker kind=workspace`, empty start |
| `BuilderShell` | layout, `useDraft` provider, `SaveStatus`, `UndoRedo`, `OutlineTree`, `FindingsPanel`, header actions (Validate, Compare, Publish, Manifest JSON) |
| `OutlineTree` | workspace settings → modules → gate / stages → approvals / fields; reorder by drag or keyboard; finding counts per node (prefix match on pointer) |
| `PublishPage` | `flush()` → diff live→draft → findings → reason (≤ 500, required) → "accept warnings" → `ensureProvisioned` (`ProvisionDialog` + `CredentialsDialog`, unchanged) → publish → result with `running_cases_on_older_releases` → link to migrations |
| `ComparePage` / `DiffView` | ref pickers, summary, `changes[]` grouped by module, `breaking` badges, "open in editor" by path |
| `ReleaseHistoryPage`, `ReleasePage` | list, manifest view, validation, reset draft to release, rollback (confirm + reason) |
| `DraftRevisionsPage` | revisions with `saved_via` (`ui`/`agent`/`import`/`reset`) |
| `MigrationsPage`, `ActivityPage`, `TenantPage` | existing `MigrateCasesPanel` / `WorkspacesList` detail, re-homed |
| `ImportV5Page` + `LegacyDraftBanner` | transition: detect and import v5 browser blobs (§8) |

### 7.2 Schema-driven editors

| Component | Responsibility |
|---|---|
| `SchemaForm` | wrapper over `@rjsf/core` 6.11 (already a dependency, used by `GenericRecordPage.jsx`) rendering any `$defs` object of the bundled manifest schema; `uiSchema` registry per `$def`; every control carries `data-pointer` |
| Widgets: `KeyInput`, `RefPicker`, `RolePicker`, `OutcomePicker`, `SourcePicker`, `ValidationEditor` | `KeyInput` → `renameKey` cascade; pickers read options from the working manifest (roles filtered by scope/membership, outcomes producible by a source, modules/signals of the same subject) |
| `ModuleEditor`, `StageEditor`, `FieldEditor`, `ApprovalTiersEditor`/`ApprovalTierEditor`, `GateEditor`, `SettingsEditor` | thin compositions: an ordered-list editor for arrays of keyed objects + `SchemaForm` for the leaf properties. They contain **no** module names, role names or outcome names |
| `ManifestJsonView` | read-only JSON of draft/release with copy (replaces v5 "Draft manifest") |

Schema drift guard: a test walks `$defs.{module, stage, field, approval, gate, condition, submit, exit, rollup, view,
grant, role, outcome, subject, signal}` and fails if a property has no editor control (§9), so a new manifest
feature (e.g. `required_if` from the templates backlog) cannot ship without an editor.

### 7.3 Findings and templates

| Component | Responsibility |
|---|---|
| `findings/locate.js` | `locate(manifestAtRevision, working, path)` → `{route, pointer}`; also uses `module/stage/field` keys when present |
| `FindingsPanel`, `FindingBadge`, `FieldFinding` | grouped errors → warnings → import notes (generalises `FindingsList`, `dialogs.jsx:82`, and `findingWhere`); click navigates and focuses `data-pointer`; shows `rule` + `code` |
| `TemplatePicker` | lists `GET /templates`; shows `requires` and what will be added |
| `templates/apply.js` | `applyModuleTemplate(manifest, template)` → ops: add the module, add missing roles/outcomes/subject fields from `requires`, refuse key collisions (offer a new key with cascade); same function for any customer's template — `matrix-bd/*` is just one catalogue root |

## 8. Migration path from current drafts

### 8.1 Where drafts live today

| Store | Content | Imported? |
|---|---|---|
| NocoBase `cfg_workspaces` rows, `is_custom: true` | `state = {format:'wsconfig_v5_custom/1', workspace:{id, name, slug, start, created}, order, data: stash}`; `stash = {modules, perms, live:{modules, perms}, liveV, draftV, history}` (`projection.mjs:116-131`) | **yes** — primary source |
| Browser `localStorage['wsconfig_v5_custom']` (+ `__sync {dirty, base, pendingReleases}`, `__conflict_backup`) | same blob; newer than NocoBase when the browser ran in local mode or had unsynced edits (`sync-engine.js:161-170`) | **yes**, via recovery (§8.3) |
| NocoBase `cfg_workspaces` rows, `is_custom: false` | demo brand seeds (`store.mjs:243`) | **no** (LR-04) |
| Demo workspace edits | in memory only, never persisted (`web/README.md` "Limitations") | nothing to import |
| `cfg_releases` | release ledger mirrored from v5 publishes | no — provenance cross-check only |
| App `tenant_config_releases` (`configurator-v5`) + `platform_workspaces.workspace_ref` (= v5 id, e.g. `ws_third_wave`) | published releases | yes, by Task 3 cut-over step 2 (releases first, so drafts get a `base_release_version`) |

### 8.2 Conversion (importer `packages/store/import/v5_drafts.py`, used by the CLI and `POST /import/v5-drafts`)

1. **Stash → v5 manifest of the draft**: Python port of `buildManifest(cw, stash, {source:'draft'})`
   (`bridge-core.js:101`) **plus** the creator rule `stage.creatorOnly → restricted_to: 'site_creator'`
   (`configurator.dc.html:2005`), which `buildManifest` omits today — tested against the in-app `manifest()`.
2. **v5 → `workspace-manifest/1`**: `from_v5.convert(v5, include_templates=<module templates from the catalogue>)`
   (`from_v5.py:215`); built-ins (`report.builtins`) are filled from `templates/<customer>/<key>`; workspace key =
   `cw.slug` (falls back as `convert` does).
3. **Validate** with `packages/manifest` and the installed adapter registry.
4. **Save** with `store_save_draft(ws, expected=head|0, manifest, actor='import:<operator>', saved_via='import',
   note='v5 <slug> draft v<draftV> (cfg_workspaces)')`, validation stored on the revision. Drafts with errors are
   saved (`API.md` §1.2) — they are work in progress.
5. **Conversion findings are kept, not lost**: `report.notes` (e.g. unreadable validation hints kept as `help`)
   and missing templates become `severity: "info"`, `rule: "IMPORT"`, `code: "import_note"|"builtin_without_template"`
   entries with a best-effort `path`, stored in the revision's activity `detail.import_report`; the builder shows
   them in `FindingsPanel` under "Imported from configurator v5" until the next publish. Validator errors appear as
   normal findings. Nothing is auto-fixed.
6. **Identity**: the store workspace key is the v5 `slug`; an alias `workspace_legacy_refs(ref → workspace_id)`
   maps v5 ids (`platform_workspaces.workspace_ref`, `source_ref 'configurator:<id>@vN'`) so tenant lookups,
   provenance and `/platform/workspaces/{ref}` keep resolving.
7. **Draft = live**: if the converted draft equals the imported live release (same sha256), it is recorded as
   `draft/reset to live` (`differs_from_live: false`). A provisioned ref with **no** persisted draft (a demo
   workspace published in the sandbox) gets draft r1 = its imported live release; brand-named refs are listed and
   skipped unless `--include-demo-refs`.
8. **Idempotent**: keyed by `(slug, sha256(state))`; re-running skips imported states and reports them.

### 8.3 Drafts mid-edit

| Situation | Handling |
|---|---|
| Edits synced to NocoBase | imported in the final run (P2) |
| Open tab still editing at freeze | `CFG_READONLY=1` → `PUT /cfg/state` `423`; the old pill turns "Sync error" so nothing is silently lost; the edits stay in that browser's `localStorage` → next row |
| Browser-only edits (local mode, `__sync.dirty`, `__conflict_backup`) on the app origin | the native builder runs on the **same origin** as the in-app configurator, so `LegacyDraftBanner` reads those keys (try/catch), `POST /import/v5-drafts?dry_run=true`, shows per workspace: create / new revision on top of head / identical; on confirm saves with `saved_via: import`, note `recovered browser edits`, `If-Match` = head (a conflict goes through the normal conflict dialog). Keys are renamed `…__imported_<ts>`, deleted in P4 |
| Browser-only edits on `localhost:4300` (other origin) | before freeze, open `:4300` once in nocobase mode: hydration pushes dirty edits (`decideHydration` `push`); else paste the exported blob into `ImportV5Page` |
| `pendingReleases` never posted | ignored: the app's `tenant_config_releases` is authoritative; the v5 "live" snapshot becomes part of the draft diff instead |

### 8.4 Phases

| Phase | Gate to enter | Work | Removed |
|---|---|---|---|
| P0 Backend | Task 3 store mounted at `/api/v1` | new endpoints (§6), importer + alias, shadow import dry-run report for every `cfg_workspaces` row, capture v5 fixtures | — |
| P1 Parallel | P0 | builder behind `VITE_NATIVE_BUILDER=1`: list, create, edit, validate, compare, history; **publish disabled** until the runtime reads `workspace_releases` (Task 3 step 4) | — |
| P2 Cut-over | runtime re-pointed; dry-run import with 0 failures | freeze old configurator, final import, builder default + publish on, recovery banner, migrations on store API | 58 files (§3.2), `/cfg` proxy |
| P3 Independence | P2 stable one release cycle | delete `web/`, stack scripts, NocoBase (Task 3 step 6); `check-independence --only=dc-runtime,nocobase` | 68 files |
| P4 Clean-up | no legacy keys seen for 30 days | remove `ImportV5Page`/banner, v5 release endpoints → `410`, drop old tables (Task 3 step 7) | transition code |

## 9. Tests to add

| Level | Test | Proves |
|---|---|---|
| Unit (vitest) | `ops.test.js` — apply/inverse of every op; `renameKey` cascade for module/stage/field/role/outcome keys over `packages/manifest/examples/acme-retail.manifest.json` and `templates/matrix-bd/workspace.manifest.json` | edits keep references valid; undo restores byte-equal manifests |
| Unit | `locate.test.js` — **data-driven over every case in `packages/manifest/tests/fixtures/invalid_cases.json` (62 today)**: run through recorded validator output, every finding resolves to a route + an existing `data-pointer` | every validator code is reachable in the UI |
| Unit | `autosave.test.js` (fake timers + fetch) — debounce/max-wait, single in-flight, `If-Match` sequencing, 409 → conflict + paused, retry/backoff, offline recovery copy, flush before publish | conflict detection never loses edits |
| Unit | `rebase.test.js` — pending ops re-applied on a moved/renamed/deleted target | conflict rebase is correct and reports skipped ops |
| Unit | `schemaCoverage.test.js` — every property of the listed `$defs` has an editor control; bundled schema sha256 == `packages/manifest/workspace_manifest.schema.json` | schema-driven, no drift |
| Unit | `applyTemplate.test.js` — each `templates/matrix-bd/*.template.json` and a neutral fixture template apply to an empty and a populated manifest; collisions produce a rename; result validates (server mock) | templates are data, generic |
| Component (RTL) | WorkspacesPage, CreateWorkspacePage, Module/Stage/Field/ApprovalTier/Gate editors, FindingsPanel (click → focus), ConflictDialog (3 choices), PublishPage (reason required; each 409/422 code; provisioning path with `ProvisionDialog`/`CredentialsDialog`), ComparePage, ReleasePage (reset + rollback), LegacyDraftBanner | all preserved features |
| Contract | request/response mocks validated with ajv against `docs/store/openapi.yaml` | client and contract agree |
| Static | `noLegacy.test.js` — `src/` has no `<iframe`, `postMessage`, `/configurator/`, `/cfg`, `wsconfig_v5`, `x-dc`; no Matrix-bd module/brand names in `src/modules/builder/` | rules hold in code |
| Backend (pytest) | new endpoints (list/create/templates/schema/import) incl. grants and RLS; importer on captured fixtures: v5 seeds from `web/lib/v5-model.mjs` + sync-engine flows, creatorOnly mapping, builtins via templates, alias, draft=live, idempotency, demo refs skipped | migration correctness |
| Smoke | `app-stack/smoke-builder.mjs`: create from template → save r1 → stale save 409 → validate → publish v1 → edit → diff → publish v2 → history → migrate dry-run → activity `chain_valid` | end-to-end on the real stack without NocoBase |
| Gate | `node docs/independence/check-independence.mjs --only=dc-runtime,nocobase` over `app/` (P2) and the repo (P3) = 0 | licence blockers gone |

## 10. Acceptance criteria

| # | Criterion | Verified by |
|---|---|---|
| A1 | **No dc-runtime in production**: no `support.js`, `.dc.html`, `<x-dc>`, React UMD, `@babel/standalone`, `'unsafe-eval'` in `app/` (P2) or the repo's product paths (P3) | independence gate = 0, `noLegacy.test.js`, CSP without `unsafe-eval` |
| A2 | **No NocoBase dependency**: no `/cfg`, no `nocobase/lib/client.mjs` import, no NocoBase container in `app-stack`; the builder journey works with NocoBase absent | gate `--only=nocobase` = 0; smoke-builder with NocoBase stopped |
| A3 | **No iframe bridge**: the builder is ordinary routes in the SPA; no `iframe`/`postMessage` in `src/modules/admin` or `src/modules/builder` | `noLegacy.test.js`; the 126 files of §3.2 are gone |
| A4 | **Drafts save through first-party APIs** with revisions and optimistic concurrency: every save is `PUT /api/v1/workspaces/{ws}/draft` with `If-Match`; a stale save shows the conflict dialog and loses nothing | `autosave.test.js`, `rebase.test.js`, smoke 409 step |
| A5 | **Publish uses first-party release APIs** only: `POST /api/v1/workspaces/{ws}/releases`; errors refuse, warnings need acceptance; one live release; the builder never calls `/platform/…/releases` | PublishPage tests, smoke v1/v2 |
| A6 | All 14 features of §2 work: workspace list, create, edit modules/stages/fields/approval tiers/gates, validate, publish, history, compare draft vs live, findings, conflict-safe saves | component tests + smoke |
| A7 | **Manifest-driven**: editors are generated from the bundled `workspace-manifest/1` schema; pickers read the manifest's own roles/outcomes/modules; findings map by JSON path to a focused control for every validator code | `schemaCoverage.test.js`, `locate.test.js` (all invalid fixtures) |
| A8 | **Not hard-coded to Matrix-bd**: templates come from `GET /templates`; the builder works on `acme-retail` with zero Matrix-bd templates installed; no brand or module names in builder code | `applyTemplate.test.js`, static test, smoke with the neutral example |
| A9 | **Migration**: every custom `cfg_workspaces` draft and every recovered browser blob becomes a `workspace-manifest/1` draft revision (`saved_via: import`) or is reported with a reason; conversion notes surface as findings; re-running is a no-op; legacy v5 ids still resolve | importer tests, P2 dry-run report = 0 failures |
| A10 | Access: editing needs `edit_draft`, publishing `publish_release`, migrating `migrate_cases`, creating workspaces the operator; the UI hides what the principal cannot do and the API refuses it anyway | backend grant tests; component tests with reduced grants |

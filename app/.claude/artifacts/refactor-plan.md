# Z-Matrix New-Store-Folder Refactor Plan

Generated: 2026-05-21

---

## 1. Source inventory (pre-refactor)

```
z-matrix-design-system/project/ui_kits/new-store-folder/
  index.html          — CDN React 18 + Babel-standalone entry
  Primitives.jsx      — Icon, StatusPill, Avatar, STAGES, TONES
  PageHeader.jsx      — PageHeader, HeaderTag
  Chrome.jsx          — TopBar, Sidebar, SidebarItem
  Pipeline.jsx        — MetricCard, MetricStrip, FilterChip, PipelineFilter, SiteRow, SitesTable, CornerTicks
  Drafts.jsx          — DraftsView, DraftRow, DraftsFilterBar, RejectReasonDialog
  Shortlist.jsx       — ShortlistCard, ShortlistQueue, LOITimelineModal, NewPipelineModal
  Staging.jsx         — StagingView, ExecRow, SupervisorRow, StagingKpiStrip, StagingFilterBar, TimelineTracker
  Archive.jsx         — ArchiveView
  SiteDrawer.jsx      — SiteDrawer, SiteOverviewTab, SiteActivityTab, SiteDocsTab
  AddDetailsForm.jsx  — AddDetailsForm, PhotoPicker, TextField, SelectField, FormSection

z-matrix-design-system/project/ui_kits/workspace/   — dark AI workspace UI, untouched
```

---

## 2. Target module hierarchy

```
frontend/
  package.json
  vite.config.js
  index.html
  src/
    main.jsx                           # ReactDOM.createRoot + HashRouter + App
    App.jsx                            # TopBar + Sidebar + <Outlet/>; theme + toast state only
    router/
      AppRouter.jsx                    # <Routes> tree
      routes.js                        # ROUTES constants
      guards.jsx                       # RequireRole, RequireScope
    rbac/
      roles.js                         # ROLE enum
      permissions.js                   # ACTION -> roles map
      scope.js                         # scope resolution
    state/
      SessionContext.jsx               # user + role + tenant + city; mock seed = Riya Sharma / exec
      SitesContext.jsx                 # cross-module site cache (drafts, shortlist, staging, archive)
    services/api/
      client.js                        # fetch wrapper (base URL + auth header)
      sites.js                         # site CRUD + transition helpers
      loi.js                           # loi upload / view
      staging.js                       # staging queries
      audit.js                         # activity feed
      notifications.js                 # stub send
      mock/
        drafts.js                      # DRAFTS seed + async listDrafts()
        shortlist.js                   # SHORTLIST seed + async listShortlist()
        staging.js                     # STAGING seed + async listStaging()
        archive.js                     # ARCHIVE_SEED + async listArchive()
    modules/
      bd/
        overview/OverviewPage.jsx      # metrics strip + motion table (was inline in App.jsx)
        drafts/DraftsPage.jsx          # wraps DraftsView
        shortlist/ShortlistPage.jsx    # wraps ShortlistQueue
      loi/
        details/AddDetailsPage.jsx     # wraps AddDetailsForm (modal route)
        timeline/LOITimelinePage.jsx   # wraps LOITimelineModal (modal route)
      staging/
        exec/ExecStagingPage.jsx       # wraps StagingView for exec
        supervisor/SupervisorStagingPage.jsx
      archive/ArchivePage.jsx          # wraps ArchiveView
      shared/
        chrome/                        # TopBar.jsx, Sidebar.jsx (moved from Chrome.jsx)
        primitives/                    # Icon.jsx, StatusPill.jsx, Avatar.jsx, constants.js
        page-header/                   # PageHeader.jsx, HeaderTag.jsx
        site-drawer/                   # SiteDrawer.jsx + sub-tabs
    lib/
      stateMachine.js                  # client mirror: SiteStatus enum + ALLOWED_TRANSITIONS
  legacy/
    workspace/                         # untouched copy of workspace kit
```

---

## 3. Migration map (old -> new)

| Verb | Old path | New path | Reason |
|------|----------|----------|--------|
| MOVE | new-store-folder/Primitives.jsx | src/modules/shared/primitives/ | Shared primitive components |
| MOVE | new-store-folder/PageHeader.jsx | src/modules/shared/page-header/ | Shared chrome |
| MOVE | new-store-folder/Chrome.jsx | src/modules/shared/chrome/ | TopBar + Sidebar |
| MOVE | new-store-folder/Pipeline.jsx | src/modules/shared/primitives/ (MetricStrip, PipelineFilter) | Used by overview |
| MOVE | new-store-folder/Drafts.jsx | src/modules/bd/drafts/DraftsPage.jsx | BD domain page |
| MOVE | new-store-folder/Shortlist.jsx | src/modules/bd/shortlist/ShortlistPage.jsx | BD domain page |
| MOVE | new-store-folder/Staging.jsx | src/modules/staging/ (split exec/supervisor) | Staging domain |
| MOVE | new-store-folder/Archive.jsx | src/modules/archive/ArchivePage.jsx | Archive domain |
| MOVE | new-store-folder/SiteDrawer.jsx | src/modules/shared/site-drawer/ | Shared drawer |
| MOVE | new-store-folder/AddDetailsForm.jsx | src/modules/loi/details/AddDetailsPage.jsx | LOI domain |
| EXTRACT | App.jsx DRAFTS constant | src/services/api/mock/drafts.js | Seed data layer |
| EXTRACT | App.jsx SHORTLIST constant | src/services/api/mock/shortlist.js | Seed data layer |
| EXTRACT | App.jsx STAGING constant | src/services/api/mock/staging.js | Seed data layer |
| EXTRACT | App.jsx ARCHIVE_SEED constant | src/services/api/mock/archive.js | Seed data layer |
| EXTRACT | App.jsx view routing (if/else) | src/router/AppRouter.jsx | Router owns navigation |
| EXTRACT | App.jsx state handlers | src/state/SitesContext.jsx | Lifted state |
| KEEP | new-store-folder/index.html | frontend/index.html | Updated for Vite |
| KEEP | workspace/ kit | frontend/legacy/workspace/ | No changes |
| NEW | — | frontend/src/main.jsx | Vite entry |
| NEW | — | frontend/src/router/ | Routing layer |
| NEW | — | frontend/src/rbac/ | RBAC layer |
| NEW | — | frontend/src/state/ | Context layer |
| NEW | — | backend/ | FastAPI app |

---

## 4. State machine (canonical)

```
null                -> draft_submitted      (exec: create_draft)
draft_submitted     -> shortlisted          (supervisor: shortlist)
shortlisted         -> shortlisted          (exec: save_draft_details, sets details_completion=partial)
shortlisted         -> details_submitted    (exec: submit_details_for_review)
details_submitted   -> approved             (supervisor: approve_details, sets expected_loi_days)
approved            -> loi_uploaded         (exec: upload_loi)
loi_uploaded        -> pushed_to_payments   (supervisor: push_to_payments)

Any stage except pushed_to_payments:
  -> rejected  (supervisor: reject)
  -> archived  (supervisor: archive)
```

---

## 5. RBAC

| Role | Scope | Who |
|------|-------|-----|
| executive | own originated sites only | BD exec |
| supervisor | entire BD department, tenant-wide | BD supervisor |
| sub_supervisor | single city within BD dept | Assigned by supervisor |

Tenancy: `tenant_id` on every row. `get_tenant` dependency in FastAPI extracts from JWT.

---

## 6. API route table

### Domain: bd (`/bd`)

| Method | Path | Handler | Role | State transition | Audit | Notes |
|--------|------|---------|------|-----------------|-------|-------|
| POST | /bd/drafts | create_draft | executive | null->draft_submitted | yes | Notifies supervisor |
| GET | /bd/drafts | list_drafts | executive,supervisor,sub_supervisor | — | no | Scoped by role |
| POST | /bd/drafts/{id}/shortlist | shortlist_draft | supervisor,sub_supervisor | draft_submitted->shortlisted | yes | Notifies exec |
| POST | /bd/drafts/{id}/reject | reject_draft | supervisor,sub_supervisor | *->rejected | yes | Notifies exec |
| POST | /bd/drafts/{id}/archive | archive_draft | supervisor,sub_supervisor | *->archived | yes | |
| GET | /bd/shortlist | list_shortlist | executive,supervisor,sub_supervisor | — | no | |
| POST | /bd/shortlist/{id}/details/save | save_draft_details | executive | stays shortlisted, completion=partial | no | |
| POST | /bd/shortlist/{id}/details/submit | submit_details_for_review | executive | shortlisted->details_submitted | yes | Notifies supervisor |
| POST | /bd/shortlist/{id}/approve | approve_shortlist | supervisor,sub_supervisor | details_submitted->approved | yes | Sets expected_loi_days; notifies exec |
| POST | /bd/shortlist/{id}/reassign | reassign_site | supervisor | — | yes | Move between execs |
| POST | /bd/assign-sub-supervisor | assign_sub_supervisor | supervisor | — | yes | Assigns sub_sup to city |

### Domain: loi (`/loi`)

| Method | Path | Handler | Role | State transition | Audit | Notes |
|--------|------|---------|------|-----------------|-------|-------|
| POST | /loi/{site_id}/upload | upload_loi | executive | approved->loi_uploaded | yes | Notifies supervisor |
| GET | /loi/{site_id} | view_loi | executive,supervisor,sub_supervisor | — | no | Exec sees own only |
| POST | /loi/{site_id}/set-timeline | set_loi_timeline | supervisor,sub_supervisor | — | yes | Sets expected_loi_days |

### Domain: staging (`/staging`)

| Method | Path | Handler | Role | State transition | Audit | Notes |
|--------|------|---------|------|-----------------|-------|-------|
| GET | /staging/exec | list_exec_staging | executive | — | no | All approved sites for this exec |
| GET | /staging/supervisor | list_supervisor_staging | supervisor,sub_supervisor | — | no | Only loi_uploaded sites |
| POST | /staging/{site_id}/push | push_to_payments | supervisor,sub_supervisor | loi_uploaded->pushed_to_payments | yes | Stub; notifies Payments module |

### Domain: sites (`/sites`)

| Method | Path | Handler | Role | State transition | Audit | Notes |
|--------|------|---------|------|-----------------|-------|-------|
| GET | /sites | list_sites | executive,supervisor,sub_supervisor | — | no | Scoped by role/tenant |
| GET | /sites/{id} | get_site | executive,supervisor,sub_supervisor | — | no | Overview tab data |
| GET | /sites/{id}/activity | get_site_activity | executive,supervisor,sub_supervisor | — | no | Audit feed for site |
| GET | /sites/{id}/documents | get_site_documents | executive,supervisor,sub_supervisor | — | no | Document list |

### Domain: audit (`/audit`)

| Method | Path | Handler | Role | State transition | Audit | Notes |
|--------|------|---------|------|-----------------|-------|-------|
| GET | /audit | list_audit_events | supervisor | — | no | Tenant-wide feed; paginated |
| GET | /audit/site/{site_id} | get_site_audit | executive,supervisor,sub_supervisor | — | no | Per-site feed |

### Domain: notifications (`/notifications`)

| Method | Path | Handler | Role | State transition | Audit | Notes |
|--------|------|---------|------|-----------------|-------|-------|
| POST | /notifications/send | send_notification | system | — | no | Stub; TODO(mcp) |
| GET | /notifications | list_notifications | executive,supervisor,sub_supervisor | — | no | In-app feed |

### Domain: tenancy (`/tenancy`)

| Method | Path | Handler | Role | State transition | Audit | Notes |
|--------|------|---------|------|-----------------|-------|-------|
| GET | /tenancy/tenants | list_tenants | supervisor | — | no | |
| GET | /tenancy/cities | list_cities | executive,supervisor,sub_supervisor | — | no | Scoped to tenant |

### Domain: users (`/users`)

| Method | Path | Handler | Role | State transition | Audit | Notes |
|--------|------|---------|------|-----------------|-------|-------|
| GET | /users/me | get_me | * | — | no | Current user + role |
| GET | /users | list_users | supervisor | — | no | Tenant-scoped |
| POST | /users/{id}/assign-city | assign_sub_supervisor_city | supervisor | — | yes | Sub-supervisor city assignment |

---

## 7. Risk callouts

- **CDN globals to ES imports**: All components currently rely on `window.*` globals (e.g. `Object.assign(window, { TopBar, ... })`). When moved to Vite modules, every component must switch to `import`/`export`. Render bodies are NOT changed — only the module boundary changes.
- **CSS vars in index.html**: The `<head>` styles and `<link rel="stylesheet" href="../../colors_and_type.css"/>` must be preserved verbatim; the CSS path will need updating relative to the new frontend root.
- **BuildDrawerSite helper**: Currently defined inline in App.jsx. Will be extracted to `src/lib/buildDrawerSite.js` — not UI logic, pure data transform.
- **Theme state**: `document.documentElement.dataset.theme` manipulation stays in App.jsx; only the state value itself is lifted to SessionContext.
- **No real auth**: SessionContext seeds a mock user. The backend stubs `get_current_user` with a hardcoded payload. Real auth is out of scope.
- **Payments module**: `push_to_payments` is a stub route only; no Payments UI is scaffolded.
- **sub_supervisor in sidebar**: The existing sidebar only has `supervisor`/`exec` toggle. The `sub_supervisor` role is added to the RBAC layer but the sidebar toggle is not changed (only 2 values in the existing UI buttons).

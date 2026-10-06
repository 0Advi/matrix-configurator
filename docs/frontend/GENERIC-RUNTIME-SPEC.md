# Generic frontend runtime spec

**Task 8** · 2026-10-06 · scope: the frontend pages that let **any** manifest module (custom or a Matrix-bd template) run
with no module-specific React page. Contract: the case's **pinned release** (manifest), runtime API data, and
`authorize()` decisions (`docs/rbac/README.md` §3). No marketing/landing pages are in scope.

**Inspected.** Generic runtime: `app/frontend/src/modules/custom-module/{GenericModulePage,GenericRecordPage,ManageViewsPage,GateLocked,kit,viewsKit,widgets}.jsx|js` + `__tests__/` (4 files, 35 tests);
`services/api/moduleRuntimeApi.js`; `state/useWorkspaceModules.js`; `modules/shared/workspaceModules.js`;
`modules/shared/chrome/Sidebar.jsx`; `router/{routes.js,AppRouter.jsx,guards.jsx}`. Backend: `app/backend/app/routers/{module_runtime,module_views,workspace}.py`,
`services/module_runtime_service.py`, `services/module_runtime/{runtime,forms}.py`. Hard-coded: `modules/{legal,design,project,nso,project_excellence,launch,financial_closure,module-history,module-process-flow}/**`,
`modules/shared/{checklist,documents,site-drawer,rent,primitives}/**`. Target: `docs/{manifest,store,rbac,adapters,templates}/*`, `packages/manifest/workspace_manifest.schema.json`.

**Rules for every component below.** (1) Labels, stages, fields, tiers, outcomes, gates and views come from the module definition of
the release the case is pinned to. (2) Whether a button shows comes from a server decision (`allowed_actions` today, `can.*` below),
never from a role name. (3) Built-ins and custom modules use the same routes and components. A built-in that needs more gets a
**generic extension point** (field type, column renderer, provenance renderer, adapter violation), never its own page.

## 1. Existing reusable components

Found **24** reusable units. "Hard-coded inside" lists what must be removed before they are truly generic.

| # | Component / unit | Where | Reuse | Hard-coded inside (to remove) |
|---|---|---|---|---|
| 1 | `GenericModulePage` (list page) | `custom-module/GenericModulePage.jsx:42` | becomes **CaseQueue** page | `canOpen` from role names `:89`; executive-specific empty text `:164-167`; "Sites are created in BD (Pipeline)" `:289`; supervisor_only lede `:104-106` |
| 2 | `CasesTable` + `Cell` | `GenericModulePage.jsx:231`, `:201` | becomes the queue table | fixed column set `COL_WIDTH :197`; no subject/stage-field columns |
| 3 | `OpenCase` (subject picker + gate retry) | `GenericModulePage.jsx:252` | becomes **OpenCaseDialog** | sites only (`listSitesForCases`, `moduleRuntimeApi.js:114`) |
| 4 | `ModuleProblem` | `GenericModulePage.jsx:184` | becomes page-level **ProblemNotice** | 403 copy names roles `:192` |
| 5 | `filterCases` / `VIEWS` fallback tabs | `GenericModulePage.jsx:26-40` | keep only as the no-views fallback | — |
| 6 | `GenericRecordPage` (case detail) | `custom-module/GenericRecordPage.jsx:50` | becomes **RecordDetail** | `canAssign` from roles `:166`; executives only `:165`; `release_mismatch` treated as stale `:30` |
| 7 | `NextStep` | `GenericRecordPage.jsx:359` | split into **StepCard** + **ApprovalPanel** | turn copy branches on role names `:390-414`; "created the site in BD" `:386` |
| 8 | `StageRow` | `GenericRecordPage.jsx:422` | becomes **StageTimeline** item | value formatting inline `:432` (needs FieldValue registry) |
| 9 | `ReasonForm` (send back / reject) | `GenericRecordPage.jsx:496` | becomes **ReasonDialog** | send-back targets = any earlier stage `:499`, not `send_back_to` |
| 10 | `AssignForm` | `GenericRecordPage.jsx:478` | becomes **AssignmentPanel** | executives only; no unassign |
| 11 | Approvals card + audit card, `humanAction` | `GenericRecordPage.jsx:271-325`, `:348` | become **ApprovalsList** + **AuditTimeline** | provenance renderers inline (`files`, `release_migration`) `:304-316` |
| 12 | `problemTitle`, `transformErrors` | `GenericRecordPage.jsx:334`, `:34` | become **DenialCopy** table + form error mapping | codes are pre-RBAC (`wrong_tier`, `not_site_creator`) |
| 13 | `GateLocked` | `custom-module/GateLocked.jsx:8` | becomes **GateConditions** | entry gate only; condition = `reached` only |
| 14 | `ManageViewsPage` + `ViewEditor` | `custom-module/ManageViewsPage.jsx:22`, `:142` | becomes **ViewsManager** | filter vocabulary is G3's, not the manifest's (below) |
| 15 | `viewsKit` (`describeFilter`, `filterFromForm`, `formFromFilter`, `COLUMNS`) | `custom-module/viewsKit.js:12-83` | keep, regenerate from definition | `AUDIENCE :5`, `TIERS :26` are fixed role lists; stages by order, not key (manifest M6) |
| 16 | `kit.jsx` (`Card`, `SectionTitle`, `Tone`, `Button`, `Notice`, `Empty`, `when`) | `custom-module/kit.jsx:8-104` | reuse as is | — |
| 17 | `CaseStatus`, `StageState` | `kit.jsx:44`, `:52` | reuse; tone from outcome `kind` | — |
| 18 | `tierLabel` / `TIER_LABEL` | `kit.jsx:107` | replace with `roleLabel(def, key)` | four fixed role names |
| 19 | `MatrixPersonWidget`, `MatrixFileWidget`, `checkFile`, `formatBytes`, `MembersContext`, `RecordContext` | `custom-module/widgets.jsx:10-123` | reuse in the field widget registry | `tierFilter` knows executive/supervisor `:49` |
| 20 | `moduleRuntimeApi` (`problemOf`, `toExtraErrors`, `resolveView`, all calls) | `services/api/moduleRuntimeApi.js` | the only API client the runtime uses | `assignRecord` sends `executive_id` `:93` |
| 21 | `useWorkspaceModules`, `isModuleEnabled`, `whenModuleEnabled` | `state/useWorkspaceModules.js:67-106` | reuse for nav + module enabled state | — |
| 22 | `customNavItems`, `switcherModules` | `shared/chrome/Sidebar.jsx:19`, `shared/workspaceModules.js:75` | reuse for every module | built-ins keep bespoke routes `workspaceModules.js:87` |
| 23 | `PageHeader`/`HeaderTag`, `MetricCard`, `SearchBox`, `SubFilterPill`, `ViewMoreButton`, `ImageLightbox` | `shared/page-header`, `shared/primitives`, `shared/media` | reuse as presentational primitives | — |
| 24 | `usePagedList`, `useSiteDataRefresh` | `hooks/usePagedList.js`, `hooks/useSiteDataRefresh.js` | reuse for paging + refresh-on-focus | refresh sources are module names |

## 2. Missing reusable components

**27** proposed. All live under `app/frontend/src/modules/runtime/` (the renamed `custom-module/`). None may import from
`modules/{legal,design,project,nso,…}` or compare against a module key or role name (enforced by test T21).

| # | Component | Purpose | Data | Replaces |
|---|---|---|---|---|
| 1 | `useModuleDefinition(key, release?)` | Load + cache the module slice of a release (immutable per version) | `GET /m/{key}/definition?release=v` (new) | per-module label/status constants |
| 2 | `useModuleAccess(key)` | Module-level decisions: open, manage views, view audit, assign, migrate, `view_as` | `GET /m/{key}` (new) `can.*` | `canOpen` / `canManage` / role checks |
| 3 | `useCase(key, id)` | Load, act (`expected_seq` + `expected_release_version`), refetch on focus, stale detection | records detail | state soup in `GenericRecordPage :55-64` |
| 4 | `ModuleDashboard` | KPI tiles + stage funnel + "my turn" | `GET /m/{key}/summary` (new) | 6 `*OverviewPage.jsx` |
| 5 | `KpiTile` | One count, click opens the matching view | summary `views[]` | `MetricCard` KPI blocks, `KpiTile` in NsoHandover/PEx QA |
| 6 | `StageFunnel` | Cases per stage × waiting on submit/approval | summary `by_stage` | stage pills / `stageOf()` helpers |
| 7 | `CaseQueue` | Table + search + sort + paging over a saved view | records list (+ `q`, `cursor`) | 7 `*QueuePage.jsx` |
| 8 | `ViewSwitcher` | Tabs of the role's views with counts | `GET /m/{key}/views` | tabs `GenericModulePage :122` |
| 9 | `ColumnRegistry` | Renderers per column key incl. `subject.<field>` and `<stage>.<field>` | definition fields | `COL_WIDTH`/`Cell` switch |
| 10 | `RecordHeader` | Subject title, case status, `ReleaseBadge`, assignee, refresh | detail | header `GenericRecordPage :176` |
| 11 | `ReleaseBadge` + `MigrationNotice` | Pinned vs live; last migration summary | `release`, `record.migration` (new) | `outdated` tag `:168` |
| 12 | `StageTimeline` | All stages: state, tier chain with **tier labels**, values, stage gate | `stages[]` | `StageRow`, `legalStages()`… `ModuleHistoryPage :189-256` |
| 13 | `FieldValue` registry | Read-only render per field type: text, long_text, number, money (currency), date, choice (option label), multi_choice, yes_no, file, person | definition field `type` | ad-hoc formatters (`formatMoney`, `formatINR`, `pretty`) |
| 14 | `StageForm` | rjsf wrapper: widget registry, server + adapter violations inline, draft save, "keep values on refresh" | `next_step.form`, `draft` (new) | `ModuleChecklistPage`, `ExecutionSection`, NSO `StageCard` forms |
| 15 | Widget registry additions | `MoneyWidget`, `MultiChoiceWidget`, `MultiFileWidget` (`max_files`), `DateWidget` (`min_date/max_date`), `LongTextWidget`; later `TableWidget` | field `validation` | `BoolToggle`, `NumberField`, `ReportSlot`, `DocCard` |
| 16 | `ApprovalPanel` | Current tier: label (`approval.label`), approval-field form, actions from `can.*`, override + SoD notes | `next_step` (approve kind with `form`), `can` | `NextStep` approve branch, `DeliverableCard` review, `ReasonModal`s |
| 17 | `ReasonDialog` | Reason + target (`send_back_to` keys only) | `can.send_back.targets` (new) | `ReasonForm`, `PromptModal`, `ReasonModal` |
| 18 | `DenialMessage` | One copy table keyed by stable denial code | problem+json `code` | `problemTitle`, per-page error strings |
| 19 | `GateConditions` | Entry **and** stage gates: met/unmet, match all/any, refusal message, re-check | `gate`, `stages[].gate` (new) | `GateLocked`, NSO `TriggerRail`/`LockedNotice` |
| 20 | `JourneyStrip` | The subject's modules in gate order with reached outcomes | `GET /subjects/{type}/{id}/cases` (new) | `ModuleProcessFlowPage` `buildStages :128` |
| 21 | `RelatedCasesPanel` | Read-only values/outcomes of other modules' cases of the same subject (visibility-filtered) | same as 20 | NSO `PropertySnapshotPanel :122`, `LegalLicenseSnapshotPanel :188`, Launch `DeptChip`, FC GFC baseline |
| 22 | `SubjectPanel` | The subject's shared fields (declared in `subjects[]`) | subject read (new) | `SiteDrawer` overview tab |
| 23 | `AuditTimeline` + provenance renderer registry | Events with renderers keyed by `provenance.policy` (`files`, `release_migration`, `override`, `delegate`, `adapter`), chain badge | `audit[]`, `audit_chain_valid` | audit card, `getSiteActivity` in `ModuleHistoryPage` |
| 24 | `AssignmentPanel` | Assign / reassign / unassign; candidates from `can_be_assigned` | `GET …/assignees` (new) | `AssignForm`, DDR/Design delegation blocks |
| 25 | `FilesPanel` | Every case file grouped by stage/field, open via signed URL, image preview | `files{}`, `GET /m/{key}/files/{id}` | `ExcellenceDocuments`, `ReportSlot`, `SiteDocsTab` |
| 26 | `ModuleSettingsSummary` | Read-only: stages + tiers diagram, members, gates (in/out), exits, views, visibility, delegation, adapter hooks | definition + `GET /workspaces/{ws}/modules` | `ModuleProcessFlowPage` per-module diagram |
| 27 | State primitives: `PageSkeleton`, `ConflictBanner`, `ViewAsBanner` | Uniform loading / stale / narrowed-view states | — | "Loading…" divs on every page |

## 3. Hardcoded UI patterns to convert

**28** patterns. "Extension point" = what a built-in needs beyond today's generic runtime; it is generic, not a page.

| # | Hard-coded pattern | Where | Becomes | Extension point / note |
|---|---|---|---|---|
| 1 | Overview KPIs over a module queue | `legal/LegalOverviewPage.jsx:274-280`, `design/DesignOverviewPage.jsx:77`, `project/ProjectOverviewPage.jsx:158`, `nso/NsoOverviewPage.jsx:164`, `project_excellence/ProjectExcellenceOverviewPage.jsx:91` | `ModuleDashboard` + `KpiTile` (one per view) | KPIs = saved views in the manifest (`views[]`) |
| 2 | Per-module status label maps | `LegalOverviewPage.jsx:29-31`, `LegalQueuePage.jsx:17`, `DesignOverviewPage.jsx:24`, `DesignQueuePage.jsx:14` | `CaseStatus` + outcome badge from `outcomes[].kind` | — |
| 3 | Per-module stage label maps / `stageOf()` | `LegalQueuePage.jsx:26`, `DesignQueuePage.jsx:46`, `nso/NsoQueuePage.jsx:27`, `nso/NsoOverviewPage.jsx:37` | `StageTimeline` / `stage` column from definition | — |
| 4 | Stage filter chips | `DesignQueuePage.jsx:25` `STAGE_FILTERS`, `:37` | view filter `stage: [keys]` / `reached` | — |
| 5 | Queue pages with `mode` props | `project/ProjectQueuePage.jsx:55`, `ProjectExcellenceQueuePage.jsx:58`, `financial_closure/FinancialClosureQueuePage.jsx:43` | `CaseQueue` + `ViewSwitcher` | — |
| 6 | Queue search + "View more" paging | `usePagedList` in Legal/Design/History pages | `CaseQueue` search + cursor | needs `q`/`cursor` on records list |
| 7 | DDR checklist (yes/no rows + 2 "other" rows) + save draft | `legal/ddr/DdrPage.jsx:22`, `:714`; `shared/checklist/ModuleChecklistPage.jsx:413` | `StageForm` with `yes_no`/`choice` fields, layout from uiSchema | "other" rows → `table` field type; save draft → draft API |
| 8 | DDR verdict override modal | `DdrPage.jsx:68` | approval field `dd_final_verdict` in `ApprovalPanel` | consistency = adapter `validateBusinessRule` violation shown inline |
| 9 | Checklist submit limited to `role === 'supervisor'` | `ModuleChecklistPage.jsx:451` | `can.submit` | — |
| 10 | Agreement state stepper | `legal/agreement/AgreementPage.jsx:16`, `:39` | `StageForm` (`agr_signed`, `agr_registered`, `agr_document`) | — |
| 11 | Legal change-request inbox + approve/reject | `legal/ChangeRequestsPage.jsx:100`, modals `:35`, `:63` | its own manifest module (approval stage) run by the same pages | revival of a rejected DDR = adapter `syncExternalState` + generic `reopen` action (templates doc, Legal) |
| 12 | Design deliverable cards (upload → review → admin) | `design/DesignReviewPage.jsx:74`, role logic `:111-114`, `KIND_LABEL :21` | file field per stage in `StageForm` + 2-tier `ApprovalPanel` | "Awaiting admin" = second tier label |
| 13 | Allocation / delegation blocks | `DesignReviewPage.jsx:363`; `DdrPage.jsx:150-204`; `legalDelegationApi` | `AssignmentPanel` | `module.delegation` + `assign_cases` grant |
| 14 | Project execution section with per-step reject modals | `project/ProjectReviewPage.jsx:651`, `ReasonModal :608`, `StageCard :592` | `StageTimeline` + `StepCard` + `ReasonDialog` | — |
| 15 | Initialization date accepted by executive | `ProjectReviewPage.jsx:724` | approval tier `executive` "Accept date" | prefill from PE = adapter `syncExternalState` (templates doc, Project) |
| 16 | NSO handover KPI + "Push to NSO" | `project/NsoHandoverPage.jsx:46`, `:101-108` | view + `StepCard` submit of field-less stage `push_to_nso` | — |
| 17 | NSO trigger rail / locked stage notice | `nso/NsoReviewPage.jsx:391`, `:370` | `GateConditions` (entry + stage gate) | backend must send stage-gate conditions |
| 18 | NSO snapshot panels (property, Legal licences) | `NsoReviewPage.jsx:122`, `:188` | `SubjectPanel` + `RelatedCasesPanel` | prefilled licences = `field.prefill_from` candidate / adapter |
| 19 | NSO bool toggles / stage cards | `NsoReviewPage.jsx:292`, `:323` | `yes_no` widget, `StageTimeline` | — |
| 20 | PE budget (11 heads) + approval comments + init date | `project_excellence/ProjectExcellenceReviewPage.jsx:36`, `:62` | `money` fields + approval fields (`pex_initialization_date`) | `MoneyWidget`, approval-field forms |
| 21 | PE quality-audit report slots with push | `ProjectExcellenceQualityAuditPage.jsx:79` | file fields + submit | `MultiFileWidget` not needed (one file each) |
| 22 | Financial closure actual vs GFC baseline | `financial_closure/FinancialClosureReviewPage.jsx:47` | `money` fields + `RelatedCasesPanel` column | side-by-side baseline → `field.reference` extension (new manifest key) |
| 23 | Launch review tabs + modal (dept chips, rent terms) | `launch/LaunchPage.jsx:93`, `LaunchReviewModal.jsx:55`, `ClosureDetailsDrawer.jsx:66` | `CaseQueue` views + `RecordDetail` + `RelatedCasesPanel` | rent terms → `table` field + adapter (BD rule) |
| 24 | Rent terms forms / schedule dialog | `shared/rent/RentTermsFormV2.jsx`, `RentScheduleDialog.jsx` | `StageForm` | `table` field type + `required_if`/`visible_if`; until then adapter `beforeSubmit`/`validateBusinessRule` violations |
| 25 | Module history: per-module stage synthesis | `module-history/ModuleHistoryPage.jsx:189-265` (`legalStages`…`stagesFor`) | `CaseQueue` (closed view) + `StageTimeline` + `AuditTimeline` | — |
| 26 | Cross-module process flow | `module-process-flow/ModuleProcessFlowPage.jsx:106-196` | `JourneyStrip` (subject) + `ModuleSettingsSummary` (module) | gate graph from definition |
| 27 | Site drawer tabs (overview/activity/docs) | `shared/site-drawer/SiteDrawer.jsx:209`, `:396`, `:444` | `SubjectPanel`, `AuditTimeline`, `FilesPanel` | — |
| 28 | Module nav + route guards per built-in | `Sidebar.jsx:239-400`, `routes.js:15-57`, `guards.jsx:46-76` (`RequireModule`, `homeForSession`) | `customNavItems` + `/m/:moduleKey/*` + `can.*` | `X-View-As` replaces `X-Override-*` (`axiosClient.js:45-46`) |

**Built-ins on the same contract.** The backend refuses built-ins on `/m/{key}` today (`_custom_module`,
`module_runtime_service.py:140`). Each built-in moves when its template runs on the runtime (rbac §5 P4). Until then its
legacy route stays, and afterwards it redirects to `/m/<key>`. Built-in extras use only these extension points:
**field types** (`table`, `money`, `multi_choice`), **uiSchema layout hints** (checklist rows), **adapter violations** (inline),
**provenance renderers** (adapter events in the timeline), **`RelatedCasesPanel`** (cross-module reads). Nothing gets its own page.

## 4. API data each page needs

`exists` = served today. `new` = proposed. Paths stay `/m/{key}/…` in the client; the backend may move them to
`/modules/{key}/cases/…` (rbac P1) behind `moduleRuntimeApi.js` alone. Errors become problem+json `{status, code, detail, release_version, …extras}`.

| Page | Data | Status | Source / proposal |
|---|---|---|---|
| all | enabled modules, nav sections, my roles, live release | exists | `GET /workspace/modules` (→ store `GET /workspaces/{ws}/modules`) |
| all | module definition: stages (key, name, submit, approvals + labels + fields, gate, send_back_to), fields with typed `validation`, roles/outcomes/subject labels + kinds, views, delegation, visibility, adapter hooks | **new** | `GET /m/{key}/definition?release=<v>`: member-readable, `ETag v<v>`, immutable |
| all | module decisions `can.{open,assign,manage_views,view_audit,migrate}` as `{allowed, code, as_override}` + `view_as` | **new** | `GET /m/{key}` (authorize over the live release) |
| Dashboard | totals by case status, by stage × step kind, by outcome, my turn, overdue (`sla_hours`), per-view totals | **new** | `GET /m/{key}/summary` (one call, replaces N `records?view=` calls in `GenericModulePage :72-75`) |
| Queue | rows: id, subject `{type,id,title,code}`, case_status, current stage **key**, next_step `{stage,kind,role,tier_label}`, assignee, opened_by/at, closed_at, release_version, `can_act` | exists (site-shaped) | `GET /m/{key}/records?view=` (`_list_item`, `module_runtime_service.py:641`) |
| Queue | `q`, `sort`, `limit`, `cursor`, `next_cursor`, `total` | **new** | store pagination convention (`docs/store/API.md` §0) |
| Queue | saved views for my role, default, can_manage | exists | `GET /m/{key}/views` |
| Open case | subjects I may open on + per-subject gate preview, release it runs on | partly | `GET /sites` + `GET /m/{key}/records?site_id=` → `site_gate`; **new** `GET /m/{key}/openable?q=` (subject-agnostic) |
| Record detail | record, release `{version, live_version}`, stages + states + values, next_step + form, approvals, audit, chain validity, files | exists | `GET /m/{key}/records/{id}` (`svc_get_record :689-778`) |
| Record detail | `can.{submit,approve,reject,send_back,assign,upload,reopen}` with `code`, `as_override`, `send_back.targets` | **new** (replaces `allowed_actions` + client role logic) | same response |
| Record detail | `record.migration {from_version,to_version,at,reason,before_stage,after_stage}` | **new** (derivable from audit `release_migration`) | same response |
| Stage form | `next_step.form` for **approval** steps (approval `fields[]`) | **new** (`runtime.py:141` gives forms to submit steps only) | same response |
| Stage form | saved draft values for the current step | **new** | `PUT /m/{key}/records/{id}/draft {values, expected_seq}`; returned as `draft` |
| Stage form | submit / decide | exists | `POST …/actions {action, values, reason, to_stage, expected_seq}` + **new** `expected_release_version` |
| Stage form | adapter violations `[{field, code, message}]` | **new** | 422 `code: business_rule`, `violations[]` (adapters §2) |
| Files | upload, open via signed URL | exists | `POST …/records/{id}/files`, `GET /m/{key}/files/{id}` |
| Files | list across stages incl. approval-field files | exists | `files{}` on detail |
| Assignment | assign | exists | `POST …/assign {executive_id}`; **change** to `{user_id}` |
| Assignment | candidates, unassign | **new** | `GET …/records/{id}/assignees` (`can_be_assigned`), `DELETE …/assign` |
| History (case) | audit + provenance + chain | exists | detail `audit[]` |
| History (module) | module activity feed | **new** | `GET /m/{key}/activity?cursor=` (grant `view_audit`) |
| Journey / related | the subject's cases in every module (status, reached, gate open) + visible values | **new** | `GET /subjects/{type}/{id}/cases` (filtered by `module.visibility`) |
| Views manager | CRUD + reset | exists | `/m/{key}/views[...]`. **Change:** filter vocabulary → manifest `view.filter` (`status`, `stage` keys, `reached`, `mine`, `subject_field`), `sort` |
| Settings summary | definition + release history line (version, published_at, running cases on older releases) | partly | definition (new) + `GET /workspaces/{ws}/releases` (needs `view_audit`) |

## 5. Component tree proposal

```
<ModuleRuntimeRoute moduleKey>                       useModuleAccess + useModuleDefinition(live)
├─ <ModuleShell>                                     PageHeader · ViewAsBanner · ReadOnlyBanner · module tabs from nav
│   ├─ /           <ModuleDashboard>   KpiTile[] (views) · StageFunnel · MyTurnList(CaseQueue compact)
│   ├─ /cases      <CaseQueuePage>     ViewSwitcher · SearchBox · CaseQueue(ColumnRegistry) · ViewMoreButton
│   │                                  └─ <OpenCaseDialog>  subject search · GateConditions (preview) · open
│   ├─ /history    <ModuleHistoryPage> CaseQueue(view=closed) · AuditTimeline(module activity)
│   ├─ /views      <ViewsManager>      ViewList · ViewEditor(filter vocabulary from definition)
│   ├─ /assignments<AssignmentsPage>   CaseQueue(view=unassigned|by assignee) · AssignmentPanel (row action)
│   └─ /settings   <ModuleSettingsSummary> StageDiagram · MembersTable · GateList(in/out) · ViewsTable · AdapterHooks
└─ /cases/:caseId  <RecordDetail>                    useCase + useModuleDefinition(release=pinned)
    ├─ RecordHeader      subject title · CaseStatus · ReleaseBadge · assignee · Refresh
    ├─ MigrationNotice | ConflictBanner | DenialMessage | Result (completed/rejected)
    ├─ JourneyStrip      (subject's modules, gate order)
    ├─ main column
    │   ├─ StepCard      whose turn (tier label) · restriction note · sent-back note · override note (from can.*.as_override)
    │   │   ├─ StageForm       (kind=submit)  rjsf + WidgetRegistry + violations + draft save
    │   │   └─ ApprovalPanel   (kind=approve) approval-field StageForm + actions + ReasonDialog
    │   ├─ GateConditions      (entry gate closed / current stage gate closed)
    │   └─ StageTimeline       StageItem[] → FieldValue registry · per-stage gate state · file links
    └─ side column (tabs on narrow screens)
        ├─ CaseFacts + AssignmentPanel   (shown when can.assign)
        ├─ SubjectPanel + RelatedCasesPanel
        ├─ FilesPanel                   (/cases/:id/files)
        ├─ ApprovalsList
        └─ AuditTimeline + ProvenanceRegistry   (/cases/:id/history)
```

Registries are the only extension surface: `WidgetRegistry` (field `type` → widget), `FieldValueRegistry`, `ColumnRegistry`,
`ProvenanceRegistry` (`provenance.policy` → renderer), `DenialCopy` (`code` → message). A registry is keyed by **contract
vocabulary** (field type, policy, denial code), never by module key.

## 6. Route proposal

Every module, built-in or custom, uses one route family. Guards come from server decisions, not `RequireRole`/`RequireModule`.

| Route | Page | Visible when | Replaces (redirect) |
|---|---|---|---|
| `/m/:moduleKey` | ModuleDashboard | module enabled + `module.view` | `/legal/overview`, `/design/overview`, `/project/overview`, `/nso/overview`, `/project-excellence/overview` |
| `/m/:moduleKey/cases?view=<id\|seed>&q=` | CaseQueuePage | `module.view` | `/legal`, `/design`, `/project`, `/project/sites`, `/nso`, `/project-excellence`, `/project/nso-handover`, `/project/financial-closure`, `/launch`, `/legal/change-requests`; today's `/m/:key?view=` → here |
| `/m/:moduleKey/cases/new?subject=<id>` | OpenCaseDialog (route-addressable) | `can.open` | `OpenCase` card |
| `/m/:moduleKey/cases/:caseId` | RecordDetail | `case.view` (else 404 copy) | `/legal/sites/:siteId/{ddr,agreement,licensing}`, `/design/sites/:siteId`, `/project/:siteId`, `/nso/:siteId`, `/project-excellence/:siteId`, `/project/financial-closure/:siteId`; `/m/:key/records/:id` → here |
| `/m/:moduleKey/cases/:caseId/stages/:stageKey` | RecordDetail scrolled to a stage (read-only unless current) | `case.view` | per-stage legal subpages |
| `/m/:moduleKey/cases/:caseId/files` | RecordDetail › FilesPanel | `case.view` | PEx QA report slots, Site docs tab |
| `/m/:moduleKey/cases/:caseId/history` | RecordDetail › AuditTimeline | `case.view` (+ `audit.view` for full provenance) | `/legal/history/:siteId`, `/design/history/:siteId`, `/project/history/:siteId`, `/nso/history/:siteId` |
| `/m/:moduleKey/history` | ModuleHistoryPage | `module.view` (activity feed needs `audit.view`) | `/legal/history`, `/legal/rejected`, `/design/history`, `/project/history`, `/nso/history`, `/project-excellence/history` |
| `/m/:moduleKey/views` | ViewsManager | `can.manage_views` | exists (G3) |
| `/m/:moduleKey/assignments` | AssignmentsPage | `can.assign` and `delegation: true` | delegation blocks in DDR/Design pages |
| `/m/:moduleKey/settings` | ModuleSettingsSummary | `module.view` | `/{legal,design,project,nso}/process-flow` (module part) |
| `/s/:subjectType/:subjectId` | Subject journey (JourneyStrip + RelatedCasesPanel full page) | any module visible on the subject | `/{legal,design,project,nso}/process-flow/:siteId` |

Sidebar items stay manifest-driven (`customNavItems`): `page` maps to these routes instead of `?view=` (`Sidebar.jsx:11`). The
workspace switcher uses `/m/<key>` for every module (`switcherModules`, `workspaceModules.js:87`).

## 7. UX states required

Precedence on one screen: page load problem > release mismatch > stale > denial/validation > migrated/closed notices.

| State | Where it appears | Trigger (API code / data condition) | What the user sees / can do |
|---|---|---|---|
| **Loading** | every page; `PageSkeleton` in place of table, timeline, step card | first fetch pending (`status: 'loading'`); refetch → `refreshing` (`GenericModulePage :69`) | First load: skeleton rows, not a blank "Loading…". Refetch: content stays, the Refresh button shows busy. Action in flight: only that button is busy and the form is disabled (`disabled={!!busy}`, `GenericRecordPage :216`). |
| **Empty queue** | CaseQueue, Dashboard tiles, MyTurnList | list `200` with `items: []`. Three cases: (a) module has no cases; (b) the view matches none but `summary.total > 0`; (c) `can.open.allowed=false` | (a) "No cases yet" + **Open a case** if `can.open`; (b) "No case matches ‘<view name>’" + link to the default view; (c) "Cases appear when someone opens one for a <subject label>" (subject label from definition). No role names in the copy (`GenericModulePage :164` today). |
| **Gate locked** | OpenCaseDialog, RecordDetail (above timeline), StageTimeline item | open: `409 gate_closed` + `gate` (`module_runtime_service.py:411`); detail: `gate.open=false && next_step=null`; stage: `409 stage_gate_closed` (`runtime.py:217`) or **new** `stages[].gate.open=false` | `GateConditions`: refusal message, "opens when all/any of N", each condition met/unmet with source module label + what it has reached so far. **Check again** re-runs open or refetch. No action buttons on a locked stage. Backend must also attach `gate` to `stage_gate_closed` (today only `gate_closed`, `:491`). |
| **No permission** | page-level: Queue/Detail/Views; action-level: StepCard buttons | `403` problem `code ∈ {not_member, not_visible, module_disabled, read_only, view_as_narrowed}`; `404` for a case outside visibility (`:705`); action-level `can.<a>.allowed=false` with `code ∈ {wrong_step, not_actor, restricted_case_creator, restricted_subject_creator, restricted_assignee, separation_of_duties, action_not_allowed, closed, delegation_off, not_assignable}` | Page: `ProblemNotice` with `DenialMessage(code)` + Retry, no data leaked. Action: the button is hidden when the step isn't theirs, and the step card explains who acts (tier label + restriction). `separation_of_duties`: "You already acted on this stage; someone else takes this step." `view_as_narrowed`: `ViewAsBanner` "Viewing as <role>, switch back to act." `read_only`: the existing ReadOnlyBanner. `as_override=true`: an allowed action carrying the note "recorded as an override". |
| **Stale record** | RecordDetail (`ConflictBanner`), queue row open | `409 stale` (expected_seq ≠ `seq`, `:466-468`); also refetch-on-focus finds a higher `seq` | Banner "This case changed since you opened it" + **Refresh**. Typed values are kept in memory; after refresh they are re-applied if the step key is the same (`stepKey`, `GenericRecordPage :89`), otherwise discarded with a note. Non-blocking variant on focus: "Updated by <actor>, refresh to see it". |
| **Validation error** | StageForm, ApprovalPanel form, ReasonDialog | client: rjsf/ajv (`transformErrors :34`); server: `422 invalid_form` + `errors[]` (`:488-490`); adapter: `422 business_rule` + `violations[{field,code,message}]` (new); `422 reason_required` | Messages under each field (`toExtraErrors`). Root errors go above the submit button. Focus moves to the first invalid field. Values stay. Adapter violations look the same as schema errors (adapters §2), and the code is only in the tooltip. |
| **Upload error** | file widgets in StageForm; FilesPanel open | client `checkFile` (type/size, `widgets.jsx:25`); server `415 file_type`, `413` size cap (`core/uploads.py`), `422 empty_file`, `403 wrong_tier`, `409 wrong_action`, `422 unknown_field`, timeout after `UPLOAD_TIMEOUT_MS` (`moduleRuntimeApi.js:99`); open: `503` storage unreachable (`:931`); submit: `422 invalid_form` "files not uploaded for this case" (`:972`) | Inline alert under the field (`widgets.jsx:91`). The previous file stays attached. **Choose again** retries. Submit is disabled while an upload runs. Open failure closes the pre-opened tab and shows a Notice (`GenericRecordPage :134-136`). |
| **Release mismatch** | RecordHeader badge; StepCard; OpenCaseDialog row | info: `release.version ≠ release.live_version`; blocking: `409 release_mismatch` (`:472`, plus **new** check on `expected_release_version`); open: `409 module_not_in_release` / `module_disabled_in_release` (`:401-405`) | Info: `ReleaseBadge` "Pinned v3 · live v5" with an explanation, no action. Blocking: "This case now follows release vN" + **Reload**. The form re-renders from the new definition and keeps values only for fields with the same key and type. Open: the row says "Not available on the release this <subject> runs on (vN)". Today this is shown as stale (`CONFLICT_CODES :30`). |
| **Migrated record** | RecordHeader `MigrationNotice`; AuditTimeline entry; StageTimeline | `record.migration` (new) / audit `provenance.policy='release_migration'` (`GenericRecordPage :309-316`) | Notice "Moved v3 → v5 on <date>: stage ‘plan’ → ‘plan’, reason …" (dismiss per viewer, remembered in localStorage). Values of fields removed in the new release show as "kept as history (not in v5)". The current step follows the new chain (e.g. the new finance tier). |
| **Completed record** | StepCard → "Result"; queue `closed_at` | `case_status='completed'` (+ `exit_outcome`); any action → `409 closed` | Result card with the exit outcome, coloured by `outcomes[].kind`. It lists the downstream modules this unblocks (gates referencing this module, from the definition) and links to them via JourneyStrip. Forms read-only, no action buttons. Files and history stay available. |
| **Rejected record** | StepCard → "Result"; queue | `case_status='rejected'` (+ `exit.on_reject` outcome) | Result card shows who rejected, at which stage and tier, and the **reason** (latest `approvals[]` verdict `rejected` + comment, not shown today, `GenericRecordPage :372`). **Reopen** appears only if `can.reopen` (future generic action, Legal template). Otherwise the case is read-only. |

## 8. Tests to add

All under `app/frontend/src/modules/runtime/__tests__/` (Vitest + Testing Library, API mocked at `moduleRuntimeApi`), plus one static check.

| # | Test | Asserts |
|---|---|---|
| T1 | `definition.test.js` | `useModuleDefinition` caches per release version. The pinned version is used on RecordDetail and the live one on the queue. |
| T2 | `dashboard.test.jsx` | One KPI per view with server totals; a click opens `/cases?view=<id>`; funnel uses stage names from the definition. |
| T3 | `queue.test.jsx` | Columns come from the view incl. `subject.<field>` and `<stage>.<field>`; search and cursor paging; the three empty-queue variants. |
| T4 | `openCase.test.jsx` | Subject-agnostic picker; `gate_closed` → GateConditions; `record_exists` → navigates; `module_not_in_release` row copy. |
| T5 | `stageForm.test.jsx` | Every manifest field type renders (incl. money currency, multi_choice, date min/max, long_text); `invalid_form` and `business_rule` violations land under fields; draft save round-trip. |
| T6 | `approvalPanel.test.jsx` | Tier label from `approval.label`; approval fields required to approve; send-back targets = `send_back_to` only; `as_override` note; no buttons when `can.*` false. |
| T7 | `denials.test.jsx` | Every rbac denial code maps to copy (table-driven over `docs/rbac/README.md` §3 codes); unknown code → generic. |
| T8 | `gates.test.jsx` | Entry and stage gates, `all`/`any`, met counts, re-check. |
| T9 | `stale.test.jsx` | `409 stale` keeps typed values and re-applies them after refresh on the same step; focus refetch shows the soft banner. |
| T10 | `release.test.jsx` | Badge on pinned ≠ live; `409 release_mismatch` reloads the definition; values kept only for same key+type. |
| T11 | `migrated.test.jsx` | `MigrationNotice` from `record.migration`; dismissal remembered; removed fields shown as history. |
| T12 | `closed.test.jsx` | Completed → outcome + downstream modules; rejected → reason + actor; `reopen` only with `can.reopen`. |
| T13 | `files.test.jsx` | Extends `f5aFiles.test.jsx`: 413/415/422/503 messages, `max_files`, submit blocked during upload, FilesPanel grouping. |
| T14 | `assignment.test.jsx` | Candidates from `/assignees`; assign/unassign; hidden when `delegation:false` or `can.assign=false`. |
| T15 | `audit.test.jsx` | Provenance registry renders files, migration, override, delegate, adapter events; chain badge. |
| T16 | `viewsManager.test.jsx` | Editor offers only manifest filter keys; stages by key; audience = roles from the definition. |
| T17 | `settingsSummary.test.jsx` | Stages, tiers, gates in/out, views, visibility, adapter hooks rendered from a template definition. |
| T18 | `routes.test.jsx` | Each legacy route in §6 redirects; `/m/:key/records/:id` → `/m/:key/cases/:id`; sidebar `page` → route. |
| T19 | `viewAs.test.jsx` | `X-View-As` sent instead of `X-Override-*`; `view_as_narrowed` banner. |
| T20 | `templates.contract.test.jsx` | Render Dashboard, Queue and RecordDetail for **each** `templates/matrix-bd/*.template.json` (Legal, Design, Project, NSO, PE, Launch, FC) from fixtures. No crash, every field type has a widget, every approval tier has a label. |
| T21 | `independence.test.js` (static) | No file in `modules/runtime/**` imports `modules/{legal,design,project,nso,project_excellence,launch,financial_closure}`. No string literal equals a built-in module key (`BUILTIN_MODULE_KEYS`) or a default role key (`supervisor`, `executive`, `business_admin`, `observer`). Hooked into `docs/independence/check-independence.mjs`. |
| T22 | `a11y.test.jsx` | Tab order through StepCard actions; `role="alert"` on denials and errors; queue rows keyboard-openable (`GenericModulePage :241-242` behaviour kept). |

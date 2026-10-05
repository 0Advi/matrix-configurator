# For G3: the creator-scoped rule and role-scoped saved views

Ground truth: Matrix-bd `origin/main` @ `3d4f277beb22c5be02c2abacea61b6afaee7cdeb`, read-only. All paths below are in that repo unless prefixed `ours:`. **[V]** means I read it in the source. **[I]** means I inferred it. The machine-readable copy is `crosscheck.json → creatorRule`, `rolesAndViews`.

---

## 1. The "only for sites they created" rule

### 1.1 Definition (what to implement)

```
owns(site, user)  :=  site.submitted_by = user.id  OR  site.assigned_to = user.id
```

* **Who is scoped.** Any caller whose *effective* role is `executive` [V].
  * `_common.apply_role_scope` reads `user["role"]` (`backend/app/services/_common.py:180-194`).
  * `assert_executive_owns_site` reads `actor["role"]` (`_common.py:131-141`).
  * The effective role is the role *after* the `X-Override-Role` rewrite (`backend/app/core/deps.py:74-113`). A supervisor dropping to executive (`has_executive_access`) is therefore scoped. So is a business admin simulating an executive [V].
* **Who is not scoped.** Supervisors, `business_admin` and `observer` see the whole tenant (`_common.py:189-193`; `rbac/roles.py:36-46`) [V].
* **"Creator" is two people.** The submitter (`submitted_by`, set once at draft creation, `bd_service.py:194`) and the current assignee (`assigned_to`) [V]. The two are always tested together. No real check uses `submitted_by` alone, with one exception, D32 (below).
* **The one rule that ignores role.** The Launch *creator review* (`launch_service._assert_is_site_creator`, `:607-617`) checks `owns()` for **any** role that reaches the route. That covers executives and supervisors (`routers/launch_approval.py:47-50`), and a business admin through the guard bypass. The business admin gets **no** exemption there [V].

### 1.2 Where the real app enforces it

| Surface | Code | Check | Refusal |
|---|---|---|---|
| Site lists (drafts, shortlist, staging, `/api/sites`, BD status) | `_common.apply_role_scope` `:180-194` ← `query_service.list_sites` `:136-150`, `bd_status_service` `:79-90`, `routers/staging.py:24-54`, `routers/bd.py:90-148` | WHERE `submitted_by = me OR assigned_to = me` | rows filtered |
| Read one site | `query_service._assert_can_read_site` `:173-183` | owns | 403 `Forbidden` |
| Activity, BD legal-status view, tracker, documents | `assert_executive_owns_site` ← `routers/sites.py:110-113`, `routers/bd.py:224-229`, `site_tracker_service.py:60`, `site_documents_service.py:27-34` | owns | 403 `This site is not assigned to you.` |
| Audit trail, stage-status projection | `routers/audit.py:48-53`, `site_stage_status_service.py:338-340` | owns, **only when the caller's module is `bd` or empty** (module members keep access through delegation) | 403 |
| Save / submit details | `bd_service._assert_can_edit_details` `:83-101`; the submit route is **EXECUTIVE-only** (`routers/bd.py:167-175`) | owns **and** `status == shortlisted` | 403 |
| Upload LOI | `loi_service.svc_upload_loi` `:44-59`; route EXECUTIVE-only (`routers/loi.py:34-53`) | owns | 403 |
| View LOI | `routers/loi.py:69-74` | owns | **404** `Site not found` |
| Finance: save draft / request approval | `finance_service.py:124,174` | owns (supervisors pass) | 403 |
| Raise a legal change request | `change_request_service.py:160-164` | owns | 403 |
| List a site's delegations | `routers/delegations.py:70-82` | owns **or** an active delegate | 403 |
| Launch creator review + `rent_start_date` while `under_exec_review` | `launch_service.py:588-641,758-759` | owns, **any role** | 403 `Only the executive who created this site can review it.` |
| Owner notifications | `notification_service.recipients_for_site_owner` `:122-134` | `assigned_to` + `submitted_by` | n/a |

Related segregation rule: `bd_service._assert_not_self_approval` (`:56-80`). A **non-supervisor** may not approve or reject a draft it submitted. Supervisors and business admins **may** approve their own [V].

Frontend mirrors, which G3 should **not** copy (follow the backend):
* `frontend/src/rbac/scope.js:11-39` `filterByScope` also matches on **display name** (`createdBy === user.name`), which is looser than the backend [V].
* `modules/launch/LaunchPage.jsx:163-170` matches the creator by `submitted_by` **only** (D32) [V].

### 1.3 Where it does *not* apply

* **Module executives** in legal, design, project_excellence, project, financial_closure and quality_audit are **delegation-scoped**, not creator-scoped. They act only on sites where an active `site_delegations(module, delegate_user_id, revoked_at IS NULL)` row exists [V]:
  * `delegation_service.svc_is_delegated` `:449-479`
  * `legal_service._require_executive_legal_delegation` `:220-240`
  * design / PE / project / FC allocate functions

  A supervisor can "take" a site by delegating to itself.
* **NSO** is supervisor-only on every route (`routers/nso.py:32-33`) [V].
* **`shortlist_delegations`** rows exist (`delegation_service.py:1-247`), but **no BD guard reads them**. `actor_has_delegation_for_site` has no caller outside its own module. A BD "delegation" therefore does **not** widen an executive's scope. Only `assigned_to` does [V].

### 1.4 How operaton-plat expresses it (and what it misses)

operaton-plat sets `"assignee": "initiator"` on four tasks: `bd_site_details`, `bd_upload_loi`, `fin_ca_entry` and `launch_exec_verdict` (`catalogue.json:62,78,127,233`). The compiler emits `operaton:assignee="${initiator}"` **instead of** `candidateGroups` (`matrix.py:240-242,389-392`), where `initiator` is set by the start event (`matrix.py:411-412`) [V]. What this misses:

* **Immutable.** There is no `assigned_to` hand-off. The real hand-off is `POST /api/bd/shortlist/{id}/reassign`, which is supervisor-only, accepts an executive or the supervisor itself, and never another supervisor (`bd_service.py:741-771`).
* **Task-only.** The rule hides tasks, but not lists or reads. The real rule scopes the whole site surface.
* **Role not enforced** on assignee tasks. The group attribute is dropped.
* **Obsolete rule.** `skip_if initiator ∈ bdSupervisor` encodes the pre-2026-07-14 auto-shortlist. **Do not port it** (D04): every draft enters `draft_submitted` (`bd_service.py:159-167`).

### 1.5 Edge cases G3 must handle

| # | Case | Real behaviour |
|---|---|---|
| E1 | Supervisor creates a site | Enters `draft_submitted` like any draft. The supervisor may shortlist its own draft. **Details submit is EXECUTIVE-only**, so the supervisor must reassign to an executive or role-switch to executive (`has_executive_access`). At Launch the supervisor is the creator and does the creator review [V] |
| E2 | Reassignment | `assigned_to` is overwritten: the previous assignee loses access unless it is also the submitter. The submitter **never** loses access [V] (`bd_service.py:741-771`; predicate in §1.1) |
| E3 | Role-switch / override | Scope follows the **effective** role. `real_role` is used only for business-admin detection (`actor_is_business_admin`, `_common.py:107-118`) and for observer write denial (`deps.py:48-67`) [V] |
| E4 | Business admin and the Launch creator review | No bypass. A business admin who is not the creator gets 403 [V] (`launch_service.py:607-617`) |
| E5 | Assigned executive at Launch | Backend allows it; the frontend Review tab hides it (D32). Implement the backend rule [V] |
| E6 | Status gates are separate from ownership | For example, finance fields are refused while `legal_rejected` (`finance_service.py:35-38`), and details are editable only while `shortlisted`. Keep the two checks separate [V] |
| E7 | Deactivated owner | `users.is_active=false` blocks the user on the next request (`deps.py` re-reads the DB every request). Their sites stay owned by them until a supervisor reassigns [V] (deps) / [I] (operational consequence) |
| E8 | Separation of duties | Production SoD only blocks a **non-supervisor** approving its own submission. A supervisor's self-upload in Design auto-approves (`design_service.py:838-853`). ours: `module_runtime/runtime.py:135-136` refuses *any* actor acting on two tiers of a stage. That is stricter than production; decide deliberately [V] |
| E9 | Status codes | Cross-tenant ids give 404 (`fetch_site_or_404`). Ownership failures give 403, **except** LOI view, which gives 404. Do not leak existence across tenants [V] |
| E10 | Module members reading BD data | Audit and stage-status skip the ownership check when the caller's module is not `bd` [V] |
| E11 | Observer presenting as executive | `apply_role_scope` would then filter to "own", which is nothing. It can never write (`deps.py:48-67`) [V] / [I] (outcome) |
| E12 | A business admin creating a draft through the API | `require_role(EXECUTIVE, SUPERVISOR)` admits a business admin through the bypass, so `submitted_by` would be the admin. That admin is then "creator" for Launch [I] (no UI path) |

### 1.6 Mapping to our runtime (suggestion)

* **Today.** `ours: app/backend/app/services/module_runtime_service.py:494-508` scopes an executive's custom-module records to `opened_by = me OR assigned_to = me OR delegated site`. That is **record-level**. The production rule is **site-level** (`sites.submitted_by/assigned_to`).
* **Suggested per-module manifest switch.** `executive_scope: "creator" | "delegation" | "creator_or_delegation"`.
  * `creator`: the `owns(site)` predicate above, joined on `sites`.
  * `delegation`: today's `site_delegations` behaviour.
* **Built-in defaults that reproduce production.**
  * `bd`, `finance_ca`: `creator`.
  * `legal`, `design`, `pex`, `project`, `financial_closure`: `delegation`.
  * `nso`: no executives.
  * `launch_approval`: creator-review stage = `creator` (any role).
* **Where to enforce.** In the same transaction as the action, in **three** places: lists, reads and actions. A UI filter alone is not enforcement.

The flow model carries the same facts in proposed patch F-09 (`x-matrix.executiveScope`) and F-08 (`creatorRule`).

---

## 2. Role-scoped saved views

### 2.1 What exists

* **Real app.** There are **no saved views** [V]: a grep for saved/filter-view concepts in `frontend/src` and `backend/app` finds nothing. Each role gets fixed pages, and data scope is enforced server-side.
* **operaton-plat.** Three Operaton Tasklist filters (`catalogue.json:50-54`; `matrix.py sync_views` `:628-645`), each made visible with a filter READ grant:
  * *My tasks*: assignee = me, audience `*`.
  * *Team queue (unclaimed)*: candidate groups = my groups, audience `*`.
  * *Admin approvals*: candidateGroups = businessAdmin, including assigned tasks; audience businessAdmin.

### 2.2 Real role pages, which should become the default view set

| Role | Real pages | Scope predicate | Evidence |
|---|---|---|---|
| BD executive | Sites; Pipeline (`draft_submitted`); Shortlisted (`shortlisted`, `details_submitted`); Sites in process (`approved`, `loi_uploaded`, `pushed_to_payments`); DDR negative; Process flow; Payment (finance); Launch → Review (`under_exec_review` ∧ creator) | `owns(site)` | `Sidebar.jsx:147-163`; `routers/bd.py:90-148`; `routers/staging.py:24-45`; `LaunchPage.jsx:163-175` [V] |
| BD supervisor | Same pages tenant-wide, plus Archived/Rejected. Staging shows `loi_uploaded` (send to Legal / send back). Launch Review shows creator items plus `under_supervisor_review`. Also a Financial Closure tab | tenant | `Sidebar.jsx:155-157`; `routers/staging.py:48-54`; `LaunchPage.jsx:171-201` [V] |
| Module supervisor | Overview; Sites/Pipeline (module queue, i.e. the gate is open); extras (Legal: Change requests; PE: Quality Audit; Project: NSO Handover, Financial Closure); Process flow; History | module queue | `Sidebar.jsx:167-200` [V] |
| Module executive | Same pages, only for delegated sites | delegation | `legal_service.py:313,383`; `design_service.py:260` [V] |
| Business admin | Approval Center, with types All / Design (2D+3D admin reviews, GFC pending) / Payment (`finance_status=awaiting_admin`) / Budget (PE `pending_admin`) / Quality (read-only) / Closure (FC pending admin). Also Launch Approvals, Financial Closure, Departments (access approvals), Sites | tenant | `TeamDashboard.jsx:79-83`; `ApprovalCenter.jsx:11-25`; `business_admin_service.py:630-639`; `design_service.py:1063-1077,1583`; `project_excellence_service.py:512-527`; `financial_closure_service.py:607` [V] |
| Observer | Sites, Departments (read-only portal) | tenant, no writes | `ObserverDashboard.jsx:42-43`; `deps.py:48-67` [V] |

Module queue predicates, which a view's base scope should reuse rather than restate:

| Queue | Predicate |
|---|---|
| Legal | `status ∈ {legal_review, legal_rejected}` (`legal_service.py:298-326`) |
| Design | DDR positive ∧ finance approved (`design_service.py:230-244`) |
| PE / Project | `design_status='approved'` (`project_excellence_service.py:252`; `project_service.py:375`) |
| NSO | `finance_status='approved'` ∧ `ca_code` set (`nso_service.py:484-485`) |
| Launch | any `launch_approvals` row |
| Financial Closure | launched ∧ sent |

### 2.3 Semantics to keep (rules for G3)

1. **A view never widens data scope.** Server-side: rows = *role scope* (creator / delegation / module / tenant) **AND** *view filter*. operaton-plat relies on engine task authorizations for this. The real app relies on `apply_role_scope` and delegation checks. Ours must apply the scope in the API, not in the view.
2. **Audience ≠ access.** A view's audience (roles × modules) decides who *sees the view in the menu*. Data access still comes from rule 1. operaton-plat models audience as filter READ grants per group (`matrix.py:640-645`); ours can store `audience: {roles: [...], modules: [...]}` on the view.
3. **Effective role.** Views and scope follow the **effective** role (after override), as production does (§1.5 E3).
4. **Suggested defaults** (operaton-plat → ours):

   | operaton-plat view | Suggested equivalent |
   |---|---|
   | *My tasks* | *My actions*: records whose next step's role is mine, and I own or am delegated the site |
   | *Team queue* | *Module queue*: the module's sites with the gate open and the next step on my tier, not yet delegated |
   | *Admin approvals* | *Approval Center*: every stage whose next tier is `business_admin`, grouped by module, site-centric (one row per site with chips), as the real Approval Center does |

5. **Badges and counts** must come from the same scoped query. The real app computes pre-pagination totals on the scoped statement (`_common.count_rows` `:162-175`; `query_service.py:150-153`) [V].
6. **Observer.** All read-only views; no "act" affordances. Writes are refused server-side by `real_role` regardless of view [V].

### 2.4 Pitfalls seen in the models

* Do not give NSO an executive view; NSO executives do not exist (D13).
* Do not put the quality-audit sign-off in the business-admin queue. It moved to the PE supervisor and the admin card is read-only (D11).
* The Finance supervisor tier and the Launch supervisor tier are un-moduled in production: *any* supervisor passes the route guard (D22). Decide whether our views and scope restrict them to the BD module. Recommendation: restrict them, and record this as a deliberate deviation.

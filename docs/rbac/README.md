# Modular RBAC and permission model

**Task 6** · 2026-10-06 · code: `packages/access/` · schema: `packages/manifest/workspace_manifest.schema.json` (`roles`,
`permissions`, `module.members`, `module.visibility`) · storage: `packages/access/sql/0003_access.sql`

**Goal:** stop relying on four fixed roles and one `module` claim in the token. Who may do what is **data in the
release manifest**. The platform adds only a **ceiling** (what a workspace may grant at all) and one operator
principal. A single function, `authorize(principal, action, resource, policy)`, makes every decision.

| File | What |
|---|---|
| `workspace_access/model.py` | `Principal`, compiled `Policy` (`compile_policy(manifest, version)`), resources, `Decision` |
| `workspace_access/authorize.py` | `authorize()`, `can_be_assigned()`, `explain()` — the only access decision in the platform |
| `workspace_access/guard.py` | `Guard`: loads the principal per request, picks the right release, caches policies per release id, raises problem+json |
| `workspace_access/ceiling.py` + `platform_ceiling.json` | Publish-time platform ceiling (rule **C1**) |
| `sql/0003_access.sql` | `workspace_role_assignments`, `module_memberships`, `workspace_access_versions`, `access_principal()` |
| `tests/` | 35 tests: every rule below on the Acme example **and** the real Matrix-bd templates, the guard, the SQL on PostgreSQL |

```bash
cd packages/access && python -m pytest -q        # 35 passed (the SQL tests skip without PostgreSQL at STORE_TEST_DSN)
```

## 1. Permission schema

### 1.1 Roles are data

```jsonc
"roles": [
  {"key": "workspace_admin",  "scope": "workspace", "label": "Workspace admin"},
  {"key": "business_admin",   "scope": "workspace", "label": "Business admin"},
  {"key": "supervisor",       "scope": "module",    "label": "Module supervisor"},
  {"key": "executive",        "scope": "module",    "label": "Module executive"},
  {"key": "finance_reviewer", "scope": "module",    "label": "Finance reviewer"},     // a custom role
  {"key": "observer",         "scope": "workspace", "label": "Observer", "read_only": true}
]
```

* `scope: workspace` — held once per workspace (`workspace_role_assignments`).
* `scope: module` — held **per module**, any number of modules and any number of roles per module
  (`module_memberships`). A module lists the roles it accepts in `members`.
* `read_only: true` — the role can never write, whatever it is granted (validator R10 + `authorize()` + ceiling C1).
* `rank` is display-only. **Nothing derives from rank or from a role's name** — the six names above are only the
  defaults the templates ship with; a workspace may rename them or add its own.

### 1.2 Two sources of permission

| Source | Decides | Where |
|---|---|---|
| **The flow** (per stage) | who submits a stage, who decides each approval tier and with which actions, creator/assignee restrictions, separation of duties | `stages[].submit`, `stages[].approvals[]`, `module.separation_of_duties` |
| **Grants** (per workspace) | everything that is not "acting on the current step" | `permissions[]: {action, roles, modules?, can_grant?}` |

| Grant action | Unlocks (`authorize` action) | Platform ceiling (C1) |
|---|---|---|
| `edit_draft` | `draft.edit` | workspace-scope roles only |
| `publish_release` | `release.publish` | workspace-scope roles only |
| `migrate_cases` | `cases.migrate` | workspace-scope roles only |
| `manage_workspace` | `workspace.manage` (settings, subjects, signals) | workspace-scope roles only |
| `override_step` | act on **any** step as an audited override | workspace-scope roles only |
| `manage_members` (+ `can_grant`) | `members.manage` | any scope; module-scope holders **must** list `modules` |
| `manage_views` | `views.manage` | any scope |
| `assign_cases` | `case.assign` (only where `module.delegation` is on) | any scope |
| `view_all_cases` | `case.view` for every case in the granted modules | any scope, read-only roles allowed |
| `view_audit` | `audit.view` | any scope, read-only roles allowed |

`modules` narrows a grant to named modules (omitted = every module). `can_grant` (only on `manage_members`) lists
the roles a holder may hand out; without it, any member role of that module. The validator refuses a module-scope
holder handing out a workspace role (`privilege_escalation`) and warns on self-granting (`self_granting`).

### 1.3 Who can see which cases — `module.visibility`

`visibility: {role: all | own | actionable}` per module. Defaults when it is omitted: a role that decides an
approval tier in the module → `all`; every other member role → `own` (created, assigned, subject-created or acted
on). Under any level a person **always** sees a case they can act on now.

### 1.4 The principal

```python
Principal(user_id, workspace_roles={...}, memberships={(module, role), ...}, platform_operator=False, view_as=None, active=True)
```

Loaded from the database on **every request** (`access_principal(workspace, user)`: one read, roles + memberships +
`access_version`). The token carries **identity only** — no role, no module.

## 2. Default roles (what the templates grant)

| Role | Scope | Flow (Matrix-bd templates) | Grants | Can never |
|---|---|---|---|---|
| **Workspace admin** | workspace | none | `edit_draft`, `publish_release`, `migrate_cases` (+ `view_audit` in Acme) | work cases unless also granted a role in the flow |
| **Business admin** | workspace | final tiers of some stages (e.g. Acme feasibility, sign-off) | `manage_members`, `manage_views`, `assign_cases`, `view_all_cases`, `override_step`, `view_audit` | publish/migrate unless granted; override changes the step or action |
| **Module supervisor** | module | approval tiers; some submits | `assign_cases`; sees `all` cases of its modules by default (tier role) | act in modules where it holds no membership |
| **Module executive** | module | submits | none | see others' cases unless it can act on them; approve |
| **Observer** | workspace, `read_only` | none | `view_all_cases`, `view_audit` | any write — refused before anything else is checked |
| **Custom role** (e.g. `finance_reviewer`) | as declared | wherever the flow names it (`fit_out.plan` tier 2: approve / send back) | whatever the manifest grants within the ceiling | exceed the ceiling (C1) |

The **platform operator** is not a workspace role: it may perform the workspace-level actions (support, rescue a
stuck migration) and is refused every case action (`platform_operator`).

## 3. Rules

Each rule is a test in `packages/access/tests/test_authorize.py`. Decisions carry a `code` (below), a `reason`,
`via` (what matched) and the `release_version` of the policy used.

| Action | Allowed when | Denial codes |
|---|---|---|
| **View module records** (`module.view`, `case.view`) | `view_all_cases` grant for the module, **or** a member role whose visibility level covers the case (`all` / `own`), **or** the person can act on the current step (incl. borrowed tiers). `view_as` can only narrow. | `not_member`, `not_visible`, `view_as_narrowed` |
| **Open a case** (`case.open`) | holds a submit role of the first stage (incl. `submit.module` borrowing); `subject_creator` restriction applies; else `override_step` → **override** | `not_actor`, `restricted_subject_creator` |
| **Submit a stage** (`stage.submit`) | case open, current step is the submit step, holds a submit role (from `submit.module` if borrowed), restriction (`case_creator` / `subject_creator` / `assignee`) for roles in `restrict_roles`, separation of duties | `closed`, `wrong_step`, `not_actor`, `restricted_*`, `separation_of_duties` |
| **Approve / reject / send back** | current step is approval tier *k*, the tier allows the action, holds the tier role (from `approval.module` if borrowed), separation of duties | `wrong_step`, `action_not_allowed`, `not_actor`, `separation_of_duties` |
| …override | any `not_actor` / `restricted_*` / `separation_of_duties` failure + `override_step` grant → allowed with `as_override=true`, audited. An override **never** changes the step, the tier's allowed actions or the stage (`wrong_step`, `action_not_allowed`, `bad_*` stay denials). | |
| **Assign users** (`case.assign`) | `module.delegation` on + `assign_cases` grant; the assignee must be able to work the current step (`can_be_assigned`) | `delegation_off`, `not_granted`, `not_assignable` |
| **Manage members** (`members.manage`) | `manage_members` grant covering the module, holder not read-only, target role in `can_grant` (or the module's member roles) | `not_granted` |
| **Publish releases** (`release.publish`) | `publish_release` grant | `not_granted` |
| **Migrate running cases** (`cases.migrate`) | `migrate_cases` grant; per-case target checks are the store's (Task 3) | `not_granted` |
| everything | principal active; module in the release and enabled; read-only roles never write | `inactive`, `unknown_module`, `module_disabled`, `read_only` |

**Which release decides.** Case actions use the case's **pinned** release (a case opened on v7 keeps v7's flow and
actors until migrated). Workspace and module actions use the **live** release. Tested in `test_guard.py`.

**Read-only applies first.** An observer cannot submit even where a draft carelessly names it in a flow (the validator
also refuses that, R3/R10).

## 4. Matrix-bd behaviour reproduced without hard-coding

| Matrix-bd today | In the manifest | Test |
|---|---|---|
| `READ_ALL_ROLES` bypass for business_admin / observer | `view_all_cases` grant; BA writes only via `override_step` (audited) | `test_case_visibility`, `test_approval_tier_and_override` |
| Observer writes refused in `get_current_user` | `observer.read_only` | `test_submit_by_actor_and_denials` |
| Project QA approved by Project Excellence supervisors | `approval.module: project_excellence` | `test_borrowed_tier_project_quality_audit` |
| Financial closure staffed by the project team | `submit.module: project` | `test_closure_staffed_by_project_team` |
| Launch creator review only by the site's creator | `restricted_to: subject_creator` | `test_launch_creator_review_is_bound_to_the_subject_creator` |
| Supervisor with `has_executive_access` dropping to executive | holds both memberships `(m, supervisor)` and `(m, executive)` | covered by the multi-membership principal |
| `tenant_modules.enabled = false` → 403 for everyone | `module.enabled: false` | `test_disabled_module_is_closed_for_everyone` |
| NSO / financial-closure without delegation | `delegation: false` | `test_nso_has_no_delegation` |
| Join codes readable only by real business admins (`require_real_role`) | `manage_members` grant (codes are a member-management credential) — never `view_all_cases` | `test_member_management_and_can_grant` |

## 5. Migration away from the single `module` claim

Today: `users.role` (4-value enum) + `app_metadata.module` / `module_role` in a 24 h token, re-checked per request
for **one** claimed module (`deps.get_current_user`), `X-Override-Role` / `X-Override-Module` headers, 131 route
guards (`require_role`, `require_module`, `require_real_role`, `require_module_enabled`) and 8 direct reads of the
`module` claim in services. `user_module_memberships` has CHECKs on three module keys and two role names.

| Phase | Change | Safe because |
|---|---|---|
| **P0 Tables + backfill (shadow)** | Apply `0003_access.sql`. Backfill: `users.role ∈ {business_admin, observer}` → `workspace_role_assignments`; every `user_module_memberships` row → `module_memberships(module, role_in_module)` (`supervisor_id` → `reports_to`; one row per supervisor collapses to one membership); `has_executive_access` → extra `(module, executive)` membership; workspace admins from the tenant owner list. Every guarded request also runs `Guard.check()` in **shadow mode** and logs disagreements with the old guard. | Old guards still decide; disagreements are measured on real traffic before anything switches. |
| **P1 New routes on the guard** | Runtime routes for manifest modules (`/modules/{key}/cases/...`) use only `Guard.check()`. Built-in routes keep the old guards. | No old route changes behaviour. |
| **P2 Frontend on memberships** | `/auth/whoami` returns `workspace_roles` + `memberships` + `access_version`; the module switcher lists memberships instead of the one claim. `X-View-As: <role>` replaces `X-Override-Role` / `X-Override-Module` and **only narrows reads** (writes ignore it). | Old headers keep working until P4; new header cannot escalate. |
| **P3 Tokens without module** | Login stops writing `module` / `module_role` into `app_metadata`. `require_module(m)` becomes a shim: allowed if the principal has **any** membership in `m` (or `view_all_cases`). `require_role` shim: maps the 4 roles to workspace roles / "any membership with that role". Shadow disagreements must be zero for 2 weeks first. | Shims are strictly membership-based; the claim is no longer trusted. |
| **P4 Remove** | Delete `role`/`module` claims, `X-Override-*`, `READ_ALL_ROLES`, `_apply_workspace_override`, `users.role`, `user_module_memberships`. Built-in routes are replaced by the template modules (Task 4) on the runtime. | Independence check (`docs/independence/check-independence.mjs`) gates the removal. |

`workspace_access_versions.version` is bumped by trigger on every grant/revoke: sessions and caches compare it, so a
revocation takes effect on the next request (Matrix-bd's #103 kill switch, now for every grant, not only `is_active`).

## 6. Backend guard design

```python
guard = Guard(load_principal=db.access_principal,            # one read per request, never from the token
              load_live_release=store.live_release,          # (id, version, manifest)
              load_case=runtime.case_with_pinned_release,    # (CaseResource, pinned release)
              audit=activity.append)

def allow(action: str):                                       # FastAPI dependency
    async def dep(request: Request, user=Depends(identity)):  # identity = verified token subject + workspace
        try:
            return guard.check(user.id, user.workspace_id, action, case_id=request.path_params.get("case_id"),
                               module=request.path_params.get("module"), view_as=request.headers.get("X-View-As"))
        except AccessDenied as e:
            raise HTTPException(403, e.problem(), headers={"Content-Type": "application/problem+json"})
    return dep

@router.post("/modules/{module}/cases/{case_id}/approve", dependencies=[Depends(allow("stage.approve"))])
```

* **One decision function.** No route, service or adapter checks a role (adapters cannot even see roles — Task 5,
  lint AD002). Services receive the `Decision` (`as_override`, `via`) and record it with the action.
* **Policy from the release.** `compile_policy` runs once per **immutable** release id (`PolicyCache`); publishing a
  release creates a new id, so there is nothing to invalidate.
* **Principal from the database.** `access_principal()` per request; nothing about permissions is read from the token.
* **Denials** are RFC 9457 problem+json with a stable `code` the UI maps to a message, plus the release version.
* **Audit.** Every denial and every override is recorded with `explain(decision)`; membership changes are written to the
  hash-chained `workspace_activity` by trigger (`access_granted` / `access_revoked` / `access_changed`).
* **Database checks too.** Role keys are validated against the **live** release at insert (`unknown_role`,
  `role_scope`, `not_a_member_role`); RLS isolates workspaces like the store.
* **Publish checks.** The manifest validator (R3, R10 incl. `can_grant`, `visibility_not_member`) and the ceiling (C1)
  both run before `store_publish`; a release that grants beyond the ceiling cannot go live.

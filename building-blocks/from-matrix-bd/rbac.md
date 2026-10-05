# Matrix-bd roles and RBAC

Source: Matrix-bd `origin/main` @ `3d4f277beb22`. Data: `rbac.json`; every route's guard: `route-guards.json`
(218 routes, extracted with Python AST by `scripts/route_guards.py`).

## The model in one table

| Role | Scope | Writes? | Module membership | Route guards | Approval tier |
|---|---|---|---|---|---|
| `business_admin` | whole workspace | yes | none | **bypasses** `require_role` / `require_module` (`READ_ALL_ROLES`) | second level (confirm / GFC / final) |
| `observer` | whole workspace | **no**: every non-GET is refused in `get_current_user` (keyed on `real_role`) | none | bypasses, like business_admin | none; never an actor |
| `supervisor` | one module (`user_module_memberships`) | yes | `supervisor` | `require_role(SUPERVISOR)` + `require_module(m)` | first-level review; the **only** tier in NSO |
| `executive` | own sites (submitted / assigned / delegated) | yes | `executive`, under one or more supervisors | `require_role(EXECUTIVE)` | capture / upload / submit |

## How a request gets its identity (`backend/app/core/deps.py`)

1. HS256 JWT. `aud=authenticated`, `exp` and `sub` are required. `app_metadata.role` and `app_metadata.tenant_id`
   are mandatory; without them the request gets a 403.
2. The **DB is re-read on every request**. `users.role` replaces the token's role, and `users.is_active=false`
   is an immediate kill switch (fix #103).
3. `real_role = role = DB role`. Then `_apply_workspace_override` may rewrite **only** `role` / `module`:
   * business_admin may set any role or module through `X-Override-Role` / `X-Override-Module`. This is
     "workspace access".
   * An observer may present as supervisor or executive and pick a module. It can **never** present as
     business_admin.
   * A supervisor with `has_executive_access` may drop to executive inside its own module.
4. `_assert_may_write` refuses observer writes. It runs after `db.rollback()`; the #103 regression is the reason
   for that ordering.

## Guard primitives (`backend/app/rbac/guards.py`)

* `require_role(*roles)`: role ∈ roles, or role ∈ {business_admin, observer}.
* `require_module(name)`: the module claim (or override) must equal `name`, or role ∈ {business_admin, observer}.
* `require_real_role(*roles)`: keys on `real_role`, with no bypass and no override. It is used only for
  **credentials** (`GET /api/business-admin/dept-codes`, `/observer-code`), because a join code would let an
  observer cause writes by proxy.
* Service-level checks (`backend/app/services/_common.py`):
  * `actor_can_supervise`: a supervisor, or the real business admin.
  * `actor_is_business_admin`.
  * `assert_executive_owns_site`.
  * `apply_role_scope`: executives see only `submitted_by` or `assigned_to` sites.
  * Per-site delegation checks: `shortlist_delegations`, and `site_delegations.module` ∈ bd, legal, design, project,
    nso, project_excellence, financial_closure, quality_audit.

## Route-guard census (from `route-guards.json`)

There are 218 routes; 129 of them mutate. The largest write groups:
* business_admin only: 23
* supervisor only: 22
* supervisor in `project`: 11
* executive+supervisor: 11
* supervisor in `nso`: 7

Every NSO route is `require_role(SUPERVISOR) + require_module('nso')`; the tests assert this. A "(none)" guard means
one of: pre-session auth, platform-admin tenancy, or any authenticated user via `CurrentUser` / `TenantId`.

## Onboarding = approvals too

| Who joins | Code | Approver |
|---|---|---|
| supervisor | department join code (`module_codes`, rotated by business admin) | business admin |
| executive | supervisor's own code (`supervisor_invite_codes`) | that supervisor |
| observer | workspace observer code (`observer_codes`, one live per tenant) | business admin |
| supervisor → also executive | `supervisor_executive_requests` | business admin |

## Things to carry into the configurator

* **Separate "who you are" from "who you act as".** `real_role` vs `role` is the mechanism that makes simulation
  safe. The configurator's preview-as-role feature maps directly onto it.
* **The backend `PERMISSIONS` map is dead documentation.** Nothing outside `permissions.py` imports it, and the
  frontend copy diverges. Enforcement lives in route guards and service checks. A configurator permission
  matrix needs ONE enforced source.
* **Supervisor-only is a module property**, enforced on every route. v5's `supervisorOnly` switch is the right
  abstraction.
* Unmerged on `feat/supervisor-module-access` (`3392f62`, not in `origin/main`): supervisors can **borrow**
  another module with admin approval (`supervisor_module_access_grants`). It is a per-request-checked
  simulation, not a membership.

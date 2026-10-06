# G3 API — migrate running cases, creator-scoped stages, role-scoped saved views

Backend `http://localhost:8000/api` (sandbox). Conventions as in `docs/F4-API.md` §0: platform-admin calls carry
`X-Platform-Admin-Key: <admin JWT>`; workspace users carry `Authorization: Bearer <JWT>` and the tenant always
comes from the token; every 4xx has a string `detail`, machine-readable extras (`code`, …) ride next to it.
Written by G3, 2026-10-05/06. Working client of every endpoint: `app-stack/smoke-g3.mjs` (59/59).

DB: migrations `20261005_1_release_migrations.sql`, `20261005_2_creator_scoped_stages.sql`,
`20261005_3_module_views.sql` (ledger 70 → 73).

---

## 1. Migrate running cases (platform admin)

Cases normally finish on the release they started on (pinning). This is the explicit, audited way to move
**in-flight custom-module cases** from release vN (or every older release) onto release vM — the hot-fix path.
Idea: the user's operaton-plat `op_migrate_running`.

### What moves, and why both pins
The runtime reads a case's rules from `module_records.release_id`; a new case on a site starts from
`sites.config_release_id`; F2's guards require *record release = site pin* on every write. So a migration moves
the **site pin and every in-flight custom-module case on that site together**. The unit is the **site**: one
transaction per site, the site row then its records locked `FOR UPDATE`, every running case re-planned under the
lock; if any running case on the site is incompatible, the **whole site is skipped** (never half-migrated).
Finished cases (completed / rejected / parked) keep the release they finished on. A running case of another
module that shares a moving site is moved too and reported as `co_migrated: true` (it must be compatible too).

### 1.1 `POST /platform/workspaces/{ref}/migrations`

```json
{
  "from_release_version": 1,            // or "all_older" (default) = every release older than the target
  "to_release_version": 2,              // optional; default = the live release
  "scope": { "module_keys": ["g3_vendor"], "site_ids": ["<uuid>"], "record_ids": ["<uuid>"] },   // all optional, AND
  "reason": "Hot-fix: sign-off stage removed",   // REQUIRED (≥3 chars) when dry_run=false; recorded on every moved case
  "dry_run": true,                      // default true — a dry run writes nothing
  "stage_map": { "g3_vendor": { "3": 2 } },      // optional explicit stage mapping {from order: to order | null}
  "restart_stage_on_chain_change": false          // optional, see "compatibility"
}
```
Unknown keys anywhere → 422 (`extra="forbid"`).

`200` (dry run and execute have the same shape):
```json
{
  "configurator_ref": "ws_g3_…", "tenant_id": "…", "dry_run": false, "migration_id": "…" | null,
  "from": { "spec": "v1" | "all_older", "versions": [1] }, "to": { "id": "…", "version": 2 },
  "scope": {…}, "options": {…}, "reason": "…", "actor": "platform-admin@example.com",
  "summary": { "records": 2, "sites": 2, "compatible": 1, "blocked": 1,
               "by_outcome": { "migrated": 1, "skipped": 1 } },
  "items": [ {
    "record_id": "…", "module_key": "g3_vendor", "site": { "id": "…", "name": "…", "code": "…" },
    "from_version": 1, "to_version": 2, "case_status": "in_progress", "in_flight": true,
    "compatible": true, "co_migrated": false,
    "outcome": "would_migrate | blocked | migrated | skipped | failed | not_in_flight",
    "blocking": [ { "code": "stage_missing", "message": "Current stage 3 “Sign-off” has no counterpart in v2.", "stage": 3 } ],
    "warnings": [ { "code": "fields_dropped", "message": "…" } ],
    "stage": { "before": { "order": 2, "name": "Compliance check", "step": 0, "role": "supervisor", "chain": ["supervisor"], "restricted_to": null },
               "after":  { "order": 2, "name": "Compliance check", "step": 0, "role": "supervisor", "chain": ["supervisor"], "restricted_to": null } },
    "stage_mapping": [ { "from": { "order": 1, "name": "Vendor capture" }, "to": { "order": 1, "name": "Vendor capture" }, "how": "same" },
                       { "from": { "order": 3, "name": "Sign-off" }, "to": null, "how": "unmapped" } ],
    "fields": { "kept": [ { "stage": 1, "field": "vendor_name" } ], "dropped": [], "kind_changed": [], "new_required": [] },
    "approvals_carried": 2, "message": null } ]
}
```

**Stage mapping** (first rule that applies): `explicit` (`stage_map`) · `same` (same order and name) · `by_name`
(one target stage with the same name — a stage was inserted/removed before it) · `by_order` (renamed in place) ·
`unmapped`.

**Compatibility** — a running case is **blocked** when: the module is missing / switched off / not custom in the
target (`module_not_in_target`, `module_disabled_in_target`); its current stage has no counterpart
(`stage_missing`); a completed stage maps onto or after the current one, or two stages land on one target
(`mapping_not_monotonic`, `mapping_not_injective`); someone already acted in the current stage and its tier chain
changed (`chain_changed_mid_stage` — unless `restart_stage_on_chain_change`, which restarts that stage at its first
step, values kept, warning `stage_restarted`); the case state doesn't belong to its pinned release
(`state_release_mismatch`); the site shares a running case on another release (`other_release`) or another running
case on the site is blocked (`site_blocked`). **Warnings** (never blocking): `completed_stage_dropped`,
`fields_dropped` (values whose field the target no longer has — removed from the live case, kept in the journal +
audit), `field_kind_changed`, `new_required_field` (on an already-submitted stage; not asked again),
`skips_new_stage` (a new target stage before the current one), `chain_changed` (later step), `creator_rule_changed`,
`delegation_changed`. Finished cases: `not_in_flight`.

**Execute** (`dry_run: false`): header row + per site: re-plan under locks → journal items → site pin → records
(`release_id`, `runtime_state`, status columns) → stage rows re-keyed to target orders (submitted/decided stamps
carried) → audit. Approvals (append-only) stay as history on the old release. Outcomes: `migrated`, `skipped`
(incompatible at execution time, e.g. someone acted after the dry run), `failed` (DB refused; logged).

Errors: `401`; `404` unknown ref / `unknown_release`; `409 workspace_not_active` / `no_release`;
`422 reason_required` / `same_release` / body validation.

### 1.2 `GET /platform/workspaces/{ref}/migrations`
`200 {items:[{id, from, to_version, scope, reason, actor, status: running|done|failed, summary, created_at, finished_at}]}`
(newest first, 100 max; dry runs are never stored).

### 1.3 `GET /platform/workspaces/{ref}/migrations/{id}`
Header + `items:[{site_id, record_id (null = the site-pin item), module_key, from_version, before_stage,
after_stage, before_state (the FULL pre-migration runtime_state), plan, at}]`.

### 1.4 Audit (what the case page shows)
Per moved case one `audit_logs` row `module_release_migrated` (entity = the case, so it is in
`GET /m/{key}/records/{id}` → `audit[]`): `actor_name` = platform-admin email, `config_release_id` = target,
`provenance = {policy: "release_migration", migration_id, from_release:{id,version}, to_release:{id,version},
actor, actor_kind: "platform_admin", reason, before_stage, after_stage, stage_mapping, fields, warnings,
approvals_carried, co_migrated, pre_state, event}` — `event` is a hash-chained `release_migrated` runtime event, so
`audit_chain_valid` stays true across releases. Also `site_release_migrated` (entity = site) and
`release_migration_executed` (entity = the migration).

### 1.5 The controlled re-pin path (DB)
`sites.config_release_id` and `module_records.release_id` may change only when
`cfg_release_migration_authorizes(tenant, site, record, from, to)` is true: the transaction-local setting
`matrix.release_migration` names a **running** `module_release_migrations` row of the tenant **and** an
append-only `module_release_migration_items` row authorises exactly that site/record from→to. A plain UPDATE, the
old `matrix.allow_repin = 'on'` switch, or naming a finished migration are refused
(`check_violation … only an audited release migration may move it`). NULL → release (adopting a legacy site) is
unchanged.

**For G1** (`agent-configurator` `migrate_running` stub): call 1.1 with `dry_run: true` first, show `summary` +
blocked items, then repeat with `dry_run: false` and a reason (mirror G1's `confirm: true` convention).

---

## 2. Creator-scoped stages (manifest + runtime)

### 2.1 Manifest
Stage-level, optional, backwards compatible: `"restricted_to": "site_creator"` (the only value; absent = anyone in
the tier). Accepted by the app's manifest schema copy (`module_runtime/manifest.schema.json`; any other value is a
`schema` error). Publish findings (warnings): `creator_rule_first_tier` (the stage's chain does not start with the
executive tier — the rule then binds that first tier), `creator_rule_builtin_ignored` (on a built-in module).

Designer: the in-app configurator copy (`/#/admin` → Workspaces) — wizard step **Stages** and the inspector's
**Stages & fields** card of a custom module: **"Only the site’s creator can do this"** (v5 state
`stage.creatorOnly: true` ⇄ manifest `restricted_to: "site_creator"`; a change shows up in the publish diff as
`creator rule`).

### 2.2 Semantics (real app: `launch_service._assert_is_site_creator`, `_common.assert_executive_owns_site`)
`owns(site, user) := sites.submitted_by = user OR sites.assigned_to = user` (the submitter and the current BD
assignee). The rule binds the stage's **first step** (chain head, normally the executive step):

| Actor on the creator step | Result |
|---|---|
| executive who owns the site | allowed — **no delegation needed** for this step |
| executive who does not own it (even delegated / assigned the case) | `403 not_site_creator` |
| supervisor (in the chain) who owns the site | allowed (real-app E1: supervisors create sites too); their following supervisor step collapses as before |
| supervisor who does not own it | `403 not_site_creator` |
| business admin who owns it | as today (entitled if in the chain, else override) |
| business admin who does not own it | allowed **only as an override**: `is_override = true`, provenance `override: true, creator_override: true`; an override never self-approves, so with SoD another person signs the next tier |
| observer | `403 observer_read_only` |

Later steps of the stage (e.g. the supervisor's approval) are not creator-scoped. The DB approvals guard enforces
the same rule (a non-owner row on the creator step is refused unless it is a flagged business-admin override).

### 2.3 API changes (`/m/{key}/…`, additive)
- `GET /m/{key}/records/{id}`: `next_step.restricted_to`, `stages[].restricted_to`, `me.owns_site`; audit
  provenance of creator-step events: `rule: "site_creator"`, `site_creator: true|false`, `creator_override`.
- `GET /m/{key}/records`: items gain `next_step.restricted_to`, `opened_by`, `owned_by_me`.
- **Visibility:** an executive also sees (list + detail) the cases on sites it owns **when the case's module has a
  creator-scoped stage** in the case's release (so the creator can find the case only they may act on). Module
  executives stay delegation-scoped otherwise (real app).
- `POST …/actions`: new refusal `403 not_site_creator` ("Only the site's creator can do this step.").

---

## 3. Role-scoped saved views (workspace users)

Idea: operaton-plat's Tasklist filters ("My tasks", "Team queue", "Admin approvals" + per-group READ grants).
Table `module_views` (RLS `tenant_isolation`). **Audience ≠ access**: the audience decides who sees a view in the
switcher; the data is always the caller's scope first (tenant; executives: opened / assigned / delegated /
owned-creator-scoped cases), then the view's filter — a view can only narrow.

Caller role for views = the role the runtime acts with: `business_admin` / `observer` workspace-wide (real role),
otherwise the module membership tier (`supervisor` / `executive`).

### 3.1 `GET /m/{key}/views[?manage=true]`
`200 {module:{key,label}, role, can_manage, default_view_id, items:[view]}` — views of this module plus all-module
views whose audience has my role, by `position`. `manage=true`: every view (business admin only, else 403).
`default_view_id` = the first `is_default` view (by position) whose audience has my role, else the first visible.

View: `{id, module_key, all_modules, name, filter, columns, audience, position, is_default, seed_key, created_by, updated_at}`.

### 3.2 `GET /m/{key}/records?view=<id>`
Applies the view server-side (after the scope). A view outside your audience, of another module, deleted or of
another tenant → `404 View not found.` The response adds `view: {id, name, filter, columns, seed_key}`. Other query
params can't widen anything (only `site_id` narrows).

### 3.3 Business admin — `POST /m/{key}/views` · `PATCH /m/{key}/views/{id}` · `DELETE /m/{key}/views/{id}` · `POST /m/{key}/views/reset`
Body (POST; PATCH = any subset except `all_modules`):
```json
{ "name": "Waiting at sign-off", "filter": { "stage": [3] }, "columns": ["site","next_step","status","release","opened_at"],
  "audience": ["executive","supervisor","business_admin"], "position": 100, "is_default": false, "all_modules": false }
```
`201` view / `200` view / `204` (soft delete — a removed default is not re-seeded by the next publish) /
`200` = the manage list + `reset: {removed, seeded}` (drops this module's views incl. custom ones, re-seeds the
defaults; all-module views stay). Others → `403 Only a business admin can manage views.` Every change writes an
`audit_logs` row (`module_view_created|updated|deleted`, `module_views_reset`, provenance `policy: "views"`).

**Filter keys** (all optional, AND; booleans: `true` = must hold, `false` = must not; unknown keys → 422):

| Key | Meaning |
|---|---|
| `stage: [int]` | current stage order is one of |
| `status: ["open","in_progress","completed","rejected","parked"]` | case status is one of |
| `closed: bool` | completed / rejected / parked |
| `assigned_to_me: bool` | the case (`assigned_to`) or the BD site (`sites.assigned_to`) is assigned to me |
| `created_by_me: bool` | I opened the case or created the site (`sites.submitted_by`) |
| `mine: bool` | assigned to me, created by me, or the site is delegated to me |
| `awaiting: "my_tier"\|"executive"\|"supervisor"\|"business_admin"` | the next step belongs to that tier |
| `actionable: bool` | I can act on the case now (`allowed_actions` non-empty) |
| `assigned: bool` | the case has an assignee |
| `site_ids: [uuid]` | site is one of |
| `kind: "submit"\|"approve"` | next step kind |

**Columns:** `site, stage, next_step, status, assigned_to, opened_by, opened_at, closed_at, release`.
**Audience roles:** `executive, supervisor, business_admin, observer`.

### 3.4 Defaults (seeded by the DB for every enabled custom module — on publish via a `tenant_modules` trigger, backfilled by the migration)

| seed_key | Name | Filter | Audience | Default for |
|---|---|---|---|---|
| `awaiting_me` | Awaiting my approval | `{"awaiting":"my_tier","actionable":true}` | executive, supervisor | executive, supervisor |
| `admin_signoff` | Admin sign-off | `{"awaiting":"business_admin"}` | business_admin | business admin |
| `my_cases` | My cases | `{"mine":true,"closed":false}` | executive, supervisor | — |
| `team_queue` | Team queue | `{"closed":false,"assigned":false}` | supervisor, business_admin | — |
| `all` | All cases | `{}` | everyone | observer |
| `closed` | Closed | `{"closed":true}` | everyone | — |

SPA: `/#/m/<key>` has a view switcher (`?view=` = a view id, a seed key, or the sidebar's page keys
`queue|review|history`, mapped to team_queue/awaiting_me/admin_signoff/closed); business admins get
**Manage views** → `/#/m/<key>/views`.

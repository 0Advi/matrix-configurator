# F4 API — configurator ↔ Matrix app backend contract (for F4b)

Backend: `http://localhost:8000/api` (sandbox). Every path below is relative to that base.
Written by F4a, 2026-10-04. Proven end to end by `app-stack/smoke-configurator.mjs`
(67/67) — read that script for a working client of every endpoint.

## 0. Conventions

**Two authorities.**

| Who | Header | How to get it |
|---|---|---|
| Platform admin (configurator, `/#/admin`) | `X-Platform-Admin-Key: <admin JWT>` | `POST /tenancy/admin/login {email, password}` → `{token, email}`; 30-minute TTL, then 401 → log in again. The existing `AdminPortalPage` already does this. |
| Workspace users (BA, supervisor, executive, observer) | `Authorization: Bearer <JWT>` | `POST /auth/login {workspace_code, email, password}` (unchanged). Tenant always comes from the token. |

**Errors.** Every 4xx body has `detail`. For the new endpoints `detail` is always a human-readable
**string**; machine-readable extras ride next to it:

```json
{ "detail": "Vendor onboarding is locked: waiting for the BD shortlist.", "code": "gate_closed", "gate": { ... } }
```

Exception: request-body validation errors from FastAPI/pydantic keep FastAPI's shape
(`422 {"detail": [{"loc": [...], "msg": "...", "type": "..."}]}`).

**Module keys** match `^[a-z][a-z0-9_]{1,38}$` and are not one of `admin api new site sites user users
module modules settings auth report reports`. Built-in keys: `bd legal finance_ca design
project_excellence project nso launch_approval financial_closure` (the configurator's `pex` is an alias
of `project_excellence`; the app always uses the runtime key).

---

## 1. Platform admin — configurator workspaces (`X-Platform-Admin-Key`)

### 1.1 `POST /platform/workspaces` — provision a tenant (D3)

Runs the app's **own** provisioning path (a `workspace_requests` row is inserted and approved
exactly like the existing "Approve" button), then links it to the configurator id.

Request:
```json
{
  "configurator_ref": "ws_acme_retail",          // the configurator's workspace id; ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$
  "company": "Acme Retail",                       // 1..200
  "admin_email": "owner@acme.example",            // the business admin
  "admin_name": "Asha Rao",                       // optional
  "seat_limit": 25,                               // optional 1..10000 (default: from team_size, else 10)
  "team_size": "11 to 50 users",                  // optional, used only when seat_limit is absent
  "city": "Mumbai"                                // optional metadata
}
```

`201`:
```json
{
  "configurator_ref": "ws_acme_retail",
  "tenant_id": "4e06de1e-…",
  "workspace_code": "ACMERE-C7C3ECCF78AB3D2B",
  "seat_limit": 25,
  "business_admin_id": "95d514f6-…",
  "admin_email": "owner@acme.example",
  "admin_setup_token": "<one-time setup code — shown ONLY in this response>",
  "workspace_request_id": "…",
  "live_release": null,
  "message": "Provisioned Acme Retail. Share the workspace code AND the one-time setup code …"
}
```

Show the workspace code + setup code to the platform admin once (copy buttons); never store the
setup code in the browser. The BA claims the account on the normal login page: **"Request a
reset" → enter the setup code** (`POST /auth/password-reset/complete {email, workspace_code,
new_password, reset_token}`), then signs in.

Errors:
| Status | `code` | When |
|---|---|---|
| 401 | — | missing / invalid / expired admin token |
| 409 | `already_provisioned` | this `configurator_ref` already has a tenant. Body also carries `configurator_ref`, `tenant_id`, `workspace_code` (never the setup token). **Idempotency decision: 409, not 200** — treat it as "already done" and continue with publishing. |
| 409 | `provisioning_in_progress` | another call for the same ref is in flight (a claim older than 10 minutes is considered dead and can be retried) |
| 409 | — | `Concurrent approve detected.` (from the app's approval path; retry) |
| 422 | FastAPI list | body invalid (bad ref, email, seat_limit range) |

### 1.2 `POST /platform/workspaces/{ref}/releases` — publish (D2)

Request:
```json
{
  "manifest": { "workspace": {…}, "pipeline": {…}, "signals": [], "modules": [ … ], "permissions": [ … ] },
  "reason": "stage 2: supervisor-only sign-off",      // optional, ≤500, shown in history
  "source_ref": "nocobase-cfg-release-17"              // optional: the design-time release id
}
```
`manifest` = the configurator v5 `manifest()` output (`building-blocks/from-design/manifest.schema.json`,
additionalProperties false — send it unmodified).

Checks (all before anything is written; any **error** refuses the publish):
1. JSON Schema of the v5 manifest;
2. modules: unique keys; built-ins must be catalog keys/aliases (`pex` ok, `payment` retired → error,
   `quality_audit` is a scope → error); custom keys valid, never a built-in key/alias;
3. every entry gate / stage gate compiles to JsonLogic `matrix-gate/1` and passes lint; every condition
   source must be a module/signal of this manifest (unknown → error; disabled → warning);
4. roll-ups compile + lint (`custom` strategy → warning: the module parks);
5. custom modules: ≥1 stage, unique stage orders, outcomes in the vocabulary, unique field keys, every
   stage form compiles to a valid JSON Schema; free-text validation hints the compiler cannot read →
   warning `unparsed_hint`; outcome-affecting text/number/file fields → warning `rollup_field_ignored`;
6. the runtime can be built for every custom module.

Then, in **one transaction**: version = previous + 1, insert the immutable release
(`published_by` = the platform admin's email from the token), `cfg_activate_release()` projects it
onto the tenant's module registry (enable/disable, label = module `name`, position = manifest order,
`supervisor_only = !tiers.executive`, `delegation_enabled = tiers.delegation`; modules absent from
the manifest are disabled, never deleted), the live pointer moves, and an `audit_logs` row
`config_release_published` with provenance is written.

`201`:
```json
{
  "configurator_ref": "ws_acme_retail",
  "tenant_id": "4e06de1e-…",
  "release": { "id": "b5884929-…", "version": 2, "manifest_sha256": "7028f778…", "published_by": "platform-admin@example.com",
               "reason": "…", "source_ref": null, "created_at": "2026-10-04T06:04:21.170601+00:00" },
  "findings": [ { "severity": "warning", "code": "gate_disabled_source", "message": "entry_gate: condition waits on disabled module 'design'; the gate can never open", "module": "pex" } ],
  "modules": [ { "key": "bd", "label": "BP – Site identification", "kind": "builtin", "position": 10, "enabled": true,
                 "supervisor_only": false, "route": "/" }, … ]
}
```

Errors: `401`; `404` unknown ref ("Provision it first"); `409 workspace_not_active`;
`422 manifest_invalid` with `findings` (same shape as below — show them inline in the configurator).

Finding shape: `{severity: "error"|"warning", code, message, module?, stage?, field?, path?}`.
Error codes: `schema, duplicate_module, unknown_builtin, retired_builtin, not_a_module, invalid_module_key,
custom_key_collides, gate_invalid, gate_lint, gate_unknown_source, gate_self_reference, rollup_invalid,
rollup_lint, no_stages, duplicate_stage_order, stage_outcome, duplicate_field, form_invalid,
runtime_invalid`. Warning codes: `workspace_ref_mismatch, custom_route, gate_disabled_source,
gate_outcome, rollup_custom, terminal_not_last, no_approver, unparsed_hint, rollup_field_ignored`.

### 1.3 `POST /platform/workspaces/{ref}/releases/validate` — dry run

Body `{ "manifest": {…} }` → `200 {ok, errors, warnings, findings, modules:[{key, manifest_key, kind, enabled}]}`.
Writes nothing; works for a ref that is not provisioned yet (use it for the configurator's
"Check" button before the first publish).

### 1.4 `GET /platform/workspaces` — list

`200 {items:[<workspace summary>], total}`; summary:
```json
{ "configurator_ref": "ws_acme_retail", "status": "active", "tenant_id": "…", "company": "Acme Retail",
  "workspace_code": "ACMERE-…", "seat_limit": 25, "used_seats": 3,
  "live_release": { "id": "…", "version": 2, "activated_at": "…", "activated_by": "platform-admin@example.com" },
  "release_count": 2, "provisioned_by": "platform-admin@example.com", "created_at": "…", "provisioned_at": "…",
  "last_error": null }
```
`status`: `provisioning | active | failed` (`failed` → `last_error`; provisioning the same ref again retries).

### 1.5 `GET /platform/workspaces/{ref}` — detail

Summary (above) plus:
- `releases`: `[{id, version, manifest_sha256, schema_version, reason, published_by, source, source_ref, created_at, is_live}]` (newest first);
- `modules`: the tenant's registry incl. disabled: `[{key, label, kind, position, enabled, supervisor_only, delegation_enabled, config_key, route, surface}]`;
- `business_admin`: `{email, name, has_password}` — `has_password=false` means the BA has not claimed the account yet.

`404` when the ref is not linked.

### 1.6 `GET /platform/workspaces/{ref}/releases/{version}` — one release

`200 {id, version, manifest, manifest_sha256, reason, published_by, source_ref, created_at, is_live}` — use it
to diff the configurator draft against what is live.

---

## 2. Workspace users — data-driven modules (`Authorization: Bearer`)

### 2.1 `GET /workspace/modules` (any signed-in user)

The tenant's **enabled** modules in order — drive the sidebar / home routing from this, not from
`WORKSPACE_MODULES`.
```json
{
  "tenant_id": "4e06de1e-…",
  "release": { "id": "…", "version": 2, "activated_at": "…", "workspace_ref": "ws_acme_retail" },   // null = never published (legacy tenant)
  "modules": [
    { "key": "bd", "label": "BP – Site identification", "kind": "builtin", "position": 10,
      "supervisor_only": false, "delegation_enabled": true, "has_membership": true,
      "implementation": "builtin:bd", "route": "/", "my_roles": [],
      "navigation": [ { "section": "Pipeline", "items": [ { "label": "…", "icon": "…", "page": "…", "badge": "queue", "roles": ["supervisor"] } ] } ] },
    { "key": "vendor_onboarding", "label": "Vendor Onboarding", "kind": "custom", "position": 120,
      "supervisor_only": false, "delegation_enabled": true, "has_membership": true,
      "implementation": "generic", "route": "/m/vendor_onboarding", "my_roles": ["supervisor"], "navigation": [] }
  ]
}
```
- `route` is the SPA page that serves the module: built-ins → their existing page (`/`, `/legal`,
  `/design`, `/project-excellence`, `/project`, `/nso`, `/launch`, `/project/financial-closure`;
  `finance_ca` → `null`, it has no page of its own); custom → `/m/<key>` (HashRouter: `/#/m/<key>`).
  The manifest's own built-in `route` (`/pex`, `/finance-ca`, …) is configuration data only.
- `my_roles` = the caller's `role_in_module` values (`supervisor`/`executive`); empty for BA/observer.
- `has_membership=false` modules (finance_ca, launch_approval, financial_closure) have no teams/dept codes.
- Legacy tenants (`release: null`) get the 9 built-ins, all enabled — exactly today's behaviour.

### 2.2 Changed existing endpoints (all additive / same shapes)

| Endpoint | Change |
|---|---|
| `GET /auth/whoami` | adds `disabled_modules: ["design", …]`. `module` (JWT claim) can now be a **custom key** (e.g. `vendor_onboarding`) — `homeForRoleModule` must send such users to `/m/<key>`. The claim never points at a disabled module. |
| `GET /business-admin/org` | `modules[]` = enabled team modules incl. custom ones, ordered by position; each adds `label`, `kind`. Disabled modules disappear. Note: built-in order is now bd, legal, design, project_excellence, project, nso (was … project, nso, project_excellence). |
| `GET /business-admin/dept-codes` | codes of disabled modules are left out. |
| `POST /business-admin/dept-codes/{module}/rotate`, `POST /business-admin/pending-supervisors/{id}/approve {module}`, `GET /business-admin/pending-supervisors?module=` | `module` accepts any registered key (custom too). Disabled → **403** "Module 'x' is disabled in this workspace."; unregistered or team-less → **404** "Module 'x' is not available in this workspace."; malformed → 422. |
| `/supervisor-codes/me/{module}/…` (rotate, pending, team, approve) | same rules; approving an executive into a supervisor-only module → 400 (was NSO-only). |
| `/auth/signup/supervisor`, `/auth/signup/executive` | a code whose module is disabled → 404 "not valid" (same as revoked). |
| Every built-in route guarded by `require_module(x)` | **403** when `x` is disabled for the tenant — for every role incl. business admin and observer. |

---

## 3. Custom modules — generic runtime (`Authorization: Bearer`)

Who may call: the business admin (acts on any step; outside the stage's tier chain the action is an
**override**, recorded as such), members of the module (their `role_in_module` is their tier),
observers (read only). Others → `403 "You are not a member of <label>."`. Module must be a custom
module of the tenant (`404` otherwise) and enabled live (`403` otherwise). Built-in keys → 404 here.

### 3.1 `GET /m/{module_key}/members`
`200 {module:{key,label}, items:[{id, name, email, role_in_module}]}` — the assign picker and the
`MatrixPersonWidget` source.

### 3.2 `GET /m/{module_key}/records[?site_id=<uuid>]`
```json
{
  "module": { "key": "vendor_onboarding", "label": "Vendor Onboarding" },
  "role": "supervisor",
  "items": [ {
    "id": "03d45c8f-…", "site": { "id": "…", "name": "Cfg Site A", "code": "BT-MUM-8A1P", "city": "Mumbai" },
    "status": "approved", "case_status": "completed", "current_stage": null, "exit_outcome": "approved",
    "release_version": 1, "next_step": null, "allowed_actions": [], "assigned_to": "…",
    "opened_at": "…", "closed_at": "…" } ],
  "total": 1,
  "site_gate": {                       // only with ?site_id=
    "can_open": false, "reason": "gate_closed", "release_version": 1, "pinned": true,
    "gate": { "open": false, "refusal": "Vendor onboarding is locked: waiting for the BD shortlist.", "match": "all",
              "conditions": [ { "source": "bd", "outcome": "in progress", "met": false, "reached": ["submitted"] } ] } }
}
```
Executives only see cases they opened, are assigned to, or whose site is delegated to them in this
module. `reason`: `gate_closed | record_exists | module_not_in_release | no_release | null`.
Sites to open a case on: supervisors/BA can list them with the existing `GET /sites`.

### 3.3 `POST /m/{module_key}/records` — open the case for a site
Body `{ "site_id": "<uuid>" }` → `201` = the record detail (3.4). The case runs on the **release the
site is pinned to** (sites are pinned to the live release when created; a site created before the
tenant's first publish is adopted into the live release by its first case — audit
`site_adopted_into_release`) and stays on it.

| Status | `code` | Meaning |
|---|---|---|
| 409 | `gate_closed` | entry gate closed; `gate` explains each condition (`met`, `reached`) — render the "locked" screen from it |
| 409 | `record_exists` | already open; `record_id` |
| 409 | `module_not_in_release` / `module_disabled_in_release` | the site's pinned release (`release_version`) does not run this module |
| 409 | `no_release` | the tenant never published |
| 403 | — | observer / non-member |
| 404 | — | site not in this tenant |

### 3.4 `GET /m/{module_key}/records/{id}` — case detail
```json
{
  "record": { "id": "…", "module_key": "vendor_onboarding", "status": "in progress", "case_status": "in_progress",
              "verdict": null, "current_stage": 2, "exit_outcome": null, "reached": ["submitted"], "seq": 5,
              "site": { "id": "…", "name": "…", "code": "…", "city": "Pune" },
              "opened_by": "…", "assigned_to": null, "supervisor_id": null, "opened_at": "…", "closed_at": null },
  "release": { "id": "…", "version": 2, "pinned": true, "site_pinned_release_id": "…", "live_version": 2 },
  "module": { "key": "vendor_onboarding", "label": "Vendor Onboarding", "name": "Vendor Onboarding",
              "tiers": { "supervisor": true, "executive": true, "business_admin_signoff": true, "delegation": true },
              "exit_signal": "approved" },
  "stages": [ { "order": 1, "name": "Vendor capture", "outcome": "submitted", "terminal": false,
                "chain": ["executive", "supervisor"], "state": "submitted",
                "field_values": { "vendor_name": "Beta Traders", "gst_number": "29ABCDE1234F1Z5" },
                "submitted_by": "…", "submitted_at": "…", "decided_at": "…", "fields": [ <manifest field defs> ] }, … ],
  "next_step": { "stage": 2, "name": "Compliance check", "role": "supervisor", "kind": "submit",
                 "form": { "schema": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "title": "Compliance check",
                                       "properties": { "credit_days": { "title": "Credit days", "type": "number", "minimum": 0, "maximum": 120 },
                                                       "payment_terms": { "title": "Payment terms", "type": "string", "enum": ["advance", "net 30", "net 60"] } },
                                       "additionalProperties": false, "required": ["credit_days", "payment_terms"] },
                           "uiSchema": { "ui:order": ["credit_days", "payment_terms"], "payment_terms": { "ui:widget": "radio" } },
                           "unparsed": [] } },
  "me": { "id": "…", "role": "supervisor" },
  "allowed_actions": ["submit", "send_back"],
  "gate": { "open": true, "refusal": null, "match": "all", "conditions": [ { "source": "bd", "outcome": "in progress", "met": true, "reached": ["in progress", "submitted"] } ] },
  "approvals": [ { "stage_order": 1, "tier": "executive", "actor_id": "…", "actor_name": "Cfg BA", "actor_role": "business_admin",
                   "acting_as_delegate": false, "is_override": true, "verdict": "submitted", "comment": null, "decided_at": "…", "release_id": "…" }, … ],
  "audit": [ { "action": "module_case_created", "actor_id": "…", "actor_name": "Cfg BA", "detail": "vendor_onboarding v2 seq 1",
               "config_release_id": "…", "module_key": "vendor_onboarding",
               "provenance": { "policy": "runtime", "release_version": 2, "manifest_sha256": "…",
                               "event": { "seq": 1, "type": "case_created", "prev": null, "hash": "fca1d0b5…", "override": false, … } },
               "at": "…" }, … ],
  "audit_chain_valid": true
}
```
- `next_step.kind`: `submit` (render `form` with rjsf; `next_step.form` is null for `approve`) or `approve`.
- `next_step.role` is the tier whose turn it is; `allowed_actions` is what **this** caller may do now
  (`[]` = read only). Possible values: `submit`, `approve`, `send_back`, `reject`.
- `stages[].chain` = the tier chain of that stage **in the pinned release** (executive < supervisor < business_admin).
- `stages[].state` uses the outcome vocabulary (`pending`, `in progress`, `submitted`, `approved`, `rejected`, …).
- `record.case_status`: `open | in_progress | completed | rejected | parked` (parked = roll-up unresolved).
- `audit[].provenance.policy`: `gate` (incl. `inputs.reached` that opened it), `tier` (an approval
  event), `runtime`, `delegation`; `provenance.override: true` marks an admin override.
- Form widgets: `ui:widget: "MatrixFileWidget"` (file fields; value = a storage key string) and
  `"MatrixPersonWidget"` (`ui:options.tier`; value = a user id — use 3.1).

### 3.5 `POST /m/{module_key}/records/{id}/actions`
```json
{ "action": "submit", "values": { "credit_days": 45, "payment_terms": "net 30" }, "expected_seq": 5 }
{ "action": "approve" }
{ "action": "send_back", "reason": "GST certificate name differs", "to_stage": 1 }   // to_stage optional (default: one step back)
{ "action": "reject", "note": "vendor blacklisted" }                                  // note = alias of reason
```
`200` = the updated record detail. `expected_seq` (optional) = the `record.seq` the user acted on → `409 stale` if
someone else acted first. One locked transaction per action; concurrent actions are serialised (the losers
get `409 wrong_action` / `stale`).

| Status | `code` | Meaning |
|---|---|---|
| 403 | `wrong_tier` | this step needs another tier |
| 403 | `no_delegation` | executive acting on a site not assigned/delegated to them (module `tiers.delegation=true`) — a supervisor must assign first (3.6) |
| 403 | `separation_of_duties` | same person already acted on another tier of this stage pass |
| 403 | `observer_read_only` / — | observer, non-member |
| 409 | `wrong_action` | e.g. `approve` while the step is a `submit` |
| 409 | `closed` | case finished |
| 409 | `nothing_to_send_back` / `stage_gate_closed` / `release_mismatch` / `stale` | as named |
| 422 | `invalid_form` | `errors: ["gst_number: 'x' does not match '^[0-9]{2}…'", …]` (path: message) — feed to rjsf `extraErrors` |
| 422 | `reason_required` / `bad_target` | send_back/reject without reason; bad `to_stage` |

### 3.6 `POST /m/{module_key}/records/{id}/assign`
Body `{ "executive_id": "<uuid>" }` — supervisor of the module or business admin. Writes a
`site_delegations` row for this module + `assigned_to`. `404` if the user is not an active executive
of the module. Returns the record detail.

---

## 4. The journey (what F4b wires, in order)

1. `/#/admin` → platform admin login (existing). Configurator "Publish": if `GET /platform/workspaces/{ref}`
   is 404 → `POST /platform/workspaces` (show workspace code + setup code once) → `POST …/releases`.
   Otherwise just `POST …/releases`. Show `findings` (errors block, warnings inform).
2. BA: login page with the workspace code → "Request a reset" → setup code → password → sign in (existing UI).
3. BA portal Departments (`GET /business-admin/org`) now includes custom modules; dept-code rotate per module.
4. Supervisors/executives sign up with the codes (existing UI); their JWT `module` may be a custom key.
5. App chrome: sidebar from `GET /workspace/modules`; route `/m/:moduleKey` → generic module page:
   list (3.2) → open (3.3, locked screen from `gate`) → detail (3.4) → rjsf form + action buttons from
   `allowed_actions` (3.5) → assign (3.6 + 3.1) → history from `approvals` / `audit`.

## 5. Quirks / known limits (backend)

- The manifest's built-in **gates, stages and approvers are not enforced** — built-ins run their bespoke
  code; only enable/label/position/supervisor-only/delegation flags apply to them. Only custom modules run
  the manifest's rules.
- Disabling a built-in blocks every route guarded by `require_module`: `legal`, `design`, `project`,
  `project_excellence`, `nso` (financial-closure writes are guarded by `require_module("project")`, so they
  follow `project`). BD, finance_ca, launch_approval and financial_closure have no module guard of their
  own and stay reachable when disabled — hide them in the UI.
- Enablement/navigation follow the **live** release; stage rules follow the **pinned** release. A module
  disabled/removed live is closed for everyone, including cases opened on an older release.
- No upload endpoint for custom-module file fields yet (`MatrixFileWidget` has nowhere to put bytes);
  no revoke endpoint for custom-module delegations; no notifications for custom-module steps.
- Rate limits (in memory, reset on backend restart) apply to the existing auth endpoints, not to the new ones.

# Matrix-bd and configurator-v5 concepts → `workspace-manifest/1`

How each existing concept lands in the universal manifest — or why it does not. "Executable" = reproduced by
`packages/manifest/workspace_manifest/from_v5.py` and covered by `tests/test_from_v5.py`.

## 1. Matrix-bd (the real app) concepts

| Matrix-bd concept | Where it lives today | In the manifest | Notes |
|---|---|---|---|
| Tenant / workspace, workspace code | `tenants`, `workspace_requests`, `tenant_config_live` | `workspace` (key, name) — the **code** is identity data, not configuration | Codes stay in the identity service |
| Business admin | `business_admins`, JWT `role=business_admin` | role `business_admin`, `scope: workspace` | Its powers become grants (`manage_members`, `override_step`, …) instead of "BA can do anything" |
| Supervisor / executive | JWT `role` + `user_module_memberships.role_in_module` | roles `supervisor`, `executive`, `scope: module`; module `members[]` | Any number of further module roles (e.g. `finance_reviewer`) |
| Observer (read-only) | `observer_codes`, `require_not_observer` guards | role with `read_only: true`, `scope: workspace` | R3/R10 forbid read-only roles from acting or holding write grants |
| Supervisor-only module (NSO) | `module_catalog.supervisor_only`, `tiers.executive=false` | module `members: ["supervisor"]` | Nothing implicit |
| Platform admin | `X-Platform-Admin-Key` | role `workspace_admin` + grants `edit_draft`, `publish_release`, `migrate_cases` | Task 6 separates platform operator from workspace admin |
| Module (BD, Legal, Design, …) | 9 routers + services + `module_catalog` | `modules[]` entries from **templates** (Task 4) | No built-ins (R7) |
| Site (the thing everything is about) | `sites` + 7 `site_*` tables | `subjects: [{key: "site", fields: [...]}]`; modules declare `subject: "site"` | Other workspaces use other subjects (vendor, store, contract) |
| Site status columns (`sites.status`, `legal_dd_status`, `design_status`, …) | one column per module on `sites` | the module's **reached outcomes** (stage outcomes + exit) | `status_source` / `outcome_map` / `reached_map` are forbidden (R7) |
| Hard-coded unlocks ("design opens when BD is done") | `workflow_unlocks.py`, `design_unlock_ready` | `entry_gate: {match: all, conditions: [{source: "bd", outcome: "done"}]}` | D18 ("BD done opens too early") becomes a validated, visible gate |
| Approval chains (`approvals` table, finance/CA two-step, launch loop) | per-module code | `stages[].submit` + ordered `approvals[]` with `actions` | Separation of duties is a module flag |
| Send back / rework | per-module code, `legal_change_requests` | approval action `send_back`, `send_back_to[]` | |
| Reject | per-module statuses (`legal_rejected`, `rejected`) | approval action `reject` → `exit.on_reject` | R6 requires the exit to exist |
| Site / shortlist delegation | `site_delegations`, `shortlist_delegations` | `delegation: true`, `submit.restricted_to: "assignee"`, grant `assign_cases` | |
| Creator rule (G3: "only for sites they created") | `restricted_to: site_creator`, `cfg_user_owns_site` | `submit.restricted_to: "case_creator"` | Executable |
| Override by business admin | `is_override` on approvals | grant `override_step` (recorded as override) | Explicit instead of role-implied |
| Department / module codes | `module_codes`, `supervisor_invite_codes` | not configuration — identity invites per module role | Task 6 |
| Rent terms, budgets, GFC, DD checklist fields | columns spread over `site_*`, `design_*`, `legal_*` tables | typed `fields[]` on stages (`money`, `choice`, `file`, `date`, …) | Templates (Task 4) carry the actual fields |
| Budget / closure roll-ups | service code | `rollup` (`sum_under`, `all_positive`, …) | Anything non-standard → adapter `computeOutcome` (Task 5) |
| SLA timers | `stage_events` | `stages[].sla_hours` | Runtime support to be built (STATUS §3.4) |
| Quality audit "scope" | `module_catalog.surface='scope'` | a normal module, or a view | No special surface type |
| Payment module (retired) | `module_catalog.retired_at` | nothing | Retirement = not in the manifest |
| Saved views (G3) | `module_views` rows seeded on publish | `modules[].views[]` | Now part of the release, versioned with it |
| Release pinning (sites pinned to a release) | `sites.config_release_id` | unchanged rule, pinned **on the case** (Task 3) | |
| India-specific data (₹ amounts, GST, PAN) | free-text hints, regexes in code | `money` + `validation.currency`, `text` + `validation.pattern` | Locale comes from `workspace.locale/currency` |
| Notifications | `notification_outbox` | not in the manifest yet — runtime events consumers subscribe to | Task 5 events |

## 2. Configurator-v5 manifest fields

| v5 field | → | Executable |
|---|---|---|
| `workspace {id, name, slug, live_version, draft_version}` | `workspace {key, name}`; versions move to the release store (Task 3) | yes |
| `pipeline` (platform-owned BD backbone, `editable: false`) | dropped (empty in every v5 seed) | yes |
| `signals[] {key, outcomes}` | `signals[] {key, label, subject, outcomes}` | yes |
| `permissions[] {action, platform_ceiling, granted}` | `permissions[] {action, roles, modules?}`; the platform ceiling becomes a platform policy outside the manifest (Task 6) | defaults only |
| `modules[].type: builtin` | **not allowed**; reported, replaced by a template | reported |
| `modules[].type: custom`, `route: /m/<key>`, `state`, `navigation` | module; routes and navigation are derived by the app | yes |
| `tiers.supervisor` (always true) | `members` includes `supervisor` | yes |
| `tiers.executive` | `members` includes `executive` (or not) | yes |
| `tiers.business_admin_signoff` | whether `business_admin` tiers stay in each stage's approvals | yes |
| `tiers.delegation` | `delegation` | yes |
| `entry_gate {match, conditions[{source, outcome}], refusal_message}` | same shape; outcome keys normalised (`in progress` → `in_progress`); `pex` → `project_excellence` | yes |
| `stages[].order` | array order + `key` (`s<order>` when converting) | yes |
| `stages[].approvers` (implicit rank sort, default `supervisor`) | `submit.roles` = first tier, `approvals[]` = the rest | yes, equals `ModuleRuntime.chain` |
| `stages[].terminal` | implied: the last stage | yes |
| `stages[].outcome` | `stages[].outcome` | yes |
| `stages[].restricted_to: site_creator` | `submit.restricted_to: case_creator` | yes |
| `stages[].gate` (stage number conditions) | `gate` with stage **keys** | yes |
| `fields[].kind` choice / yesno / text / number / date / file / person | `type` choice / yes_no / text / number / date / file / person (+ new `long_text`, `money`, `multi_choice`) | yes |
| `fields[].validation` free text | typed `options` / `validation` | yes (unreadable hints → `help` + a note) |
| `fields[].affects_outcome` | kept when the roll-up can score it, else dropped with a note | yes |
| `rollup {strategy, n, of, field, limit}` | `rollup {strategy, fields[], n, limit, positive, negative}`; `custom` → adapter | yes |
| `exit_signal` | `exit.on_complete` (+ `on_reject` when a tier can reject) | yes |
| Outcome vocabulary (8 fixed) | `outcomes[]` (the 8 become the default set; `allocated` kept for compatibility) | yes |

## 3. What deliberately has no place in the manifest

* **Identity data**: users, invite codes, workspace codes, passwords, setup codes.
* **Runtime state**: cases, stage states, approvals, audit events, migrations.
* **Storage and table names**: no manifest value may name a table or column (`status_source`, `outcome_map` are refused).
* **Platform policy**: what a workspace admin is allowed to grant at all (v5's `platform_ceiling`) — a platform setting, enforced at publish (Task 6).

# Notification and SLA system plan

**Task 11** · 2026-10-06 · design only (nothing implemented) · consumes the event contract of
[`docs/events/EVENT-BUS.md`](../events/EVENT-BUS.md) (designed in parallel) and adds **four event types** to it.

**Inspected** (`app/` = sandbox Matrix-bd): `backend/app/services/notification_service.py`, `backend/app/routers/notifications.py`,
`backend/app/main.py` (drain loop), `backend/app/core/config.py`, `backend/app/db/models.py` (`NotificationOutbox`),
`backend/database/schema.sql` + `migrations/20260803_notification_outbox_drain_index.sql`, every `notify_enqueue` caller
(`bd_service`, `loi_service`, `legal_service`, `finance_service`, `change_request_service`, `delegation_service`,
`design_service`), `audit_service.py`, `module_runtime_service.py`, `module_views_service.py`, `query_service.py`,
`frontend/src/modules/business-admin/approval/`, `frontend/src/modules/custom-module/`, `frontend/src/modules/staging/`,
`frontend/src/services/api/adapters/httpAdapter.js`. Target: `packages/manifest` (schema + `validate.py`), `packages/access`
(`authorize.py`, `model.py`), `packages/store/sql/0002_store.sql`, `docs/adapters/README.md`, `docs/runtime/HARDENING.md`
(RT-*), `docs/frontend/GENERIC-RUNTIME-SPEC.md` (component #), `templates/matrix-bd/bd.template.json`.

## 1. Current notification behavior

| # | Behaviour today | Evidence |
|---|---|---|
| C1 | **Transactional outbox, one row per recipient × channel.** `enqueue()` is called inside the business transaction, so a rolled-back action never notifies | `notification_service.py:8-11`, `:139-186` |
| C2 | **41 hand-written call sites in 7 services**, each with its own event string (40 distinct names, module-prefixed: `draft_submitted`, `design_gfc_ready`, `legal_approved`, `finance_awaiting_admin`, `pe_budget_opened`, …): bd 10, design 14, legal 5, change_request 5, finance 4, loi 2, delegation 1 | e.g. `bd_service.py:123-134`, `:444-449`, `design_service.py:514-517`, `:1693-1695`, `loi_service.py:216-225` |
| C3 | **Recipients are code with hard-coded roles and module keys**: `Role.SUPERVISOR` / `Role.BUSINESS_ADMIN` from `users.role`, `module="legal"` / `"design"`, SQL literal `role_in_module = 'supervisor'`; "site owner" = `sites.assigned_to` + `submitted_by` | `notification_service.py:43-52`, `:55-78`, `:93-99`, `:107-119`, `:122-134` |
| C4 | **Text lives in services or nowhere.** Most calls pass no subject/body; the email drain then sends `type.replace("_"," ").title()` and `<p>Event: …</p>` | `notification_service.py:246-247`; hand-written body `loi_service.py:220-225` |
| C5 | **Email only, via Resend, in an API-process asyncio task**, started only when `RESEND_API_KEY` is set; otherwise rows pile up | `main.py:159-181`, `:519-526`; `config.py:110-116` |
| C6 | **No real retry.** The first failure sets `status='failed'`, and the drain only selects `status='pending'` — the `attempts < 3` limit is never reached; no backoff, no dead-letter alert | `notification_service.py:216-221`, `:250-279` |
| C7 | **Duplicate sends possible.** Candidates are read without a lock, sent, then updated with an optimistic `WHERE status='pending'`; two drains (two instances) both send the same row — only the second UPDATE is a no-op | `notification_service.py:211-226`, `:266-279`; single-process assumption `main.py:73`, `:517` |
| C8 | **`slack` rows are written but no transport exists** — they stay `pending` forever | `bd_service.py:133`, `:447`; channel CHECK `models.py:402` |
| C9 | **In-app feed is read-only and unused**: list only, no read/unread, no count; in-app rows keep `status='pending'`; no frontend caller of `/notifications` | `routers/notifications.py:19-52`; grep of `frontend/src` |
| C10 | **Custom (manifest) modules notify nobody.** `svc_act` / `svc_assign` write state, approvals and audit only | `module_runtime_service.py:449-511`, `:513-563` |
| C11 | **Notifications are BD-site rows**: `site_id` FK `ON DELETE CASCADE`, tenant-scoped, no module/case/release columns | `models.py:382-405`; `schema.sql:310-334` |
| S1 | **The only SLA is the LOI deadline**: computed as a DATE at shortlist approval (`approved_at + expected_loi_days`), stored on `approvals.loi_deadline` and **never read again** | `bd_service.py:474-485`; `models.py:341` |
| S2 | **Overdue is computed in the browser** from `approved_at` / `loi_uploaded_at`; nothing server-side knows a site is late; no reminder, no escalation, no event | `httpAdapter.js:229-232`; `ExecStagingPage.jsx:34-35`, `:65`; `SupervisorStagingPage.jsx:32-33`, `:104` |
| S3 | **Send-back restarts the clock** by clearing `loi_uploaded_at` (a deliberate rule worth keeping generically) | `loi_service.py:179-185`, `:200` |
| S4 | **No scheduler of any kind** — the drain loop is the only background task | `main.py:522`; grep for cron/scheduler |
| S5 | Manifest already has `stages[].sla_hours` (integer) with **no validator rule and no runtime**; `stage_events` is called the "SLA ledger" but no SLA reads it | `workspace_manifest.schema.json:664-667`; `MAPPING.md:29`; `audit_service.py:5-6`, `:66-76` |
| S6 | The BD adapter turns `expected_loi_days` into an event `matrix_bd.bd.loi_deadline_set {due_at}` with **no consumer**; the template names the missing generic feature `stage.sla_from_field` | `docs/adapters/README.md:120`; `bd.template.json:453-457` |

## 2. Gaps for modular runtime

| Gap | Why it blocks modular runtime | Fixed by |
|---|---|---|
| G1 Event names and recipients are code per module (C2, C3) | A configured module cannot say who hears about what; adding a module means editing services | rules in the manifest (§3, §5) over canonical events |
| G2 Role names / module keys in recipient SQL (C3) | Contradicts manifest M2 (roles are data) and rbac §1.1 ("nothing derives from a role's name") | selectors resolved by `packages/access` (§5.2) |
| G3 Custom modules are silent (C10) | Every manifest module is mute today | runtime emits canonical events (EVENT-BUS); dispatcher is generic |
| G4 Rules are not release-pinned | A case pinned to v7 must notify per v7 even after v8 goes live | rules compiled per **pinned** `release.id` from the envelope |
| G5 No durable timers / no SLA model (S1–S5) | Deadlines exist only as UI arithmetic; a restart or a second instance loses nothing only because nothing exists | `case_timers` + timer worker (§4) |
| G6 Per-case deadline from a field is adapter-only (S6) | `expected_loi_days` needs custom code | `sla.due_from_field` (§3) retires the BD `afterApprove` hook |
| G7 Unsafe delivery (C6, C7, C8) | No retry, possible duplicates, dead channels | idempotent deliveries, leased claims, backoff, dead letter (§9) |
| G8 No inbox, no read state, no SLA display (C9, S2) | Users cannot see "my turn" / "overdue" across modules | §8 surfaces |
| G9 Notifications ignore visibility | An escalation could reveal a case the recipient may not open | every recipient filtered by `authorize(case.view)` on the pinned policy |
| G10 BD-site coupling (C11) | Cases will have generic subjects (RT-F01) | deliveries keyed by `case_id` + `subject {type,id}` |

Legacy → rule mapping (proves the 41 calls need no code; written into `templates/matrix-bd/*` at cut-over):

| Legacy event (service) | Canonical `on` | Selector(s) |
|---|---|---|
| `draft_submitted`, `details_submitted_for_review`, `design_gfc_ready`, `finance_submitted`, `legal_dd_pending_review` | `module.stage.submitted` (stage rule) | `next_approver` |
| `site_approved`, `draft_shortlisted`, `legal_approved`, `design_deliverable_approved` | `module.stage.approved` | `submitter`, `assignee` |
| `loi_sent_back`, `design_deliverable_rejected`, `design_gfc_rejected` | `module.stage.sent_back` | `submitter`, `assignee` |
| `draft_rejected`, `legal_rejected`, `finance_rejected` | `module.stage.rejected` | `submitter`, `case_creator` |
| `design_allocated`, `legal_delegated`, `site_reassigned` | `module.assignment.changed` | `assignee`, `previous_assignee` |
| `pe_budget_opened`, `site_sent_to_legal` (cross-module hand-off) | `module.record.opened` (rule on the **receiving** module) | `module.supervisor` |
| `*_ack` (confirmation to the actor) | same event | `actor` |
| LOI deadline (S1/S2) | `module.sla.warning` / `module.sla.breached` | `next_actor`, `sla.escalate_to` |

## 3. Manifest schema additions

All additions are optional; a manifest without them behaves as today's custom runtime (no notifications, no SLA).

### 3.1 Placement and precedence

| Key | Allowed at | Precedence |
|---|---|---|
| `sla` | `modules[]` (default for every stage) and `stages[]` | **Stage wins, key by key**: effective = `{...module.sla, ...stage.sla}`; list keys (`escalate_to`, `escalation`, `warn_to`) are **replaced**, never concatenated. `stage.sla: {"enabled": false}` switches the SLA off for that stage. Legacy `stage.sla_hours` = stage-level `stage_due_in_hours` (deprecated). |
| `notifications[]` | root (workspace events only), `modules[]` (any stage), `stages[]` (only events whose `stage_key` is this stage) | Module and stage rules both apply. A stage rule with the **same `key`** as a module rule replaces it for that stage (`"enabled": false` silences it). Per event, deliveries are merged per (recipient, channel): the highest-precedence rule (stage > module > SLA-derived; then array order) is sent, the others recorded `skipped: duplicate_of`. |

The task example is valid at either level:

```jsonc
"modules": [{ "key": "fit_out", …,
  "sla": {"stage_due_in_hours": 48, "warn_before_hours": 6, "escalate_to": ["module.supervisor", "workspace.admin"]},
  "notifications": [{"key": "ready", "on": "module.stage.submitted", "to": ["next_approver"],
                     "template": "Stage {{stage.name}} is ready for approval"}],
  "stages": [{ "key": "loi", …, "sla": {"due_from_field": {"stage": "details", "field": "expected_loi_days", "unit": "days"},
                                        "clock": "stage"} }]   // BD's LOI deadline, no adapter (G6)
}]
```

### 3.2 JSON Schema fragments (`$defs`, draft 2020-12, `additionalProperties: false` like every existing def)

```jsonc
"recipient": { "type": "string", "pattern":
  "^(next_actor|next_approver|submitter|assignee|previous_assignee|case_creator|subject_creator|actor|stage_participants|case_participants)$|^role:[a-z][a-z0-9_]{1,38}$|^(module|workspace)\\.[a-z][a-z0-9_]{1,38}$" },
"channel":   { "enum": ["in_app", "email", "slack"] },
"escalation_step": { "type": "object", "additionalProperties": false, "required": ["after_breach_hours", "to"],
  "properties": { "after_breach_hours": {"type": "integer", "minimum": 0, "maximum": 8760},
                  "to": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"$ref": "#/$defs/recipient"}},
                  "channels": {"type": "array", "uniqueItems": true, "items": {"$ref": "#/$defs/channel"}, "default": ["in_app", "email"]},
                  "template": {"$ref": "#/$defs/template"} } },
"sla": { "type": "object", "additionalProperties": false, "properties": {
  "enabled":            {"type": "boolean", "default": true},
  "stage_due_in_hours": {"type": "integer", "minimum": 1, "maximum": 8760},
  "due_from_field":     {"type": "object", "additionalProperties": false, "required": ["stage", "field", "unit"],
                         "properties": {"stage": {"$ref": "#/$defs/key"}, "field": {"$ref": "#/$defs/key"},
                                        "unit": {"enum": ["hours", "days"]}}},
  "clock":              {"enum": ["stage", "step"], "default": "stage",
                         "description": "stage: one clock from stage entry to stage completion; step: restarts at the submit step and at each approval tier"},
  "on_send_back":       {"enum": ["restart", "resume"], "default": "restart"},
  "warn_before_hours":  {"type": "integer", "minimum": 1},
  "warn_to":            {"type": "array", "uniqueItems": true, "items": {"$ref": "#/$defs/recipient"}, "default": ["next_actor"]},
  "escalate_to":        {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"$ref": "#/$defs/recipient"},
                         "description": "sugar for escalation: [{after_breach_hours: 0, to: escalate_to}]"},
  "escalation":         {"type": "array", "minItems": 1, "maxItems": 5, "items": {"$ref": "#/$defs/escalation_step"}} } },
"template": { "oneOf": [ {"type": "string", "minLength": 1, "maxLength": 2000},
  {"type": "object", "additionalProperties": false, "required": ["body"],
   "properties": {"subject": {"type": "string", "maxLength": 200}, "body": {"type": "string", "minLength": 1, "maxLength": 4000}}} ] },
"notification_rule": { "type": "object", "additionalProperties": false, "required": ["key", "on", "to", "template"],
  "properties": { "key": {"$ref": "#/$defs/key"}, "enabled": {"type": "boolean", "default": true},
    "on": {"type": "string", "pattern": "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$"},
    "to": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"$ref": "#/$defs/recipient"}},
    "channels": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"$ref": "#/$defs/channel"}, "default": ["in_app"]},
    "template": {"$ref": "#/$defs/template"},
    "when": {"type": "object", "additionalProperties": false, "properties": {
       "outcome": {"type": "array", "uniqueItems": true, "items": {"type": "string"}},
       "to_stage": {"type": "array", "uniqueItems": true, "items": {"$ref": "#/$defs/key"}} }},
    "include_overriders": {"type": "boolean", "default": false},
    "mandatory": {"type": "boolean", "default": false, "description": "recipients cannot mute it (§8 preferences)"} } }
```

Wiring: `$defs/module.properties` += `sla`, `notifications: {items: notification_rule}`; `$defs/stage.properties` += `sla`,
`notifications`; `sla_hours` keeps validating but gains `"deprecated": true`; root `properties` += `notifications` (only
`release.*` and `notification.failed`); `$defs/grant.action` enum += `manage_notifications` (workspace-scope only, ceiling C1);
`$defs/view.filter` += `sla: {"type":"array","items":{"enum":["on_track","warning","breached","none"]}}`.
`on` is a **pattern, not an enum**, so an unknown type gets the precise code `unknown_event_type` (as R7 does for
built-in markers) and adapter-emitted types can be allowed from the registry.

### 3.3 Selectors and how `module.supervisor` / `workspace.admin` resolve

No selector names a role in code. Role selectors are **looked up in `roles[]` of the pinned manifest by key**:

| Selector | Resolves to (at dispatch, on the pinned policy) | Available on |
|---|---|---|
| `next_actor` | every active principal for whom `authorize(stage.submit | stage.approve…)` on the case's step **after** the event is allowed **without** `as_override` (incl. borrowed tiers, `restricted_*`, SoD) — `_step_actor` semantics (`authorize.py:50-83`) | events leaving the case open |
| `next_approver` | `next_actor` when the step after the event is an approval tier, else ∅ | same |
| `submitter` / `stage_participants` | who submitted / everyone who acted on the current stage pass (from `case_events`) | stage events |
| `assignee` / `previous_assignee` | `cases.assignee_id` / payload `previous_assignee_id` | any / `module.assignment.changed` |
| `case_creator` / `subject_creator` | `cases.opened_by` / subject `created_by` | any case event |
| `actor` | `envelope.actor.on_behalf_of ?? actor.id` when `kind = user` (the actor is **excluded from every other selector**) | any |
| `case_participants` | everyone who ever acted on the case (`CaseResource.participants`) | any |
| `role:<key>` | holders of role `<key>`, using the role's declared `scope` (module scope ⇒ members **of this case's module**) | any |
| `module.<key>` | role `<key>` must have `scope: module` and be in `module.members`; holders = `module_memberships (module_key, key)` (`0004_access.sql:29`) | module rules |
| `workspace.<key>` | role `<key>` must have `scope: workspace`; holders = `workspace_role_assignments` (`0004_access.sql:20`) | any |

So `"module.supervisor"` resolves to the role whose **key** is `supervisor` (Acme and Matrix-bd both declare it with
`scope: module`) and to the people holding that membership in the case's module. `"workspace.admin"` needs a role with
key **`admin`** and `scope: workspace`; neither Acme (`workspace_admin`, `business_admin`) nor the Matrix-bd template has
one, so publish fails with **`R11 unknown_recipient_role`** —
`{"severity":"error","rule":"R11","code":"unknown_recipient_role","message":"recipient 'workspace.admin': no role with key 'admin' (workspace roles: workspace_admin, business_admin, observer)","path":"modules/1/sla/escalate_to/1","module":"fit_out","suggestions":["workspace_admin","business_admin"]}`.
Suggestions are a string-similarity hint for the configurator; the validator never maps names by meaning.
Every resolved recipient is then filtered: active principal, not the actor, `authorize(case.view)` allowed (G9), channel
preference (§8). Override-only holders are excluded unless `include_overriders: true` — otherwise a business admin with
`override_step` would receive every "ready for approval".

### 3.4 Template variables (closed vocabulary; `{{ path }}`, no logic, no partials, escaped per channel)

| Variable | Available on |
|---|---|
| `workspace.name`, `module.key`, `module.name`, `case.id`, `case.status`, `case.url`, `subject.type`, `subject.title`, `subject.<field>` (declared `subjects[].fields`), `release.version`, `recipient.name`, `actor.name`, `event.type`, `event.occurred_at` | every case event |
| `stage.key`, `stage.name`, `step.label` (`approval.label`/tier index) | events with `stage_key` |
| `event.reason` | `module.stage.rejected`, `module.stage.sent_back` |
| `outcome.key`, `outcome.name` | `module.record.completed`, `module.outcome.reached` |
| `assignee.name`, `previous_assignee.name` | `module.assignment.changed` (`assignee.name` also on any event) |
| `fields.<stage_key>.<field_key>` (non-file fields of **completed** stages, RT-B08) | any case event |
| `sla.due_at`, `sla.warn_at`, `sla.overdue_hours`, `sla.escalation_level` | `module.sla.*` |
| `migration.summary` (counts migrated / skipped) | root rules on `release.migration.completed` |
| `notification.rule`, `notification.channel`, `notification.error` | root rules on `notification.failed` |

### 3.5 New validator rules (findings shape unchanged: `{severity, rule, code, message, path, module?, stage?, field?}`)

`validate(manifest, adapters=None, channels=None)` — `channels` is the platform's transport registry
(`{"in_app": true, "email": true, "slack": false}`; `None` = unknown, like `adapters`).

| Rule | Requirement | Codes (severity) |
|---|---|---|
| **R11 notifications** | `on` ∈ EVENT-BUS canonical types ∪ the four additions ∪ `emits` of this module's installed adapter (registry given); `release.*`/`notification.failed` only at root, `module.*` never at root; stage rules only on events that carry `stage_key`; selector syntax and role lookup by key; scope of `module.`/`workspace.` matches the role; `module.<key>` is a member role of the module; rule keys unique per module (R1 `duplicate_key`); `template` balanced and every variable in §3.4 **and** available for `on`; `fields.*` exist; `when.outcome` / `when.to_stage` exist and fit `on`; a rule on `notification.failed` only uses `in_app` | `unknown_event_type`, `event_not_allowed_here`, `unknown_recipient_selector`, `unknown_recipient_role`, `recipient_scope`, `recipient_not_member`, `template_syntax`, `template_unknown_variable`, `template_variable_unavailable`, `unknown_field`, `unknown_outcome`, `notification_loop` (E); `recipient_never_resolvable` (e.g. `next_approver` on `module.record.completed`, `assignee` with `delegation: false`), `rule_never_fires` (`module.stage.approved` on a stage without approvals; `sent_back` where nothing can send back), `template_field_maybe_empty`, `channel_unavailable` (registry says no transport), `duplicate_rule` (same `on` + `to` + `channels` twice at one level) (W) |
| **R12 SLA** | due defined when anything else is (`stage_due_in_hours` xor `due_from_field`); `warn_before_hours < stage_due_in_hours` (for `due_from_field`, checked against the field's `validation.max`); `due_from_field` names a `number` field of an **earlier** stage (or an approval field of one); legacy `sla_hours` not contradicting `sla`; `unit: days` needs `workspace.timezone` | `sla_due_missing`, `sla_warn_not_before_due`, `sla_due_field_invalid`, `sla_hours_conflict` (E); `sla_hours_deprecated`, `sla_unit_without_timezone` (falls back to UTC), `sla_warn_unbounded` (field has no `max`), `sla_step_clock_without_approvals` (W) |
| **R13 escalation** | every `escalate_to`/`escalation[].to` role exists (`unknown_recipient_role`), is **not `read_only`**, matches scope; steps strictly increasing in `after_breach_hours`; the target can either act on some step of the stage, hold `override_step`, or `assign_cases` for the module — otherwise escalation is a notification to someone powerless; target can `case.view` the module's cases (visibility/`view_all_cases`) | `escalation_read_only`, `escalation_scope`, `escalation_order` (E); `escalation_powerless`, `escalation_cannot_view` (W) |

Each code gets a failing fixture in `packages/manifest/tests/fixtures/invalid_cases.json` (§10).

## 4. Timer rules

**Business hours / calendars — decision N1: wall-clock time only in v1, `unit: days` rounds to end-of-day in
`workspace.timezone`.** Justification: (a) a due date must be a **pure function of (anchor, pinned release, timezone)**
so it can be recomputed identically after a send-back or a migration (§4.3); holiday calendars are mutable data
outside the release, so editing one would silently move deadlines of running cases unless calendars were themselves
versioned in the release; (b) the only real SLA in Matrix-bd is in calendar days with an end-of-day DATE
(`bd_service.py:474-477`, browser day-diffs `httpAdapter.js:232`); (c) wall-clock is what users can verify by hand.
Forward path: a later `workspace.calendars[]` **inside the manifest** (so release-pinned) plus `sla.calendar: <key>` —
the `case_timers` model below does not change, only the due-date function.

### 4.1 Model

`case_timers` (one row per future firing; in `0003_runtime.sql` next to `cases`, RT §4; RLS by `workspace_id`):

| Column | Meaning |
|---|---|
| `id`, `workspace_id`, `case_id → cases`, `module_key`, `stage_key`, `pass_no` | which stage pass (pass increments on send-back / re-entry) |
| `step` (null when `clock: stage`) | tier index for `clock: step` |
| `kind` (`warn` / `due` / `escalate`), `level` (0 for warn/due, 1..5 for escalation steps) | |
| `release_id`, `release_version` | the pinned release the SLA came from |
| `anchor_at`, `fire_at` | clock start (event `occurred_at`, never processing time) and DB-computed fire time |
| `status` `armed → claimed → fired` · `armed → cancelled` · `armed → superseded` | forward-only (trigger) |
| `claimed_by`, `lease_until`, `attempts`, `last_error` | crash-safe claiming |
| `armed_by_event_id`, `cancelled_by_event_id`, `fired_event_id` | causation trail |
| unique `(case_id, stage_key, pass_no, coalesce(step,-1), kind, level)` | arming is idempotent; a breach fires once per pass |
| index `(fire_at) WHERE status = 'armed'` | the worker's hot set |

### 4.2 Arming and cancelling (subscriber `sla-timers` on EVENT-BUS, at-least-once, per-subscriber offset)

| Event (canonical) | Timer action |
|---|---|
| `module.record.opened` | arm `warn`/`due`/`escalate*` for the first stage, anchor = `occurred_at` |
| `module.stage.submitted` | `clock: step` → cancel the pass's step timers, arm for tier 1; `clock: stage` → nothing |
| `module.stage.approved` (intermediate tier) | `clock: step` → re-arm for next tier |
| `module.stage.approved` (last tier) | stage complete → cancel this pass; arm the next stage (anchor = this event) |
| `module.stage.sent_back` | cancel the current pass; arm target stage `pass_no+1`, anchor = this event (`on_send_back: restart`, S3) or the original anchor (`resume`) |
| `module.stage.rejected`, `module.record.completed` | cancel every armed timer of the case |
| `module.assignment.changed`, `module.file.uploaded`, `module.outcome.reached` | none (recipients are resolved at fire time) |
| `release.migration.completed` | per migrated case: mark armed timers `superseded`, recompute from the **new** release with the **same anchor** (stage mapped by key, RT-D01; a removed stage → anchor = migration time); a `due` already in the past fires immediately unless this pass's breach already fired (unique key) |
| `release.published` | none — running cases stay pinned |

Ordering guard: each timer stores the case `seq` of its arming event; the subscriber ignores an event whose `seq` is
lower than the latest armed/cancelled `seq` for the case (out-of-order replay). `due_from_field` reads the value from the
pinned case state **at arming**; an empty value arms nothing and records `sla_skipped: field_empty` on the case.

### 4.3 Firing (worker `timer_worker`, any number of instances, DB time only)

```sql
WITH due AS (SELECT id FROM case_timers WHERE status = 'armed' AND fire_at <= now()
             ORDER BY fire_at LIMIT 100 FOR UPDATE SKIP LOCKED)
UPDATE case_timers t SET status = 'claimed', claimed_by = :worker, lease_until = now() + interval '2 minutes',
       attempts = attempts + 1 FROM due WHERE t.id = due.id RETURNING t.*;
-- recovery, same loop: UPDATE case_timers SET status='armed' WHERE status='claimed' AND lease_until < now();
```

Then **one transaction per timer**: lock the case (`FOR UPDATE`); re-check case open, same `stage_key`/`pass_no`/`step`,
`cases.release_id = timer.release_id` (else `superseded`/`cancelled` with reason); skip a `warn` whose `due` has also
passed (`superseded_by_breach`); write the event through the EVENT-BUS outbox with
`idempotency_key = sla:{case_id}:{stage_key}:{pass_no}:{step}:{kind}:{level}`, `actor {id: "sla", kind: "timer"}`,
`causation_id = armed_by_event_id`, `correlation_id` = the arming event's; append the chained `case_events` row (§6); set
`status='fired', fired_event_id`. Restart = the table is the state; past-due timers fire in `fire_at` order with
`late_by_seconds` in the payload.

## 5. Notification rules

### 5.1 Event additions owned by this plan (names as **additions** to EVENT-BUS)

| Type | `actor.kind` | `payload` |
|---|---|---|
| `module.sla.warning` | `timer` | `{stage_key, pass_no, step?, due_at, warn_at, late_by_seconds, timer_id}` |
| `module.sla.breached` | `timer` | `{stage_key, pass_no, step?, due_at, breached_at, late_by_seconds, timer_id, sla_source: "stage"|"module"|"field"}` |
| `module.sla.escalated` | `timer` | `{stage_key, pass_no, level, after_breach_hours, to: [selectors], timer_id}` |
| `notification.failed` | `system` | `{delivery_id, rule_key, channel, recipient_id, source_event_id, attempts, error_class, error}` (no address, no body) |

All carry the standard envelope incl. `release {id, version}` of the **case's pinned release**.

### 5.2 Dispatch (subscriber `notifications`, at-least-once)

1. Take the event; load rules for `envelope.release.id` (compiled once per immutable release, like `PolicyCache`).
2. Select rules: root rules for workspace events; module rules + stage rules for `module_key` / `stage_key` with
   precedence §3.1; apply `when`; add **SLA-derived rules** compiled from `sla` (`warn_to` on `module.sla.warning`;
   `escalation[level].to` on `module.sla.escalated`; default text from the platform catalogue, overridable via
   `escalation_step.template`). Derived rules are shown in the configurator's compiled-rule preview — nothing implicit.
3. Staleness: for `next_actor`/`next_approver`, if the case `seq` moved past the event's step, skip with
   `stale_step` (no "ready for approval" for a step already decided).
4. Resolve selectors with `packages/access` on the pinned policy + current memberships (§3.3); filter (G9, active,
   actor, preferences unless `mandatory`).
5. Render once per (rule, recipient, channel) — locale = `workspace.locale`; unknown values render empty + `render_warning`.
6. `INSERT … ON CONFLICT (idempotency_key) DO NOTHING` into `notification_deliveries`, with
   `idempotency_key = sha256(rule_key | event.id | recipient_id | channel)` (rule key includes stage/module scope and the
   SLA level); in-app rows are `delivered` at insert; then commit the subscriber offset.

## 6. Escalation rules

| Rule | Behaviour |
|---|---|
| E1 Notify, never decide | Escalation sends notifications and emits `module.sla.escalated`; it **never** approves, rejects, reassigns or changes a role (same principle as adapters: no command may take a human decision, adapters README §2). Acting stays `authorize()`: an escalation target acts only through a tier role, `assign_cases` (reassign) or `override_step` (audited). |
| E2 Ladder | `escalate_to` ≡ `[{after_breach_hours: 0, to}]`. Breach at `due_at` emits `module.sla.breached` (to `warn_to`), then each step `L` emits `module.sla.escalated {level: L}` at `due_at + after_breach_hours`. All steps are armed with the `due` timer and cancelled together. |
| E3 Resolution | Recipients resolved at fire time (memberships may have changed since arming). If filtering leaves nobody, `module.sla.escalated` is still emitted with `delivered_to: 0`, the case shows "escalated — nobody reachable" (§8) and the next ladder step still fires. |
| E4 Audit | Every warning/breach/escalation appends a hash-chained `case_events` row (RT-F11 table) `{type: "sla_breached"|…, event_id, release_id, release_version, stage_key, pass_no, due_at, fired_at, late_by_seconds}` in the **same transaction** as the outbox write — the acceptance criterion's audit record. Workspace-level `workspace_activity` is unchanged (its `chk_wa_action` list is workspace actions only, `0002_store.sql:206-209`). |
| E5 Visibility | A target who cannot `case.view` gets nothing (validator warns at publish: `escalation_cannot_view`). |
| E6 Stop | Stage completion, send-back, reject, completion or migration cancels/supersedes the remaining ladder (§4.2). |

## 7. Backend services needed

| Component | Kind | Responsibility | Reuses |
|---|---|---|---|
| `packages/manifest` R11–R13 | pure | §3.5 rules; `EVENT_TYPES` imported from the EVENT-BUS package, not duplicated | `validate.py:104-142`, `_role_ref` `:235`, `_borrowed` `:286` |
| `packages/notify` `compile_rules(manifest, release)` | pure, cached per release id | precedence merge, SLA-derived rules, template parse | — |
| `recipients.resolve(selector, case, event, policy)` | pure + one membership read | §3.3 | `authorize()`, `_step_actor`, `Principal.holds` (`model.py:37`) |
| `templates.render(tpl, ctx, channel)` | pure | closed vocabulary, escaping (HTML for email, plain for in-app/slack) | — |
| `notification_dispatcher` | EVENT-BUS subscriber | §5.2 | EVENT-BUS offsets / dead letters |
| `delivery_worker` | worker | claims `notification_deliveries` (`FOR UPDATE SKIP LOCKED`, lease), sends, retries, dead-letters, emits `notification.failed` | replaces `drain_pending_emails` |
| `channels.{in_app,email,slack}` | transport plugins | `send(delivery) → Sent | Transient | Permanent | Ambiguous`; declare `idempotent: bool` | Resend call from `notification_service.py:237-249` |
| `sla_timer_service` | EVENT-BUS subscriber | §4.2 | — |
| `timer_worker` | worker | §4.3 | — |
| `sla_read` | read model | view `case_sla(case_id, stage_key, pass_no, due_at, warn_at, state on_track|warning|breached|none, escalation_level)` over `case_timers` | feeds summary/list/detail |
| Notifications API | router | `GET /notifications?unread&module&cursor`, `GET /notifications/unread-count`, `POST /notifications/{id}/read`, `POST /notifications/read-all`, `GET/PUT /me/notification-preferences`; admin (`manage_notifications`): `GET /workspaces/{ws}/deliveries?status=dead`, `POST …/deliveries/{id}/retry`, `POST …/deliveries/{id}/dismiss` | `routers/notifications.py` (rewritten) |
| Runtime API additions | existing routes | `sla {due_at, state, level}` on case list items, detail `next_step`, and `GET /m/{key}/summary` `overdue` | GENERIC-RUNTIME-SPEC §4 row "Dashboard" |
| Legacy bridge (cut-over only) | shim | `notify_enqueue` callers keep working until their module runs on templates; new code never calls it | RT-F02 |

New tables (one migration `0006_notify.sql`, RLS like the store):

| Table | Key columns | Replaces |
|---|---|---|
| `case_timers` | §4.1 | nothing (S4) |
| `notification_deliveries` | `id, workspace_id, idempotency_key UNIQUE, source_event_id, event_type, rule_key, release_id, module_key, case_id, subject_type, subject_id, recipient_id, channel, address (resolved at send), subject, body, status pending|sending|delivered|read|skipped|dead, skip_reason, attempts, next_attempt_at, lease_until, provider_message_id, last_error, created_at, delivered_at, read_at`; index `(next_attempt_at) WHERE status='pending'`, `(recipient_id, created_at DESC) WHERE channel='in_app'` | `notification_outbox` (C11) |
| `notification_attempts` | append-only: `delivery_id, attempt, started_at, outcome, http_status, error_class, error` | `failed_reason` single column |
| `notification_preferences` | `workspace_id, user_id, module_key NULL, channel, enabled` | — |

Workers run in a separate process (`python -m workspace_worker timers|deliveries|subscribers`), not the API lifespan
(`main.py:519-533`), so API scale-out is no longer constrained.

## 8. Frontend surfaces needed

All under `modules/runtime/` (GENERIC-RUNTIME-SPEC §2), keyed by contract vocabulary only — no module key or role name (T21).

| Surface | Where | Data |
|---|---|---|
| `NotificationBell` + `InboxDrawer` | shell chrome (Sidebar header) | `unread-count` (poll 60 s / on focus), `GET /notifications`; click → `/m/:key/cases/:id` |
| `/inbox` page | new route | grouped by module; filters "needs me" (`next_actor`-derived rules), "overdue" (`module.sla.*`), "updates"; mark read / all |
| "My turn" across modules | replaces `ApprovalCenter`'s fixed `TYPE_FILTERS` (`ApprovalCenter.jsx:10-25`) | list endpoint with `can_act` per module (spec #7 `CaseQueue`) |
| `SlaBadge` | `CaseQueue` column `sla` via `ColumnRegistry` (spec #9), `RecordHeader` (#10), `StepCard` | `sla {due_at, state, level}`; replaces `ExecStagingPage`/`SupervisorStagingPage` day arithmetic (S2) |
| Overdue tile | `ModuleDashboard` (#4) `KpiTile` (#5) | `summary.overdue`; a seeded view with `filter.sla: ["breached"]` |
| SLA + notification renderers | `AuditTimeline` `ProvenanceRegistry` (#23) | `case_events` types `sla_warning/breached/escalated`, delivery count |
| `NotificationPreferences` | user settings | per module × channel; `mandatory` rules shown locked |
| `DeliveriesAdmin` | workspace admin (`manage_notifications`) | dead letters, attempts, retry/dismiss |
| Configurator: `SlaEditor`, `NotificationRuleEditor` | stage/module editor | selector picker from `roles[]` + members; variable palette per `on` (§3.4); live R11–R13 findings at `path`; compiled-rule preview incl. SLA-derived rules; test render with a sample case |
| `ModuleSettingsSummary` (#26) | read-only | SLA per stage, rule list |

## 9. Failure/retry behavior

| Failure | Behaviour | Guarantee |
|---|---|---|
| Dispatcher crashes mid-event | offset not committed → replay; deliveries `ON CONFLICT (idempotency_key) DO NOTHING` | no duplicate rows |
| Dispatcher keeps failing on an event (bad data) | EVENT-BUS retry then **subscriber dead letter** + alert; other events continue | no silent loss |
| Template render error | fallback text (`{module.name}: {event.type}` + case link) + `render_warning`; never blocks | always delivered |
| No address / inactive user / not visible / muted | `skipped` with `skip_reason`; never retried | — |
| Transport transient (timeout before send, 429, 5xx) | `pending` with `next_attempt_at = now() + backoff[attempt] ± 20 % jitter`, backoff `1 m, 5 m, 30 m, 2 h, 12 h`; `Retry-After` honoured | bounded |
| Transport permanent (4xx invalid address, rejected) | `dead` immediately | — |
| Max attempts (6) reached | `dead`; emit `notification.failed` (root rules may route it in-app to `workspace.<role>`; a failure of that notification never emits another — `notification_loop` R11) | alert once |
| Claim + send | `UPDATE … SET status='sending', lease_until = now()+2 m … FOR UPDATE SKIP LOCKED`; expired lease → back to `pending` | one sender at a time (fixes C7) |
| Ambiguous outcome (crash/timeout after the provider may have accepted) | transports with `idempotent: true` resend with the **same provider idempotency key** (the delivery's key) → provider dedupes; transports without it go to `dead` with `ambiguous` for manual review instead of risking a second send | **no duplicate sends** |
| Admin retry of a dead delivery | same row, same idempotency key, `attempts` continues | — |
| Timer worker crash after claim | lease expires → reclaimed; firing is one transaction (outbox event + `case_events` + status) and the event `idempotency_key` is unique | breach fires exactly once per pass |
| Downtime | all timers + deliveries in tables; catch-up on start in `fire_at` / `next_attempt_at` order | survives restarts |
| Clock skew | only DB `now()` decides | — |
| Retention | delivered in-app rows 180 days, attempts 30 days; `dead` kept until dismissed | — |

## 10. Tests to add

| ID | Level | Test |
|---|---|---|
| NT1 | validator | one failing fixture per new code in §3.5 (R11 ×17, R12 ×8, R13 ×5 incl. shared `unknown_recipient_role`); the task example passes with `workspace_admin` and fails `unknown_recipient_role` (+ `suggestions`) with `workspace.admin` |
| NT2 | validator | precedence: stage `sla` overrides module key-by-key, lists replaced, `enabled:false`; same-key stage rule replaces module rule |
| NT3 | unit | selectors on Acme + Matrix-bd templates: `next_approver` incl. borrowed tier (`approval.module`), `restricted_to`, SoD, excludes override-only holders; `module.supervisor` vs `workspace.<role>` scope |
| NT4 | unit | templates: every variable × event availability matrix; escaping per channel; missing value → empty + warning |
| NT5 | integration | rules come from the **pinned** release: case on v1, v2 changes the rule → v1 text/recipients; after migration → v2 |
| NT6 | integration (PG) | dispatcher replay of the same event 3× → one delivery per (rule, event, recipient, channel) |
| NT7 | integration (PG) | two `delivery_worker`s + fake transport → each delivery sent once; lease expiry after simulated crash resends with the same provider key |
| NT8 | integration | backoff schedule, `Retry-After`, permanent → dead, 6 transients → dead + one `notification.failed`; no loop |
| NT9 | integration (PG) | timers: open → arm; restart worker process mid-run → past-due fires once with `late_by_seconds`; two workers + `SKIP LOCKED` → one firing |
| NT10 | integration | send-back re-arms `pass_no+1` (restart vs resume); last-tier approval cancels and arms next stage; reject/complete cancels all |
| NT11 | integration | `release.migration.completed` supersedes and recomputes from the same anchor; already-fired breach not refired; removed stage → anchor = migration time |
| NT12 | integration | breach writes `module.sla.breached` + chained `case_events` row with event id + release id in one txn; rollback leaves neither |
| NT13 | integration | escalation ladder levels fire in order; never changes case state/assignee; invisible targets skipped |
| NT14 | unit | `due_from_field` reproduces Matrix-bd LOI: `expected_loi_days` → end-of-day in workspace tz (`bd_service.py:474-477`) |
| NT15 | frontend | Bell/Inbox/SlaBadge render from fixtures for every `templates/matrix-bd/*` module (spec T20); no module key or role literal (spec T21) |
| NT16 | independence | `check-independence.mjs`: no `recipients_for_*`, no module key or role literal in `packages/notify`, workers or runtime notification code |

### Acceptance checklist

| Criterion | Where satisfied |
|---|---|
| Notifications driven by manifest rules on the record's **pinned** release | §3.1–3.4 (schema, precedence), §5.2 steps 1–2 (rules from `envelope.release.id`), NT5 |
| Timers survive restarts: durable table, `FOR UPDATE SKIP LOCKED`, re-arm on send-back, cancel on completion, recompute after migration | §4.1 (`case_timers`), §4.2 (arm/cancel/migration table), §4.3 (claim + lease), §9, NT9–NT11 |
| Failed notifications retry safely: key per (rule, event, recipient, channel), backoff, dead letter, no duplicates | §5.2 step 6, §7 tables, §9 (lease, provider key, ambiguous → dead), NT6–NT8 |
| SLA breach creates `module.sla.breached` **and** an audit record with event id + release id | §4.3, §5.1, §6 E4, NT12 |
| No hard-coded module names (or role names) | §2 legacy mapping → template rules, §3.3 (lookup by key, `unknown_recipient_role`), §7, §8 (T21), NT16 |

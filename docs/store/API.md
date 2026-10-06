# Draft & release store — API contract

**Task 3** · base path `/api/v1` · machine-readable: [`openapi.yaml`](openapi.yaml) · SQL: `packages/store/sql/0002_store.sql`

Every path is scoped to one workspace: `/api/v1/workspaces/{ws}/…`, where `{ws}` is the workspace key
(`acme-retail`). The server resolves it to `workspaces.id` and runs every statement with
`SET LOCAL app.workspace_id = <id>`, so row-level security backs the authorisation check.

## 0. Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <JWT>`. Each endpoint names the **grant** it needs (manifest `permissions[]`, Task 6). The platform operator token may act on any workspace. |
| Errors | `application/problem+json`: `{type, title, status, code, detail, …extras}`. `code` is stable and machine-readable; `detail` is a human sentence. DB errors raised by `store_raise(code, …)` map 1:1 (the DETAIL JSON becomes the extras). |
| Concurrency | Drafts use **ETags**: `ETag: "r<revision>"`. Saving requires `If-Match` (`428 precondition_required` without it). Publishing requires the draft revision and the live version the caller saw. |
| Idempotency | `POST` endpoints accept `Idempotency-Key`; a replay within 24 h returns the first response. |
| Validation | The server always runs `packages/manifest` (`validate(manifest, adapters=<installed registry>)`). The client's opinion is never trusted. |
| Pagination | `?limit=` (default 20, max 100) + opaque `?cursor=`; responses carry `next_cursor`. |
| Times | RFC 3339 UTC. |

Finding shape (from the validator): `{severity, rule, code, message, path, module?, stage?, field?}`.

---

## 1. Drafts

### 1.1 `GET /workspaces/{ws}/draft` — load the head draft  · grant `edit_draft`

`200`, `ETag: "r12"`:
```json
{
  "revision": 12,
  "base_release_version": 4,
  "manifest": { "format": "workspace-manifest/1", "…": "…" },
  "manifest_sha256": "9c1e…",
  "validation": { "ok": true, "errors": 0, "warnings": 1, "findings": [ … ], "validated_at": "2026-10-06T09:12:03Z" },
  "saved_by": "ana@acme.example", "saved_via": "ui", "saved_at": "2026-10-06T09:12:01Z",
  "live_version": 4,
  "differs_from_live": true
}
```
`404 no_draft` → the workspace has never been edited (start from a template or from `GET …/releases/live`).

### 1.2 `PUT /workspaces/{ws}/draft` — save  · grant `edit_draft`

Headers: `If-Match: "r12"` (or `If-Match: "r0"` for the very first save). Body:
```json
{ "manifest": { … }, "note": "renamed stage 2", "validate": true }
```
* Saves a **new revision** (13). An identical manifest returns the current head with `200` and creates nothing.
* `validate: true` (default) runs the validator and stores the report on the revision. **A draft with errors
  can be saved** — drafts are work in progress; only publishing requires `ok`.
* Agents send `X-Client: agent` → `saved_via: "agent"`; the activity log shows who (human or agent) changed what.

`200` + `ETag: "r13"` → same body as 1.1.

| Status | `code` | When |
|---|---|---|
| 409 | `revision_conflict` | someone saved since you loaded. Extras: `head_revision`, `saved_by`, `saved_at`. The client reloads, shows a 3-way diff (`GET …/diff?from=r12&to=r13`), re-applies. |
| 400 | `bad_if_match` | the `If-Match` value is not `"r<number>"` |
| 413 | `manifest_too_large` | > 2 MB |
| 422 | `not_a_manifest` | not a JSON object / wrong `format` |
| 428 | `precondition_required` | no `If-Match` |

### 1.3 `POST /workspaces/{ws}/draft/validate` — validate  · grant `edit_draft`

Body: `{}` (validate the head draft and store the report on it) **or** `{ "manifest": { … } }` (validate an unsaved
manifest; nothing is stored — the configurator's live "Check" button).

`200`:
```json
{ "ok": false, "errors": 2, "warnings": 1, "revision": 13,
  "findings": [
    { "severity": "error", "rule": "R5", "code": "dead_gate", "message": "waits on disabled module 'site_survey'; the gate can never open",
      "path": "modules/1/entry_gate/conditions/0", "module": "fit_out" } ],
  "adapters_checked": true }
```
Always `200` for a well-formed request — validation errors are data, not HTTP errors.

### 1.4 `POST /workspaces/{ws}/draft/reset` — discard edits  · grant `edit_draft`

Body: `{ "to": "live" }` or `{ "to": { "release": 3 } }` or `{ "to": { "template": "acme/site-rollout@1.2.0" } }`.
Needs `If-Match`. Writes a new revision with `saved_via: "reset"` (history keeps the discarded one) → `200` as 1.1.

### 1.5 `GET /workspaces/{ws}/draft/revisions` — draft history  · grant `edit_draft`

`200 { items: [{revision, manifest_sha256, note, saved_by, saved_via, saved_at, validation: {ok, errors, warnings}}], next_cursor }`.
`GET …/draft/revisions/{n}` returns one full revision.

---

## 2. Publish

### 2.1 `POST /workspaces/{ws}/releases` — publish the draft  · grant `publish_release`

```json
{
  "draft_revision": 13,
  "expected_live_version": 4,
  "reason": "Fit-out: finance reviewer signs off the budget",
  "accept_warnings": true
}
```
Steps, in **one transaction**: re-validate revision 13 with the server's adapter registry → refuse on errors, or on
warnings unless `accept_warnings` → `store_publish()` (version 5, previous live → superseded, module projection,
activity) → `201`.

`201`:
```json
{
  "release": { "id": "4c0d…", "version": 5, "manifest_sha256": "9c1e…", "from_draft_revision": 13, "status": "live",
               "reason": "Fit-out: finance reviewer signs off the budget", "published_by": "ops@acme.example",
               "created_at": "2026-10-06T09:20:00Z" },
  "validation": { "ok": true, "errors": 0, "warnings": 1, "findings": [ … ] },
  "modules": [ { "key": "site_survey", "change": "unchanged" }, { "key": "fit_out", "change": "changed" } ],
  "running_cases_on_older_releases": 37,
  "next": { "migrate": "/api/v1/workspaces/acme-retail/migrations" }
}
```

| Status | `code` | When |
|---|---|---|
| 409 | `draft_changed` | revision 13 is not the head (someone saved after you reviewed) |
| 409 | `live_changed` | live is no longer `expected_live_version` |
| 409 | `nothing_to_publish` | the draft equals the live manifest |
| 409 | `warnings_not_accepted` | warnings exist and `accept_warnings` is false; extras: `findings` |
| 422 | `manifest_invalid` | errors; extras: `findings` |

### 2.2 Roll back — `POST /workspaces/{ws}/releases` with `{"rollback_to": 3, "expected_live_version": 5, "reason": "…"}`

Implemented as *reset draft to v3* + *publish* in one transaction → **v6** with `rollback_of_version: 3`. Versions
never go backwards. Running cases stay pinned where they are.

---

## 3. History

### 3.1 `GET /workspaces/{ws}/releases` — release history  · grant `view_audit` or `edit_draft`

`200`:
```json
{ "live_version": 5,
  "items": [ { "version": 5, "status": "live", "manifest_sha256": "9c1e…", "reason": "…", "published_by": "ops@acme.example",
               "created_at": "…", "from_draft_revision": 13, "rollback_of_version": null,
               "warnings": 1, "modules": { "added": 0, "changed": 1, "removed": 0 }, "running_cases": 112 } ],
  "next_cursor": "…" }
```

### 3.2 `GET /workspaces/{ws}/releases/{version}` (or `/live`) — one release

`200 {…item, manifest, validation, imported_from}`. `ETag` = `"v<version>"`; immutable → `Cache-Control: max-age=31536000, immutable`.

### 3.3 `GET /workspaces/{ws}/modules` — the live projection  · any member

`200 { release_version, items: [{key, name, subject, position, enabled, members, delegation, adapter, stage_keys,
introduced_in, changed_in}] }` — what the app shell uses for navigation (replaces `GET /workspace/modules`).

---

## 4. Diff

### 4.1 `GET /workspaces/{ws}/diff?from=<ref>&to=<ref>`  · grant `edit_draft` or `view_audit`

`<ref>` = `v<version>` | `live` | `r<draft revision>` | `draft` (head). Defaults: `from=live`, `to=draft`.

`200`:
```json
{
  "from": { "ref": "v4", "sha256": "…" }, "to": { "ref": "r13", "sha256": "…" },
  "summary": { "modules_added": 0, "modules_removed": 0, "modules_changed": 1, "breaking": 1 },
  "changes": [
    { "path": "modules[fit_out].stages[plan].approvals", "op": "add", "after": { "role": "finance_reviewer", "actions": ["approve", "send_back"] },
      "kind": "approval_tier_added", "breaking": true,
      "impact": "Running fit_out cases at stage 'plan' will need the new tier after migration." },
    { "path": "modules[fit_out].stages[plan].fields[budget].validation.max", "op": "replace", "before": 1500000, "after": 2000000,
      "kind": "field_validation_relaxed", "breaking": false }
  ]
}
```
**Algorithm.** Arrays of objects with a `key` (roles, outcomes, subjects, signals, modules, stages, fields, views,
options by `value`) are matched **by key**, not position — re-ordering is one `move` change, not a cascade. Each change
gets a `kind` from a fixed table, and `breaking: true` when it affects running cases:

| Breaking kinds | Non-breaking kinds |
|---|---|
| `stage_removed`, `stage_reordered`, `field_removed`, `field_required_added`, `field_type_changed`, `field_validation_tightened`, `approval_tier_added`, `approval_tier_removed`, `submit_roles_changed`, `module_subject_changed`, `outcome_removed`, `exit_changed`, `gate_tightened` | `module_added`, `stage_added_at_end`, `field_added_optional`, `field_validation_relaxed`, `label_changed`, `view_*`, `grant_*`, `gate_relaxed`, `module_disabled` (cases close), `role_added` |

The store also exposes the module-level diff in SQL (`store_release_diff(ws, from, to)`), used by the publish
response and the history list without loading manifests into the API.

---

## 5. Migrate running cases

Cases stay on the release they opened on (pinned). Moving them is explicit, reviewed and journalled.

### 5.1 `POST /workspaces/{ws}/migrations` — plan (dry run)  · grant `migrate_cases`

```json
{
  "to_version": 5,
  "from": "all_older",
  "modules": ["fit_out"],
  "stage_map": { "fit_out": { "plan": "plan", "build": "build", "handover": "handover" } },
  "include_idle": false,
  "reason": "Apply finance sign-off to running fit-outs"
}
```
`201` — a **planned** migration; nothing moved:
```json
{
  "id": "6f2a…", "status": "planned", "to_version": 5, "from_versions": [3, 4],
  "plan_sha256": "be41…", "expires_at": "2026-10-06T10:20:00Z",
  "summary": { "cases": 37, "compatible": 35, "incompatible": 2, "closed_skipped": 11 },
  "cases": [
    { "case_id": "…", "module": "fit_out", "subject": { "type": "site", "title": "Site #812" }, "from_version": 4,
      "from_stage": "plan", "to_stage": "plan", "step_after": { "kind": "approve", "role": "finance_reviewer" },
      "compatible": true, "notes": ["new approval tier 'finance_reviewer' will be required"] },
    { "case_id": "…", "module": "fit_out", "from_version": 3, "from_stage": "build", "compatible": false,
      "reason": "submitted value for 'completion_pct' (120) violates the new max (100)" } ]
}
```
Compatibility rules: every from-stage maps to an existing to-stage (`stage_map`, default same key); submitted
values of completed stages validate against the new fields (or are kept as history if the field was removed);
the current step must exist in the new chain (else the case restarts the stage's chain); the case's entry gate
is not re-evaluated (it already opened).

### 5.2 `POST /workspaces/{ws}/migrations/{id}/execute`  · grant `migrate_cases`

```json
{ "plan_sha256": "be41…", "confirm": true }
```
Refused with `409 plan_changed` if the plan's inputs changed since the dry run (a case moved stage, a new
release went live), `410 plan_expired` after 60 minutes, `409 migration_in_progress` if another migration runs
in this workspace. Otherwise `202 {id, status: "running"}`. The runtime then moves **one case per transaction**
(row lock on the case, journal item with before/after state, audit event on the case), heartbeats every case,
and finishes `done` (or `failed` with the journal showing exactly what moved). Incompatible cases are skipped
and listed. A migration is undone by planning a counter-migration from the journal.

### 5.3 `GET /workspaces/{ws}/migrations[?status=]` · `GET …/migrations/{id}` · `GET …/migrations/{id}/items`

History, live progress (`summary.moved`, `summary.remaining`, `heartbeat_at`, `stale`) and the per-case journal.
`POST …/migrations/{id}/cancel` cancels a `planned` migration. A `running` migration without a heartbeat for
10 minutes is marked `failed` by `store_recover_stale_migrations()` (startup + every minute).

---

## 6. Activity

### 6.1 `GET /workspaces/{ws}/activity?since=<seq>&actions=release_published,module_changed`  · grant `view_audit`

`200 { items: [{seq, action, actor, at, draft_revision, release_version, migration_id, module_key, detail, hash}],
chain_valid: true, next_cursor }`. The server re-computes the hash chain over the returned window; any break
→ `chain_valid: false` and an alert.

Actions: `draft_saved`, `draft_reset`, `draft_validated`, `release_published`, `release_rolled_back`,
`release_imported`, `module_added`, `module_changed`, `module_removed`, `module_enabled`, `module_disabled`,
`migration_planned`, `migration_started`, `migration_finished`, `migration_failed`, `migration_cancelled`,
`migration_recovered`.

Webhooks (optional): the same events, POSTed to subscribers with an HMAC signature — this is what replaces
NocoBase's "release → activity" workflow for anything outside the platform.

---

## 7. Endpoint summary

| Method | Path | Grant | Writes |
|---|---|---|---|
| GET | `/workspaces/{ws}/draft` | `edit_draft` | — |
| PUT | `/workspaces/{ws}/draft` | `edit_draft` | `workspace_drafts`, `workspace_activity` |
| POST | `/workspaces/{ws}/draft/validate` | `edit_draft` | validation on the head revision (or nothing) |
| POST | `/workspaces/{ws}/draft/reset` | `edit_draft` | new draft revision |
| GET | `/workspaces/{ws}/draft/revisions[/{n}]` | `edit_draft` | — |
| POST | `/workspaces/{ws}/releases` | `publish_release` | `workspace_releases`, `workspace_modules`, `workspace_activity` |
| GET | `/workspaces/{ws}/releases[/{version}\|/live]` | `view_audit` \| `edit_draft` | — |
| GET | `/workspaces/{ws}/modules` | member | — |
| GET | `/workspaces/{ws}/diff` | `edit_draft` \| `view_audit` | — |
| POST | `/workspaces/{ws}/migrations` | `migrate_cases` | `workspace_release_migrations` (planned) |
| POST | `/workspaces/{ws}/migrations/{id}/execute` | `migrate_cases` | migration status; per case: case state + journal item |
| POST | `/workspaces/{ws}/migrations/{id}/cancel` | `migrate_cases` | status |
| GET | `/workspaces/{ws}/migrations[/{id}[/items]]` | `migrate_cases` \| `view_audit` | — |
| GET | `/workspaces/{ws}/activity` | `view_audit` | — |

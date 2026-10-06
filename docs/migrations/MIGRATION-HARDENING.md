# Release migration hardening plan

Task 13. Make "migrate running cases" safe enough for production when a workflow changes between releases. This is a
design only; no code changes. It hardens the current app toward the target that is already designed. It reuses
these and does not re-design them: the store migration tables (`packages/store/sql/0002_store.sql:129-185`, store
API §5, invariant S5), stage and field keys (manifest **M6**), the `migrate_cases` grant (`docs/rbac/README.md:56,113`),
and runtime findings **RT-F15**, **RT-B14**, **RT-D01**, **RT-D02**, **RT-F10**, **RT-F14**, **RT-D05** and **RT-B04**
(`docs/runtime/HARDENING.md`). The page is `/admin/workspaces/:ws/migrations` (`docs/configurator/NATIVE-BUILDER-PLAN.md:163,224`).
Events follow the shared envelope in `docs/events/EVENT-BUS.md`, which is being written in parallel.

**Files inspected.** All paths are under `app/` unless they start with `packages/` or `docs/`:
`backend/app/services/release_migration_service.py` (`svc:`), `backend/app/services/module_runtime/migrate.py`
(`mig:`), `backend/database/migrations/20261005_1_release_migrations.sql` (`sql:`),
`frontend/src/modules/admin/workspaces/MigrateCasesPanel.jsx` (`panel:`), `frontend/src/modules/admin/adminApi.js`,
`backend/app/routers/platform.py:132-182` (`router:`), `backend/app/services/module_runtime_service.py` (`rts:`),
`backend/app/services/module_runtime/runtime.py` (`rt:`), `backend/database/migrations/20261004_5_generic_module_runtime.sql`
(`mig_5:`), `20261006_1_module_files.sql` (`files:`), tests `backend/tests/test_g3_features.py:182-330`,
`test_f5a_fixes.py:156-260`, `__tests__/MigrateCasesPanel{,.f5a}.test.jsx`; and `packages/store/sql/0002_store.sql`
(`store:`), `packages/manifest/workspace_manifest/from_v5.py`, `packages/store/tests/test_store.py:150-176`.
Claims marked *(probe)* come from running `migrate.plan()` from a scratch directory against the real interpreter.

**Labels:** **bug** (wrong today), **missing feature** (absent), **design decision** (a choice that has to be made
and recorded). **Verdicts:** **migrate** (the case moves; only its release changes and its stages/fields are
re-keyed), **transform** (the case moves with listed state or data changes), **skip** (by design the case stays on
its release with nothing to fix), **block** (moving would corrupt the case; it stays on its release until an admin
supplies a mapping or option).

## 1. Current migration behavior

| Step | What happens | Where |
|---|---|---|
| Request | `POST /platform/workspaces/{ref}/migrations` with `{from_release_version \| all_older, to_release_version?, scope, reason?, dry_run=true, stage_map {module: {"<order>": order\|null}}, restart_stage_on_chain_change, include_idle_sites}`. Platform admin only | `router:145-171` |
| Resolve | `to` defaults to the release that is live **when the request is processed**. Only `from == to` is refused, so a **downgrade** (from v5 to v3) is accepted | `svc:100-123` (`:104-108`, `:118-120`) |
| Plan | Per record: source runtime from its own release, target runtime from the target release, then `migrate.plan()`. All in-flight records on a touched site are planned together. A record on another release or with a pin mismatch blocks | `svc:175-193`, `:220-248` |
| Stage mapping | explicit (by **order**) → `same` (order and name) → `by_name` (unique name) → `by_order` → unmapped | `mig:49-71` |
| Compatibility | current stage mapped; completed stages injective and before it; mid-stage chain prefix kept, or restart if opted in. Everything else is a warning | `mig:88-138`, `:181-227` |
| Data | values re-keyed to target orders; fields missing in the target are dropped from the live state; a changed field kind is carried unchanged with a warning; verdicts of unmapped stages are dropped | `mig:141-161`, `:223-224` |
| Unit | **site**: one transaction per site. The site row and then its records are locked `FOR UPDATE`, re-planned under the locks, and if any case is incompatible the whole site is skipped (`site_blocked`). Out-of-scope modules on the site are `co_migrated` | `svc:251-255`, `:284-310` |
| Write | journal (site item, then record items with full `before_state`/`after_state`) → site pin → record (`release_id`, `runtime_state`) → `module_stage_states` upsert → provenance audit per record and per site. The pin triggers accept a move only when an item authorises it under `matrix.release_migration` | `svc:324-387`, `sql:186-313` |
| Event | one hash-chained `release_migrated` event appended to the case chain; `seq` increases by 1 | `mig:230-240` |
| Concurrency | advisory lock plus a check for a "live running header" before the header insert; heartbeat after every site; a header with no heartbeat for 600 s is failed on startup or on the next execute; the DB refuses items for a header that is not running | `svc:58-63`, `:398-457`, `:622-634`; `sql:148-151`, `:197` |
| Dry run | computes everything, writes nothing and **stores nothing**. Execute is a new request that **re-plans from parameters** | `svc:602-620`, `:622-639` (RT-F15) |
| UI | form → dry-run table (outcome pill and server `message` strings) → reason (at least 3 chars) → confirm → execute **re-sends the parameters**; history shows the last 5 runs | `panel:55-72`, `:129-146`, `:182-207` |

**Bugs and gaps found in the current code.** The IDs are used again in §2 and §10.

| ID | Label | Finding | Evidence |
|---|---|---|---|
| MH-B01 | bug | **`by_order` fallback silently mis-binds.** Rename "Legal"→"Legal review" and insert "Survey" before it: completed "Legal" maps to "Survey" (`by_order`), its values land there, and the real "Legal review" is skipped. The plan is `compatible: True` *(probe)*. A split ("Legal"→"Legal A"+"Legal B") behaves the same way *(probe)* | `mig:67-68` |
| MH-B02 | bug | An explicit `stage_map` entry pointing at a target that does not exist becomes "unmapped" without any error. `{"2": 99}` on a completed stage gives `compatible: True` and silently archives its values *(probe)* | `mig:60-62` |
| MH-B03 | bug | **A field-kind change carries the raw value.** text `"x"` → number stays `"x"` with only a `field_kind_changed` warning *(probe)*. Target validation (min/max/options) is never checked | `mig:152`, `:158-160` |
| MH-B04 | bug | **Stage projections are corrupted on renumbering.** `_write_stage_rows` upserts only the target's orders. Rows for orders the target lacks keep their old status and name. Append-only `module_approvals` stay FK-bound to `(record, stage_order)`, so after a reorder their history shows up under a **different** stage | `svc:260-281`; `mig_5:189-190` |
| MH-B05 | bug | Files are not re-keyed (= **RT-B14**). `module_files.stage_order` is append-only, so a file uploaded before a renumbering fails `_check_file_values` on resubmit | `files:34,85`; `rts:957-971` |
| MH-B06 | bug | **The executed plan is not the reviewed one.** Execute re-plans, and when `to_release_version` is omitted the target is live at execute time. A release published between the dry run and the execute changes the target (the panel sends `to` explicitly, but API clients may not) | `svc:104-108`, `:622-639`; `panel:55-63` |
| MH-B07 | bug | `_finish` updates the header with no `status='running'` guard. If the header was recovered meanwhile, the trigger raises, the API returns 500 after the sites committed, and `_mark_failed` does nothing | `svc:691-697`; `sql:119-121` |
| MH-B08 | bug | Lock waits are unbounded (`FOR UPDATE`, no `lock_timeout`). A user transaction that is stuck stalls a site for longer than `STALE_AFTER_SECONDS`, so a live run is marked failed and a second run can start. The DB fences the later items (`sql:148`), so the effect is noisy failures, not corruption | `svc:164`, `:290`; `:398-433` |
| MH-B09 | bug | `expected_seq` is optional on case actions (= **RT-F14**). An action queued behind the migration's row lock runs against the **migrated** state, which the user never saw | `rts:466-468`; `routers/module_runtime.py:49` |
| MH-B10 | bug | An upload computes its stage outside any lock and inserts later, so during a migration the file lands on the old stage order | `rts:862-903` |
| MH-B11 | missing feature | Changes to roll-ups and gates (entry and stage) are never compared. A roll-up strategy change gives no warning at all *(probe)* | `mig:181-227` |
| MH-B12 | bug | Parked cases (roll-up pending) are `not_in_flight` and cannot be migrated, although a hot-fix is the obvious way out (= **RT-F10**) | `mig:42`, `:194-196` |
| MH-B13 | design decision | **Site atomicity.** One incompatible case blocks every case on the site, and out-of-scope modules move along with it. This follows from the site pin (**RT-D02**) | `svc:243-255`, `:304-310` |
| MH-B14 | bug | A new stage inserted **before** the current one is bypassed with only a warning. A hot-fix that adds a control does not apply it to running cases | `mig:130-134` |
| MH-B15 | missing feature | No revert. `svc_get_migration` does not even return `after_state` | `svc:743-746` |
| MH-B16 | bug (UI) | `key={b.code}` produces duplicate React keys when a site has several `site_blocked` issues. The UI shows only server messages; reason codes are not mapped; `stage_map`, `kind_changed` and `new_required` are not shown | `panel:202`, `:189-198` |
| MH-B17 | bug (store) | `store_migration_guard` accepts `OLD.status = NEW.status` for **every** status, so a `done`/`failed` row can still change `summary`/`heartbeat_at`/`error`. An executor that was recovered but is still alive is not fenced | `store:251-256` |
| MH-B18 | missing feature | No domain events (`release.migration.*`, `module.record.migrated`); only audit rows | `svc:362-387` |

## 2. Missing safety cases

| # | Case | What happens today | Required behaviour | Verdict (reason code) | Label |
|---|---|---|---|---|---|
| 1 | **Stage deleted** | Current stage: `stage_missing` blocks (`mig:92-95`). Completed stage: warning, values dropped from the live state (`mig:97-103`, `:147-149`). With an insert at the same order, `by_order` mis-binds (MH-B01) | Current stage: block unless `stage_map` names a target key. Completed stage: archive its values in `state.archived` and the journal, keep its outcome in `reached` (§5.6) | current: **block** `stage_unmapped` / with map: **transform** `stage_remapped`; completed: **transform** `completed_stage_archived` | bug (B01) + missing feature |
| 2 | **Stage renamed** | Same order: `by_order`; moved: `by_name` (`mig:63-68`). A rename combined with a reorder mis-binds (MH-B01) | Identity is the stage **key** (M6). A name-only change is invisible and the case migrates. A key change is a rename only through lineage or `stage_map` (§4.2); otherwise it counts as delete + add | name only: **migrate** (`stage_renamed`, info); key via hint: **transform** `stage_remapped`; key without hint: **block** `stage_unmapped` | bug |
| 3 | **Stage split** | `by_order` sends the case to the first part and silently skips the second (*probe*, MH-B01) | A split must be declared: `{"legal": {"split": ["legal_a","legal_b"], "land": "legal_a"}}`. Current stage → `land`, at step 0 when the chain differs. A completed split stage → the first part is completed, and the other parts need `allow_skip_stages` | with hint: **transform** `stage_split`; without: **block** `stage_split_ambiguous` | missing feature |
| 4 | **Stage merged** | Two sources mapping to one target: `mapping_not_injective` blocks (`mig:106-107`) | A declared merge (several source keys → one target key) is allowed. Completed+completed → the merged stage is completed. Completed+current → current = merged stage, restarted at step 0 (`restart_stage` required). The same field key from two sources → block | **transform** `stage_merged` (+`stage_restarted`); collision: **block** `field_collision` | missing feature |
| 5 | **Field deleted** | Value dropped from the live state, kept in the journal (`mig:152-156`); warning `fields_dropped` | Same, plus `state.archived[stage_key][field_key]` so the case page shows it read-only. If a gate in the target reads this field fact, warn `field_fact_removed` | **transform** `field_archived` | missing feature (visibility) |
| 6 | **Field renamed** | Treated as delete + add: the value is dropped and `new_required_field` is raised (*probe*) | Detected only through a stable key (a label change is not a rename) or through `field_map` / lineage (§4.2). The value moves and is validated against the target type | with hint: **transform** `field_renamed`; without: **transform** `field_archived` + `new_required_field` | missing feature |
| 7 | **Field type changed** | Raw value carried; warning only (MH-B03) | Conversion matrix in §5.2: lossless → convert; value valid under the target type and validation → keep; otherwise block. Never coerce silently | **migrate** / **transform** `field_converted`; **block** `field_value_invalid` / `field_type_incompatible` | bug |
| 8 | **Approver tier changed** | Mid-stage prefix change → `chain_changed_mid_stage` blocks, or restart if opted in; otherwise warning (`mig:114-129`) | Keep the rule. Add `pending_approver_changed` when the **next** tier differs (*probe*: exec→sup became exec→BA and the case silently waits for BA). Completed stages are history only | step 0: **migrate** `chain_changed`; prefix kept: **transform** `pending_approver_changed`; prefix broken: **block** `chain_changed_mid_stage` or **transform** `stage_restarted` | missing feature |
| 9 | **Gate changed** | Never compared (MH-B11) | Entry gate: not re-evaluated for an open case (**RT-D05**, store API §5.1); warn `gate_changed`. Stage gate of the target current stage: evaluated now against facts; if it is closed, warn `stage_gate_closed` (the case waits, nothing is corrupted). Gates of **other** modules that read this case are protected by §5.6 | **migrate** + warning | missing feature |
| 10 | **Roll-up changed** | Never compared (MH-B11) | Compare strategy, n, limit and scored fields. A scored field in an already **completed** stage with no valid value → block (the case would park or reject wrongly). Otherwise warn and show the predicted verdict under the target roll-up | **transform** `rollup_changed`; **block** `rollup_input_missing` | missing feature |
| 11 | **Module disabled** in target | `module_disabled_in_target` blocks the record, and the whole site with it (`mig:200-202`, MH-B13) | The record stays on its source release, where the module is enabled, and finishes there (the access guard uses the pinned release, rbac README:116). Per record, not per site | **skip** `module_disabled_in_target` | design decision (B13) |
| 12 | **Module removed** in target | `module_not_in_target` blocks, plus the site (`mig:197-199`) | As for #11 | **skip** `module_not_in_target` | design decision |
| 13 | **Record already completed** (or rejected) | `not_in_flight`; listed and not touched (`mig:194-196`). **Parked** cases are wrongly in the same group (MH-B12) | Completed/rejected: skip. Parked: in flight; migrate it and leave it parked; it is resolved later by `resolve` (**RT-F10**) with the target roll-up. A migration never advances a case | **skip** `case_closed`; parked → **migrate** | bug (B12) |
| 14 | **Record currently in approval** (step > 0) | Re-planned under the site lock; tier-prefix rule. User actions queued behind the lock run on the new state when `expected_seq` is absent (MH-B09) | Rule #8, plus an optimistic check: plan-time `seq`+`last_hash` must equal the values under lock, else skip. The migration bumps `seq`, so a client holding the old seq gets `409 stale`. `If-Match` becomes mandatory (**RT-F14**) | as #8; drift: **skip** `record_changed_since_plan`; lock busy: **skip** `record_busy` | bug (B09) |
| 15 | **Migration interrupted** | Per-site commits; heartbeat; failed by recovery after 600 s; journal shows what moved (`svc:398-433`). `_finish` can 500 (MH-B07); long lock waits look stale (MH-B08) | One case per transaction, with journal, outbox and activity in that same transaction. The header is fenced (§7). Recovery → `failed` + `release.migration.failed`. Resume = **plan again** with `resumes_migration_id`; moved cases are now `already_on_target`. A failed plan can never be re-executed | moved: done; rest: **skip** `migration_aborted` → re-plan | bug (B07, B08) |
| 16 | **Two migrations started together** | Advisory lock plus a live-header check → `409 migration_in_progress` (`svc:625-629`). Dry runs are not locked. A stale threshold can let a second run start (MH-B08) | `uq_wrm_one_running` (`store:165`) plus the advisory lock. Executing a plan whose global inputs changed (live release, any release published since planning, another migration finished since planning) → `409 plan_changed`. Records moved by the other run → per-record `record_changed_since_plan` | second execute: **block** (409); overlapping records: **skip** | missing feature |

**Further gaps** (not one of the 16 cases): the plan is not frozen and not hashed (MH-B06, **RT-F15**); the execute
reason is only checked when the dry run is skipped (`svc:581-585`), and there is no reason on the plan; there is no
revert (MH-B15); there are no events (MH-B18); downgrades are accepted silently (`svc:118-120`, design decision:
forward only, going back = revert §6); a newly inserted earlier stage is bypassed (MH-B14, design decision: block
unless `allow_skip_stages` lists it).

## 3. Compatibility rules

**3.1 Plan-level preconditions.** These are checked at plan time and again at execute time. Each failure refuses the whole request:

| Rule | Refusal |
|---|---|
| Caller holds `migrate_cases` (`cases.migrate`) | 403 `not_granted` |
| Target release exists in this workspace; every source version is lower than the target (revert plans excepted, §6) | 404 `unknown_release`, 422 `target_not_newer` |
| `to` is resolved **at plan time** and frozen into the plan; omitted = the live release then | — |
| Every `stage_map`/`field_map` key and value exists in its release (MH-B02) | 422 `stage_map_invalid` / `field_map_invalid` with a JSON pointer |
| Plan reason 3–500 chars (`store:157`) | 422 `reason_required` |
| Execute: `plan_sha256` equals the stored hash; status `planned`; younger than 60 min; the live release id, the source and target `manifest_sha256` and the "last migration finished" marker are unchanged | 409 `plan_hash_mismatch`, 409 `bad_transition`, 410 `plan_expired`, 409 `plan_changed` |
| Execute: reason 3–500 chars and `confirm: true` | 422 `reason_required` |
| No other migration is `running` for the workspace | 409 `migration_in_progress` |

**3.2 Record verdict procedure.** The first matching rule wins. The codes are listed in §3.3.
1. Out of scope or already on the target → **skip** (`already_on_target`).
2. Status `completed`/`rejected` → **skip** `case_closed`. `parked` counts as in flight (#13).
3. Module absent or disabled in the target → **skip** (#11, #12).
4. Integrity: `state.release` equals the pinned release (`svc:188-191`), and `verify_chain(head=state.last_hash, seq)` passes (**RT-B09**). Otherwise **block** `state_release_mismatch` / `chain_integrity_failed`.
5. Stage mapping (§4). Any failure → **block**.
6. Data mapping (§5). Any value that would be corrupted → **block**.
7. Otherwise **migrate**, or **transform** if any transform code is present. The plan stores `new_core` and the codes.
At execute: lock acquired, else **skip** `record_busy`. `seq`/`last_hash` equal the plan, else **skip** `record_changed_since_plan`. The header is still `running`, else **skip** `migration_aborted`.

**3.3 Reason-code catalogue.** These are stable API codes. The UI maps every code to a message and fix hint (§8). The server also sends `message` with parameters as a fallback.

| Code | Verdict | Message (parameters) | Fix hint |
|---|---|---|---|
| `case_closed` | skip | Case is {status}; finished cases keep the release they finished on | — |
| `already_on_target` | skip | Already on v{to} | — |
| `module_not_in_target` | skip | {module} is not in v{to}; the case finishes on v{from} | — |
| `module_disabled_in_target` | skip | {module} is switched off in v{to}; the case finishes on v{from} | — |
| `record_changed_since_plan` | skip | Someone acted on this case after the dry run (seq {plan_seq} → {seq}) | Plan again |
| `record_busy` | skip | The case was being edited during the move (lock wait > 2 s) | Plan again |
| `migration_aborted` | skip | The migration stopped before this case | Plan again (resume) |
| `stage_unmapped` | block | Current stage “{stage}” has no counterpart in v{to} | Map it in Stage mapping |
| `stage_map_invalid` | block | Mapping names stage “{key}”, which v{to} does not have | Fix the mapping |
| `stage_split_ambiguous` | block | “{stage}” was split into {keys}; choose where running cases land | Declare a split |
| `mapping_not_injective` | block | Two stages of the case land on “{target}” without a declared merge | Declare a merge |
| `mapping_not_monotonic` | block | A completed stage would land on or after the current stage | Fix the order of the mapping |
| `skips_required_stage` | block | New stage “{stage}” comes before the current one and would be bypassed | Allow the skip, or map the case to an earlier stage |
| `chain_changed_mid_stage` | block | Approval already started ({passed}); chain changed {from} → {to} | Enable “restart stage” |
| `field_value_invalid` | block | “{field}” = {value} breaks v{to}: {rule} | Correct it on v{from} first, or map the field elsewhere |
| `field_type_incompatible` | block | “{field}” changed {from_type} → {to_type}; no safe conversion | Map the field, or let the case finish on v{from} |
| `field_map_invalid` | block | Field mapping names an unknown field “{key}” | Fix the mapping |
| `field_collision` | block | Merge puts two values on “{field}” | Map one of them elsewhere |
| `rollup_input_missing` | block | Roll-up of v{to} scores “{field}”, which has no valid value on a finished stage | Let the case finish on v{from} |
| `file_link_unresolvable` | block | File {file} of “{field}” has no field to attach to in v{to} | Map the field |
| `state_release_mismatch` | block | The case state does not belong to its pinned release | Investigate (data integrity) |
| `chain_integrity_failed` | block | The case's audit chain does not verify | Investigate (data integrity) |
| `stage_renamed`, `stage_remapped`, `stage_split`, `stage_merged`, `stage_restarted`, `completed_stage_archived`, `field_archived`, `field_renamed`, `field_converted`, `new_required_field`, `chain_changed`, `pending_approver_changed`, `gate_changed`, `stage_gate_closed`, `field_fact_removed`, `rollup_changed`, `reached_kept`, `sla_recomputed`, `files_relinked`, `delegation_changed`, `creator_rule_changed` | migrate / transform (info) | One line each, naming the stage or field and its before/after | — |
| `revert_window_expired`, `revert_case_changed`, `revert_superseded`, `revert_not_moved` | skip (revert only, §6) | — | — |

The current codes are renamed as follows: `stage_missing`→`stage_unmapped`, `not_in_flight`→`case_closed`,
`site_blocked`/`other_release`/`inconsistent_pin`/`changed` are dropped with per-case pinning, and
`completed_stage_dropped`→`completed_stage_archived`.

## 4. Stage mapping rules

**4.1 Identity.** A stage is identified by `(module_key, stage_key)` (M6, **RT-D01**). Order is only a position.
Names and labels never decide identity.

**4.2 Resolution order**, for each source stage key:

| # | Source | Rule |
|---|---|---|
| 1 | **Explicit** `stage_map[module][src_key]` | `tgt_key` \| `null` (drop; only for completed stages) \| `{"split": [k…], "land": k}`. Several source keys → one target = declared merge. Validated (MH-B02) |
| 2 | **Lineage** | the target release's `lineage` block (below) says `src_key` was renamed to `tgt_key`, or split/merged |
| 3 | **Same key** | `tgt_key == src_key`, **unless** either release came from `from_v5` (keys `s{order}`, `from_v5.py:141`, are positional, not identities). For those, same key **and** same normalised name is required; otherwise unmapped plus a *suggestion* |
| 4 | **Unmapped** | a completed stage is archived; the current stage is blocked. Name or order matches are only **suggested** in the UI, pre-filled into `stage_map` for the admin to confirm. `by_name`/`by_order` (`mig:65-68`) are never applied automatically |

**How renames become detectable.** A key change looks exactly like delete + add, so it can only be known from a
stable key or a recorded hint. (a) The builder's `renameKey` (NATIVE-BUILDER-PLAN:185) on a stage or field key
that exists in the **live** release adds `{kind, module, from, to}` to the draft's `lineage`. Publish freezes it into
the release manifest as `migration_hints: {module: {stages: {old: new | {split: […]}}, fields: {"stage.old": "stage.new"}}}`
(it is part of the release hash, so it is immutable). (b) An explicit `stage_map`/`field_map` in the plan always
wins. (c) Lineage spans several releases: from v3 to v5, the v4 and v5 hints are composed.

**4.3 Invariants checked on the whole mapping** (on top of `mig:106-110`):
- The current stage maps to exactly one target stage (`land` for a split).
- Completed stages map strictly before the current target stage (monotonic). Injectivity applies except for declared merges.
- Every target stage before the current target that no completed stage maps onto is a stage the case would skip. That is a block (`skips_required_stage`, MH-B14) unless the plan option `allow_skip_stages: {module: [keys]}` lists it. Then it becomes a transform: the stage is recorded `skipped` with the migration as cause, and `reached` does not gain its outcome.
- Restarted or merged current stage: step 0, `pass=[]`, values kept as the stage's draft; earlier approvals stay in history, marked `superseded_by_migration`.

**4.4 Approval chain at the current stage.** Step 0 → migrate (`chain_changed` when it differs). `step > 0`: the
target chain must start with the tiers already passed and still have a step left. Then the case moves, with
`pending_approver_changed` when the next tier differs. Otherwise block, or restart if `restart_stage` is set
(`mig:120-127`). Delegation and creator-rule changes stay as warnings (`mig:135-137`, `:214-215`).

**4.5 Projections.** Projections are re-keyed by stage key, never upserted by order (fixes MH-B04).
`case_stage_states` rows of the target are written. Source rows that have no target are marked `archived`.
Approvals are history rows keyed `(case, stage_key, release_id)` and are never re-pointed. The case page shows
history grouped by the release it happened on.

## 5. Data mapping rules

**5.1 Field identity** = `(stage_key, field_key)`. `field_map[module]["stage.old"] = "stage.new"` (or lineage)
moves a value, including across stages. With no map and no same key, the value is archived (#5/#6).

**5.2 Type conversion matrix.** The type sets come from the manifest (`$defs/field.type`). After conversion, every
kept value is validated with the **target** field's typed validation (M5: min/max, regex, options, currency, accept).

| From → To | Rule | Verdict |
|---|---|---|
| same type | validate against the target constraints | migrate / block `field_value_invalid` |
| `text` → `long_text` | identity | transform `field_converted` |
| `long_text` → `text` | allowed if the length fits | transform / block |
| `number` → `money` | wrap `{amount, currency}` only when the target has exactly one currency | transform / block |
| `money` → `number` | allowed if the currency matches the source's single currency | transform / block |
| `choice` → `multi_choice` | `[v]` when `v` is among the target options | transform / block |
| `multi_choice` → `choice` | allowed if the list has exactly one element | transform / block |
| `yes_no` ↔ `choice` | allowed only through an explicit `outcome_map`/option mapping in `field_map` | transform / block |
| `text` → `number`/`date`/`choice`/`person` | parse strictly; any failure → block (no guessing) | transform / block |
| anything ↔ `file` | never | block `field_type_incompatible` |
| any → removed | archive (#5) | transform `field_archived` |

**5.3 Required fields.** A target field that becomes required on an already **submitted** stage is not asked
again (warning `new_required_field`), as today (`mig:164-169`). The plan option `require_backfill` turns this into a block.

**5.4 Approvals and verdicts.** Verdicts move with their stage key. A dropped stage's verdicts go to `state.archived`
and are no longer silently lost (`mig:223-224`). Approval rows are never rewritten (§4.5).

**5.5 Roll-up.** If a scored field (`rollup.fields`, "stage.field") of a **completed** stage has no valid value →
block `rollup_input_missing`. Otherwise, if the strategy, n, limit or field set changed → `rollup_changed` with
`predicted_verdict` under the target roll-up. A parked case stays parked (#13).

**5.6 `reached` is cumulative** (**RT-B04**). `after.reached = before.reached ∪ target_reached(new_core)`. An
outcome from a now-archived stage stays (`reached_kept`). That way no downstream gate of another module flips
because of a migration, and other modules' cases are never touched.

**5.7 Files** (fixes **RT-B14** / MH-B05). Under the store design, files are referenced **by id** from
`state.values`. The binding to a field lives in `state.files {file_id: {stage_key, field_key}}`, which the
migration re-keys with the field mapping (`files_relinked`). `module_files` stays append-only provenance
("uploaded under v{from}, stage x"). The file check (`rts:957-971`) validates against `state.files`, not
`module_files.stage_order`. Unsubmitted uploads on the current stage are re-linked the same way. A file whose
field has no target → block `file_link_unresolvable`. Uploads take the case lock and `If-Match` (fixes MH-B10).

**5.8 Timers / SLA.** The app has no timers today. The target stage has `sla_hours` (manifest `$defs/stage`).
Rule: keep the stage `entered_at`. `due_at = entered_at + target.sla_hours`; a restart resets `entered_at`
(`sla_recomputed`). Scheduled reminders and escalations carry `(case_id, stage_key, seq)` and fire only if the
case still has that `seq`, so pending timers from before the move go stale automatically and are re-scheduled in
the migration transaction.

**5.9 Before/after state.** The journal item `workspace_release_migration_items` (`store:170-185`) stores the full
`before_state` and `after_state`. It is extended with: `verdict`, `reason_codes text[]`,
`before_seq`/`after_seq`, `before_last_hash`/`after_last_hash`, `mapping jsonb` (stage and field mapping applied,
conversions), `files jsonb` (re-links), `reverts_item jsonb` (revert only). `outcome` adds `blocked`,
`skipped_changed`, `skipped_busy`, `reverted`. Skipped and blocked records get an item too (with `after_state` =
`before_state`), so the journal explains every candidate.

**5.10 Events** (outbox row in the same transaction as the change; envelope per EVENT-BUS.md):

| Type (owner) | When | `record_id` / `subject` | Payload |
|---|---|---|---|
| `release.migration.started` (ours) | `planned→running` transaction | null / `{type: workspace}` | `{migration_id, kind: forward\|revert, plan_sha256, from_versions, to_version, counts, plan_reason, execute_reason}` |
| `module.record.migrated` (ours) | each moved case | case id / the case's subject | `{migration_id, verdict, reason_codes, before: {release, stage_key, step, status, seq, last_hash, reached}, after: {…same}, values_changed: [stage.field…], journal_item}`. Full values stay in the access-controlled journal |
| `release.migration.completed` (shared) | `running→done` | null | `{migration_id, counts by outcome, duration}` |
| `release.migration.failed` (ours) | error or stale recovery | null | `{migration_id, error, moved_before_failure}` |

Envelope: `release` = the **target** `{id, version}`; `actor` = `{id, kind: user}` of the executor (the system
for a recovery); `correlation_id` = migration id; `causation_id` = the `started` event id;
`idempotency_key` = `migration:{id}:case:{case_id}` (or `:started`/`:completed`/`:failed`). `stage_key` = the target stage.

## 6. Rollback strategy

| Aspect | Rule |
|---|---|
| Mechanism | **Revert = a counter-migration** (`kind: revert`, `reverts_migration_id`) planned from the journal. It is not a DB rollback and not a chain rewrite. For each `moved` item, `new_core = before_state` core, the target is the item's `from_release_id`, and a chained `release_migration_reverted` event is appended (seq goes on increasing) |
| Same pipeline | Dry run is mandatory, plan hash, reason, `confirm`, per-case transaction, journal, events (`module.record.migrated` with `revert_of`) |
| Window | `revert_window` (default 7 days, per workspace) from the migration's `finished_at` |
| Refused per case | `revert_case_changed`: `seq`/`last_hash` ≠ the item's `after_*` (someone acted; the before-state would erase their work); `revert_superseded`: a later migration moved the case; `revert_not_moved`: the item was skipped or blocked; `revert_window_expired`. Files uploaded or timers fired since then always raise `seq`, so they fall under `revert_case_changed` |
| Refused as a whole | the migration is `planned`/`running`/`cancelled`; it is itself a revert (reverting a revert is not allowed: plan a forward migration instead); 403 without `migrate_cases` |
| After the window or for a changed case | a normal **forward** plan to the old release is not allowed (`target_not_newer`). Publish a new release that restores the old flow (store `rollback_of_version`) and migrate forward onto it with mappings |
| Release rollback ≠ case rollback | `store_publish(..., p_rollback_of)` changes the live release only and never moves cases |

## 7. Locking/concurrency strategy

**Unit = one case per transaction** (store API §5.2, **RT-F15**), replacing the site batch (MH-B13). Batching per
site existed only because of the site pin; with the pin on the case (**RT-D02**) it holds unrelated cases hostage.
Per-case transactions keep locks short, make progress visible, and make an interruption harmless. The price is
that cases of one subject can sit on different releases for a moment, which the per-case pin allows by design.

**Execute sequence:**
1. One transaction: advisory lock `migration:{ws}`; `planned→running` (`uq_wrm_one_running` is the backstop); check §3.1; set `execute_reason`, `executed_by`, `started_at`; emit `release.migration.started`.
2. For each plan item, in stable order (case id), one transaction:
   `SET LOCAL lock_timeout = '2s'` → `SELECT … FROM workspace_release_migrations WHERE id=$m FOR SHARE` (fence: recovery's `UPDATE` waits, and a non-`running` header gives `migration_aborted` and a stop) → `SELECT … FROM cases WHERE id=$c FOR UPDATE` (timeout gives `record_busy`) → compare `seq`/`last_hash`/`release_id` with the plan (optimistic version check) → `SET LOCAL app.release_migration=$m` (the pin guard, as in `sql:186-205`) → write case state, stage projections, file links, timers, journal item, activity, outbox event → commit.
3. Heartbeat (its own small transaction) every 50 cases or every 5 s, whichever comes first, so a slow lock never looks stale (fixes MH-B08). `p_stale` (10 min) is ≫ `lock_timeout`.
4. `running→done` with `WHERE status='running'`; 0 rows → report `failed` (fixes MH-B07); emit `completed`.
5. Any exception → `running→failed` (guarded) + `release.migration.failed`.

| Concern | Mechanism |
|---|---|
| User action vs migration on the same case | Both take `FOR UPDATE` on the case row. The migration bumps `seq`. `If-Match: "s<seq>"` is **mandatory** on actions, assign and upload (**RT-F14**; today optional, MH-B09), so a stale client gets `409 stale` and reloads onto the new release |
| Case changed between dry run and execute | per-case `seq`+`last_hash` check → `record_changed_since_plan` (skip, never a re-plan inside execute) |
| Global drift | live release / source and target `manifest_sha256` / last finished migration fingerprint in the plan → `409 plan_changed` |
| Two executes | advisory lock + `uq_wrm_one_running` → `409 migration_in_progress` |
| Recovered but still-alive executor | header `FOR SHARE` fence + the pin guard requires `status='running'` (as `sql:197`) + **store guard fix**: terminal rows are frozen (fixes MH-B17: allow `OLD.status = NEW.status` only while `running`) |
| Deadlocks | the migration locks header (share) then one case; actions lock one case; no path locks two cases |
| Idempotency | repeating execute on the same plan → `409 bad_transition` (status not `planned`). Resuming = a new plan; moved cases are `already_on_target`; outbox `idempotency_key` per case |

**Interim, while the app still pins on sites** (before `0003_runtime.sql`): keep the per-site transaction, but
apply fixes for MH-B01–B04, B06–B08, B11, B14 and B16. Store the dry run in `module_release_migrations` with status
`planned` and `plan_sha256` (new columns, mirroring `store:132-162`), and execute only `{migration_id, plan_sha256, reason}`.

## 8. UI changes

`MigrationsPage` at `/admin/workspaces/:ws/migrations` replaces `MigrateCasesPanel` (NATIVE-BUILDER-PLAN:163) and
uses the store API (`POST …/migrations`, `…/{id}/execute|cancel|revert`, `GET …/{id}/items`).

| Step | Shows / does |
|---|---|
| 1 Configure | from/to (only newer targets), modules, options (`restart_stage`, `allow_skip_stages`, `require_backfill`, `include_idle`), **plan reason** (required) |
| 2 Mapping | per module, a source→target stage table with how each was resolved (key / lineage / explicit / **suggested** / unmapped). Suggestions must be accepted before they apply. Split and merge editors; a field-map table for archived or new fields. Pre-filled from `migration_hints` |
| 3 Dry run | stored plan: id, `plan_sha256` (short), expiry countdown, counts per verdict. A per-case table: subject, module, v{from}→v{to}, stage before→after (keys and names), step and pending approver before→after, **verdict pill + every reason code as a message from the catalogue (§3.3) with its fix hint**, expandable before/after diff (values, archived, converted, files, SLA). Filters by verdict and by code; "Fix" links jump to step 2 |
| 4 Execute | only from a `planned`, unexpired plan: shows the plan reason, **execute reason** (required, 3–500), typed confirmation `MIGRATE <n>`. Sends `{plan_sha256, reason, confirm: true}`. `409 plan_changed` / `410` → "plan again" with the same inputs |
| 5 Progress / result | polling: moved / skipped / remaining, heartbeat age, stale badge; result table with the same code→message rendering; link to the journal |
| History | all migrations with status, kind (forward/revert), reasons, actor; per migration the journal items with before/after; **Revert…** (dry run first) while inside the window, with per-case revert verdicts |

The catalogue lives in `frontend/src/modules/admin/migrations/reasonCodes.js` as `{code: {verdict, message(params), hint}}`.
An unknown code falls back to the server `message`. Fixes in the current panel are covered by the replacement:
duplicate keys (`panel:202`), parameter re-send (`panel:55-72`), the missing `stage_map` editor, and the missing
`kind_changed`/`new_required` details (`panel:195-198`). Pages hide what the principal cannot do (`migrate_cases`),
and the API refuses it anyway.

## 9. Tests to add

| File | Test | Asserts |
|---|---|---|
| `backend/tests/test_migration_mapping.py` (pure) | rename+insert (probe 1), split (probe 9), bogus explicit (probe 4) | no `by_order` auto-binding: `stage_unmapped` / `stage_split_ambiguous` / `stage_map_invalid`; suggestions are listed but not applied |
| same | key-stable rename; lineage rename; v5-converted `s{order}` with a changed name | migrate / transform `stage_remapped` / unmapped+suggestion |
| same | declared merge (completed+completed, completed+current), field collision | `stage_merged` + restart; `field_collision` block |
| same | inserted earlier stage with and without `allow_skip_stages` | block `skips_required_stage` / transform with a `skipped` row |
| `test_migration_data.py` (pure) | every cell of the §5.2 matrix, including text→number `"x"` (probe 2) and file↔text | conversions exact; invalid → `field_value_invalid`; never coerced |
| same | field rename via `field_map`; field deleted; new required field ± `require_backfill` | value moved and validated / archived / warning vs block |
| same | roll-up change with a missing scored value; strategy change (probe 6) | `rollup_input_missing` block; `rollup_changed` + predicted verdict |
| same | `reached` cumulative after archiving a completed stage | `after.reached ⊇ before.reached` |
| same | tier change at step 0, step>0 prefix kept (probe 10), prefix broken ± restart | codes as in §2 #8 |
| same | parked case; completed; module removed/disabled | migrate (stays parked) / `case_closed` / per-record skip (no site cascade) |
| `test_migration_execute.py` (DB) | execute without a plan, wrong `plan_sha256`, expired plan, a new release published since the plan, missing execute reason | 404/409 `plan_hash_mismatch`/410/409 `plan_changed`/422 |
| same | case acted on between plan and execute; a case row locked by another connection | `record_changed_since_plan`; `record_busy` after ≈2 s; other cases move |
| same | every moved case has a journal item with before/after, `before_seq+1 = after_seq` and a verifying chain; skipped/blocked cases have items too | journal completeness |
| same | kill after N cases → recovery → re-plan | N moved, `failed` + event, re-plan lists them `already_on_target`; re-execute of the failed plan → 409 |
| same | two concurrent executes; a recovered-but-alive executor | one 409; the fenced executor writes nothing more (`migration_aborted`) |
| same | user action with a stale `If-Match` after the migration; action without `If-Match` | 409 `stale`; 428 |
| same | stage projections and approvals after a reorder (MH-B04); file uploaded before a renumbering is accepted on resubmit (MH-B05) | history under the right stage; `files_relinked` |
| `test_migration_revert.py` (DB) | revert untouched case; case acted on since; outside the window; revert a revert | before-state restored + chained event; `revert_case_changed`; `revert_window_expired`; 422 |
| `test_migration_events.py` | outbox rows in the same transaction: started, one `module.record.migrated` per moved case with before/after, completed/failed; idempotency keys unique | envelope fields per EVENT-BUS.md |
| `packages/store/tests/test_store.py` | terminal migration rows are frozen (MH-B17); new item columns/outcomes; `kind`/`reverts_migration_id` | guard raises `immutable` |
| `frontend/…/migrations/__tests__/MigrationsPage.test.jsx` | dry run → mapping fix → re-plan → execute sends `{plan_sha256, reason, confirm}` only; 409 `plan_changed` flow; every catalogue code renders its message and hint; unknown code falls back; no duplicate keys | |
| same | revert flow; history kinds; reduced grants hide execute | |

## 10. Acceptance criteria

| ✓ | Criterion | Satisfied by |
|---|---|---|
| ☐ | **Dry run is mandatory**: execute accepts only the id of a stored `planned` plan, its unchanged `plan_sha256`, and unchanged source and target releases | §3.1 (`plan_hash_mismatch`, `plan_changed`, `plan_expired`, `bad_transition`); `store:132-162` frozen plan + `store_migration_guard`; §7 step 1; §8 step 4; tests `test_migration_execute.py` rows 1–2. Fixes MH-B06 |
| ☐ | **Execute requires a reason** (in addition to the plan reason) | §3.1 `reason_required` on execute; `execute_reason` lifecycle column; carried in `release.migration.started` and every journal item; §8 step 4 |
| ☐ | **Every moved record has before/after state saved** | §5.9 journal item in the case's own transaction (with seq/hash before and after, mapping, file links); `module.record.migrated` payload; §9 journal completeness test |
| ☐ | **Incompatible records are skipped, not corrupted**, each with a verdict and reason code | §3.2 procedure, §3.3 catalogue, §4.3/§5.2 blocks instead of coercion; skipped/blocked items in the journal; fixes MH-B01–B05, B11, B14 |
| ☐ | **Idempotent or safely blocked when repeated** | re-execute → 409 `bad_transition`; a resume plan sees `already_on_target`; one running per workspace; outbox idempotency keys; fencing (§7, MH-B17) |
| ☐ | **UI shows exactly why each record can or cannot migrate** | §3.3 codes → `reasonCodes.js` messages + fix hints; per-case before/after diff; §8 steps 3 and 5; frontend tests render every code |
| ☐ | Renames are migrated only through stable keys or explicit hints; no name/order guessing | §4.2 (lineage `migration_hints`, `stage_map`/`field_map`, v5 caveat) |
| ☐ | One case per transaction with an optimistic version check against concurrent user actions | §7 sequence; mandatory `If-Match` (RT-F14) |
| ☐ | Rollback = a reverse migration from the saved before-state inside a window, refused when the case changed | §6 |
| ☐ | Files and timers follow the case | §5.7, §5.8; fixes RT-B14 / MH-B05, MH-B10 |
| ☐ | Domain events are emitted through the outbox | §5.10 (`started`, `module.record.migrated`, `completed`, `failed`) |

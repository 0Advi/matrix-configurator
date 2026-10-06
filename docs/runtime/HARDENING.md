# Runtime hardening report

**Task 7** · 2026-10-06 · scope: make the generic custom-module runtime the core runtime for **all** modules.
Analysis only: no code was changed. Behaviour marked *(probe)* was confirmed by running `runtime.py` directly
(a scratch script against the sandbox copy, not committed).

**Files inspected**

| Area | Files |
|---|---|
| Interpreter | `app/backend/app/services/module_runtime/{__init__,runtime,forms,gates,validate,migrate}.py`, `manifest.schema.json` |
| Service / HTTP | `app/backend/app/services/module_runtime_service.py`, `app/backend/app/routers/module_runtime.py`, `app/backend/app/services/release_migration_service.py` |
| DB | `app/backend/database/migrations/20261004_1` `_4` `_5` `_6`, `20261005_1` `_2` `_3`, `20261006_1`; `database/schema.sql` (`audit_logs`) |
| Tests | `app/backend/tests/test_configurator_integration.py`, `test_g3_features.py`, `test_f5a_fixes.py`; `third_party/matrix-adapters/test/test_runtime.py` |
| Frontend | `app/frontend/src/modules/custom-module/{GenericRecordPage,GenericModulePage,kit,widgets}.jsx` |
| Target | `packages/{manifest,store,access,adapters}`, `docs/{manifest,store,rbac,adapters,templates,independence}` |

**Legend:** **bug** = the code does something wrong · **missing feature** = the target needs something that does not
exist yet · **design decision** = a choice the owner has to make. ⛔ = **blocks universal modularity** (a manifest
module that is not a Matrix-bd "custom module on a site" cannot run until this is fixed).
`rt.py` = `services/module_runtime/runtime.py`, `svc.py` = `services/module_runtime_service.py`, `mig_5` =
`database/migrations/20261004_5_generic_module_runtime.sql`.

**Coverage of the 17 checks**

| # | Check | Findings |
|---|---|---|
| 1 | Stage ordering | RT-D01, RT-B11 |
| 2 | Send-back behaviour | RT-B05, RT-B04, RT-F05 |
| 3 | Reject behaviour | RT-B03, RT-B06, RT-F04, RT-D06 |
| 4 | Terminal stages | RT-B11, RT-F04, RT-F10 |
| 5 | Stage-level gates | RT-B12, RT-B15, RT-B08 |
| 6 | Entry gates | RT-D05, RT-B03, RT-B04, RT-F02 |
| 7 | Release pinning | RT-D02 |
| 8 | Migration compatibility | RT-F15, RT-B14, RT-D01 |
| 9 | Audit hash chain | RT-B09, RT-F11 |
| 10 | Concurrency / stale records | RT-F14, RT-B10 |
| 11 | Admin override | RT-F07, RT-D03 |
| 12 | Delegation | RT-F08, RT-B10, RT-D04 |
| 13 | Creator-only rules | RT-F09 |
| 14 | Roll-up behaviour | RT-B01, RT-B02, RT-F10, RT-F06 |
| 15 | Form validation | RT-B07, RT-F12 |
| 16 | File fields | RT-F16, RT-B07, RT-B14 |
| 17 | Runtime errors that belong at publish | RT-F13, RT-B01, RT-B02, RT-B11, RT-B15 |

## 1. Current strengths

Keep these; the hardening plan builds on them rather than replacing them.

| Strength | Evidence | Keep as |
|---|---|---|
| **Pure interpreter, persistence outside** | `ModuleRuntime` has no DB/HTTP; `act()` deep-copies and never mutates the input (`rt.py:198-211`) | the core of `server/app/runtime/` (AUDIT.md §6) |
| **Typed refusals → stable HTTP problems** | `Refusal(code, message)` (`rt.py:56-59`), `_REFUSAL_STATUS` (`svc.py:73-79`), `ApiProblem` extras (`svc.py:485-493`) | same contract; add new codes (§5) |
| **One locked transaction per command** | `svc_act` locks the case `FOR UPDATE` and writes record, stages, approvals, audit together (`svc.py:455-508`); `svc_open_record` locks the site row (`svc.py:380-383`) | unchanged pattern on `cases` |
| **Optimistic check exists** | `expected_seq` vs `state.seq` → 409 `stale` (`svc.py:466-468`); the UI always sends it (`GenericRecordPage.jsx:98`) | make it mandatory (RT-F14) |
| **Release pinning enforced in code and DB** | `release_mismatch` (`rt.py:202-203`); records/approvals guarded against the pinned release (`mig_5:222-261`, `:321-326`); releases append-only (`20261004_1:102-103`) | pin moves to the case (RT-D02) |
| **DB re-checks the flow** | approvals guard re-derives the tier chain and keeps `is_override` truthful both ways (`mig_5:306-358`), creator rule too (`20261005_2`); approvals and files append-only (`mig_5:365-368`, `20261006_1`) | port as manifest-driven checks |
| **Per-case hash chain** | `_emit` chains every event (`rt.py:362-369`); `verify_chain` (`rt.py:381-388`); migrations append a chained `release_migrated` event (`migrate.py:230-240`) | move into an append-only table (RT-F11) |
| **Restricted, cross-language gate dialect** | `ALLOWED_OPS` + `lint()` close JS/Python divergences (`gates.py:36-39`, `:137-170`); gates read **reached** outcomes, stages and fields | reuse `gates.py` as `packages/rules` |
| **One form schema for UI and API** | `forms.stage_form` → draft-07 schema used by rjsf and `jsonschema` (`forms.py:117-157`), `additionalProperties: false` | keep compiler; feed it typed fields (RT-F12) |
| **Careful file pipeline** | per-field size/type caps, MIME allowlist + magic bytes, no DB txn held during storage I/O, object deleted if the insert fails, value must be a file of *this* case/stage/field (`svc.py:848-908`, `:948-973`) | keep; add RT-F16 |
| **Migration planner** | pure `plan()`/`apply()` with blocking vs warning issues (`migrate.py:181-240`); execution re-plans under lock, journals full before/after state, heartbeats, stale recovery (`release_migration_service.py:284-396`) | merge with store's frozen plans (RT-F15) |
| **Test base** | 36 interpreter tests on real flows in `third_party/matrix-adapters/test/test_runtime.py` (send-back, loops, override, SoD, pinning, tamper); app-side mapping/override/creator/migration/file tests | port the 36 into app CI (§7) |

## 2. Critical gaps

Missing features and design decisions the universal runtime needs. Most are already solved in a target package —
the fix is to **wire it in**, not to re-design.

| ID | Type | ⛔ | Gap | Evidence | Targeted change (and what already provides it) |
|---|---|---|---|---|---|
| RT-F01 | missing feature | ⛔ | A case is always "module × BD site": one per site, site FK, gate facts per site | `module_records.site_id … REFERENCES sites`, `UNIQUE (site_id, module_key)` (`mig_5:119,133`); `build_facts(session, tenant_id, site_id)` (`svc.py:231-255`); `svc_open_record` reads `sites` (`svc.py:380-383`) | `cases(subject_type, subject_id)` in `0003_runtime.sql` (§4); `build_facts` → `build_facts(subject)`; manifest `module.subject` (AS-01) |
| RT-F02 | missing feature | ⛔ | Built-in modules never run on the runtime; their gate outcomes come from hard-coded `sites` columns | `module_def` skips `type == "builtin"` (`svc.py:117-122`); `_custom_module` requires `kind == custom` (`svc.py:138-144`); `site_module_outcomes.builtin_raw` lists 9 modules/columns (`mig_5:374-405`) | run `templates/matrix-bd/*` as normal modules; drop the `builtin_raw` branch; gate facts only from `cases.reached` + signals |
| RT-F03 | missing feature | ⛔ | Actors are a fixed 3-role ladder: chain = `approvers` sorted by rank, "a higher tier may do an earlier step" | `TIER_RANK` (`rt.py:52`), `chain()` (`rt.py:103-109`), `_authorize()` (`rt.py:158-182`), `Actor.role` single string (`rt.py:63-68`), `_actor_role` (`svc.py:150-176`), `chk_ma_tier`/`chk_ma_actor_role` (`mig_5:193-194`), rank `CASE` in `cfg_release_stage_chain` (`mig_5:96-98`) | replace `chain()`/`_authorize()` with the manifest's `submit` + ordered `approvals[]` and **`packages/access` `authorize()`** (`authorize.py:124`, `_step_actor` `:50`); `Actor` → `Principal` with memberships |
| RT-F04 | missing feature | ⛔ | Fixed 8-outcome vocabulary; no `exit.on_complete` / `exit.on_reject` | `chk_mr_status`, `chk_mr_exit_outcome`, `chk_mss_status` (`mig_5:138-142,167-168`); `F2_OUTCOMES` + `module_record_row` maps an unknown exit to `"approved"` (`rt.py:395-410`); `OUTCOMES` (`validate.py:35`) | manifest `outcomes[]` + `exit{}`; `_advance` end-of-case (`rt.py:311-316`) sets `exit.on_complete` / roll-up result; `reject` sets `exit.on_reject` (fixes RT-B03) |
| RT-F05 | missing feature | ⛔ | Every tier may approve/send back/reject; send-back may target **any** earlier stage; approvers cannot enter fields | `actions()` always returns `approve, send_back, reject` (`rt.py:194-195`); `to_stage` only checked `≤ current` (`rt.py:271-273`); only the submit step has a form (`rt.py:149-152`) | honour `approvals[].actions`, `send_back_to[]`, `approvals[].fields` (schema `$defs/approval`, `$defs/stage`); new refusals `action_not_allowed`, `bad_send_back` |
| RT-F06 | missing feature | ⛔ | No adapter hooks; `custom` roll-up just parks | no hook call in `svc_open_record`/`svc_act`; `compile_rollup` returns `pending_engineering` (`gates.py:119-120`) | call **`AdapterHost.run`** (`packages/adapters/workspace_adapters/host.py:76`) at the points in `docs/adapters/README.md` §2: `beforeOpen` in `svc_open_record`, `beforeSubmit`/`validateBusinessRule` before `forms.validate_submission` (`rt.py:229-232`), `beforeApprove`, `computeOutcome` in `_verdict` (`rt.py:335-341`), `after*` via outbox |
| RT-F07 | missing feature | ⛔ | Override = "real role is `business_admin`", always on | `runtime_for` builds `ModuleRuntime(mdef, release=…)` with default `admin_override=True` (`svc.py:125-133`, `rt.py:91`); `_authorize` keys on `actor.role == "business_admin"` (`rt.py:165,180`) | override only via the **`override_step` grant** (`authorize()` returns `as_override`); service records `Decision.via`; keep `is_override` truthfulness in the DB |
| RT-F08 | missing feature | ⛔ | Delegation only gates the `executive` role on a site; no `assignee` restriction, no `can_be_assigned` | `rt.py:170-172`; `_delegated_sites` reads `site_delegations` by site+module (`svc.py:193-201`); `svc_assign` checks `role_in_module = 'executive'` (`svc.py:529-537`) | `case.assign` + `can_be_assigned()` (`authorize.py:208`); `case_assignments` table (§4); `submit.restricted_to: assignee` |
| RT-F09 | missing feature | ⛔ | Only `site_creator`, defined as `sites.submitted_by OR sites.assigned_to`, bound to step 0 | `creator_step()` (`rt.py:114-117`), `_owned_sites` (`svc.py:204-211`), `cfg_user_owns_site` (`20261005_2:30`) | `case_creator` / `subject_creator` / `assignee` + `restrict_roles` via `authorize()` (`restricted_*` codes); creator = `cases.opened_by` / subject creator |
| RT-F10 | missing feature | | A **parked** case (roll-up `pending`/`pending_engineering`) has no way out | `next_step` returns `None` for `parked` (`rt.py:146`); `migrate.IN_FLIGHT` excludes it (`migrate.py:42`); no endpoint resolves it | `POST …/cases/{id}/resolve` (grant `override_step`, reason, chained event) and `computeOutcome` retry; make parked migratable |
| RT-F11 | missing feature | | Case chain lives in `audit_logs.provenance`, which is mutable and cascades on site delete; assign/upload events are outside the chain | `_write_events` (`svc.py:294-315`); `audit_logs.site_id … ON DELETE CASCADE` (`schema.sql:253`), no append-only trigger on `audit_logs`; `svc_assign`/`svc_upload_file` write plain audit rows (`svc.py:552-559`, `:895-903`) | append-only `case_events` with the hash computed **by trigger under an advisory lock**, exactly like `store_activity_chain` (`packages/store/sql/0002_store.sql:261-301`) |
| RT-F12 | missing feature | ⛔ | Field validation is a free-text hint parser (₹, "max 20MB", "a · b") | `field_schema` (`forms.py:45-114`), `unparsed_hint` warnings (`validate.py:233-236`); no `money`, `long_text`, `multi_choice`; `person` is any string (`forms.py:95-100`) | compile typed `fields[].validation`/`options` (schema `$defs/field`) in `field_schema`; keep the JSON-Schema output shape (AS-06) |
| RT-F13 | missing feature | ⛔ | Publish runs the old v5 checker; dead gates, unreachable outcomes, actor-less stages are warnings or invisible | `check_manifest` (`validate.py:59-112`): `no_approver` W (`:214-216`), `terminal_not_last` W (`:211-213`), `gate_disabled_source` W (`:262-265`), `gate_outcome` W (`:266-269`) | publish via **`workspace_manifest.validate(manifest, adapters=…)`** (`packages/manifest/workspace_manifest/validate.py:104`): R3 `_r3_actors` `:314`, R5/R6 `_r4_r5_r6_gates` `:451`, R8 `_r8_fields` `:545`, R9 `_r9_rollup_views` `:579` |
| RT-F14 | missing feature | | Stale check is optional; no idempotency | `expected_seq: Optional[int]` (`routers/module_runtime.py:49-50`) and `if expected_seq is not None` (`svc.py:466`); `svc_assign`/`svc_upload_file` neither check nor bump `seq` (`svc.py:513-561`, `:862-866`) | require `If-Match: "s<seq>"` (428 without), `Idempotency-Key` on POSTs (store API §0 conventions); assign + upload bump `seq` |
| RT-F15 | missing feature | | Execute re-plans from parameters; unit of migration is the **site**; stage mapping is order/name heuristics | `svc_migrate_running_cases` (`release_migration_service.py:576-`), `_migrate_site` re-plans every case on the site (`:284-310`); `stage_mapping` (`migrate.py:49-71`) | frozen plan + `plan_sha256` quoted on execute (store S5, `0002_store.sql:132-158`); one case per transaction; map by stage **key** (RT-D01) |
| RT-F16 | missing feature | | File fields: one file per field, accept list from a hint, uploads never garbage-collected | `field_schema` file branch (`forms.py:83-94`); `module_files` rows stay forever when the form is never submitted (`svc.py:886-903`); no `max_files` | typed `accept` (MIME), `max_size_mb`, `max_files` (schema `$defs/field.validation`); `attached_at` + GC job for unattached files older than N days |
| RT-F17 | missing feature | | Separation of duties is a constructor flag, never read from the manifest | `separation_of_duties=True` default (`rt.py:92`), not passed by `runtime_for` (`svc.py:131`) | read `module.separation_of_duties` (schema default true); decision lives in `authorize()` |
| RT-D01 | design decision | ⛔ | Stages are identified by **order** everywhere | `state.values` keyed `str(order)` (`rt.py:233`); gates `{"stage": int}` (`gates.py:82-85`); `to_stage: int` (router `:48`); `module_stage_states` PK `(record_id, stage_order)` (`mig_5:165`); `module_files.stage_order` | **adopt stage keys** (manifest M6): state, tables, gates, send-back targets and migration mapping by key; order = array position only |
| RT-D02 | design decision | ⛔ | Release pinned on the **site**, record must equal site pin | `svc_open_record` uses `sites.config_release_id` (`svc.py:392-418`); `cfg_module_records_guard` (`mig_5:237-242`); a site on vN cannot open a module added in vN+1 → 409 `module_not_in_release` (`svc.py:398-402`) | **pin on the case** (store README §4 step 4, AUDIT AS-01): new case → live release; a running case keeps its own; drop `sites.config_release_id` checks |
| RT-D03 | design decision | | Override never bypasses SoD (stricter than target) | SoD checked before override returns (`rt.py:166-167`, `:173-174`); target: `override_step` also covers `separation_of_duties` (rbac README §3) | choose: follow `authorize()` (audited bypass) or keep strict and add a `separation_of_duties: strict` option; record the choice in `docs/rbac` |
| RT-D04 | design decision | | Under delegation an executive may **open** a case but then gets `no_delegation` on stage 1 | open only refuses observers (`svc.py:377-379`); `_delegated_sites` ignores `opened_by` (`svc.py:193-201`) | either auto-assign the opener (chained `assigned` event) or refuse open via `case.open` (RT-B13) |
| RT-D05 | design decision | | Entry gate is evaluated **only at open**; a later upstream send-back never re-locks a running case | gate check `svc.py:408-411`; `refresh()` exists but cases are never persisted `locked` (`rt.py:130-139`) | keep "gates open doors, never close them" (consistent with cumulative reached, RT-B04); document it in `docs/manifest` semantics |
| RT-D06 | design decision | | A rejected case is final and the unique key forbids a second case | reject sets `status = rejected` (`rt.py:255`); `UNIQUE (site_id, module_key)` (`mig_5:133`) | allow a new case after `exit.on_reject` (partial unique on open cases) or adapter `reopen_case` command (adapters README §2) |
| RT-D07 | design decision | | `runtime_state` JSON is the truth; `module_stage_states`/`module_approvals` are projections written alongside | `_write_stages` upserts every stage each action (`svc.py:340-365`); `_write_approvals` (`svc.py:318-337`) | keep state + `case_events` as truth, projections rebuildable from events; add a rebuild/verify job |

## 3. Logic flaws

All **bugs**, reproducible today. "Publish" = should be a publish-time error instead of a runtime surprise.

| ID | Type | Flaw | Evidence | Fix (named function) |
|---|---|---|---|---|
| RT-B01 | bug | **`sum_under` is never evaluated.** `rollup_inputs` only collects `choice`/`yesno` (`rt.py:320-333`); `_verdict` never passes a sum (`rt.py:335-341` → `gates.rollup_verdict(..., sum_value=None)` `gates.py:189-191`). With only number fields → no checks → `"approved"` regardless of the limit *(probe: amt=5, limit 100 → approved; any amount does)*; with a yes/no field too → `pending` → parked forever (`gates.py:129-133`) | `_verdict`, `rollup_inputs` | compute `sum` over `rollup.fields` (number/money) in `rollup_inputs`; pass it; publish error when `sum_under` has no numeric field (R9 already does) |
| RT-B02 | bug | A `choice` field with `affects_outcome` whose options are not yes/no words parks the case *(probe: "positive · negative" → `parked/pending`)*. `outcome_map` would fix it but the app schema refuses it (RT-B15); publish only warns for non-choice kinds (`validate.py:237-241`) | `rollup_inputs`, `_check_stage` | roll-up `positive`/`negative` option lists (target `$defs/rollup`); R9 error for unscorable fields |
| RT-B03 | bug | **Rejection is invisible to gates.** `reject` leaves `reached` unchanged (`rt.py:255-258`); a roll-up rejection never adds an outcome (`_reached` adds the exit only on approved/done, `rt.py:350`); `site_module_outcomes` uses `runtime_state.reached` whenever it is an array (`mig_5:410-413`) → a gate on `{source: custom, outcome: "rejected"}` never opens *(probe: reached `[]` after reject)* | reject branch of `act`, `_reached` | append `exit.on_reject` to reached on reject (RT-F04); R6 `unreachable_outcome` catches gates on outcomes that cannot occur |
| RT-B04 | bug | **Send-back shrinks `reached`.** `completed` is cut back and `reached` recomputed (`rt.py:275-277`) although the service documents reached as *cumulative* (`svc.py:21`) and the target says "cumulative, never currently is" *(probe: `["submitted"]` → `[]`)*; downstream modules not yet opened re-lock while already-opened ones keep running | `act` send-back branch, `_reached` | keep `reached` append-only; track "current" stage state separately |
| RT-B05 | bug | **In-stage send-back steps back one tier, not to the submitter** (`rt.py:263-265`). After a self-collapsed step (`_advance` auto-approve, `rt.py:293-298`) the case lands on a step its original actor may not redo: chain exec→sup→BA, supervisor submits (auto-approves sup step), BA sends back → step 1, same supervisor → `separation_of_duties` *(probe)*. The UI labels it "the previous step (default)" (`GenericRecordPage.jsx:511`) | `act` send-back branch | default target = this stage's submit step (target semantics); `send_back_to` for anything else; reset `pass` to `[]` |
| RT-B06 | bug | A `forward_only` reject on the **last** stage completes the module **approved** with its exit signal — `_advance` ignores `s["verdicts"]` (`rt.py:252-254`, `:307-316`) *(probe: `completed approved ['done']`)*. Latent today (schema refuses `forward_only`, RT-B15) | `_advance`, `_verdict` | drop `forward_only`; express the Launch loop with `send_back_to` (templates) — or make the final verdict read `verdicts` |
| RT-B07 | bug | **Required fields accept `""`**: `required` only checks presence (`forms.py:130-139`), strings have no `minLength`; a required **file** field with `""` is skipped by `_check_file_values` (`svc.py:957-958`) *(probe: required text + file = `""` → stage completes)* | `stage_form`, `field_schema`, `_check_file_values` | `minLength: 1` (or `pattern: \S`) for required text/file/person/choice; reject `""` file values |
| RT-B08 | bug | **Field facts are ambiguous and premature.** `contribution`/`build_facts` merge every stage's values into one dict (`rt.py:354-359`, `svc.py:251-254`): same key in two stages → last wins *(probe: `{'t': 'two'}`)*; submitted-but-unapproved and sent-back values count, so a field gate can open on an unapproved form | `contribution`, `build_facts` | facts keyed `fields.<module>.<stage_key>.<field>` from **completed** stages only; R4 checks references |
| RT-B09 | bug | **Chain truncation is undetectable.** `verify_chain` checks links only (`rt.py:381-388`); `svc_get_record` never compares the last hash with `runtime_state.last_hash` (`svc.py:727-776`) *(probe: dropping the last 2 events still verifies)* | `verify_chain`, `svc_get_record` | `verify_chain(events, head=state["last_hash"], seq=state["seq"])`; return `{valid, head_matches, length}` |
| RT-B10 | bug | **Re-assigning never revokes the previous delegate.** `svc_assign` inserts with `ON CONFLICT … DO NOTHING` and never sets `revoked_at` (`svc.py:538-543`); `_delegated_sites` reads every unrevoked row (`svc.py:193-201`) → the old assignee keeps acting rights and visibility; assignment does not bump `seq` | `svc_assign` | revoke other active delegations of the case in the same txn; chained `assigned` event + `seq` bump (RT-F11/F14) |
| RT-B11 | bug | **`terminal` on a middle stage silently ends the module**; later stages are unreachable (`rt.py:307-310`) *(probe: 2 stages, `terminal` on 1 → completed after stage 1)*; publish only warns (`validate.py:211-213`) | `_advance`, `_check_stage` | remove `terminal` (target: last stage is terminal, MAPPING.md); until then make `terminal_not_last` an error |
| RT-B12 | bug | **`actions()` ignores the stage gate**: returns `["submit"]` while the gate is closed *(probe)*; `next_step` exposes no gate status; the UI only learns via 409 `stage_gate_closed` (`GenericRecordPage.jsx:342`) | `actions`, `next_step` | evaluate `st["gate"]` in `next_step` (needs facts) and drop `submit` when closed; return `gate` on `next_step` |
| RT-B13 | bug | **Open-case permission differs between API and UI.** API lets any non-observer member open (`svc.py:377-379`); UI shows "open" only to supervisor/BA (`GenericModulePage.jsx:89`); neither checks who can submit stage 1 | `svc_open_record`, `GenericModulePage` | `authorize(principal, "case.open", …)`; return `can_open` from the API |
| RT-B14 | bug | **Files are not re-keyed by a migration.** `module_files.stage_order` is untouched by `_migrate_site` (`release_migration_service.py:284-396`); after a stage is renumbered a file uploaded before the move fails `_check_file_values` (`svc.py:964-971`) on resubmit | `_migrate_site` | re-key or reference files by stage **key** (RT-D01) |
| RT-B15 | bug | **The publish schema refuses features the runtime implements**: stage `gate`, `forward_only`, field `outcome_map` all fail `manifest.schema.json` (`$defs/stage` and `$defs/field` have `additionalProperties: false` without them) *(verified with jsonschema on the test fixture)* → stage-level gates are unusable in production, and `_check_stage`'s gate branch (`validate.py:224-226`) is dead | `manifest.schema.json`, `validate.py` | resolved by RT-F13 (target schema has `stage.gate`); do not patch the v5 schema |

## 4. Required DB changes

One new migration, `0003_runtime.sql` (already anticipated by `packages/store/sql/0002_store.sql:9` and
AUDIT.md §6), ported from `20261004_5`, `20261005_2`, `20261006_1`. Keep the RLS pattern and append-only triggers.

| Change | Replaces | Fixes |
|---|---|---|
| `cases (id, workspace_id, module_key, subject_type, subject_id, release_id → workspace_releases, status, current_stage_key, step, outcome, reached text[] **append-only**, seq, last_hash, opened_by, assignee_id, state jsonb, opened_at, closed_at)`; partial unique `(module_key, subject_type, subject_id) WHERE closed_at IS NULL` | `module_records` (`mig_5:116-146`) | RT-F01, RT-D02, RT-D06, RT-B04 |
| `cases.release_id` is the pin; guard: release belongs to workspace and contains the module; change only under `app.release_migration` (as today's `matrix.release_migration`) | `cfg_module_records_guard` pin checks (`mig_5:237-242`), `trg_sites_pin_release` | RT-D02 |
| `case_stage_states (case_id, stage_key, status, values, …)` | `module_stage_states` (`mig_5:153-170`) | RT-D01 |
| `case_approvals (…, stage_key, tier_index, role text, actor_id, is_override, via, verdict)`; guard validates `role` and `tier_index` against the pinned manifest's `approvals[]`, **no role/outcome enums** | `module_approvals` + `chk_ma_tier`/`chk_ma_actor_role` (`mig_5:175-197`), `cfg_release_stage_chain` rank `CASE` (`mig_5:76-114`) | RT-F03, RT-F05 |
| `case_events (case_id, seq, type, actor, payload, prev_hash, hash)`; trigger computes `seq`/`hash` under `pg_advisory_xact_lock('case:'||id)`, append-only, **no cascade from subjects** | `audit_logs.provenance.event` (`svc.py:294-315`) | RT-F11, RT-B09 |
| `case_assignments (case_id, user_id, granted_by, granted_at, revoked_at)`, partial unique one active row per case | `site_delegations` for runtime modules | RT-B10, RT-F08 |
| `case_files (…, stage_key, field_key, attached_at)` + index for the GC job | `module_files` (`20261006_1`) | RT-F16, RT-B14 |
| `case_outcomes` view = `cases.reached` per subject (+ signals) | `site_module_outcomes` (`mig_5:372-418`) incl. the hard-coded `builtin_raw` | RT-F02, RT-B03 |
| FK `workspace_release_migration_items.case_id → cases(id)` | `module_release_migration_items` (`20261005_1`) | RT-F15 |
| Drop after cut-over: `cfg_user_owns_site` (`20261005_2:30`), `chk_mr_status`, `chk_mss_status`, `chk_mr_exit_outcome` | — | RT-F04, RT-F09 |

Interim (sandbox only, if the port is delayed): an append-only trigger on `audit_logs` rows with
`entity_type = 'module_record'`, and the `svc_assign` revocation (code only).

## 5. Required API changes

Targeted edits; the router stays thin and `ModuleRuntime` stays pure.

| Endpoint / function | Change | Findings |
|---|---|---|
| Routes | `/m/{key}/records/…` → `/modules/{key}/cases/…` behind `Guard.check()` (rbac README §5 P1, §6); one decision per action, `Decision.as_override`/`via` passed into the service | RT-F03, RT-F07 |
| `POST …/actions` (`svc_act`, `svc.py:449`) | `If-Match: "s<seq>"` required (428 without); `Idempotency-Key`; `to_stage` → `to_stage_key` validated against `send_back_to`; `values` for approval fields; adapter hooks around `rt.act` | RT-F14, RT-F05, RT-F06, RT-D01 |
| `GET …/cases/{id}` (`svc_get_record`, `svc.py:689`) | `next_step` adds `stage_key`, `gate {open, refusal, unmet}`, `actions` of the tier, `send_back_targets`, `approval_form`, `restriction`; `audit_chain {valid, head_matches, length}`; role labels from manifest | RT-B12, RT-F05, RT-B09 |
| `GET …/cases` + `site_gate` (`svc_list_records`, `_site_gate`, `svc.py:577,666`) | `can_open` from `authorize("case.open")`; scope from `module.visibility` (`authorize` `case.view`) instead of `_executive_sees` (`svc.py:632-638`) | RT-B13, RT-F09 |
| `POST …/cases` (`svc_open_record`, `svc.py:370`) | subject instead of `site_id`; pin = live release; `beforeOpen` hook; creator = `opened_by` | RT-F01, RT-D02, RT-F06 |
| `POST …/assign` (`svc_assign`, `svc.py:513`) | `authorize("case.assign")` + `can_be_assigned()`; revoke previous; chained event; `seq` bump | RT-F08, RT-B10 |
| New `POST …/cases/{id}/resolve` | parked → outcome from `allowed` (grant `override_step`, reason required, chained) | RT-F10 |
| New `POST …/cases/{id}/reopen` (if RT-D06 = allow) | new pass after `on_reject` | RT-D06 |
| `POST …/files` (`svc_upload_file`, `svc.py:848`) | typed accept/size/count; returns `attached=false` until submit | RT-F16 |
| Publish (`platform_workspace_service.py:373,388`) | `check_manifest` → `workspace_manifest.validate(…, adapters=registry)` + access ceiling C1 | RT-F13, RT-B15 |
| Migrations | dry run stores the plan; execute requires `plan_sha256`, 409 `plan_changed` (store API §5.2); one case per txn | RT-F15 |
| `_REFUSAL_STATUS` (`svc.py:73-79`) | add `action_not_allowed`, `bad_send_back`, `restricted_case_creator`/`_subject_creator`/`_assignee`, `adapter_refused`, `precondition_required` (428) | — |

## 6. Required frontend changes

| File / function | Change | Findings |
|---|---|---|
| `GenericRecordPage.jsx` `ReasonForm` (`:495-522`) | targets from `next_step.send_back_targets`; default label "back to the submitter"; send stage **key** | RT-B05, RT-F05, RT-D01 |
| `GenericRecordPage.jsx` next-step block (`:201-240`) | show stage gate state and disable Submit with its refusal; render buttons from tier `actions`; approval-field form on approve steps | RT-B12, RT-F05 |
| `GenericRecordPage.jsx` override notice (`:412`) and `NextStep` | driven by `as_override`/`restriction` from the API, not `role === business_admin` / `site_creator` | RT-F07, RT-F09 |
| `GenericRecordPage.jsx` parked message (`:375`) | "Resolve" action for holders of `override_step` | RT-F10 |
| `GenericRecordPage.jsx` chain badge (`:272-273`) | show `head_matches=false` as "events missing" | RT-B09 |
| `GenericRecordPage.jsx` `StageRow` (`:422-447`) | key by stage key; drop the `terminal` "last stage" tag | RT-D01, RT-B11 |
| `GenericModulePage.jsx` `canOpen` (`:89`), hints (`:165-167`, `:217`) | use `can_open`; generic restriction labels; no role-name branches | RT-B13, RT-F03 |
| `kit.jsx` `TIER_LABEL`/`tierLabel` (`:107-108`) | labels from manifest `roles[]` returned by the API | RT-F03 |
| `widgets.jsx` file widget (`:26-32`, `:95-113`) + person widget (`:51`) | typed `accept`/`max_size_mb`/`max_files`, multi-file; person picker by `validation.role` | RT-F16, RT-F12 |
| rjsf widgets | `money`, `long_text`, `multi_choice` | RT-F12 |
| `moduleRuntimeApi` client | send `If-Match` + `Idempotency-Key` (keep the existing 409 `stale` handling) | RT-F14 |

## 7. Tests to add

The 36 interpreter tests live only in `third_party/matrix-adapters/test/test_runtime.py`; the app has no direct
tests for send-back, reject, `forward_only`, roll-up strategies, stage gates or `expected_seq` (grep of
`app/backend/tests`). Add (pytest unless stated):

| Test file | Cases | Findings |
|---|---|---|
| `app/backend/tests/test_runtime_core.py` (port of the 36) | flows, loops, override, SoD, pinning, tamper — run in app CI | baseline |
| `test_runtime_rollup.py` | `sum_under` below/above/at limit with number fields; choice with positive/negative lists; no scorable fields → `exit.on_complete`; parked → resolve | RT-B01, RT-B02, RT-F10 |
| `test_runtime_reject_sendback.py` | reject adds `on_reject` to reached and opens a gate waiting on it; send-back keeps reached; default send-back → submit step after auto-approve; `send_back_to` enforced; tier without `reject` gets `action_not_allowed` | RT-B03, RT-B04, RT-B05, RT-F05 |
| `test_runtime_gates.py` | `actions()` hides submit while the stage gate is closed; field facts by stage key and only from completed stages; entry gate never re-locks a running case | RT-B12, RT-B08, RT-D05 |
| `test_runtime_forms.py` | `""` refused for required text/file/person; typed min/max/pattern/currency/accept; approval fields validated | RT-B07, RT-F12 |
| `test_runtime_chain.py` | truncated tail → `head_matches=false`; DB trigger refuses UPDATE/DELETE on `case_events` and computes hashes (PostgreSQL, skip without DSN, like `packages/store/tests`) | RT-B09, RT-F11 |
| `test_runtime_concurrency.py` | missing `If-Match` → 428; stale → 409; replay with same `Idempotency-Key` → same response; two concurrent approvals → one wins (real PG) | RT-F14 |
| `test_runtime_assign.py` | re-assign revokes previous; old assignee refused; `can_be_assigned` refusal | RT-B10, RT-F08 |
| `test_runtime_access.py` | each `authorize()` code reached through the HTTP layer: `override_step` only, `case_creator`/`subject_creator`/`assignee`, borrowed tiers, observer read-only | RT-F03, RT-F07, RT-F09 |
| `test_runtime_pinning.py` | a subject with a v1 case can open a module added in v2; running case stays on v1; migration moves one case | RT-D02, RT-F15 |
| `test_runtime_migration.py` | execute without/with stale `plan_sha256`; files re-keyed by stage key; parked case migratable | RT-F15, RT-B14, RT-F10 |
| `test_runtime_adapters.py` | hook order around open/submit/approve; fail-closed refusals map to 422/409; `computeOutcome` run twice | RT-F06 |
| `test_runtime_templates.py` | every `templates/matrix-bd/*` module runs end-to-end on the runtime (no built-in code path) | RT-F02 |
| `test_publish_validation.py` | publish refuses: dead gate, unreachable outcome, actor-less stage, unscorable roll-up, `terminal` | RT-F13, RT-B11, RT-B15 |
| Frontend (vitest) `custom-module/__tests__/` | send-back targets from API; gate-closed submit disabled; `can_open`; manifest role labels; multi-file widget | §6 |

## 8. Final acceptance criteria

The generic runtime is the core runtime for **all** modules when:

1. Every module in `templates/matrix-bd/` and `packages/manifest/examples/acme-retail.manifest.json` runs end-to-end on
   the runtime with **no** built-in code path, no `sites` table read and no role/outcome name in runtime code
   (`check-independence --only=matrix-bd-tables` = 0 on the runtime).
2. Every publish goes through `workspace_manifest.validate` + ceiling C1; RT-B01/B02/B11/B15-class problems are
   publish errors, never runtime parks.
3. Every access decision is a `packages/access` `authorize()` call; overrides only via `override_step`, recorded with
   `via`; DB guards hold no role enum.
4. Reject, send-back, terminal, roll-up and exit behave as `docs/manifest/README.md` §1 states, proven by the §7 tests;
   `reached` is cumulative.
5. Cases are pinned individually; migrations execute only a frozen, hash-quoted plan, one case per transaction.
6. Every state change (incl. assign, upload, resolve, migrate) is one chained `case_events` row; `verify` checks links
   **and** head; the table is append-only in the DB.
7. Mutating calls without `If-Match` are refused; duplicate `Idempotency-Key` replays are harmless.
8. All 15 bugs have a failing-then-passing test; the 36 ported interpreter tests run in app CI.

**Modularity blockers (must be closed first):**

| ID | One line |
|---|---|
| RT-F01 | Cases are bound to BD `sites` (FK + one case per site per module) — need generic subjects. |
| RT-F02 | Built-in modules bypass the runtime; gate facts read hard-coded `sites` columns. |
| RT-F03 | Fixed executive < supervisor < business_admin ladder in code and DB CHECKs — need manifest roles + `authorize()`. |
| RT-F04 | Fixed 8-outcome vocabulary, no `exit.on_complete` / `on_reject`. |
| RT-F05 | No per-tier actions, `send_back_to` or approval fields. |
| RT-F06 | No adapter hook points in the runtime. |
| RT-F07 | Override is the `business_admin` role name, not an `override_step` grant. |
| RT-F08 | Delegation hard-wired to the executive role and site delegations. |
| RT-F09 | Creator rule is Matrix-bd's `sites.submitted_by OR assigned_to`; no `case_creator`/`subject_creator`/`assignee`. |
| RT-F12 | Free-text validation hints instead of typed field validation. |
| RT-F13 | Publish runs the v5 checker instead of the R0–R10 manifest validator. |
| RT-D01 | Stages addressed by order, not key. |
| RT-D02 | Release pinned on the site, so new modules cannot reach existing subjects. |

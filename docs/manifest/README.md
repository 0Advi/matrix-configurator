# Universal workspace manifest — `workspace-manifest/1`

**Task 2** · 2026-10-06 · code: `packages/manifest/` · concept mapping: [`MAPPING.md`](MAPPING.md)

The manifest is **the** source of modular behaviour. Everything a workspace does — which modules exist,
what a case goes through, who may act, what blocks what, what people see — is declared here and nowhere
else. The runtime has **no built-in module, no fixed role list and no fixed outcome list**.

| File | What |
|---|---|
| `packages/manifest/workspace_manifest.schema.json` | JSON Schema (draft 2020-12): structure |
| `packages/manifest/workspace_manifest/validate.py` | Validator: the cross-reference rules a schema cannot express (R1–R10) |
| `packages/manifest/workspace_manifest/from_v5.py` | Converter from today's configurator-v5 releases (migration path; sandbox only) |
| `packages/manifest/examples/acme-retail.manifest.json` | Example: 2 modules × 3 stages, entry + stage gates, approval tiers, custom role, typed fields, saved views, grants |
| `packages/manifest/tests/` | 67 tests: the example is clean, **each rule has at least one failing fixture** (`fixtures/invalid_cases.json`, 52 cases), the v5 converter reproduces runtime semantics |

```bash
cd packages/manifest
python -m workspace_manifest validate examples/acme-retail.manifest.json          # OK: 0 error(s), 0 warning(s)
python -m workspace_manifest validate my.json --adapters registry.json --json      # full report; exit 1 on errors
python -m pytest -q                                                                # 67 passed
```

## 1. Model in one picture

```
workspace ── subjects[] ─────────── what cases are about (Site, Vendor, …) + their shared fields
          ── roles[] ────────────── scope workspace|module, rank (display only), read_only
          ── outcomes[] ─────────── vocabulary with kind open|progress|positive|negative|neutral
          ── signals[] ──────────── external facts posted as events (permit granted, payment cleared)
          ── permissions[] ──────── workspace-level grants (publish, migrate, manage members, override, …)
          ── modules[]
               ├─ subject, members[] (module-scope roles that exist here), delegation, separation_of_duties
               ├─ entry_gate ─────── conditions on other modules/signals of the SAME subject
               ├─ stages[] (ordered)
               │    ├─ submit {roles, restricted_to: case_creator|assignee}
               │    ├─ approvals[] ── ordered tiers {role, actions: approve|reject|send_back}
               │    ├─ fields[] ───── typed: text, long_text, number, money, date, choice, multi_choice, yes_no, file, person
               │    ├─ gate ───────── extra condition before this stage can be submitted
               │    ├─ outcome ────── what the module has REACHED when this stage completes
               │    └─ send_back_to[]
               ├─ exit {on_complete, on_reject}
               ├─ rollup ─────────── how scored fields decide the exit
               ├─ views[] ────────── saved views: audience, default_for, filter, columns, sort
               └─ adapter? ───────── registered, versioned plug-in with DECLARED hooks (Task 5)
```

A **case** is one run of one module for one subject (e.g. "Fit-out for Site #812"). Cases of different modules on
the same subject see each other through gates: `fit_out` opens when `site_survey` has reached `approved`.

### Semantics the runtime must honour

| Concept | Rule |
|---|---|
| Stage flow | Stages run in array order. A stage's step sequence is `submit` → `approvals[0]` → `approvals[1]` …; the last step completes the stage and adds `stage.outcome` to the module's **reached** set. |
| Send back | From any approval step, to the previous stage by default or to a stage listed in `send_back_to` (always earlier). |
| Reject | Any tier whose `actions` include `reject` ends the case with `exit.on_reject`. |
| Exit | After the last stage the case ends with the roll-up result if a roll-up is defined, else `exit.on_complete`. |
| Gates | `match: all|any`; a condition is true when the source has **reached** an outcome (cumulative, never "currently is"), completed a stage, or a submitted field compares true. Only sources on the **same subject** count. |
| Separation of duties | On by default: one person acts on at most one step of a stage pass. |
| Restricted submit | `case_creator`: only the person who opened the case (among the submit roles); `assignee`: only the current assignee. Others act only through an `override_step` grant, recorded as an override. |
| Release pinning | A case runs on the release it opened on until it is migrated (Task 3, `migrate running cases`). |
| Roles | `rank` orders roles for display and escalation lists; it **never** grants anything. Permissions come only from stage actors and `permissions[]` grants (Task 6). |

## 2. Validation rules

`error` = publish refused; `warning` = shown to the publisher.

| Rule | Requirement | Codes (severity) | Fixtures |
|---|---|---|---|
| R0 | Shape matches the schema (`additionalProperties: false` everywhere — nothing hidden can ride along) | `schema` (E) | 2 |
| **R1** | **No duplicate keys**: subjects, roles, outcomes, signals, modules (modules + signals share one namespace), stages per module, fields per stage/subject, options per field, views per module; no reserved module key (`admin api auth me m new platform settings workspace workspaces`) | `duplicate_module_key`, `duplicate_key`, `reserved_key` (E) | 6 |
| R2 | No unknown references: roles, outcomes, subjects, modules, stages, fields; `members` are module-scope roles; `send_back_to` points backwards | `unknown_role`, `unknown_outcome`, `unknown_subject`, `unknown_module`, `unknown_stage`, `unknown_field`, `role_scope`, `bad_send_back` (E) | 8 |
| **R3** | **No stage without a valid actor**: ≥ 1 valid submitter per stage; every actor is a declared, non-read-only role that is either a member role of the module or a workspace-scope role | `stage_without_actor`, `invalid_actor` (E); `assignee_without_delegation`, `separation_of_duties_conflict` (W) | 4 |
| R4 | Gate references exist; no entry gate waits on its own module; operator fits the field type | `gate_unknown_source`, `gate_self_reference`, `gate_unknown_stage`, `gate_unknown_field`, `gate_op_type` (E) | 5 |
| **R5** | **No dead gates**: a gate is dead when it can never open — its source is disabled, runs on another subject, is itself dead (chains propagate), the gates form a cycle, a stage gate waits on its own or a later stage, or `match: all` demands two exits of one source. Computed as a **liveness fixed point** over all modules. | `dead_gate` (E; W for one dead branch of a live `any` gate) | 6 |
| **R6** | **No unreachable outcomes**: every outcome a gate or view waits on can actually be produced by the source (stage outcomes ∪ exits ∪ roll-up results; a signal's declared outcomes; a choice field's options); exits are final outcomes; a module that can reject declares `on_reject` | `unreachable_outcome`, `exit_not_final`, `reject_without_exit` (E); `unused_exit` (W) | 7 |
| **R7** | **No built-in-only hard-coded behaviour**: no `type`, `implementation`, `route`, `builtin`, `status_source`, `outcome_map`, `reached_map` on a module; an adapter must be installed, at an installed version, and may only declare hooks it implements | `builtin_behavior`, `unknown_adapter`, `adapter_hook_unsupported` (E); `adapter_unverified` (W, no registry given) | 6 |
| R8 | Typed validation is consistent: min ≤ max, regexes compile, validation keys fit the field type, money has a currency, person role exists | `field_validation` (E); `money_without_currency` (W) | 3 |
| R9 | Roll-up fields exist and are scorable (choice/yes_no/number/money; sum_under needs number/money); views filter on real stages/outcomes; `default_for ⊆ audience` | `rollup_invalid`, `unknown_field`, `view_default_not_in_audience` (E); `affects_outcome_unused`, `view_audience_cannot_see` (W) | 3 |
| R10 | Read-only roles never hold write grants; someone can publish | `read_only_grant` (E); `no_publisher` (W) | 2 |

Findings carry `rule`, `code`, `message`, JSON `path` and `module` / `stage` / `field` — the configurator can
point at the exact control.

### What the old checks miss that these catch

The app's current `validate.py` (configurator-v5) cannot see:
* **dead chains and cycles** — it warns only when a gate's *direct* source is disabled (`gate_disabled_source`);
* **unreachable outcomes** — exactly catalogue findings D18/D19 (`bd` gates waiting on outcomes the catalog
  could never report), which were found by hand in G2;
* **stages nobody can act on** — v5 silently defaults an empty approver list to `supervisor` (`no_approver`
  warning) and a supervisor-only module drops executives at run time;
* **built-in behaviour** — built-ins are accepted by design; their stages are "descriptive only".

## 3. Design decisions

| # | Decision | Why |
|---|---|---|
| M1 | **Subjects are declared**, cases are about a subject | Removes the "every case is a BD site" assumption (AS-01) without losing cross-module gates |
| M2 | **Roles are data** (`scope`, `read_only`, `rank`); permissions never derive from rank | Removes the fixed ladder (AS-02); Task 6 builds the guard model on this |
| M3 | **Outcomes are data** with a `kind` | The validator can tell final from transient outcomes (R6) and the UI can colour them, with no hard-coded list |
| M4 | **Explicit submit + ordered approval tiers per stage** | Replaces `approvers` sorted by an implicit rank + `tiers` flags that silently rewrote chains (AS-05) |
| M5 | **Typed field validation** | Replaces free-text hints ('min 0 · max 25,00,000', 'pdf · max 20MB') the runtime had to parse (AS-06); `unparsed_hint` disappears |
| M6 | Stage and field references by **key**, not order | Re-ordering stages no longer breaks gates, views, roll-ups or migrations |
| M7 | **Signals are events**, never reads of another system's tables | No `status_source: sites.status`-style coupling (R7) |
| M8 | **Adapters declare their hooks** in the manifest | A reviewer sees every place custom code runs; the validator checks them against the installed registry (Task 5) |
| M9 | `rank`, icons, labels are presentation | The runtime never branches on them |

## 4. Migration from today's releases

`from_v5.convert(v5_manifest)` → `(manifest, report)`. Verified by tests on the three configurator wizard
templates (vendor onboarding, retail expansion, franchise compliance): each converts and validates clean, and the
tier chain equals the app runtime's `ModuleRuntime.chain`. Built-in modules are listed in `report.builtins` and
must come from templates (Task 4) — until then gates on them fail R4, which is the point: nothing may silently
depend on hard-coded code.

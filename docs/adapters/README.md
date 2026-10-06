# Runtime adapter interface

**Task 5** · 2026-10-06 · code: `packages/adapters/` · example: `packages/adapters/examples/matrix_bd_bd/`

An **adapter** is a small, versioned plug-in that gives one module behaviour the manifest cannot express yet
(Task 4 lists every such behaviour and the generic feature that would retire it). The core runtime stays generic:
adapters run **inside a sandboxed contract**, see a frozen snapshot of one case, and can only return decisions,
violations, normalised values or effects. They cannot reach the database, roles, other modules' data or the live
release.

| File | What |
|---|---|
| `packages/adapters/workspace_adapters/sdk.py` | The whole adapter-facing surface: contexts, results, effects, `Descriptor`, `Adapter` base |
| `packages/adapters/workspace_adapters/host.py` | `AdapterHost`: runs hooks for the runtime and enforces the contract on every call |
| `packages/adapters/workspace_adapters/lint.py` | Static checks for adapter source (CI gate before a version can be installed) |
| `packages/adapters/examples/matrix_bd_bd/` | Example for the Matrix-bd **BD** module: rent terms + LOI deadline (`adapter.json` + `adapter.py`) |
| `packages/adapters/tests/` | 40 tests: the example's behaviour, every host rule, every lint rule |

```bash
cd packages/adapters
python -m pytest -q                                           # 40 passed
python -m workspace_adapters.lint examples/matrix_bd_bd/adapter.py   # 0 finding(s)
```

## 1. How an adapter is wired

```
manifest (pinned release)                 installed adapter package
  module.adapter = {                        adapter.json  (Descriptor)
    key: "matrix_bd.bd",          ◄──────►    key, version, hooks, namespace, emits, consumes,
    version: "1.0.0",                         commands, subject_fields, timeout_ms, config_schema
    hooks: [beforeSubmit, …],               adapter.py    (class BdAdapter(Adapter))
    config: {rent_stage: "draft", …} }
```

* **Publish time** — the manifest validator (Task 2, rule R7) refuses a module whose adapter is not installed,
  is not installed **at that version**, or declares a hook the adapter does not implement.
* **Run time** — the host runs a hook only if it is declared by **both** the adapter's descriptor **and** the
  case's **pinned** release manifest, and loads the adapter **version pinned by that release**. A case opened on
  release v3 keeps running adapter 1.0.0 even after v4 switches the module to 1.1.0 — until the case is migrated
  (Task 3). Release pinning covers code, not just configuration.
* **Configuration** — anything workspace-specific (stage keys, field keys, limits) comes from `adapter.config`,
  validated against the descriptor's `config_schema`. The same adapter code serves any workspace.

## 2. The hooks

Order around a human action (the runtime has already authorised the actor and checked gates):

```
open case:     gate check → beforeOpen → create case → (commit) → events
submit stage:  beforeSubmit (normalise) → validateBusinessRule → form schema check → write → (commit) → afterSubmit
decision:      validateBusinessRule → beforeApprove → write approval → (commit) → afterApprove
case ends:     computeOutcome (if declared) → exit → (commit)
event in:      syncExternalState (consumed events only) → effects
```

| Hook | When | Input (all frozen) | Returns | Transaction | On failure |
|---|---|---|---|---|---|
| `beforeOpen` | before a case is created (gate already open) | `OpenContext`: case-to-be, subject, actor, read API, config | `Decision` allow / refuse(code, message) | inside the open txn, no writes | **fail closed** — open refused |
| `beforeSubmit` | before a stage submission is validated | `SubmitContext`: stage, submitted values | `SubmitResult`: normalised values of **this stage's own fields**, or violations | inside the action txn, pure | **fail closed** — submit refused |
| `validateBusinessRule` | before every submit **and** every decision | `RuleContext`: stage, action, tier, values | `list[Violation(field, code, message)]` — shown inline like form errors | pure | **fail closed** |
| `afterSubmit` | after a submission committed | `AfterContext`: stage, action, `event_id` | `Effects` | outside the txn, via outbox, **at-least-once** | effects rejected as a whole → dead-letter + alert; the human action stands |
| `beforeApprove` | before approve / reject / send_back is written | `ApproveContext`: stage, action, tier, approval-field values | `Decision` | inside the action txn | **fail closed** |
| `afterApprove` | after a decision committed | `AfterContext` | `Effects` | outbox, at-least-once | dead-letter + alert |
| `computeOutcome` | when the case ends | `OutcomeContext`: all values, `default_outcome` (roll-up/exit), `allowed` outcomes | an outcome key from `allowed` | pure; **run twice and compared** | **fail closed** — the case parks (`parked`) |
| `syncExternalState` | a consumed event arrives (another module's event, a signal, a subject event) | `SyncContext`: event type/id/payload, `event_actor` | `Effects` | async consumer, at-least-once | dead-letter + alert |

**Effects** an adapter may return (never performs):

| Effect | Meaning | Checked by the host |
|---|---|---|
| `Event(type, payload, key)` | a fact others may consume | `type` ∈ descriptor `emits` and starts with its `namespace`; non-empty idempotency `key` |
| `Command(kind, module, case_id, stage, values, on_behalf_of, key)` | ask the runtime to `open_case`, `submit_stage`, `record_signal` or `reopen_case` | `kind` declared; **`module` = the adapter's own module**; no `release_version`; `submit_stage`/`reopen_case` need `on_behalf_of` = the person who caused the triggering event; the runtime then applies that person's permissions as if they acted |
| `SubjectUpdate(fields, key)` | ask the subject service to update shared subject fields | fields ⊆ descriptor `subject_fields`; audited |

There is **no** command to approve, reject, assign or change roles: an adapter can never take a decision a
person must take.

Idempotency: effect keys derive from `ctx.event_id` (`effect_key(event_id, suffix)`), so an at-least-once replay
yields identical effects and the outbox drops duplicates (tested with the example).

## 3. What adapters may do

1. Read the **frozen snapshot** of their own case on its **pinned** release: values, reached outcomes, subject
   fields, creator, assignee.
2. Read other modules' cases **of the same subject** through `ctx.read.cases(module)` — outcomes and values only,
   never tables.
3. Refuse an action with a coded, human-readable reason (`Decision.refuse`, `Violation`).
4. Normalise the values of the stage being submitted (`SubmitResult.values`), nothing else.
5. Emit events in their own namespace; request commands on **their own module's** cases, on behalf of the person
   who caused the triggering event; request updates of **declared** subject fields.
6. Choose the exit outcome among the outcomes the manifest allows.
7. Use `ctx.now` / `ctx.event_id` for time and identity (replayable).

## 4. What adapters must never do — and how each rule is enforced

| Rule | Enforced by |
|---|---|
| **No direct cross-module writes without events** — never write another module's case, values or tables | No DB handle exists in the SDK · host refuses `Command.module ≠ own module` (`cross_module_write`) · linter AD001 (DB/SQL), AD006 (`Command(module=<literal>)`) |
| **No bypassing release pinning** | Context carries only the pinned release (`case.release_version`, `module`, `config`) · host loads the pinned adapter version (`adapter_missing` otherwise) · host refuses `Command.release_version` (`release_override`) |
| **No hidden role checks** | `Actor` has **no role field** (tested) — the runtime authorises before any hook runs · linter AD002 (comparisons/reads of `role`, `roles`, role names) · borrowed tiers are declared in the manifest (`approval.module`), never computed by code |
| **No hard-coded workspace-specific logic** | Only `adapter.config` carries specifics, validated by `config_schema` · linter AD003 (UUID literals, `ws_…` keys) · contexts expose no workspace id |
| No impersonation / no decisions | No approve/reject/assign command exists · `on_behalf_of` must equal the triggering person (`impersonation`, `anonymous_command`) |
| No undeclared behaviour | Host runs only hooks declared by descriptor **and** pinned manifest · events/commands/subject fields outside the descriptor are refused · descriptors with unknown hooks/commands or foreign event namespaces cannot be installed |
| No hidden state | Contexts are deep-frozen (mutation → `adapter_error`, tested) · linter AD004 (`global`, mutated module-level containers) |
| No non-determinism in decisions | `computeOutcome` run twice and compared (`nondeterministic_outcome`) · linter AD007 (`random`, `uuid4`, `time.time`, `datetime.now`) |
| No side channels | Linter AD005 (network, files, subprocess) — external systems talk to the platform through **signals** (events), not from inside an adapter |
| Bounded cost | Per-call time budget from the descriptor (`adapter_timeout`, fail-closed, tested) |

## 5. Example — Matrix-bd BD (`matrix_bd.bd@1.0.0`)

The BD template (`templates/matrix-bd/bd.template.json`) declares
`adapter: {key: "matrix_bd.bd", version: "1.0.0", hooks: [afterApprove, beforeSubmit, validateBusinessRule],
config: {rent_stage: "draft", deadline_stage: "details", deadline_field: "expected_loi_days", schedule_max_rows: 5}}`.

| Hook | Matrix-bd behaviour reproduced | Source in Matrix-bd |
|---|---|---|
| `beforeSubmit` | switching away from *staggered* clears the schedule; the schedule is stored as canonical JSON sorted by year | `bd_service._apply_staggered_escalation` |
| `validateBusinessRule` | staggered rent needs a base rent and 1–5 schedule rows: unique whole years ≥ 1, 0 ≤ percent ≤ 100, mg ≥ 0, 0 ≤ dine-in/delivery ≤ 100 | `schemas/site.py` `_staggered_requirements`, DB `is_valid_staggered_escalation`, `rent-terms.json` |
| `afterApprove` | on the details approval, `expected_loi_days` becomes `matrix_bd.bd.loi_deadline_set {due_at}` — an **event**, so a deadline/SLA consumer (or the BD page) reacts; nothing is written into another module | `bd_service` approve → LOI deadline |

It reads no role, touches no table, names no workspace, and is lint-clean. The generic features that would retire
it (`field.visible_if`, `field.required_if` + `table` field, `stage.sla_from_field`) are in the Task 4 backlog.

## 6. Lifecycle of an adapter version

1. Write `adapter.json` + code; `python -m workspace_adapters.lint` must report 0 findings; tests use the host.
2. Install the version on the platform (`AdapterHost.install` refuses bad descriptors); it appears in the registry
   the manifest validator receives.
3. Reference it from a module in a draft; publish (R7 checks key, version, hooks).
4. New version → new key/version entry; old releases keep the old version until their cases are migrated.
5. Removal is only possible when no live release and no running case pins that version.

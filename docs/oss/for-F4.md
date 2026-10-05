# For F4 — what to install, copy and call to run configurator workspaces in the app

Everything here is **tested on the project's real data**: 36 tests in `third_party/matrix-adapters/test`.
Versions are exact. Source paths are relative to the project root, `/Users/aditya/Desktop/bd/matrix-configurator`.

## 0. The decision in one paragraph

Custom modules run on an **in-app interpreter** of the published manifest. The reference implementation is
`third_party/matrix-adapters/runtime.py`; it is pure functions, so you add persistence and routes.
SpiffWorkflow and Operaton are **not** adopted now:

* They do not do our authorization: tiers, delegation, separation of duties and observer rules still have to
  be written by us.
* SpiffWorkflow is LGPL; Operaton is a JVM service that brings its own database and users.
* Gate expressions are not portable between engines (JUEL vs Python).
* The v5 model is linear stages with tier approvals, which needs no BPMN engine.

The whole reasoning is in `docs/oss/GAP-ANALYSIS.md` and `docs/oss/OPERATON-SPIKE.md`. Gates use **JsonLogic**
(dialect `matrix-gate/1`), with identical results in Python and JS. Forms are **JSON Schema** compiled from
the stage fields. They are rendered by **rjsf** and validated by **jsonschema** on the backend.

## 1. Backend (FastAPI, `app/backend`)

### Install / copy

| What | How | Licence |
|---|---|---|
| `panzi-json-logic` 1.0.1 | **Copy** `third_party/panzi-json-logic/json_logic/` → `app/backend/app/vendor/json_logic/`, and `LICENSE` → `app/backend/app/vendor/json_logic/LICENSE`. Do not modify it. It is stdlib-only and its imports are relative, so it works as a subpackage. (Alternative: `panzi-json-logic==1.0.1` from PyPI. The import name `json_logic` clashes with other json-logic ports, so vendoring is safer.) | MIT |
| `jsonschema` 4.26.0 | Add to `pyproject.toml` deps and `requirements.lock.txt`: `jsonschema==4.26.0`, `attrs==26.1.0`, `jsonschema-specifications==2025.9.1`, `referencing==0.37.0`, `rpds-py==2026.6.3`. These are the versions the tests resolved. | MIT (rpds-py MIT) |
| Adapters | Copy `third_party/matrix-adapters/{gates.py,forms.py,runtime.py}` → `app/backend/app/services/module_runtime/` and add an `__init__.py`. | ours |

Import edits after copying:
* `gates.py`: delete the `sys.path` block and use `from app.vendor.json_logic import jsonLogic`.
* `runtime.py`: use `from . import forms, gates`.
* `forms.py`: no change. `jsonschema` is imported lazily inside `validate_submission`.

### APIs you call

```python
from app.services.module_runtime import gates, forms, runtime

# publish time (POST release → tenant_config_releases): lint + compile once, refuse on errors
compiled = gates.compile_manifest(manifest)                  # {"dialect": "matrix-gate/1", "modules": {key: {entry_gate, rollup, stage_gates}}}
problems = [p for m in compiled["modules"].values() for r in (m["entry_gate"], m["rollup"]) for p in gates.lint(r)]
stage_forms = {(m["key"], s["order"]): forms.stage_form(s, file_mode="ref") for m in manifest["modules"] for s in m["stages"]}
warnings = [(k, u) for k, f in stage_forms.items() for u in f["unparsed"]]   # free-text hints → surface as findings
# Compiling is deterministic and cheap (~ms), so you may also compile on load and cache by release id.

# request time
rt = runtime.ModuleRuntime(module_manifest, release=str(release_id), admin_override=False)  # see §4 conflict
state, events = rt.new_case(case_id, site_id, facts)          # → module_records insert
state, events = rt.refresh(state, facts)                      # call when upstream modules change
nxt = rt.next_step(state)          # {stage, name, role, kind: submit|approve, form: {schema, uiSchema, …} | None}
rt.actions(state, actor)           # ["submit"] | ["approve", "send_back", "reject"] — for the UI
state, events = rt.act(state, actor, "submit", {"values": {...}}, facts)       # raises runtime.Refusal(code, message)
state, events = rt.act(state, actor, "send_back", {"reason": "…", "to_stage": 1}, facts)
rt.gate_status(facts)              # {"open", "refusal", "unmet"} → the "locked" screen
actor = runtime.Actor(id=str(user_id), role="executive", delegated_sites=(str(site_id),))
```

`Refusal.code` is one of:
`gate_closed`, `stage_gate_closed`, `invalid_form`, `wrong_tier`, `no_delegation`, `observer_read_only`,
`separation_of_duties`, `reason_required`, `release_mismatch`, `closed`, `wrong_action`, `bad_target`,
`nothing_to_send_back`.
Map them to HTTP 403 (tier, delegation, observer, SoD), 409 (gate, release, closed) and 422 (form, reason).

### Facts (what gates read): one object per site

```json
{
  "reached": { "<module>": ["submitted", "approved"] },
  "stages":  { "<module>": [1, 2] },
  "fields":  { "<module>": { "<field>": "<value>" } }
}
```

Where the facts come from:
* **Custom modules:** `rt.contribution(state)` or `runtime.site_facts([...])`.
* **Built-in modules:** F2's view `public.site_module_outcomes`. Put each built-in's configurator outcome into
  `reached[module]` as a list of every outcome reached so far, not only the current one. Gates ask
  "has X reached `done`?", so `done` implies the earlier outcomes. `reached` is cumulative; keep the history,
  not a snapshot.

### Persistence: maps onto F2's proposed tables (`docs/schema-audit/proposed-migrations/20261004_5…`, `…_6…`)

| Runtime | F2 table / column | Helper |
|---|---|---|
| case `state` | `module_records` (status, current_stage, exit_outcome, release_id) — **add `runtime_state jsonb`** (ask F2). The state holds step/pass/verdicts/seq/last_hash, which the CHECK-constrained columns cannot. | `runtime.module_record_row(state, exit_signal)` gives values inside F2's outcome vocabulary |
| `state["values"][order]` | `module_stage_states.field_values` (+ status, submitted_by/at) | — |
| events of type submitted / approved / auto_approved / rejected / rejected_forward / sent_back | `module_approvals` (append-only) | `runtime.approval_row(event)`: verdict ∈ F2's CHECK; admin-tier form submissions are recorded as `approved` |
| **every** event (incl. case_created, gate_opened, stage_completed, module_completed) | `audit_logs` with `config_release_id`, `module_key`, and `provenance = {seq, prev, hash, override, acting_as_delegate}` | `runtime.verify_chain(events)` checks the chain |
| `release` pinned on the case | `sites.config_release_id` (pinned at site insert, migration `_4`) and `module_records.release_id` | build `ModuleRuntime` from **that** release's manifest, never from the live one |

Concurrency: load `module_records … FOR UPDATE` (same pattern as `services/_common.py
fetch_site_for_update_or_404`), call `rt.act(...)` (pure), then write the state, rows and events in the same
transaction. `state["seq"]` lets you assert nothing changed underneath.

### Routes (suggested, under the existing auth deps)

* `GET /m/{module_key}/queue`: cases where `next_step.role` matches the user's role (or delegation).
* `GET /m/{module_key}/sites/{site_id}`: returns state, `gate_status`, `next_step` (with form schema/uiSchema),
  `actions(actor)` and history.
* `POST /m/{module_key}/sites/{site_id}/actions` with body `{action, values?, reason?, to_stage?}`.
* `module_key` must be a custom module in the site's pinned release. Built-ins keep their bespoke routes.

## 2. Frontend (Vite + React 18.3.1, `app/frontend`)

```bash
npm i -E @rjsf/core@6.11.0 @rjsf/utils@6.11.0 @rjsf/validator-ajv8@6.11.0 json-logic-js@2.0.5
```

* 21 packages in total: Apache-2.0, MIT and BSD only, no lodash. The tree is in
  `third_party/rjsf-check/package-lock.json`. The peer dependency is `react >=18`, and the app has 18.3.1.
* `json-logic-js@2.0.5` from npm is byte-identical to the vendored `third_party/json-logic-js/logic.js`
  (sha256 `73a6dc52…d881`).

```jsx
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
<Form schema={next.form.schema} uiSchema={next.form.uiSchema} validator={validator}
      widgets={{ MatrixFileWidget, MatrixPersonWidget }}
      extraErrors={serverErrors} onSubmit={({ formData }) => post('submit', { values: formData })} />
```

* **Widgets you must provide.**
  * `MatrixFileWidget` uploads through the app's existing upload endpoint (`core/uploads.py`) and stores the
    returned file key as the value. `forms.stage_form(..., file_mode="ref")` emits it.
  * `MatrixPersonWidget` is a user picker filtered by `ui:options.tier`.
  * Everything else uses rjsf's plain-HTML default widgets. Style them with the app's `--zm-*` tokens; no
    MUI/AntD theme is needed.
* **Gate preview (optional).** Copy `third_party/matrix-adapters/gates.mjs` → `src/lib/gates.mjs` and replace
  its `createRequire` lines with `import jsonLogic from 'json-logic-js'`. The backend's verdict stays
  authoritative; the client copy only explains "why is this locked".
* **CSP / ajv: tested conclusion.** `@rjsf/validator-ajv8` compiles validators with `new Function`. Under
  `node --disallow-code-generation-from-strings`, which is what a CSP without `'unsafe-eval'` does, **every**
  validation fails, valid data included ("Code generation from strings disallowed").
  * Today `app/frontend/vercel.json` only sets `Content-Security-Policy-Report-Only` with
    `script-src 'self'`, and Vite dev sets no CSP. **Localhost works as-is.** A production report-only CSP
    would *report* the eval, not block it.
  * Before that CSP is enforced, choose one of these. Do not add `'unsafe-eval'`.
    1. Pass rjsf a small validator adapter backed by an interpreter that does not use eval:
       `@cfworker/json-schema@4.1.1` (MIT).
    2. Precompile per-release validators with `compileSchemaValidatorsCode` at publish time and serve the
       module from `'self'`.
    3. Rely on backend validation only (`extraErrors`), using a no-op validator for simple schemas without
       `oneOf` / `anyOf` / `if`.

## 3. Manifest → runtime mapping

| Manifest element (v5) | Compiled to | Runtime behaviour |
|---|---|---|
| `entry_gate {match: all\|any, conditions[{source, outcome}], refusal_message}` | `{"!!":[{"and"\|"or":[{"in":[outcome,{"var":["reached.<src>",[]]}]}…]}]}` | Case stays `locked` until open, and `refusal_message` is shown |
| `stages[].approvers` | tier chain, sorted executive < supervisor < business_admin; `tiers.business_admin_signoff=false` drops admin steps | 1st step submits (if the stage has fields), later steps approve / send back / reject |
| `stages[].fields[]` | draft-07 JSON Schema + uiSchema (`forms.stage_form`) | validated on submit (`invalid_form`) |
| `stages[].outcome`, `terminal` | joins `reached[module]` when the stage completes | drives downstream gates |
| `rollup {strategy, n, limit}` | JsonLogic over `{checks, sum}` (`gates.compile_rollup`), identical to v5-port `evaluateRollup` on 1607 cases | evaluated when the module finishes. No yes/no fields: the sign-off approves (INFERRED). Unresolved roll-up: `parked` |
| `exit_signal` | added to `reached` when the verdict is approved/done | opens downstream modules |
| `tiers.delegation` | — | an executive needs the site in `delegated_sites` (`site_delegations`) |
| `permissions[]` (ceiling ⊇ granted) | — | **not yet enforced by the runtime.** Check `granted` in the route layer for built-in actions |
| `module.runtime = "generic"`, `route = /m/<key>` | — | route + interpreter selection |

**Extensions** the runtime already supports but v5 does not emit yet (configurator follow-ups). Each has a test:
* stage-level gate `stages[].gate`, with conditions `{source, stage: <order>}` (G-A);
* field condition `{source, field, op, value}` (G-E);
* `stages[].forward_only` (G-C);
* `send_back.to_stage` loops (G-B);
* `fields[].outcome_map` (G-E: production's `positive · negative` and `pending · done` options).

## 4. Known conflicts and decisions you need to make

1. **Admin override vs F2's guard.** Production lets a business admin act anywhere (guard bypass). F2's
   `module_approvals` guard refuses a `submitted` verdict from a business admin on an executive/supervisor
   step. Pick one:
   * build `ModuleRuntime(..., admin_override=False)` for custom modules (recommended for now); or
   * ask F2 to allow it, with the `override` flag kept in `audit_logs.provenance`.

   This is test `test_admin_override_submission_conflicts_with_f2_guard`.
2. **Roll-ups on non-yes/no fields.** The wizard templates mark text, file and number fields as
   `affects_outcome`, and v5 roll-ups cannot score them. The runtime ignores them; `rollup_inputs()` returns
   them as `ignored`, so surface that as a publish warning.
3. **Roll-up vocabulary.** With v5's yes/no/n/a vocabulary only, production Legal and NSO would **park**:
   8 fields use other options. Either add `outcome_map` in the configurator, or keep built-ins on their
   bespoke code (D4 already does this).
4. **`reached` for built-ins is cumulative**, as described in §1. F2's view gives the current status; derive
   the reached list from it.
5. Don't call NocoBase at request time (D2), and don't copy any NocoBase source (licence; see
   `PROVENANCE-AUDIT.md`).

## 5. Run the proof yourself

```bash
cd /Users/aditya/Desktop/bd/matrix-configurator
python3 -m venv .venv && .venv/bin/pip install jsonschema==4.26.0 && (cd third_party/rjsf-check && npm ci)
.venv/bin/python -m unittest discover -s third_party/matrix-adapters/test -t third_party/matrix-adapters/test   # 36 OK
```

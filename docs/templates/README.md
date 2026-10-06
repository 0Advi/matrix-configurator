# Built-in modules → portable manifest templates

**Task 4** · 2026-10-06 · reference tables per module: [`MATRIX-BD-TEMPLATES.md`](MATRIX-BD-TEMPLATES.md) (generated)

| File | What |
|---|---|
| `templates/matrix-bd/<module>.template.json` | One template per former built-in: `bd`, `legal`, `finance_ca`, `design`, `project_excellence`, `project`, `nso`, `launch_approval`, `financial_closure` |
| `templates/matrix-bd/workspace.manifest.json` | All nine composed into one `workspace-manifest/1` — **validates with 0 errors, 0 warnings** |
| `templates/matrix-bd/adapters.registry.json` | The adapter hooks the templates declare (what Task 5 adapters must implement) |
| `templates/matrix-bd/build_templates.py` | Builds all of the above from the extracted production flow; reproducible (a test rebuilds and diffs) |
| `templates/matrix-bd/render_docs.py` | Renders `MATRIX-BD-TEMPLATES.md` |
| `templates/matrix-bd/tests/` | 24 tests |

```bash
python templates/matrix-bd/build_templates.py     # 9 templates written; composed workspace OK (0 warning(s))
python -m pytest -q templates/matrix-bd/tests      # 24 passed
```

The eight requested modules plus **Finance / CA** (`finance_ca`): Design's and NSO's entry gates wait on it, so
without it the composed workspace has dead gates (rule R5).

## 1. How the templates were made

1. **Source:** `building-blocks/from-matrix-bd/matrix-bd-flow.json` — Matrix-bd @ `3d4f277` as configurator data,
   **with the approved G2 fixes** (D18 "BD done opens too early", D19 unreachable outcomes). Every stage carries
   `x-matrix` facts: the real status column and transitions, **who actually acts** (`actors`), and the source files.
2. **Structure from the real actors, not from v5's `approvers`.** v5 lists one tier per stage, so a mechanical
   conversion would say "supervisor submits the BD details" — in Matrix-bd the executive submits and the supervisor
   approves. Each template's stages, submit roles and approval tiers are modelled from `x-matrix.actors`.
3. **Fields by key from the flow**, converted to typed validation (₹ amounts → `money` in INR; `yes · no · n/a` →
   scored choices; `PNG/JPEG/PDF ≤ 5 MB` → `accept` + `max_size_mb`; regexes → `pattern`). **All 114 flow fields land
   exactly once** — in a stage form, an approval form, or the `site` subject (tested).
4. **Composition check:** the nine modules plus a shared `site` subject, the default roles and outcomes, and the
   adapter registry validate as one workspace; each template also validates with only the modules it requires.
5. **No brands, no table names:** competitor-distance keys renamed (`nearest_starbucks_m` → `nearest_competitor_a_m`,
   recorded in `renamed_fields`); a store-model hint naming the customer's brand dropped; `sites.status`,
   Supabase etc. appear nowhere in a module (tested).

## 2. What became generic (and why the manifest grew)

Modelling the real flows exposed five capabilities that **any** workspace needs, so they were added to
`workspace-manifest/1` (schema + validator + fixtures) instead of being pushed into adapters:

| Addition | Needed by | Rule in the validator |
|---|---|---|
| `submit.restricted_to: subject_creator` | Launch "creator review" (the **site's** creator), Finance/CA (the site owner) | — |
| `submit.restrict_roles` | Legal / PE: executives only when assigned, supervisors always | R3: ⊆ submit roles |
| `submit.module`, `approval.module` (borrow a role from another module, same subject) | Project QA's **Project Excellence** sign-off; Financial closure staffed by the **Project** team | R2/R3: module exists, same subject, role is its member |
| `approvals[].fields` (data the approver enters) | DDR verdict, PE initialization date (required to approve), reviewer comments, LOI deadline days | R1 one field namespace per stage; R8; usable by gates/roll-ups |
| `send_back_to` may name the stage itself (rework, the default) | LOI send-back, recce re-upload | R2: never a later stage |

Without these, each would have been a hidden adapter behaviour — exactly what Task 5 forbids (e.g. a
cross-module role check inside an adapter).

## 3. What still needs an adapter (Matrix-bd-specific)

| Module | Hooks | For |
|---|---|---|
| BD | `validateBusinessRule`, `afterApprove` | rent-terms conditional amounts + staggered schedule; LOI deadline from `expected_loi_days` |
| Legal | `validateBusinessRule`, `syncExternalState` | verdict ⇄ action consistency, licensing completeness; change-request revival of a rejected DDR |
| Finance / CA | `validateBusinessRule`, `afterApprove` | unique CA code; CA code becomes the site code (event) |
| Design | — | fully generic |
| Project Excellence | `afterApprove` | propose Project's initialization date (event) |
| Project | `syncExternalState` | consume that event and submit the initialization stage, attributed to the proposer |
| NSO | `syncExternalState` | prefill licensing from Legal via the runtime read API |
| Launch approval | `syncExternalState`, `validateBusinessRule`, `afterSubmit` | auto-open when NSO completes; rent-terms group; terms committed / launched as subject events |
| Financial closure | `afterSubmit` | site archived (event) |

**13 hook uses across 8 modules; 1 module (Design) needs none.** Every cross-module effect is an **event**; no adapter
writes another module's data (Task 5 rules).

## 4. Generic-candidate backlog

Each adapter hook names the generic manifest feature that would retire it. Implementing these turns the
remaining Matrix-bd behaviour into configuration:

| Candidate | Retires | Effort |
|---|---|---|
| `field.required_if` + a `table` field type (rows of typed columns, `max_rows`) | BD and Launch rent terms | M |
| `field.prefill_from {source, stage, field}` | NSO licensing refresh, Project initialization prefill | S |
| `module.auto_open: true` (open a case when the entry gate opens) | Launch auto-open | S |
| `exit.set_subject_fields` / subject events on completion | CA code → site code, launched, archived, committed rent terms | M |
| `validation.unique: "workspace"` | unique CA code | S |
| `action.requires` (field condition per action) | DDR verdict ⇄ approve/reject | S |
| `stage.sla_from_field` | LOI deadline | S |
| `reopen` action + grant | Legal change-request revival; BD archive/revive | M |

## 5. Deliberately not carried over

* **Undo of design review decisions** (`reversible_actions`) — a send-back is the generic correction.
* **The legacy business-admin quality-audit confirmation** route in Project.
* **BD "archive with revive"** — mapped to reject until a generic `reopen` exists.
* **Status columns on `sites`** — a module's state is its case; other modules see only reached outcomes.

## 6. Where these templates live

They are **Matrix-bd's customer configuration**, not product content (`visibility: customer-private`). In the
standalone layout (Task 1 §6) they belong in a private customer repo, never in the product's `templates/`. A
product-level neutral template (e.g. "site rollout") can be derived from them with the brand-free field keys.

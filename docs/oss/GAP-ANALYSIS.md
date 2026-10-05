# Gap analysis — what the configurator can design vs what can run, and how we fill it

Inputs:
* `building-blocks/from-matrix-bd/SEED-VS-REALITY.md` (G-A…G-K, G1–G4);
* the `docs/CONTRACT.md` deviations;
* the `web/README.md` limitations;
* F2's proposed migrations (`docs/schema-audit/proposed-migrations/`);
* the tests and spikes in this workstream.

Candidates per gap are in `REPO-SURVEY.md`, and F4's instructions are in `for-F4.md`.

**Status legend:**
* ✅ **adopted now:** code plus tests in `third_party/`, ready for F4.
* 🟡 **runtime ready, authoring missing:** the runtime supports it as a manifest extension, but v5 cannot design it.
* 🔴 **open:** work needed.
* ⚪ **later by choice.**

## 1. Gap → solution table

| # | Gap | Evidence | Solution (OSS / ours) | Status | What's left |
|---|---|---|---|---|---|
| 1 | **Gate language.** v5 `{match: all\|any, conds[{src,out}]}` has no executable form shared by backend and frontend. | CONTRACT; v5 | **JsonLogic**: json-logic-js 2.0.5 + panzi-json-logic 1.0.1 (MIT, vendored); `gates.py`/`gates.mjs` compile to dialect `matrix-gate/1` with a lint step | ✅ | Proven: the JS and Python engines agree on all 548 lint-clean compat cases; 407 gate verdicts match across languages on every prefix of the production flow. |
| 2 | **Stage-level cross-module gates** (G-A, 7 in production) and **gate ambiguity** (G-D: "which stage?") | SEED-VS-REALITY §3 | condition forms `{source, stage}` and `{source, field, op, value}`, plus `stages[].gate` | 🟡 | The configurator needs UI and schema to author them; `manifest.schema.json` needs the fields. |
| 3 | **Form rendering from field definitions** | v5 fields are `{kind, required, validation: free text}` | `forms.py` → draft-07 JSON Schema + uiSchema; **rjsf 6.11.0** (Apache-2.0) in the browser; **jsonschema 4.26.0** (MIT) in the backend | ✅ | 123 real stage forms render. ajv8 == jsonschema on 725/725 submissions. File and person widgets are app-specific (F4). |
| 4 | **Field model richness** (G-F): repeaters (≤5 staggered rows, 11 budget heads), conditional visibility/requiredness, derived/read-only mirrors, per-tenant uniqueness | 12 distinct free-text hints stay unparsed (e.g. "≤ 5 rows {year, percent}", "required when the verdict is negative", "unique per workspace") | JSON Schema already covers repeaters (`type: array`), conditionals (`if/then`) and read-only fields, and rjsf renders all three. Uniqueness needs a DB check. Derived values need a formula (JsonLogic can compute them). | 🔴 | Extend the v5 field kinds (`repeater`, `conditional`, `derived`, `unique`), the forms compiler and the configurator UI. |
| 5 | **Workflow execution: stage progression + tier approvals** | no runtime for custom modules (D4) | **in-app interpreter** `runtime.py` (ours). SpiffWorkflow and Operaton were both run on the same module; see `OPERATON-SPIKE.md`. | ✅ | 11 real custom modules and all 9 production modules run end to end. F4 adds persistence (onto F2's tables) and routes. |
| 6 | **Send-back loops** (G-B: LOI send-back, negative DDR → revive, finance → pending, …) | v2 had `sendback` edges; v3–v5 dropped them | `send_back` back one tier or `to_stage` | 🟡 | Configurator authoring of the allowed send-back targets per stage. Today any earlier stage is allowed. |
| 7 | **Forward-only verdicts** (G-C, Launch loop) | SEED-VS-REALITY | `stages[].forward_only` | 🟡 | Configurator flag |
| 8 | **Decision ≠ roll-up** (G-E: DDR verdict, licence pending/done) | With v5's yes/no/n/a vocabulary, production **Legal and NSO park**; 8 fields need mapping (test) | `fields[].outcome_map` and field conditions | 🟡 | Configurator: per-option polarity. Also flag `affects_outcome` on text/file/number fields; the wizard templates set it, and roll-ups cannot score it. |
| 9 | **Multi-party sign-off / co-owned stages / committees** (G1, G-I, G4) | NSO's two sign-offs; QA co-owned by Project and PE | Design reference: **NocoBase Manual node** modes single / all / any (`plugin-workflow-manual/.../actions.ts`; design only, no code) → a `quorum` per step over named assignees | 🔴 | Runtime: quorum steps. Manifest: assignees or teams. |
| 10 | **Actor model** (G-G) | site creator approver, delegation, self-upload auto-approve, admin bypass + undo, observer | `runtime.py`: delegation, observer, admin override (flagged), separation of duties, self-approval collapse | ✅ partial | "Site creator" as an approver; **undo** (`reversible_actions`); admin override **conflicts with F2's guard** (for-F4 §4) |
| 11 | **Policy / authorization**: tier ceilings ⊇ grants, delegation, SoD | 5 of 16 seed permissions contradict production (SEED-VS-REALITY §5); `permissions[]` is not enforced anywhere | Now: in-app checks in the runtime plus the route layer. Next: **Cerbos** (Apache-2.0, PDP sidecar, CEL conditions, decision audit), with policies generated from `permissions[]` at publish. OpenFGA (ReBAC) later. | 🔴 | Enforce `permissions[].granted`; spike Cerbos. |
| 12 | **Version pinning** of in-flight cases | v5 "Live v7 · Draft v8" plus the stage-removal decision; NocoBase pins only single workflows | release id on the case (`runtime.py`) + `sites.config_release_id` (F2 migration `_4`) | ✅ | **Migrating** in-flight cases to vN (v5's "move them" choice) is open. Operaton's instance-migration API is the reference design. |
| 13 | **Audit / provenance** | v5 history hard-codes `platform:ops@matrix.io` / `11 Sep 2026`; NocoBase `createdAt` is the only real time | hash-chained runtime events (`verify_chain`, tamper test) → `audit_logs.provenance` (F2 `_6`); `module_approvals` append-only | ✅ | F4 publish must record the **real** platform-admin identity and time, not v5's hard-coded meta. |
| 14 | **BPMN/DMN interchange** | proposal D4 | `spikes/operaton/manifest_to_bpmn.py` (ours). It ran on **Operaton 2.1.5** (REST, send-back loop, COMPLETED) and **SpiffWorkflow 3.2.0** | ⚪ later | Expressions are engine-specific (JUEL vs Python), and BPMN-DI is not generated. Only needed if customers want BPMN. |
| 15 | **Graph canvas** (stage-level edges, send-back edges) | v5 canvas is module-level only, inside the dc-runtime | **xyflow** `@xyflow/react` 12.12.0 (MIT) + dagre (MIT); not bpmn-js (watermark clause) | ⚪ later | Comes with a native configurator rebuild (see #18). |
| 16 | **Multi-tab merge / conflicts** | web: whole-blob ETag, 409 → "server wins", the browser copy goes to a backup key; no merge | per-workspace ETags first; then 3-way merge with **jsondiffpatch** (MIT). CRDTs (Yjs, Automerge) are overkill. | 🔴 | Per-workspace concurrency in `/cfg/state`; then merge UI. |
| 17 | **Auth on the configurator** | standalone web has none (loopback + Host check only) | D1: inside the app's platform-admin portal, behind its own login. The platform key stays server-side. No OSS needed. | 🔴 (F4) | F4 integration |
| 18 | **Configurator runtime itself** | runs on the dc-runtime `support.js`: no licence, needs `'unsafe-eval'`, persistence bug shimmed | Keep it for Phase 2 (internal). Before external distribution, either confirm the terms or rebuild it natively in the app (React + xyflow + rjsf + the ported `validation.mjs`). | ⚪ later | Decision and rebuild |
| 19 | **CSP**: rjsf's ajv8 compiles validators with `new Function` | tested: with code generation disallowed, every submission fails, valid ones too | `@cfworker/json-schema` (MIT, no eval) adapter, or precompiled validators, or backend-only validation | ⚪ later | Before `vercel.json` moves from Report-Only to an enforced CSP |
| 20 | **Module ≠ team, work after exit, tenant facts in core** (G-H, G-J, G-K) | SEED-VS-REALITY | modelling: owner team ≠ module; post-exit stages; tenant settings | 🔴 | Manifest model work (configurator + F2 schema) |
| 21 | **Design-time store licence** | NocoBase §5.4 bans public low-code SaaS | keep NocoBase design-time only (D2); app tables are the runtime store | ⚪ watch | Legal opinion before any customer-facing use |
| 22 | **Demo-workspace edits are session-only** | web limitation (v5 persists only custom workspaces) | — | ⚪ by design | — |

## 2. What we adopted now (all tested on real data)

| Piece | Where | Licence | Proof |
|---|---|---|---|
| json-logic-js 2.0.5 | `third_party/json-logic-js/` (vendored, verbatim) | MIT | 278/278 classic suite; differential 548/548 |
| panzi-json-logic 1.0.1 | `third_party/panzi-json-logic/` (vendored, verbatim) | MIT | 277/278 (known bug, rejected by lint); differential 548/548 |
| JsonLogic compat suites | `third_party/json-logic-compat-tables/` (data) | Apache-2.0 | 1,138 cases run in both engines |
| @rjsf/core, utils, validator-ajv8 6.11.0 | npm dep, lockfile in `third_party/rjsf-check/` | Apache-2.0 | 123 forms rendered; 725/725 verdicts == jsonschema |
| jsonschema 4.26.0 | pip dep | MIT | same |
| Gate compiler + lint, forms compiler, runtime, F2 row mapping | `third_party/matrix-adapters/` (ours) | project | **36 tests green** |

## 3. Runtime decision

**In-app interpreter now. SpiffWorkflow and Operaton later.** Both engines ran the same module correctly,
but neither removes the work that matters here. The reasons:

1. **Authorization.** Tiers, delegation, separation of duties, observers and the admin bypass, plus field
   validation, remain app code in every option. The spikes confirmed both engines treat
   `candidateGroups`/`formData` as metadata.
2. **Licences.** SpiffWorkflow is LGPL-3.0 (usable as an unmodified dependency). Operaton is Apache-2.0, but
   it is a second runtime: an 815 MB image, ~0.5 GB RAM, its own DB schema and identity model, and REST that
   is open by default.
3. **Gate portability.** Gates must evaluate identically in the browser and the backend. JsonLogic gives us
   that, proven by the tests. The BPMN engines use JUEL (Operaton) or Python (Spiff) expressions.
4. **Team size and time to working.** `runtime.py` already runs all 9 production modules and 11 custom ones,
   and it maps onto F2's proposed tables. An engine adds integration and sync work before the first screen.
5. **Model fit.** v5 modules are linear stage lists with tier chains. BPMN pays off only once parallel
   branches, timers and escalations, or customer BPMN interchange are required. That is the trigger to
   revisit (gap #14).

## 4. Where we need to work more — recommended order

1. **F4, now.** Wire gates, forms and the runtime into the app:
   * publish compiles and lints;
   * map persistence onto F2's tables (add `module_records.runtime_state`);
   * routes `/m/{key}`, rjsf screens with file and person widgets;
   * set `admin_override=False` for custom modules (or relax F2's guard);
   * record the real publisher identity.
2. **Configurator authoring for the runtime extensions** (gaps #2, 6, 7, 8): stage gates, field conditions,
   send-back targets, forward-only, `outcome_map`. Also add publish findings for unparsed hints and for roll-up
   fields that cannot be scored.
3. **Field model** (gap #4): repeater, conditional, derived and unique kinds, then JSON Schema `array` /
   `if-then` / `readOnly`. rjsf already renders these.
4. **Multi-party sign-off** (gap #9): `quorum: single|all|any` steps, following NocoBase's Manual-node design.
5. **Policy** (gap #11): enforce `permissions[].granted`; time-boxed **Cerbos** spike generating policies from
   the manifest.
6. **Concurrency** (gap #16): per-workspace ETags, then jsondiffpatch merge.
7. **Hardening before external use** (gaps #18, 19, 21): a no-eval form validator for an enforced CSP; a
   decision on the dc-runtime (terms, or a native rebuild with xyflow); a NocoBase licence opinion.
8. **Optional, on demand** (gaps #12, 14): migration of in-flight cases between releases; a BPMN/DMN path via
   SpiffWorkflow (in-process) or Operaton (service). The generator and both spikes are ready.

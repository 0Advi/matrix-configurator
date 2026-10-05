# Seed vs reality — the v5 `bluetokai` seed against production Matrix-bd

**Compared:** `from-design/seed-workspaces.json` → `workspaces.bluetokai` (evaluated from
*Workspace Configurator v5.dc.html*, sha256 `b30033e9…2bda`) **vs** `from-matrix-bd/matrix-bd-flow.json`
(hand-modelled from Matrix-bd `origin/main` @ `3d4f277beb22c5be02c2abacea61b6afaee7cdeb`, 2026-09-17).
The numbers in §2 are **computed** by `scripts/build-matrix-bd-flow.mjs` (`comparisonWithV5Seed`) and
locked by `test/matrix-bd.test.mjs`.

## 1. Verdict

The seed gets the **map** right and the **mechanics** only partly right.

* **Topology: strong match.** All 9 seed modules exist in production, and production has no
  module the seed lacks. 7 of 9 entry gates name the same sources *and* outcomes. That includes the
  one real join: Design waits for **Legal (positive DDR) AND Finance/CA**, and the seed's
  "Diamond that closes at Design" is exactly `workflow_unlocks.design_unlock_ready()`. NSO is correctly
  supervisor-only. The sidebar navigation of BD, Legal, Design, Project, Project Excellence and NSO matches the
  real `Sidebar.jsx` label for label.
* **Process: simplified.** The seed has 25 stages; production needs 36 to tell the truth. The missing
  ones are mostly the **second approval tier** (Finance, PE budget, Financial Closure, Launch) and the
  **stage-level cross-module gates** that v5 cannot express at all (§3, G-A).
* **One wrong gate.** The seed has **NSO waiting on Project approved**. In production, NSO *opens* when
  **Finance/CA is approved** (`nso_service._trigger_one_unlocked`). Project only gates NSO's **stage 2**
  (initialization approved) and **stage 3** (project done and pushed, plus Legal licensing complete).
* **Fields are samples.** The seed carries **40** fields and the modelled reality **113**. For example, the seed has
  3 of the 9 DD items, 1 of the 5 licences, and one number where production has 11 budget heads. Field-key overlap is
  only 0.11 (Jaccard), partly because the keys are named differently. There are also two outright errors:
  **BOQ** is still a Design stage in the seed, but production has retired it and moved the 11-head budget to
  Project Excellence. The BD **score** is "0–100" in the seed, but production uses **1–5**.

## 2. Module by module

| Module (key) | Name seed → real | Gate seed → real | Stages seed → real | Approver match on shared stages | Notes |
|---|---|---|---|---|---|
| `bd` | BD → BD | entry → entry ✓ | 4 → 4 | 3/3 ✓ | Seed "LOI signed" by supervisor+admin. Real: the executive uploads, the supervisor **sends back** or **sends to Legal**. BD has no admin tier in production. Nav roles differ: DDR negative, Payment and Team are visible to executives too. |
| `legal` | Legal & Compliance ✓ | `bd:done` ✓ | 3 → 3 (same names) | 2/3 | Licensing is supervisor-only in production (the seed adds business admin). The DDR verdict is **stamped** by the supervisor, not computed from items. Change-request loop ✓ (`changeRequestLoop`). 9 DD items vs the seed's 3. |
| `finance_ca` | Finance / CA approval → **CA / Commercial Code** | `bd:done` ✓ (but see G-D) | 2 → 3 | — | Real: KYC + CA code + amount → **supervisor** → business admin. The seed's "Cost sheet: project/other cost" does not exist; that concept is the PE budget. |
| `design` | Design → Design / Technical | `legal:approved ∧ finance_ca:approved` ✓ | 5 → 4 | 2/4 | **BOQ retired** (`design_service._DELIVERABLE_KINDS = recce/2d/3d`). Recce is signed by the supervisor, not the executive. GFC is a **business-admin-only gate** that a supervisor requests. 2D and 3D need admin review ✓. |
| `pex` | Project Excellence ✓ | `design:approved` ✓ | 2 → 4 | 1/1 | The budget is **11 labelled heads**, not one "Budget lines (11)" number. There is a supervisor review tier. Quality-audit reports run *after* the exit and complete Project. |
| `project` | Project execution → Project Execution | `design:approved` ✓ | 3 → 5 | 1/1 | Real milestones: initialization (seeded by the PE approval) → expected completion → mid-project visit → quality audit (supervisor → admin) → push to NSO. |
| `nso` | NSO ✓ | `project:approved` → **`finance_ca:approved`** ✗ | 3 → 4 | — | Supervisor-only ✓. Each stage has its own cross-module gate (G-A). Licensing is a **read-only mirror** of Legal. |
| `launch_approval` | Launch approval → Launch Approval | `nso:done` ✓ | 1 → 5 | — | A **forward-only validation loop**: admin → site creator → supervisor → admin confirm (commits staged rent terms) → launch. |
| `financial_closure` | Financial Closure ✓ | `launch_approval:approved` → `:done` (same source, different token) | 2 → 4 | 1/1 | The admin *sends* for closure. The **Project** team enters actuals against the 11 GFC heads (variation), then supervisor → admin. |

Totals: 9/9 modules · gates 7/9 exact (8/9 same source) · supervisor-only 9/9 · stages 25 vs 36 ·
13 stage names shared · 10/13 approver sets equal on shared stages · mean field-key Jaccard 0.11.
The seed's `exit_signal` is `approved` on every module (the factory default). Its gates actually wait on
stage outcomes such as `bd:done` and `nso:done`, so `exit_signal` is decorative in the seed (only 3/9 agree with
the modelled reality).

## 3. What production does that the v5 model cannot express

Ordered by impact on a configurator that must be able to describe Blue Tokai *as it runs today*:

* **G-A Stage-level cross-module gates.** v5 gates whole modules only. Production gates individual stages:
  NSO stage 2 waits for Project initialization approved, and NSO stage 3 waits for a Project push, Legal
  licensing complete and Project done. Project initialization waits for the PE budget approval. The Project
  push to NSO waits for both PE quality-audit reports. Legal Agreement waits for a published positive DDR, and
  Licensing waits for an executed Agreement. Seven of these are recorded as `stageGate` annotations and collected in
  `matrix-bd-flow.json → x-matrix.stageLevelGates`. NSO stage 1 is the module entry gate itself.
* **G-B Send-backs and loops.** These include the LOI send-back, the negative DDR → change request → revive
  loop, finance rejects to pending, design re-upload / admin send-back / GFC → 3D, budget rejects, and undo
  (`reversible_actions`). v2 modelled these as `sendback` and `loop` edges. v3–v5 dropped them, so they are listed
  in `x-matrix.transitions`.
* **G-C Forward-only verdicts.** In the Launch loop, the creator and supervisor verdicts never bounce, and the admin
  confirm decides. None of v5's five roll-up strategies describes this.
* **G-D Gate ambiguity.** A v5 condition is `module is outcome`, not *which stage*. Finance really opens at
  **LOI upload**, while Legal opens at **send-to-legal**, and both happen inside BD's LOI stage. Both read as
  `bd:done`. Gates need a `(module, stage, outcome)` triple, or explicit signals (v3's `signals`).
* **G-E Decision ≠ roll-up.** DDR is a supervisor verdict with a reason that is required when the verdict is
  negative. Licensing *is* `all_positive` (yes/na), which matches v5. The NSO final needs both sign-offs. The
  quality audit can be completed by either of two modules.
* **G-F Field model.** Production needs:
  * repeaters (staggered escalation ≤ 5 rows, 11 budget heads)
  * conditional visibility (rent-type variants)
  * derived/read-only mirrors (NSO licences from Legal; `total_op_cost = (rent+cam)×1.18`)
  * per-tenant uniqueness (CA code)
  * one concept stored under different names per layer (`rent-terms.json → storageAliases`)

  v5 `KINDS` has none of these.
* **G-G Actor model.** Production needs:
  * a "site creator" approver (Launch)
  * per-site delegation as the executive's licence to act (`site_delegations`)
  * a supervisor's self-upload auto-approving
  * the business admin acting in any module through the guard bypass, plus undo
  * an observer that can read everything and write nothing

  v5 tiers are only supervisor / executive / business-admin sign-off.
* **G-H Module ≠ team.** Finance/CA and Launch have **no module** in production. Financial Closure is done by the
  **Project** team (`require_module('project')`). `quality_audit` is a delegation scope only. `payment` is retired
  but still admitted by the membership CHECK (migration `202606142`).
* **G-I Co-owned stages.** The quality audit is owned by Project *and* Project Excellence. This is the
  production instance of v5 capability **G1** (multi-party sign-off).
* **G-J Work after exit.** PE's quality-audit reports happen after PE's exit signal and feed another module's
  completion.
* **G-K Tenant facts in the core.** These include `nearest_starbucks_m` / `nearest_twc_m` columns, the 18 % GST
  multiplier, the `BT-` site-code prefix, and India-specific licence columns. They belong in tenant configuration,
  and the seed rightly omits them.

## 4. The seed's planned capabilities (G1–G4) against production

| Cap | Seed claim | Production evidence |
|---|---|---|
| G1 multi-party sign-off | not expressible | Quality audit co-owned by Project and PE. NSO needs `final_signoff_1` and `final_signoff_2`. The Launch loop has three parties. All hard-coded per module. |
| G2 editable gates on built-ins | not expressible | Confirmed. Order is stated in 4 places that must agree by hand: `state_machine.py` (and its JS mirror), `workflow_unlocks.py`, per-service `_assert_*_unlocked`, and the `sites.*` mirror columns. See `docs/14-dynamic-platform/dynamic-flow-transformation-plan.html` §2 in the repo. |
| G3 launch hard-wired after NSO | not expressible | Confirmed. The `launch_approvals` row is *created* by `nso_service.svc_final_approval`. |
| G4 committee approvers | business admin stands in | Confirmed. No committee or role concept beyond the four-role enum. |

## 5. Permissions (v5 ceiling vs routes)

Of 16 seed actions, **8 match** the real route guards, **3 partially match** and **5 contradict** them. See
`rbac.json → comparisonWithV5Ceiling`. The contradictions:
* `submit_details_for_review` and `upload_loi` are executive-only in production.
* `archive` is a *supervisor* action with a required note.
* `push_to_payments` is really the BD **supervisor**'s "send to Legal".
* `legal_raise_change_request` is raised by BD (executive or supervisor) and approved by the Legal supervisor.

Production has **no per-tenant narrowing** of permissions. The seed's "granted ⊆ ceiling" overlay is a new
capability, not a port.

## 6. Using the real flow in the configurator

```js
import flow from './matrix-bd-flow.json' with { type: 'json' };
import { toV5WorkspaceDocument, toV5Manifest } from './flow-adapter.mjs';
const state = toV5WorkspaceDocument(flow);   // validates against workspace.schema.json
const manifest = toV5Manifest(flow);         // validates against manifest.schema.json
```

The imported document passes the ported v5 `findings()` with **zero findings**, which the tests prove. It can
be loaded as a custom workspace, for example through `PUT /cfg/state`, to diff against the seed. Everything v5
cannot represent stays in the `x-matrix` annotations rather than being lost.

## 7. Confidence

* **Verified:** module set, gates, statuses, actors, routes and guards. Every cited route resolves in the
  machine-extracted `route-guards.json` (tested). The rent model, budget heads and NSO stage gates are all
  read from source at the SHA.
* **Interpretation:** mapping real statuses onto v5's 8 `OUTCOMES`, and where stage boundaries fall inside
  long single-row workflows (Project milestones, the Launch loop). The real status is kept beside every
  stage in `x-matrix.realState`.
* **By construction:** where a real step is the same step as a seed stage, the seed's stage name was reused.
  That keeps the shared-stage count (13) meaningful for comparing approvers, but it is not a claim about UI wording.
* **Not covered:** runtime data (counts, SLAs). Only code was read; no database was touched.

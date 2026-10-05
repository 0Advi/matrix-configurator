# Proposed patches (G2): not applied

These are proposed corrections to our model. **Nothing in this folder has been applied.** G3 or the lead decides what to apply. Each patch names the discrepancy it fixes (`Dxx`, see `../crosscheck.json` and `../REPORT.md`). `../test/crosscheck.test.mjs` proves that each patch applies cleanly to the file it targets and has the effect described here.

| # | File | Target | Fixes | Kind |
|---|---|---|---|---|
| 01 | `01-build-matrix-bd-flow.mjs.diff` | `building-blocks/scripts/build-matrix-bd-flow.mjs` (the generator) | D03, D04, D10, D11, D15, D17, D26, D30 | unified diff: **the change to apply** |
| 01 | `01-matrix-bd-flow.json-patch.json` | `building-blocks/from-matrix-bd/matrix-bd-flow.json` (sha256 `4700783466ba…`) | same | RFC 6902 patch (41 ops), equal to *regenerated output minus current output*; for review and verification only |
| 02 | `02-module_catalog-corrections.json` | `public.module_catalog` | D18, D19, D20, D21 | source of truth for the two files below |
| 02 | `02-module_catalog-corrections.sql` | existing databases | same | proposed forward migration `20261005_1_…` (UPDATEs, idempotent) |
| 02 | `02-module_catalog-seed.diff` | `app/backend/database/migrations/20261004_2_…sql` | same | the same values in the seed, for fresh installs |
| 02b | `02b-site_module_outcomes-optional.sql` | view `public.site_module_outcomes` (20261004_5) | D19 (remaining), D03 (signal) | **optional** view replacement. Not executed anywhere [I: syntax not run against Postgres] |
| 03 | `03-approvals.json-patch.json` | `building-blocks/from-matrix-bd/approvals.json` (hand-curated) | D04 | RFC 6902, 1 op + test |

## 01: matrix-bd-flow (apply through the generator)

`matrix-bd-flow.json` says *"edit the script, not this file"*. Apply the `.diff` to the script and run `node scripts/build-matrix-bd-flow.mjs`. I checked this in a scratch copy of `building-blocks/`:

* The unpatched script reproduces today's file byte for byte.
* The patched script writes a file (sha256 `3ee69173c323…`) equal to *current + the JSON patch*.
* In the patched copy, `test/matrix-bd.test.mjs` and `test/schemas.test.mjs` pass: the v5 manifest/workspace validation, `findings() == []`, and every cited route resolving.
* One schema test fails, but it fails the same way on the *unpatched* copy, because it needs `../sources/`.

| Id | Change | Why (real app @3d4f277) |
|---|---|---|
| F-01 | BD stage 1 note: no supervisor auto-shortlist; supervisors may shortlist their own draft | `bd_service.py:159-167` (commit cd70220, 2026-07-14), `:56-80` |
| F-02 | `x-matrix.gateTriple` on `legal` (bd/LOI/`send_to_legal`) and `finance_ca` (bd/LOI/`loi_uploaded`, closed while `legal_rejected`). The v5 gates stay `bd:done`, marked as an approximation | `finance_service.py:35-38,126-130,176-180`; `bd_service.py:566-579` |
| F-03 | PE stage 3 *Admin review* gets the required field `pex_initialization_date`, plus the hand-over note | `project_excellence_service.py:562-577`; `project_service.py:129-149` |
| F-04 | Project stage 1 actors: the business admin proposes the date through the PE approval (primary path). The supervisor's proposal is the recovery path | `project_service.py:738-763` (docstring: "Recovery path") |
| F-05 | Project stage 4 *Quality audit*: approvers `['supervisor']`, `coOwner` = PE supervisor ("Completed"), business-admin confirm marked LEGACY | `project_service.py:1142-1178`; `SiteApprovalPanel.jsx:666-677` |
| F-06 | NSO stage 4 note: the sign-offs are captured in the stage-three form | `nso_service.py:696-757` |
| F-07 | Financial Closure: the stage-1 `stageGate` and module `realGate` require an approved PE budget. The generator then adds it to `x-matrix.stageLevelGates` | `financial_closure_service.py:309-311` |
| F-08 | Launch stage 2 `creatorRule`: `submitted_by OR assigned_to`, executive or supervisor, no business-admin bypass, frontend divergence noted | `launch_service.py:588-641`; `LaunchPage.jsx:163-170` |
| F-09 | Flow-level `x-matrix.executiveScope`: the canonical creator rule (BD) versus delegation scope (module executives) | see `../for-G3.md` §1 |

Computed side effect: `comparisonWithV5Seed.summary.approverMatchesOnSharedStages` goes from 10 to 9, because the seed's *Quality audit* still lists the business admin. After applying, update the sentence "10/13 approver sets equal" in `building-blocks/from-matrix-bd/SEED-VS-REALITY.md` §2. No test locks that number.

Not proposed:
* Moving `final_signoff_1/2` from NSO stage 4 to stage 3 (D30). F-06 only annotates. Moving them is correct but changes field counts per stage, so the lead should decide.
* Changing the v5 `finance_ca` gate itself (D03). The v5 vocabulary cannot express it, and changing it would flip `comparisonWithV5Seed.gatesMatch`, which `test/matrix-bd.test.mjs` locks.

## 02: module_catalog

The seed in `20261004_2` uses `ON CONFLICT DO NOTHING`. Editing the seed therefore never reaches an existing database. Apply `02-module_catalog-corrections.sql` as a new migration. If you also want fresh installs to start correct, apply `02-module_catalog-seed.diff`.

| Row | Change | Why |
|---|---|---|
| `bd` | `loi_uploaded` → outcome `submitted`; it no longer reaches `done`. `shortlisted` → `allocated`; `allocated` added to every later reached list. `in progress` is kept for backward compatibility | D18: send-back `loi_uploaded → approved` exists (`state_machine.py:39-40`), and the flow's exitSignal is send-to-Legal. D19: the flow's *Shortlist review* outcome is `allocated` |
| `project_excellence` | drop the dead `done` key; `approved` also reaches `submitted` | D21: the status is never `done` (`project_excellence_service.py:371,461,572`) |
| `project` | `done` also reaches `submitted` and `approved` | D19: `done` requires the expected completion and the quality audit to be approved (`project_service.py:675-686`) |
| `nso` | `in_progress` / `complete` also reach `submitted` | D19: `in_progress` implies stage one is complete or was stamped by the Project push (`nso_service.py:185-194,310-334`) |
| `financial_closure` | `closed` also reaches `submitted` | D19 |
| names | `CA / Commercial Code`, `Design / Technical`, `Project Execution`, `Launch Approval`, `Financial Closure` | D20: the real titles (`site_stage_status_service.py:308-318`), which match our flow. *Cosmetic*: they only seed `tenant_modules.label` for **new** tenants. If adopted, also update the mirror in `app/backend/tests/conftest.py:224-234` |

After 02, two outcomes the flow offers are still unobservable. Both are listed in `knownUnreachableAfterPatch`:

* `legal:submitted`: the agreement status lives in `sites.agreement_status`.
* `pex:done`: the QA reports live in `quality_audit_reports`.

Three outcomes are *late approximations*: `pex:submitted`, `project:submitted|approved` and `fc:submitted`. They are reported only once the module reaches a later status, so a gate on them opens later than in reality, never earlier.

**02b (optional)** replaces the view so those facts become observable. It also exposes `bd_loi:done`, which is Finance's real entry condition, as a pseudo-source for custom modules. A manifest uses it by declaring `signals: [{"key":"bd_loi","outcomes":["done"]}]`.

**Recommendation R4, which needs no data change:** the configurator should warn when a gate on a *built-in* source names an outcome the catalog cannot report. The test computes that set (`unreachable()` in `../test/crosscheck.test.mjs`), so the validator can reuse the same logic.

## 03: approvals.json

The `bd_shortlist` step 1 claims `shortlisted (supervisor-created drafts skip review)`. The patch replaces it with `draft_submitted (every creator; no supervisor auto-shortlist since Matrix-bd cd70220, 2026-07-14)`. The file is hand-curated, so apply the patch directly.

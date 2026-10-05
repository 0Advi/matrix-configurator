# Catalogue cross-check — REPORT (Phase 2b item #5)

> **Provenance:** authored by workstream G2 (catalogue cross-check, 2026-10-05). G2's own write of this file was
> blocked by the harness ("Subagents should return findings as text, not write report files"); the lead recorded
> the content below from G2's handback, with the user's approval. Full tables are machine-readable in
> `crosscheck.json` (rows `operatonTasks`, `ourStages`, `catalogRows`, `ordering`, `discrepancies`). The appendix
> is the lead's own, clearly separated.
>
> Three models compared: **operaton-plat** catalogue (the user's repo, commit `fc65499`), **our model**
> (`building-blocks/from-matrix-bd/matrix-bd-flow.json` + the sandbox `module_catalog` seed + the v5 seed), and
> **ground truth** = the real app, Matrix-bd `origin/main` @ `3d4f277`. Tags: **[V]** read in source at the pinned
> commit, **[I]** inferred.

## Verdict: our `matrix-bd-flow.json` is the closest to the real app
- **Ours:** 30 of 36 stages match; all 9 module entry gates name the right sources.
- **operaton-plat:** the shape is right — Legal and Finance in parallel after LOI, a join before Design, review
  loops, forward-only Launch. Of its 55 tasks, 29 match, 18 are partial, 4 are wrong or have the wrong role, and 4
  (BOQ ×2, `design_final`, `nso_project_signoff`) don't exist in the real app.

Completeness test (offline, 16/16): `node --test docs/catalogue-crosscheck/test/crosscheck.test.mjs` — every
operaton-plat module and all 54 tasks + start form, all 36 of our stages and all 11 `module_catalog` rows are mapped
exactly once with consistent cross-links; every cited real-app route exists in `route-guards.json`; every evidence
string is tagged [V]/[I]; each proposed patch applies cleanly and has the claimed effect.

## Top discrepancies (ground truth: Matrix-bd `origin/main` @ `3d4f277`, all [V])
- **D01, high — NSO entry.** NSO opens when Finance/CA is approved and a CA code exists
  (`nso_service.py:206-207, 484-485, 613-614`). Project only gates NSO stage 2 (initialization approved,
  `:254-255`) and stage 3 (push + project done + Legal licensing, `:258-272`). operaton-plat and the v5 seed put
  NSO after Project.
- **D02, high — Design join.** Design waits only for a positive DDR plus Finance approval
  (`workflow_unlocks.py:25-29`, `design_service.py:230-244`). Agreement and Licensing run in parallel with Design.
  operaton-plat waits for all of Legal.
- **D04, high — supervisor skip.** Supervisor-created drafts no longer skip draft review: removed in `cd70220` on
  2026-07-14 (`bd_service.py:159-167`). operaton-plat's `skip_if` is obsolete, and our own flow note
  (`matrix-bd-flow.json:146`, generator line 67) and `approvals.json` are stale.
- **D09, high — Design steps.** BOQ is retired; 3D needs a business-admin review; the supervisor requests GFC;
  GFC approval ends Design (`design_service.py:73-82, 1504-1549, 1660-1669`).
- **D11, high — quality-audit sign-off.** The second-tier QA sign-off is now the Project Excellence supervisor.
  The business-admin route still exists but its screen is read-only (`project_service.py:1142-1178`,
  `SiteApprovalPanel.jsx:666-677`). operaton-plat, ours and the seed are all stale.
- **D13, high — NSO roles.** NSO is supervisor-only (`routers/nso.py:32-33`). There are no NSO executives and no
  project-supervisor sign-off; the two sign-offs are NSO-supervisor checkboxes (`nso_service.py:717-718`).
- **D03, medium — Finance timing.** Finance opens at LOI upload, before send-to-Legal, and is closed while the site
  is legal-rejected (`finance_service.py:35-38, 126-130`).
- **D18, medium — catalog mapping.** The catalog maps `loi_uploaded` to `done`. That contradicts our flow's BD exit
  (send to Legal) and the real LOI send-back (`state_machine.py:39-40`). A custom module gated on "BD done" would
  open at upload and stay open after a send-back.
- **D19, medium — unreachable outcomes.** The catalog can never report: bd `allocated`; legal `submitted`; pex
  `submitted` and `done`; project `submitted` and `approved`; nso `submitted`; financial closure `submitted`.
  A configurator gate on any of these never opens.
- **D10, medium — PE → Project hand-over.** The PE business-admin approval must set the Project initialization
  date, which hands the site to Project (`project_excellence_service.py:562-577`). Project itself opens at GFC, in
  parallel with PE (`project_service.py:67-71`).

## Module decomposition rulings
- **LOI is a BD stage, not a module.** It has its own `/api/loi` router, but no membership, no sidebar entry, and
  its states live in the BD status column; the process-flow view titles it "BD LOI Signed"
  (`site_stage_status_service.py:309-310`). Ours is right; operaton-plat's `bd_loi` is only a sub-process split.
- **Finance/CA has no module or membership** — it lives in BD plus the business-admin portal. Its real title is
  "CA / Commercial Code".
- **Launch has no module.** It is a loop created by the NSO final approval.
- **Financial Closure** is a delegation scope run by the Project team.
- **PE budget** is the same module as Project Excellence.

## Ordering and joins (from `crosscheck.json → ordering`)
- Correct in all models: start → BD, LOI → Legal, Legal ∥ Finance, Design → PE, NSO → Launch.
- Finance after LOI: operaton-plat starts it too late (D03).
- Join before Design: operaton-plat is too strict (D02).
- Design → Project: operaton-plat chains PE then Project serially; really Project runs in parallel with PE (D10).
- Finance → NSO, Project init → NSO stage 2, push → NSO stage 3, PE QA reports → push: only ours has these (D01, D12).
- Launch → Closure: ours lacks the PE-budget baseline (D17).
- **Why operaton-plat and the seed look linear (D29):** the real app's own read-only process-flow view draws a
  straight chain (`site_stage_status_service.py:97-138`), while the enforced gates are parallel.

## Creator-scoped rule (full detail in `for-G3.md`)
- **Real rule:** a site belongs to `submitted_by OR assigned_to`. It applies when the effective role is executive,
  to lists (`_common.py:180-194`), reads (`query_service.py:173-183`, `_common.py:131-141`) and writes (details
  `bd_service.py:83-101`, LOI `loi_service.py:44-59`, finance `:124,174`, change requests `:164`).
- **Launch creator review** applies the same test to any role, with no business-admin bypass (`launch_service.py:607-617`).
- **Hand-over:** a supervisor's reassign sets `assigned_to` (`bd_service.py:741-771`); the submitter keeps access.
- **Module executives** (legal, design, PE, project, closure) are scoped by per-site delegation instead, not by creation.
- **operaton-plat** expresses the rule as `assignee: ${initiator}` (`matrix.py:240-242`) — immutable, tasks only:
  no lists, no reads, no hand-over.
- **Our sandbox runtime** scopes executives per record (`module_runtime_service.py:494-508`), not per site.
- `for-G3.md` has the 11 enforcement points, 12 edge cases and a suggested per-module `executive_scope` switch.

## Roles and views
- **Real app:** 4 roles × module membership, and no saved views — each role gets fixed pages. The business admin
  gets an Approval Center (Design/Payment/Budget/Quality/Closure) plus Launch, Financial Closure, Departments and
  Sites tabs; the observer gets Sites and Departments.
- **operaton-plat:** 14 department groups and three task-list filters (My tasks / Team queue / Admin approvals).
  Its `nsoExecutive` group has no real equivalent.
- **Real-app gap (D22):** the BD, Finance-supervisor and Launch-supervisor routes check role only, not module, so
  any supervisor passes.

## Task-level detail
- All 55 operaton-plat tasks against our stages and the real actor/route: `crosscheck.json → operatonTasks`.
- Our 6 partial stages: bd/1 (D04), pex/3 (D10), project/1 (D10), project/4 (D11), nso/4 (D30), financial_closure/1 (D17).
- Catalog rows: `bd`, `legal`, `project_excellence`, `project`, `nso` and `financial_closure` are partial; the others match.
- Full register: D01–D33 in `crosscheck.json → discrepancies`.

## Proposed patches (`proposed-patches/`, not applied by G2)
- **01:** generator diff to `build-matrix-bd-flow.mjs` (+ 41-op JSON Patch of the output). Fixes D04, D10, D11,
  D15, D17, D30; adds structured `gateTriple`, `creatorRule`, `executiveScope`. Side effect: the seed-comparison
  count of matching approvers drops 10 → 9, so `SEED-VS-REALITY.md` needs that figure updated.
- **02:** `module_catalog` corrections as JSON, a forward migration (UPDATEs) and a seed diff. Fixes D18, D19, D21;
  label renames (D20) optional and cosmetic.
- **02b (optional):** a view change exposing Agreement, PE QA reports and a `bd_loi` signal — SQL not run against Postgres [I].
- **03:** a one-line `approvals.json` fix for the stale skip claim.

## Recommendations
1. Keep our flow as the reference and apply patch 01 through the generator.
2. Apply 03.
3. Apply 02 as a new migration; consider 02b.
4. Add a configurator warning for gates on built-in outcomes the catalog can't report (reuse `unreachable()` from the test).
5. operaton-plat fixes, if it stays as a demo, are listed in D01/D02/D03/D04/D09/D11/D13.
6. G3: apply the creator rule site-wide, and treat views as audience-only filters over server-side scope.
7. Report the real-app quirks D22, D31 and D32 upstream.

**Confidence:** everything above is read in source at the pinned commit [V], except the status→outcome
interpretation, edge cases E7/E11/E12 and 02b [I].

**Process:** the real app was only read with `git --no-optional-locks show/grep origin/main` — no fetch, checkout,
write, or `.env`; no running services touched. operaton-plat was read with `gh api` at a pinned commit; its
`workspace.json` holds demo passwords — G2 only checked it equals the catalogue plus passwords and did not vendor it.

---

## Appendix — lead's independent confirmation (not part of G2's text)
- Completeness test re-run by the lead: **16/16 pass**.
- Patches confirmed **not applied** by G2: `matrix-bd-flow.json` (2026-10-03 20:29), `approvals.json`
  (2026-10-03 20:21) and migration `20261004_2_…` (2026-10-04 07:15) all predate G2; no migration was added.
- User decision (2026-10-05): **apply 01, 02 and 03** as soon as phase G3 finishes (queued in
  `docs/PHASE2-PLAN.md` → "Approved fix queue"). **02b not approved.**

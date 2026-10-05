# Matrix-bd approval flows

Source: Matrix-bd `origin/main` @ `3d4f277beb22`. Full data, with every step's actor, route and source, is in
`approvals.json`. Its status vocabularies are cross-checked against the parsed CHECK constraints in
`modules-and-vocabularies.json` by `test/matrix-bd.test.mjs`.

## Site-workflow approvals (17)

| # | Flow | Module | Pattern | State / status vocabulary | Tier 1 → tier 2 | Loops |
|---|---|---|---|---|---|---|
| 1 | Shortlist | bd | one level | `sites.status` draft_submitted → shortlisted | supervisor | reject / archive (revive) |
| 2 | Site details | bd | one level | shortlisted → details_submitted → approved | exec submits → supervisor | admin **undo** |
| 3 | LOI | bd | one level | approved → loi_uploaded → legal_review | exec uploads → supervisor sends to Legal | **send-back** → approved |
| 4 | DDR | legal | checklist + one level | `legal_dd_checklist` stage draft/pending_review/published; items pending/yes/no/na; verdict positive/negative | exec (delegated) → supervisor **stamps** the verdict | negative → legal_rejected |
| 5 | Change request | legal (raised by BD) | cross-module | `legal_change_requests` pending/approved/rejected | BD exec/sup → legal supervisor | approval may revive legal_rejected → legal_review |
| 6 | Agreement | legal | supervisor only | `agreement_status` pending/signed/registered | supervisor | — |
| 7 | Licensing | legal | checklist (all_positive) | `licensing_status` pending/partial/complete | exec (delegated) → supervisor | — |
| 8 | Finance / CA | — (BD site tracker) | **two level** | `finance_status` pending → awaiting_supervisor → awaiting_admin → approved | exec → supervisor → business admin | either tier → pending |
| 9 | Design deliverables | design | two level (recce: one) | deliverable pending/submitted/approved/rejected + admin_status | exec → supervisor → admin (2D, 3D) | re-upload; admin send-back; undo |
| 10 | GFC | design | admin gate | `design_status` → gfc_pending → approved | supervisor requests → **business admin** | reject → 3D |
| 11 | PE GFC budget | project_excellence | two level | `site_budgets` draft → pending_supervisor → pending_admin → approved/rejected | exec → supervisor → admin | reject → resubmit |
| 12 | Project milestones | project | one level per date | initialization pending/proposed/submitted/approved/rejected; expected completion pending/submitted/approved/rejected | supervisor ⇄ executive | exec rejects a proposed date → supervisor finalises |
| 13 | Quality audit | project + PE | two level / supervisor only | pending → submitted → supervisor_approved → approved | exec → supervisor → admin, **or** PE supervisor | reject |
| 14 | Push to NSO | project → nso | supervisor only | `nso_status` pending → pushed | supervisor | — |
| 15 | NSO readiness | nso | supervisor only, staged | stage_one … final → done; nso_status pending/in_progress/complete | supervisor | — |
| 16 | Launch validation | — (admin portal) | **forward-only loop** | pending_admin_review → under_exec_review → under_supervisor_review → pending_admin_final → ready_to_launch → launched | admin → site creator → supervisor → admin confirm → launch | verdicts never bounce |
| 17 | Financial closure | financial_closure (Project team) | two level + admin gate | `site_budgets(closure)`; `financial_closure_status` pending/open/allocated/budgeting/closed | admin sends → exec → supervisor → admin finalise | reject → resubmit |

Plus six **access approvals**: supervisor, executive and observer sign-ups; supervisor executive-access;
workspace requests; password resets.

## What the catalogue shows

* **One doctrine, many vocabularies.** Most flows are "executive captures → supervisor reviews → business admin
  confirms", but each spells its states differently: `awaiting_supervisor` vs `pending_supervisor` vs
  `supervisor_approved` vs `under_supervisor_review`. A configurator can normalise them to v5's outcomes plus
  a per-stage `realState`, as `matrix-bd-flow.json` does.
* **The repo has already described the module contract** (`docs/14-dynamic-platform/dynamic-flow-transformation-plan.html`
  §3): a fixed internal approval template, an entry gate and an exit signal, which is the "mirror column".
  This is the same split as the v5 module (stages fixed for built-ins; gate + exit configurable).
* **Exceptions that a template engine must still allow:**
  * the forward-only Launch loop
  * supervisor-only NSO
  * the admin-only GFC gate
  * checklist roll-ups (Licensing = all yes/na) next to stamped verdicts (DDR)
  * co-owned stages (quality audit)
  * per-site delegation as the executive's licence to act
  * undo of a decision (`reversible_actions`)

# Rent terms — a reusable field group

Source: Matrix-bd `origin/main` @ `3d4f277beb22`. Machine-readable definition: `rent-terms.json`.

The rent model is the most re-used form in Matrix-bd. It appears at four points:
* BD draft creation (`CreateDraftRequest`)
* site details (`SaveDetailsRequest`)
* the Launch validation loop, where rent is edited on a staging row (`LaunchRentFieldsRequest`)
* the read views (`RentTimeline`, `ClosureDetailsDrawer`)

It is the best first candidate for a configurator **field group**: a named, versioned bundle of fields that
can be dropped into any stage.

## Variants (discriminator `rent_type`)

| `rent_type` | UI label | Fields shown |
|---|---|---|
| `fixed` | Fixed + escalation | expected rent ₹/mo, escalation %, cadence (1 / 3 / 5 yrs) |
| `revshare` | Revenue share | revenue share % of sales |
| `mg_revshare` | MG + Revenue share | minimum guarantee ₹/mo, revenue share % above MG, escalation %, cadence |
| `staggered` | Staggered Rent with Escalation | base rent ₹/mo (**required**) + schedule of ≤ 5 rows `{year, percent}` (**required**, unique years) |
| *(all)* | — | rent-free days, lock-in months, tenure months |
| *(FEATURE_RENT_V2)* | REV SHARE split | Dine-in % / Delivery % of sales, top-level and per schedule row; optional per-year `mg` |

The constraints are enforced twice:
* **Pydantic:** the `RentType` Literal turns a bad value into a clean 422; percentages are bounded 0–100; the
  staggered requirements live in `_staggered_requirements`.
* **Postgres:** `chk_sites_rent_type`, `chk_revshare_*_range`, and `is_valid_staggered_escalation(jsonb)`, which
  also accepts JSON `null` (migration `20260731`).

## V2 presentation (feature-flagged)

`RentTermsFormV2` asks a single question: **"Is the rent staggered?"** No means `fixed`, and yes means `staggered`.
A REV SHARE toggle adds the dine-in/delivery split on either path. The legacy `revshare` / `mg_revshare`
records render read-only with a logged "Convert to flat / staggered" action. It is the same storage behind a
simpler question. The configurator should treat this as a *presentation* of one field group, not as a second
model.

## Gotchas a configurator must model

* **One concept, four column names.** For example, the escalation % is:
  * `expected_escalation_pct` on `sites`
  * `escalation` in the details form
  * `escalation_pct` in `site_details` and in the launch staging row

  `rent-terms.json → storageAliases` lists them all. Field keys in the configurator should be canonical, with a
  per-binding storage map.
* **Repeaters and conditional visibility** are required. The staggered schedule is a repeater, and fields
  appear by variant. v5 `KINDS` has neither (see SEED-VS-REALITY G-F).
* **Edit rights vary by workflow state**:
  * In the Launch loop, business admin edits at `pending_admin_review` / `pending_admin_final`, and supervisor
    edits at `under_supervisor_review`.
  * The site creator may edit only `rent_start_date`, at `under_exec_review`.
  * Edits are **staged**, and only the admin's final confirm commits them to `sites` + `site_details`.

  Field-level, state-dependent permissions are a capability v5 does not have.
* **Derived values hard-code tenant facts.** `total_op_cost = (rent + cam) × 1.18` bakes in 18 % GST
  (`backend/app/services/_common.py`). It belongs in tenant configuration.

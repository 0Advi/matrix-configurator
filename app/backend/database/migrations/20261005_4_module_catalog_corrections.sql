-- 20261005_4 — module_catalog corrections (G2 catalogue cross-check, patch 02; fixes D18, D19, D20, D21).
-- Approved by the user 2026-10-05 and applied by the lead after phase G3 (named _4 to sort after G3's 20261005_1..3).
-- Source of truth: docs/catalogue-crosscheck/proposed-patches/02-module_catalog-corrections.json. Forward-only UPDATEs,
-- idempotent. The 20261004_2 seed is deliberately NOT edited (applied files are checksummed by the runner); on a fresh
-- install this file runs after the seed, so fresh installs end up corrected too.
--
-- Corrects the module_catalog seed of 20261004_2 (which uses ON CONFLICT DO NOTHING, so an edited seed
-- alone would never reach an existing database). Data-only, idempotent, transactional by the runner.
-- Rationale per row: docs/catalogue-crosscheck/proposed-patches/README.md + crosscheck.json D18–D21.
-- tenant_modules.label is NOT touched: it is the tenant's own label, projected from its live release.
--
-- ROLLBACK: re-run the 20261004_2 VALUES as UPDATEs (the original literals are in that file).

-- bd: D18: loi_uploaded is not BD's hand-off (send-back to approved is possible; flow exitSignal = send to Legal); D19: flow stage 'Shortlist review' outcome 'allocated' was unreachable
UPDATE public.module_catalog
   SET outcome_map = '{"draft_submitted":"submitted","shortlisted":"allocated","details_submitted":"submitted","approved":"approved","loi_uploaded":"submitted","legal_review":"done","legal_approved":"done","legal_rejected":"done","pushed_to_payments":"done","rejected":"rejected","archived":"skipped"}'::jsonb,
       reached_map = '{"draft_submitted":["submitted"],"shortlisted":["submitted","in progress","allocated"],"details_submitted":["submitted","in progress","allocated"],"approved":["submitted","in progress","allocated","approved"],"loi_uploaded":["submitted","in progress","allocated","approved"],"legal_review":["submitted","in progress","allocated","approved","done"],"legal_approved":["submitted","in progress","allocated","approved","done"],"legal_rejected":["submitted","in progress","allocated","approved","done"],"pushed_to_payments":["submitted","in progress","allocated","approved","done"],"rejected":["submitted","rejected"],"archived":["submitted","skipped"]}'::jsonb
 WHERE key = 'bd';

-- finance_ca: D20: real title 'CA / Commercial Code' (site_stage_status_service.py:312)
UPDATE public.module_catalog
   SET name = 'CA / Commercial Code'
 WHERE key = 'finance_ca';

-- design: D20: real title 'Design / Technical'
UPDATE public.module_catalog
   SET name = 'Design / Technical'
 WHERE key = 'design';

-- project_excellence: D21: 'done' is never a project_excellence_status value; D19: approval implies the budget was submitted
UPDATE public.module_catalog
   SET reached_map = '{"allocated":["allocated"],"budgeting":["allocated","in progress"],"approved":["allocated","in progress","submitted","approved"]}'::jsonb
 WHERE key = 'project_excellence';

-- project: D19: project_status 'done' is only reachable after expected completion was submitted/approved and the quality audit approved; D20: 'Project Execution'
UPDATE public.module_catalog
   SET name = 'Project Execution',
       reached_map = '{"allocated":["allocated"],"budgeting":["allocated","in progress"],"in_progress":["allocated","in progress"],"done":["allocated","in progress","submitted","approved","done"]}'::jsonb
 WHERE key = 'project';

-- nso: D19: nso_status in_progress implies stage one complete (or stamped by the Project push), i.e. stage-1 outcome 'submitted'
UPDATE public.module_catalog
   SET reached_map = '{"in_progress":["submitted","in progress"],"complete":["submitted","in progress","done"]}'::jsonb
 WHERE key = 'nso';

-- launch_approval: D20: 'Launch Approval'
UPDATE public.module_catalog
   SET name = 'Launch Approval'
 WHERE key = 'launch_approval';

-- financial_closure: D19: 'closed' implies the actuals were submitted; D20: 'Financial Closure'
UPDATE public.module_catalog
   SET name = 'Financial Closure',
       reached_map = '{"allocated":["allocated"],"budgeting":["allocated","in progress"],"closed":["allocated","in progress","submitted","done"]}'::jsonb
 WHERE key = 'financial_closure';

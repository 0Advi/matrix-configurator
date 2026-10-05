-- PROPOSED (G2, 2026-10-05) — OPTIONAL, NOT APPLIED. Suggested name: 20261005_2_site_module_outcomes_stage_facts.sql
-- Replaces public.site_module_outcomes (20261004_5) with three extra built-in facts so that outcomes
-- our flow model offers become observable by the gate evaluator:
--   * legal  'submitted'  when sites.agreement_status is signed/registered (flow stage 'Agreement')          — D19
--   * pex    'done'       when BOTH quality_audit_reports (before, after) are pushed (flow stage 'QA reports') — D19
--   * bd_loi 'done'       pseudo-source = Finance's real entry gate (status in finance_service._LOI_AND_BEYOND) — D03
--     A manifest that gates on it must declare  signals: [{"key": "bd_loi", "outcomes": ["done"]}]
--     (validate.py accepts signal keys; module_runtime_service.build_facts reads every row of this view).
-- Same columns, same order, so CREATE OR REPLACE is legal. Run after 02-module_catalog-corrections.sql.
-- quality_audit_reports: UNIQUE (site_id, kind), kind IN ('before','after') — Matrix-bd 20260804_quality_audit_reports.sql:20-33.

CREATE OR REPLACE VIEW public.site_module_outcomes
WITH (security_invoker = true) AS
WITH builtin_raw AS (
    SELECT s.tenant_id, s.id AS site_id, v.module_key, v.raw_status, v.extra_reached
      FROM public.sites s
     CROSS JOIN LATERAL (VALUES
            ('bd', s.status, '{}'::text[]),
            ('legal', s.legal_dd_status,
                      CASE WHEN s.agreement_status IN ('signed', 'registered') THEN ARRAY['submitted'] ELSE '{}'::text[] END
                      || CASE WHEN s.licensing_status = 'complete' THEN ARRAY['done'] ELSE '{}'::text[] END),
            -- G2 D03: Finance-style gate "LOI uploaded and not sent back / not legal_rejected"
            ('bd_loi', CASE WHEN s.status IN ('loi_uploaded', 'legal_review', 'legal_approved', 'pushed_to_payments')
                            THEN 'done' ELSE 'pending' END, '{}'::text[]),
            ('finance_ca', s.finance_status, '{}'::text[]),
            ('design', s.design_status, '{}'::text[]),
            ('project', s.project_status, '{}'::text[]),
            ('project_excellence', s.project_excellence_status,
                      CASE WHEN (SELECT count(*) FROM public.quality_audit_reports q
                                  WHERE q.site_id = s.id AND q.pushed_at IS NOT NULL) = 2
                           THEN ARRAY['done'] ELSE '{}'::text[] END),
            ('financial_closure', s.financial_closure_status, '{}'::text[])
          ) AS v(module_key, raw_status, extra_reached)
    UNION ALL
    SELECT n.tenant_id, n.site_id, 'nso', n.nso_status, '{}'::text[] FROM public.nso_reviews n
    UNION ALL
    SELECT l.tenant_id, l.site_id, 'launch_approval', l.status, '{}'::text[] FROM public.launch_approvals l
)
SELECT b.tenant_id, b.site_id, b.module_key, b.raw_status,
       coalesce(c.outcome_map ->> b.raw_status, b.raw_status) AS outcome,
       ARRAY(SELECT DISTINCT x
               FROM unnest(
                      coalesce(ARRAY(SELECT jsonb_array_elements_text(c.reached_map -> b.raw_status)),
                               '{}'::text[])
                      || CASE WHEN c.reached_map ? b.raw_status THEN '{}'::text[]
                              WHEN b.raw_status = 'pending' THEN '{}'::text[]
                              ELSE ARRAY[coalesce(c.outcome_map ->> b.raw_status, b.raw_status)] END
                      || b.extra_reached) AS x
              ORDER BY x) AS reached,
       'builtin'::text AS source,
       NULL::uuid AS release_id
  FROM builtin_raw b
  LEFT JOIN public.module_catalog c ON c.key = b.module_key
UNION ALL
SELECT r.tenant_id, r.site_id, r.module_key, r.status,
       coalesce(r.exit_outcome, r.status) AS outcome,
       CASE WHEN jsonb_typeof(r.runtime_state -> 'reached') = 'array'
            THEN ARRAY(SELECT jsonb_array_elements_text(r.runtime_state -> 'reached'))
            WHEN coalesce(r.exit_outcome, r.status) = 'pending' THEN '{}'::text[]
            ELSE ARRAY[coalesce(r.exit_outcome, r.status)] END AS reached,
       'module_record'::text AS source,
       r.release_id
  FROM public.module_records r
  JOIN public.tenant_modules tm
    ON tm.tenant_id = r.tenant_id AND tm.module_key = r.module_key AND tm.kind = 'custom';

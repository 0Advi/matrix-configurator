-- 202606093 — Drop stale project_budget_items_idx_check constraint.
--
-- CONTEXT:
--   Migration 202606091 added `chk_project_budget_idx` (idx BETWEEN 1 AND 11)
--   but the original table creation left a separate constraint named
--   `project_budget_items_idx_check` (idx BETWEEN 1 AND 10) that was never
--   explicitly dropped. With both active, PostgreSQL enforces the stricter
--   bound (≤10), so inserting the 11th budget head (Misc / idx=11) from
--   svc_save_budget raises a constraint violation → FastAPI 500.
--
-- FIX:
--   Drop the stale original constraint. The 202606091 constraint already
--   covers the correct 1..11 range; no replacement is needed.
--
-- SAFE:
--   The remaining chk_project_budget_idx still enforces idx IN [1..11].
--   Existing rows with idx 1..10 remain valid. Already applied to production.

ALTER TABLE public.project_budget_items
    DROP CONSTRAINT IF EXISTS project_budget_items_idx_check;

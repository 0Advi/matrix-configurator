-- Migration: Project Excellence module
-- Creates budget-tracking tables for the post-project excellence module,
-- moves the 11 budget line items out of project_reviews / project_budget_items,
-- and adds a project_excellence_status mirror column to sites.

-- ── 1. New: project_excellence_reviews (one row per site, budget flow) ─────
CREATE TABLE IF NOT EXISTS public.project_excellence_reviews (
    site_id         UUID PRIMARY KEY REFERENCES public.sites(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    excellence_status TEXT NOT NULL DEFAULT 'pending',
    current_stage   TEXT NOT NULL DEFAULT 'budget',
    allocated_to    UUID REFERENCES public.users(id),
    budget_status   TEXT NOT NULL DEFAULT 'draft',
    budget_total    NUMERIC(14, 2),
    total_indoor_area_sqft NUMERIC(12, 2),
    total_area_sqft NUMERIC(12, 2),
    covers          INTEGER,
    budget_supervisor_comments TEXT,
    budget_admin_comments      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_pe_excellence_status
        CHECK (excellence_status IN ('pending','allocated','budgeting','approved','done')),
    CONSTRAINT chk_pe_current_stage
        CHECK (current_stage IN ('budget','done')),
    CONSTRAINT chk_pe_budget_status
        CHECK (budget_status IN ('draft','pending_supervisor','pending_admin','approved','rejected'))
);

-- ── 2. New: project_excellence_items (11 budget line items per site) ─────────
CREATE TABLE IF NOT EXISTS public.project_excellence_items (
    id          UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    site_id     UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    label       TEXT,
    amount      NUMERIC(14, 2),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_pe_item_site_idx UNIQUE (site_id, idx),
    CONSTRAINT chk_pe_item_idx CHECK (idx BETWEEN 1 AND 11)
);

-- ── 3. Add project_excellence_status mirror to sites ─────────────────────────
ALTER TABLE public.sites
    ADD COLUMN IF NOT EXISTS project_excellence_status TEXT NOT NULL DEFAULT 'pending';

-- ── 4. Widen the module CHECK to include 'project_excellence' ────────────────
ALTER TABLE public.site_delegations
    DROP CONSTRAINT IF EXISTS chk_site_delegations_module;
ALTER TABLE public.site_delegations
    ADD CONSTRAINT chk_site_delegations_module
        CHECK (module IN ('bd','legal','design','project','nso','project_excellence'));

-- ── 5. Strip budget columns from project_reviews ─────────────────────────────
-- Drop associated CHECKs first (column DROP cascades named constraints on Postgres 15+,
-- but naming them explicitly is safer on older versions and avoids ordering issues).
ALTER TABLE public.project_reviews
    DROP CONSTRAINT IF EXISTS chk_project_budget_status,
    DROP COLUMN IF EXISTS budget_status,
    DROP COLUMN IF EXISTS budget_total,
    DROP COLUMN IF EXISTS total_indoor_area_sqft,
    DROP COLUMN IF EXISTS total_area_sqft,
    DROP COLUMN IF EXISTS covers,
    DROP COLUMN IF EXISTS budget_supervisor_comments,
    DROP COLUMN IF EXISTS budget_admin_comments;

-- Tighten current_stage: 'budget' is no longer a valid project stage.
ALTER TABLE public.project_reviews
    DROP CONSTRAINT IF EXISTS chk_project_current_stage;
ALTER TABLE public.project_reviews
    ADD CONSTRAINT chk_project_current_stage
        CHECK (current_stage IN ('execution','done'));

-- Update default so new rows start at 'execution'.
ALTER TABLE public.project_reviews
    ALTER COLUMN current_stage SET DEFAULT 'execution';

-- ── 6. Drop the now-vacant project_budget_items table ────────────────────────
DROP TABLE IF EXISTS public.project_budget_items;

-- ── 7. Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pe_reviews_tenant_status
    ON public.project_excellence_reviews (tenant_id, excellence_status);
CREATE INDEX IF NOT EXISTS idx_pe_reviews_budget_status
    ON public.project_excellence_reviews (tenant_id, budget_status);
CREATE INDEX IF NOT EXISTS idx_pe_items_site
    ON public.project_excellence_items (site_id);
CREATE INDEX IF NOT EXISTS idx_pe_items_tenant
    ON public.project_excellence_items (tenant_id);

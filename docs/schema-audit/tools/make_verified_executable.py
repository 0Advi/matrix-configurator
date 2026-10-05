#!/usr/bin/env python3
"""Turn Matrix-bd backend/database/verified.sql (a Supabase dashboard "context only" export of the
LIVE schema, committed 2026-06-23 in 9e77dc1) into a loadable script — with the smallest set of
mechanical, documented edits. Each edit must match EXACTLY the expected number of times or the
tool aborts, so a changed input can never be silently mis-transformed.

  E1  `status USER-DEFINED ... ::workspace_request_status`  -> declare the enum first
      (202605221 creates it; the export prints enum columns as USER-DEFINED)
  E2  `REFERENCES public.tenents(id)` -> `public.tenants(id)`
      (typo present in the committed export of launch_approvals)
  E3  site_details.completion_pct `integer DEFAULT (<expr over sibling columns>)`
      -> `integer GENERATED ALWAYS AS (<expr>) STORED`
      (a DEFAULT cannot reference columns; 202605241 calls it "completion_pct (generated)";
       the export renders generated columns as DEFAULT)
  E4  inline single-column CHECKs whose name a migration manages explicitly get that name back
      (`CONSTRAINT chk_sites_rent_type CHECK ...` etc. — see NAMED below; the export drops names)
  E5  multi-column UNIQUE constraints the export omits are re-added (see UNIQUES below)

Known blind spots of the export (NOT reconstructable from it; covered by the migration replay):
NOT VALID CHECKs, FK delete rules, indexes (other than PK/UNIQUE), RLS flags/policies,
functions, views, triggers, grants.
"""
import re
import sys

src_path, out_path = sys.argv[1], sys.argv[2]
sql = open(src_path, encoding="utf-8").read()


def sub_exact(pattern, repl, text, count_expected, flags=0, label=""):
    new, n = re.subn(pattern, repl, text, flags=flags)
    if n != count_expected:
        raise SystemExit(f"{label}: expected {count_expected} match(es), got {n}")
    return new


# E1
sql = sub_exact(r"status USER-DEFINED NOT NULL DEFAULT 'pending'::workspace_request_status",
                "status public.workspace_request_status NOT NULL DEFAULT 'pending'::public.workspace_request_status",
                sql, 1, label="E1")
sql = ("CREATE TYPE public.workspace_request_status AS ENUM ('pending', 'approved', 'rejected');\n" + sql)
# E2
sql = sub_exact(r"REFERENCES public\.tenents\(id\)", "REFERENCES public.tenants(id)", sql, 1, label="E2")
# E3
sql = sub_exact(r"completion_pct integer DEFAULT \(", "completion_pct integer GENERATED ALWAYS AS (", sql, 1, label="E3a")
sql = sub_exact(r"END\) \* 10\),\n  escalation_date date,", "END) * 10) STORED,\n  escalation_date date,", sql, 1, label="E3b")

# E4 — restore constraint NAMES the export loses. The export prints every single-column CHECK inline,
# so Postgres would auto-name it <table>_<col>_check. Where a migration manages that constraint by an
# explicit name (DROP CONSTRAINT IF EXISTS <name>; ADD CONSTRAINT <name> ...), the live constraint
# carries THAT name; leaving the auto-name would create a stale duplicate the replay never drops
# (e.g. sites.rent_type without 'staggered', which would wrongly reject staggered rent).
NAMED = {
    ("sites", "rent_type"): "chk_sites_rent_type",                                   # 202606020, 20260730
    ("module_codes", "module"): "chk_module_codes_module",                           # 202606142
    ("supervisor_invite_codes", "module"): "chk_supervisor_invite_codes_module",     # 202606142
    ("user_module_memberships", "module"): "chk_user_module_memberships_module",     # 202606142
    ("site_delegations", "module"): "chk_site_delegations_module",                   # 202606147
    ("launch_approvals", "status"): "chk_launch_approval_status",                    # 202606121
    ("launch_approvals", "exec_verdict"): "chk_launch_exec_verdict",                 # 202606121
    ("launch_approvals", "supervisor_verdict"): "chk_launch_supervisor_verdict",     # 202606121
    ("project_reviews", "project_status"): "chk_project_status",                     # 202606033
    ("project_reviews", "current_stage"): "chk_project_current_stage",               # 202606144
    ("project_reviews", "initialization_status"): "chk_project_initialization_status",  # 202606092
    ("project_reviews", "expected_completion_status"): "chk_project_expected_completion_status",  # 202606033
    ("project_reviews", "quality_audit_status"): "chk_project_quality_status",       # 202606144
    ("project_reviews", "nso_status"): "chk_project_nso_status",                     # 202606092
    ("site_budgets", "phase"): "chk_site_budget_phase",                              # 202606144
    ("site_budgets", "status"): "chk_site_budget_status",                            # 202606144
    ("site_budget_items", "phase"): "chk_site_budget_item_phase",                    # 202606144
    ("site_budget_items", "idx"): "chk_site_budget_item_idx",                        # 202606144
    ("password_reset_requests", "status"): "password_reset_status_chk",              # 202606081
}
blocks = re.split(r"(?=^CREATE TABLE )", sql, flags=re.M)
for (table, col), name in NAMED.items():
    hit = 0
    for i, b in enumerate(blocks):
        if not b.startswith(f"CREATE TABLE public.{table} ("):
            continue
        nb, n = re.subn(rf"^(  {col} [^\n]*?) CHECK \(", rf"\1 CONSTRAINT {name} CHECK (", b, count=1, flags=re.M)
        blocks[i] = nb
        hit += n
    if hit != 1:
        raise SystemExit(f"E4 {table}.{col}: expected 1 inline CHECK, got {hit}")
sql = "".join(blocks)

# E5 — the export also omits MULTI-column UNIQUE constraints (it prints only inline single-column
# UNIQUEs + PK/FK/CHECK). The app relies on these (ON CONFLICT inference), and the migrations that
# created them are CREATE TABLE IF NOT EXISTS (skipped on replay because the table already exists),
# so they are re-added here under the name the creating migration / ORM gives them.
UNIQUES = [
    ("users", "users_tenant_id_email_key", "tenant_id, email"),                       # schema.sql (out-of-band base table)
    ("module_codes", "module_codes_tenant_id_module_key", "tenant_id, module"),       # 202605263; named in 202606132 header
    ("supervisor_invite_codes", "supervisor_invite_codes_supervisor_id_module_key", "supervisor_id, module"),  # 202605264
    ("user_module_memberships", "user_module_memberships_user_id_module_key", "user_id, module"),  # 202605265; dropped by 20260818 discovery
    ("design_deliverables", "uq_design_deliverable_site_kind", "site_id, kind"),      # ORM models.py:736
    ("site_budgets", "uq_site_budget_site_phase", "site_id, phase"),                  # 202606144, ORM :904
    ("site_budget_items", "uq_site_budget_item_budget_idx", "budget_id, idx"),        # 202606144, ORM :930
]
sql += "\n-- E5: multi-column UNIQUE constraints omitted by the export\n"
for table, name, cols in UNIQUES:
    sql += f"ALTER TABLE public.{table} ADD CONSTRAINT {name} UNIQUE ({cols});\n"

header = ("-- GENERATED by docs/schema-audit/tools/make_verified_executable.py from Matrix-bd\n"
          "-- origin/main:backend/database/verified.sql (edits E1-E3 documented in the tool). Audit use only.\n")
open(out_path, "w", encoding="utf-8").write(header + sql)
print(f"wrote {out_path}")

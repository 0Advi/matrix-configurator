PASS | after: 10 new module constraints present (5 key-shape CHECK + 5 registry FK) | 10 found
PASS | after: all 10 VALIDATED over existing rows | all convalidated=true
PASS | after: no hard-coded module IN-list CHECK left | none
PASS | after: persisted existing-style rows survive | 35 rows for 35 (table,key) pairs
PASS | after: backfill registered built-ins for pre-existing tenant | bd, legal, finance_ca, design, project_excellence, project, nso, launch_approval, financial_closure, quality_audit, payment(off)
PASS | after: app's INSERT INTO tenants seeds tenant_modules (trigger) | 10 rows
PASS | after: app SQL business_admin_service mint dept code ('legal') for new tenant | accepted

#### Module acceptance matrix — m_prop AFTER proposals, tenant T1 (vendor_onboarding NOT yet registered)

| key | module_codes | supervisor_invite_codes | user_module_memberships | site_delegations | supervisor_executive_requests |
|---|---|---|---|---|---|
| `bd` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `legal` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `design` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `project` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `nso` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `project_excellence` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `financial_closure` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `quality_audit` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `payment` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `finance_ca` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `launch_approval` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `vendor_onboarding` | ❌ 23503 | ❌ 23503 | ❌ 23503 | ❌ 23503 | ❌ 23503 |
| `store_design` | ❌ 23503 | ❌ 23503 | ❌ 23503 | ❌ 23503 | ❌ 23503 |
| `pex` | ❌ 23503 | ❌ 23503 | ❌ 23503 | ❌ 23503 | ❌ 23503 |
| `Vendor` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `x` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `admin` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `9lives` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `a-b` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `vendor onboarding` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `(empty)` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |

PASS | after: release v1 stored, sha256 filled by trigger | 8a43fa117fbfdde1…
PASS | after: cfg_activate_release projected manifest | 14 modules; design.enabled=False project_excellence.enabled=False (Starbucks switches both off); custom: ['close_snags', 'joint_audit', 'ops_hoc', 'store_design', 'vendor_onboarding']; nso.supervisor_only=True
PASS | after: release UPDATE refused (append-only) | rejected (23001 RestrictViolationError: public.tenant_config_releases is append-only: UPDATE refused)
PASS | after: release DELETE refused (append-only) | rejected (23001 RestrictViolationError: public.tenant_config_releases is append-only: DELETE refused)
PASS | after: duplicate version refused | rejected (23505 UniqueViolationError: duplicate key value violates unique constraint "uq_tcr_tenant_version")
PASS | after: manifest without modules[] refused | rejected (23514 CheckViolationError: new row for relation "tenant_config_releases" violates check constraint "chk_tcr_manifest")

#### Module acceptance matrix — m_prop AFTER proposals, tenant T1 with release v1 live (vendor_onboarding registered)

| key | module_codes | supervisor_invite_codes | user_module_memberships | site_delegations | supervisor_executive_requests |
|---|---|---|---|---|---|
| `bd` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `legal` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `design` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `project` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `nso` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `project_excellence` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `financial_closure` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `quality_audit` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `payment` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `finance_ca` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `launch_approval` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `vendor_onboarding` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `store_design` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `pex` | ❌ 23503 | ❌ 23503 | ❌ 23503 | ❌ 23503 | ❌ 23503 |
| `Vendor` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `x` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `admin` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `9lives` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `a-b` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `vendor onboarding` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `(empty)` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |

PASS | after: custom key vendor_onboarding accepted in module_codes (T1) | 
PASS | after: custom key store_design (Starbucks seed) accepted in module_codes (T1) | 
PASS | after: junk/alias key 'Vendor' rejected in module_codes | 
PASS | after: junk/alias key 'x' rejected in module_codes | 
PASS | after: junk/alias key 'admin' rejected in module_codes | 
PASS | after: junk/alias key '9lives' rejected in module_codes | 
PASS | after: junk/alias key 'a-b' rejected in module_codes | 
PASS | after: junk/alias key 'vendor onboarding' rejected in module_codes | 
PASS | after: junk/alias key '' rejected in module_codes | 
PASS | after: junk/alias key 'pex' rejected in module_codes | 
PASS | after: built-in 'bd' still accepted in module_codes | 
PASS | after: built-in 'legal' still accepted in module_codes | 
PASS | after: built-in 'design' still accepted in module_codes | 
PASS | after: built-in 'project' still accepted in module_codes | 
PASS | after: built-in 'nso' still accepted in module_codes | 
PASS | after: built-in 'project_excellence' still accepted in module_codes | 
PASS | after: custom key vendor_onboarding accepted in supervisor_invite_codes (T1) | 
PASS | after: custom key store_design (Starbucks seed) accepted in supervisor_invite_codes (T1) | 
PASS | after: junk/alias key 'Vendor' rejected in supervisor_invite_codes | 
PASS | after: junk/alias key 'x' rejected in supervisor_invite_codes | 
PASS | after: junk/alias key 'admin' rejected in supervisor_invite_codes | 
PASS | after: junk/alias key '9lives' rejected in supervisor_invite_codes | 
PASS | after: junk/alias key 'a-b' rejected in supervisor_invite_codes | 
PASS | after: junk/alias key 'vendor onboarding' rejected in supervisor_invite_codes | 
PASS | after: junk/alias key '' rejected in supervisor_invite_codes | 
PASS | after: junk/alias key 'pex' rejected in supervisor_invite_codes | 
PASS | after: built-in 'bd' still accepted in supervisor_invite_codes | 
PASS | after: built-in 'legal' still accepted in supervisor_invite_codes | 
PASS | after: built-in 'design' still accepted in supervisor_invite_codes | 
PASS | after: built-in 'project' still accepted in supervisor_invite_codes | 
PASS | after: built-in 'nso' still accepted in supervisor_invite_codes | 
PASS | after: built-in 'project_excellence' still accepted in supervisor_invite_codes | 
PASS | after: custom key vendor_onboarding accepted in user_module_memberships (T1) | 
PASS | after: custom key store_design (Starbucks seed) accepted in user_module_memberships (T1) | 
PASS | after: junk/alias key 'Vendor' rejected in user_module_memberships | 
PASS | after: junk/alias key 'x' rejected in user_module_memberships | 
PASS | after: junk/alias key 'admin' rejected in user_module_memberships | 
PASS | after: junk/alias key '9lives' rejected in user_module_memberships | 
PASS | after: junk/alias key 'a-b' rejected in user_module_memberships | 
PASS | after: junk/alias key 'vendor onboarding' rejected in user_module_memberships | 
PASS | after: junk/alias key '' rejected in user_module_memberships | 
PASS | after: junk/alias key 'pex' rejected in user_module_memberships | 
PASS | after: built-in 'bd' still accepted in user_module_memberships | 
PASS | after: built-in 'legal' still accepted in user_module_memberships | 
PASS | after: built-in 'design' still accepted in user_module_memberships | 
PASS | after: built-in 'project' still accepted in user_module_memberships | 
PASS | after: built-in 'nso' still accepted in user_module_memberships | 
PASS | after: built-in 'project_excellence' still accepted in user_module_memberships | 
PASS | after: custom key vendor_onboarding accepted in site_delegations (T1) | 
PASS | after: custom key store_design (Starbucks seed) accepted in site_delegations (T1) | 
PASS | after: junk/alias key 'Vendor' rejected in site_delegations | 
PASS | after: junk/alias key 'x' rejected in site_delegations | 
PASS | after: junk/alias key 'admin' rejected in site_delegations | 
PASS | after: junk/alias key '9lives' rejected in site_delegations | 
PASS | after: junk/alias key 'a-b' rejected in site_delegations | 
PASS | after: junk/alias key 'vendor onboarding' rejected in site_delegations | 
PASS | after: junk/alias key '' rejected in site_delegations | 
PASS | after: junk/alias key 'pex' rejected in site_delegations | 
PASS | after: built-in 'bd' still accepted in site_delegations | 
PASS | after: built-in 'legal' still accepted in site_delegations | 
PASS | after: built-in 'design' still accepted in site_delegations | 
PASS | after: built-in 'project' still accepted in site_delegations | 
PASS | after: built-in 'nso' still accepted in site_delegations | 
PASS | after: built-in 'project_excellence' still accepted in site_delegations | 
PASS | after: custom key vendor_onboarding accepted in supervisor_executive_requests (T1) | 
PASS | after: custom key store_design (Starbucks seed) accepted in supervisor_executive_requests (T1) | 
PASS | after: junk/alias key 'Vendor' rejected in supervisor_executive_requests | 
PASS | after: junk/alias key 'x' rejected in supervisor_executive_requests | 
PASS | after: junk/alias key 'admin' rejected in supervisor_executive_requests | 
PASS | after: junk/alias key '9lives' rejected in supervisor_executive_requests | 
PASS | after: junk/alias key 'a-b' rejected in supervisor_executive_requests | 
PASS | after: junk/alias key 'vendor onboarding' rejected in supervisor_executive_requests | 
PASS | after: junk/alias key '' rejected in supervisor_executive_requests | 
PASS | after: junk/alias key 'pex' rejected in supervisor_executive_requests | 
PASS | after: built-in 'bd' still accepted in supervisor_executive_requests | 
PASS | after: built-in 'legal' still accepted in supervisor_executive_requests | 
PASS | after: built-in 'design' still accepted in supervisor_executive_requests | 
PASS | after: built-in 'project' still accepted in supervisor_executive_requests | 
PASS | after: built-in 'nso' still accepted in supervisor_executive_requests | 
PASS | after: built-in 'project_excellence' still accepted in supervisor_executive_requests | 
PASS | after: T1's custom key refused for tenant T2 in module_codes | rejected (23503 ForeignKeyViolationError: insert or update on table "module_codes" violates foreign key constraint "fk_module_codes_tenant_module")
PASS | after: T1's custom key refused for tenant T2 in supervisor_invite_codes | rejected (23503 ForeignKeyViolationError: insert or update on table "supervisor_invite_codes" violates foreign key constraint "fk_supervisor_invite_codes_tenant_module")
PASS | after: T1's custom key refused for tenant T2 in user_module_memberships | rejected (23503 ForeignKeyViolationError: insert or update on table "user_module_memberships" violates foreign key constraint "fk_user_module_memberships_tenant_module")
PASS | after: T1's custom key refused for tenant T2 in site_delegations | rejected (23503 ForeignKeyViolationError: insert or update on table "site_delegations" violates foreign key constraint "fk_site_delegations_tenant_module")
PASS | after: T1's custom key refused for tenant T2 in supervisor_executive_requests | rejected (23503 ForeignKeyViolationError: insert or update on table "supervisor_executive_requests" violates foreign key constraint "fk_supervisor_executive_requests_tenant_module")
PASS | after: custom module may not reuse a built-in key/alias ('pex') | rejected (23514 CheckViolationError: custom module key "pex" collides with a built-in module)
PASS | after: legacy site keeps NULL pin (hard-coded flow) | None
PASS | after: new site auto-pinned to live release (no app change) | 36b11123-87d3-4bb1-8c28-f120ffe35a36
PASS | after: publishing v2 leaves in-flight S1 on v1; new S2 on v2 | S1=36b11123-87d3-4bb1-8c28-f120ffe35a36 S2=cdd48b7b-c5f5-4b22-bdc1-3b2c68bc8ed0
PASS | after: re-pin S1 to v2 refused | rejected (23514 CheckViolationError: site e95b4c23-638f-404d-a573-410f056a547e is pinned to release 36b11123-87d3-4bb1-8c28-f120ffe35a36 and finishes on it (set matrix.allow_repin=on to override))
PASS | after: re-pin S1 allowed only with matrix.allow_repin=on | accepted
PASS | after: pin to another tenant's release refused | rejected (23503 ForeignKeyViolationError: release 36b11123-87d3-4bb1-8c28-f120ffe35a36 does not belong to tenant 50fe9128-77b2-4bf5-b6ab-58439e6bd4de)
PASS | after: ordinary site UPDATE (ORM-style, status) unaffected by pin trigger | accepted
PASS | after: module record for custom module inherits the site's pin (v1) | 36b11123-87d3-4bb1-8c28-f120ffe35a36
PASS | after: module record on S1 with release v2 refused (site pinned to v1) | rejected (23514 CheckViolationError: site e95b4c23-638f-404d-a573-410f056a547e is pinned to release 36b11123-87d3-4bb1-8c28-f120ffe35a36; module record may not use release cdd48b7b-c5f5-4b22-bdc1-3b2c68bc8ed0)
PASS | after: module record for unregistered module refused | rejected (23514 CheckViolationError: module ghost_module is not part of release 36b11123-87d3-4bb1-8c28-f120ffe35a36)
PASS | after: module record across tenants refused | rejected (23503 ForeignKeyViolationError: site e95b4c23-638f-404d-a573-410f056a547e does not belong to tenant 50fe9128-77b2-4bf5-b6ab-58439e6bd4de)
PASS | after: stage row validated against pinned manifest; name filled | Vendor KYC
PASS | after: stage 9 (absent from manifest) refused | rejected (23514 CheckViolationError: stage 9 does not exist in module vendor_onboarding of release 36b11123-87d3-4bb1-8c28-f120ffe35a36)
PASS | after: field_values must be a JSON object | rejected (23514 CheckViolationError: new row for relation "module_stage_states" violates check constraint "chk_mss_field_values")
PASS | after: executive submits stage 1 (first tier of chain [executive, supervisor]) | accepted
PASS | after: supervisor does the executive step of stage 1 (higher tier in the chain, no override) | accepted
PASS | after: 'submitted' by a non-first tier refused | rejected (23514 CheckViolationError: stage 1 is submitted by its first tier (executive), not supervisor)
PASS | after: supervisor approves stage 1 (approver per v1) | 3b1f2cd0-b0dd-47f4-a468-7b6f86d2e482
PASS | after: business_admin on stage 1 WITHOUT override flag refused (not in chain) | rejected (23514 CheckViolationError: business_admin may not act on the supervisor step of stage 1 (only a flagged business-admin override may))
PASS | after: business_admin on stage 1 as a FLAGGED override accepted (production guard bypass, recorded) | accepted
PASS | after: business_admin override submitting the executive step accepted (flagged) | accepted
PASS | after: override flag on a non-admin actor refused | rejected (23514 CheckViolationError: is_override must be false: supervisor is entitled to the executive step)
PASS | after: tier outside the stage chain refused even as override | rejected (23514 CheckViolationError: tier business_admin is not in the tier chain {executive,supervisor} of stage 1 in release 36b11123-87d3-4bb1-8c28-f120ffe35a36)
PASS | after: supervisor approving stage 2 on S1 refused (v1 chain [business_admin]) | rejected (23514 CheckViolationError: tier supervisor is not in the tier chain {business_admin} of stage 2 in release 36b11123-87d3-4bb1-8c28-f120ffe35a36)
PASS | after: business_admin tier with a supervisor actor refused | rejected (23514 CheckViolationError: supervisor may not act on the business_admin step of stage 2 (only a flagged business-admin override may))
PASS | after: admin-only stage WITH fields: business_admin 'submitted' on stage 2 accepted (form = sign-off) | accepted
PASS | after: override flag on an entitled actor refused (flag must be truthful) | rejected (23514 CheckViolationError: is_override must be false: business_admin is entitled to the business_admin step)
PASS | after: business_admin approves stage 2 on S1 | accepted
PASS | after: supervisor approving stage 2 on S2 accepted (v2 chain [supervisor, business_admin]) | accepted
PASS | after: approval UPDATE refused (append-only) | rejected (23001 RestrictViolationError: public.module_approvals is append-only: UPDATE refused)
PASS | after: approval DELETE refused (append-only) | rejected (23001 RestrictViolationError: public.module_approvals is append-only: DELETE refused)
PASS | after: runtime_state for the pinned release stored | accepted
PASS | after: runtime_state of another release refused | rejected (23514 CheckViolationError: runtime_state belongs to release cdd48b7b-c5f5-4b22-bdc1-3b2c68bc8ed0, record is pinned to 36b11123-87d3-4bb1-8c28-f120ffe35a36)
PASS | after: runtime_state must be an object | rejected (23514 CheckViolationError: new row for relation "module_records" violates check constraint "chk_mr_runtime_state")
PASS | after: exit_outcome without closed_at refused | rejected (23514 CheckViolationError: new row for relation "module_records" violates check constraint "chk_mr_closed")
PASS | after: outcome outside configurator vocabulary refused | rejected (23514 CheckViolationError: new row for relation "module_records" violates check constraint "chk_mr_status")
PASS | after: gate-input view merges built-in mirrors and custom outcomes (custom reached from runtime_state) | bd=draft_submitted->submitted reached=['submitted'] [builtin]; design=pending->pending reached=[] [builtin]; finance_ca=pending->pending reached=[] [builtin]; financial_closure=pending->pending reached=[] [builtin]; legal=pending->pending reached=[] [builtin]; project=pending->pending reached=[] [builtin]; project_excellence=pending->pending reached=[] [builtin]; vendor_onboarding=approved->approved reached=['submitted', 'approved'] [module_record]
PASS | after: built-in reached is CUMULATIVE (design approved => allocated,in progress,submitted,approved; legal positive+licensing complete => +done) | {'bd': ['approved', 'done', 'in progress', 'submitted'], 'design': ['allocated', 'approved', 'in progress', 'submitted'], 'legal': ['approved', 'done', 'in progress']}
PASS | after: built-in admin-only stage with fields representable — PEx Admin review: business_admin 'submitted' | accepted
PASS | after: PEx Admin review: supervisor may not submit it (not in chain, no override) | rejected (23514 CheckViolationError: supervisor may not act on the business_admin step of stage 3 (only a flagged business-admin override may))
PASS | after: built-in admin-only stage with fields representable — Design GFC approval: business_admin 'submitted' | accepted
PASS | after: Design GFC approval: supervisor may not submit it (not in chain, no override) | rejected (23514 CheckViolationError: supervisor may not act on the business_admin step of stage 4 (only a flagged business-admin override may))
PASS | after: built-in admin-only stage with fields representable — Launch Admin review: business_admin 'submitted' | accepted
PASS | after: Launch Admin review: supervisor may not submit it (not in chain, no override) | rejected (23514 CheckViolationError: supervisor may not act on the business_admin step of stage 1 (only a flagged business-admin override may))
PASS | after: audit_logs accepts release + provenance | accepted
PASS | after: audit_logs legacy-style insert (no new columns) still works | accepted
PASS | after: provenance must be an object | rejected (23514 CheckViolationError: new row for relation "audit_logs" violates check constraint "chk_audit_logs_provenance")
PASS | after: RLS on module_approvals | rls=True tenant_isolation_policies=1
PASS | after: RLS on module_catalog | rls=True tenant_isolation_policies=0
PASS | after: RLS on module_records | rls=True tenant_isolation_policies=1
PASS | after: RLS on module_stage_states | rls=True tenant_isolation_policies=1
PASS | after: RLS on tenant_config_live | rls=True tenant_isolation_policies=1
PASS | after: RLS on tenant_config_releases | rls=True tenant_isolation_policies=1
PASS | after: RLS on tenant_modules | rls=True tenant_isolation_policies=1
PASS | after: RLS isolates tenant_config_releases (authenticated+T1 claims sees only T1; no claims sees 0; app role sees all) | T1-claims=2 no-claims=0 app(bypass)=3
PASS | after: RLS isolates tenant_config_live (authenticated+T1 claims sees only T1; no claims sees 0; app role sees all) | T1-claims=1 no-claims=0 app(bypass)=2
PASS | after: RLS isolates tenant_modules (authenticated+T1 claims sees only T1; no claims sees 0; app role sees all) | T1-claims=16 no-claims=0 app(bypass)=26
PASS | after: RLS isolates module_records (authenticated+T1 claims sees only T1; no claims sees 0; app role sees all) | T1-claims=2 no-claims=0 app(bypass)=5
PASS | after: RLS isolates module_stage_states (authenticated+T1 claims sees only T1; no claims sees 0; app role sees all) | T1-claims=3 no-claims=0 app(bypass)=6
PASS | after: RLS isolates module_approvals (authenticated+T1 claims sees only T1; no claims sees 0; app role sees all) | T1-claims=1 no-claims=0 app(bypass)=1
PASS | after: anon has no privileges on new tables (REVOKE) | 42501 InsufficientPrivilegeError: permission denied for table module_records
PASS | after: DELETE tenant (cascade into append-only tenant_config_releases, tenant_config_live, tenant_modules) | accepted

SUMMARY: 161 pass, 0 fail

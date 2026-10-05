
#### Module acceptance matrix — m_prop BEFORE proposals

| key | module_codes | supervisor_invite_codes | user_module_memberships | site_delegations | supervisor_executive_requests |
|---|---|---|---|---|---|
| `bd` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `legal` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `design` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `project` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `nso` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `project_excellence` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `financial_closure` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ✅ | ❌ 23514 |
| `quality_audit` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ✅ | ❌ 23514 |
| `payment` | ✅ | ✅ | ✅ | ❌ 23514 | ❌ 23514 |
| `finance_ca` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `launch_approval` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `vendor_onboarding` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `store_design` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `pex` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `Vendor` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `x` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `admin` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `9lives` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `a-b` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `vendor onboarding` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `(empty)` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |

PASS | before: custom key 'vendor_onboarding' in module_codes | rejected (23514 CheckViolationError: new row for relation "module_codes" violates check constraint "chk_module_codes_module") — custom modules are blocked today
PASS | before: custom key 'vendor_onboarding' in supervisor_invite_codes | rejected (23514 CheckViolationError: new row for relation "supervisor_invite_codes" violates check constraint "chk_supervisor_invite_codes_module") — custom modules are blocked today
PASS | before: custom key 'vendor_onboarding' in user_module_memberships | rejected (23514 CheckViolationError: new row for relation "user_module_memberships" violates check constraint "chk_user_module_memberships_module") — custom modules are blocked today
PASS | before: custom key 'vendor_onboarding' in site_delegations | rejected (23514 CheckViolationError: new row for relation "site_delegations" violates check constraint "chk_site_delegations_module") — custom modules are blocked today
PASS | before: custom key 'vendor_onboarding' in supervisor_executive_requests | rejected (23514 CheckViolationError: new row for relation "supervisor_executive_requests" violates check constraint "supervisor_executive_requests_module_check") — custom modules are blocked today
persisted 35 representative existing-style rows for tenant 149537c1-7300-4f73-af8b-773e659ad308

SUMMARY: 5 pass, 0 fail

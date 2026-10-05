
#### Module acceptance matrix — m_schema

| key | module_codes | supervisor_invite_codes | user_module_memberships | site_delegations | supervisor_executive_requests |
|---|---|---|---|---|---|
| `bd` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `legal` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `design` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `project` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `nso` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `project_excellence` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `financial_closure` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ✅ | ❌ 23514 |
| `quality_audit` | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
| `payment` | ✅ | ❌ 23514 | ❌ 23514 | ❌ 23514 | ❌ 23514 |
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

sites.status='launched': rejected 23514 CheckViolationError: new row for relation "sites" violates check constraint "chk_sites_status"
sites.status='legal_review': rejected 23514 CheckViolationError: new row for relation "sites" violates check constraint "chk_sites_status"
sites.status='pushed_to_payments': rejected 23514 CheckViolationError: new row for relation "sites" violates check constraint "chk_sites_status"

SUMMARY: 0 pass, 0 fail

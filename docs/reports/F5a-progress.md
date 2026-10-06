# F5a progress — caveat fixes

Started 2026-10-06. Baseline (from lead): pytest 683/1, vitest 695/697 (2 env-only), smokes 41/67/59, ledger 74.

## Log
- Read: PHASE2-PLAN, ADOPTION-AUDIT, F1/F4a/F4b/G3/N1 reports, F4-API, G3-API, SANDBOX-CHANGES, app skills.
- SEC-1 decision (in progress): staff choose their password AT SIGNUP (stored hashed on the inactive row;
  approval only activates) + `/auth/password-setup` requires a one-time setup code (token-bound, same
  `password_reset_requests` machinery as the BA setup code). No credential ever passes through an approver.
  Platform admin can re-issue an unclaimed BA's setup code.

### Fix 1 — SEC-1 — DONE (2026-10-06 ~08:50)
- Backend: `routers/auth.py` (signup password field `_SignupPassword` on the 3 signup bodies; `_enqueue_signup`
  stores the hash; `PasswordSetupIn.setup_code` required; `_verified_reset_request` helper shared with
  reset/complete; setup consumes the code), `services/auth_repo.py` (`insert_pending_signup(password_hash=)`),
  `services/tenancy_service.py` (`reissue_admin_setup_code`), `services/platform_workspace_service.py`
  (`svc_reissue_admin_setup_code` + audit `business_admin_setup_code_reissued`), `routers/platform.py`
  (`POST /platform/workspaces/{ref}/admin-setup-code`).
- Tests: `tests/test_batch_sec_auth_config.py` (5 setup tests updated to carry a code; +12 SEC-1 tests),
  `tests/test_observer_readonly.py` allowlist.
- Frontend: `supabaseAuth.js` (signup password; setupPassword(…, setupCode)), `BrandedLoginPage.jsx` (Join:
  password+confirm; setup step: code required + "No setup code? Request one"), `ScaleLandingPage.jsx` (join
  modal password fields), `admin/adminApi.js` (`reissueSetupCode`), `admin/workspaces/WorkspacesList.jsx`
  (`SetupCodeReissue`), `admin/CredentialsDialog.jsx` (copy). Tests: joinModes (2 updated + 1 new),
  workspaceAuthenticity (1 replaced by 2), new SetupCodeReissue.test.jsx (2).
- Smokes: smoke-existing 52/52 (was 41: +SEC-1 probes, single-use replay, legacy password-less recovery
  via reset request); smoke-configurator 69/69 (+re-issue, superseded code, 409 after claim); smoke-g3 59/59.
- Unclaimed accounts left in the sandbox (now protected, claimable only with a code): `ws_agent_coffee` BA (G1),
  `configurator-smoke-20261006031434` BA (my rate-limited run), `g3-smoke-20261005161309` 2 executives (G3's
  rate-limited run). Re-issue for agent-coffee: /#/admin → Workspaces → Details → "Issue a new setup code"
  (not done by me — the code would be a secret in tool output).

### Fix 2 — disabled built-ins refused — DONE (~09:20)
- `rbac/guards.py`: `require_module_enabled(key)` (403 every role, NO membership check) + `GUARDED_MODULE_KEYS`
  registry + `guard.module_enabled_key` for introspection; `require_module` shares `_refuse_disabled`.
- Router-level guard on bd, staging, loi (→ bd), legal, design, project, project_excellence, nso,
  launch_approval, financial_closure; per-route on /sites BD write aliases (10) → bd, /sites finance (4) and
  /business-admin/finance-approvals (3) → finance_ca. /sites reads stay shared.
- D22 (membership on BD/finance/launch supervisor routes) NOT changed: different policy (membership, not
  existence); would break G3's creator rule journeys (custom-module execs create BD sites) and existing
  tenants' cross-module use. Documented as upstream recommendation.
- Frontend: `useWorkspaceModules.js` `isModuleEnabled` / `whenModuleEnabled`; TeamDashboard REAL_FETCHERS gated +
  Launch/Closure tabs hidden when off; Overview Payments/Launch tiles don't navigate to a disabled module.
- Tests: backend `tests/test_f5a_fixes.py` (9); frontend `state/__tests__/moduleEnabled.f5a.test.js` (3).
- pytest 703/1. smoke-configurator 75/75 (v2 now switches finance_ca/launch_approval/financial_closure off; +6 steps).

### Fix 3 — release migration robustness — DONE (~10:00)
- `services/release_migration_service.py`: `STALE_AFTER_SECONDS=600`; heartbeat+progress in header `summary` after
  every site; `recover_stale_migrations()` (running + no heartbeat 10 min → failed + recovery note + journal counts +
  audit `release_migration_recovered`; header only); `_mark_failed` on an in-request exception; one live migration
  per tenant (`pg_advisory_xact_lock` + 409 `migration_in_progress`); list/get expose `stale`.
  Opt-in `include_idle_sites` (dry run `would_repin`, execute per-site locked txn, journal item plan.idle,
  `site_release_migrated` audit policy idle; finished cases keep their release); response gains `idle_sites` +
  `summary.idle_sites` only when asked (W1/G1 contract unchanged).
- `main.py` lifespan: `_recover_stale_release_migrations()` after `_verify_schema()` (verified: a 2-hour-old
  running header was marked failed on restart).
- `routers/platform.py` MigrateIn `include_idle_sites: bool = False`.
- Frontend MigrateCasesPanel: idle checkbox + idle list + re-pin-only execute + history status pills.
- Tests: +6 backend (test_f5a_fixes.py), +3 frontend (MigrateCasesPanel.f5a.test.jsx). smoke-g3 67/67 (+8).
- Decision (idle sites): default OFF (keeps G3 semantics and the API contract W1 is wiring), opt-in per migration.

### Fix 4 — X-Override-Role in the generic runtime — DONE (~10:40)
- `module_runtime_service.py`: `_actor_role` = AUTHORIZATION role (BA/observer by real_role; members by tier; a
  dual-role supervisor with executive access in THIS module who dropped to executive acts as executive);
  new `view_role()` = SCOPE/VIEWS role (effective role after override for BA/observer). List/detail scope,
  saved-view audience/default/matching follow `view_role`; acting, manage-views, observer write denial follow
  the real role. Responses gain `view_role` (list) and `me.view_role` (detail) — additive.
- `module_views_service.svc_list_views`: audience + default by `view_role`, `can_manage` by real role.
- Tests: +17 parametrised backend; smoke-g3 +2 (BA simulating executive → executive scope/views, still BA).

### Fix 5 — custom-module file fields — DONE (~11:10)
- Migration `20261006_1_module_files.sql` (table + insert guard + append-only + RLS + REVOKE; 12 statements;
  verified twice in a rolled-back txn; applied by the runner → ledger 75).
- `module_runtime_service.py`: `svc_upload_file` (current form step's file field only; uploader must be allowed
  to submit; size from hint capped by MAX_UPLOAD_BYTES; app MIME allowlist + magic bytes + hint accept list;
  storage `module-files/<tenant>/<module>/<record>/<file>/<name>`; read txn released before storage I/O; one
  txn row + audit `module_file_uploaded`; object deleted if the insert fails), `svc_get_file` (signed URL,
  case visibility), `_check_file_values` on submit (value must be a module_files id of this record/stage/field),
  record detail `files` map. Router: POST `/m/{key}/records/{id}/files`, GET `/m/{key}/files/{id}`.
  `business_admin_service.delete_site` also purges module-file objects.
- Frontend: `MatrixFileWidget` uploads (client mirror of type/size), `RecordContext`, stage summary file links,
  audit "File uploaded"; API `uploadRecordFile`/`getRecordFile`. Tests: f5aFiles.test.jsx (4), 1 updated.
- smoke-configurator 81/81 (template's file field kept; +6 steps incl. download bytes check); smoke-g3 +1 SQL probe.

### Fix 6 — session/UI caveats — DONE (~11:40)
- Re-auth: new `admin/useAdminReauth.jsx` (the F4b withAuth/ReauthDialog logic, extracted unchanged); used by
  AdminPortalPage (Requests list/approve/reject, Password resets list/confirm, CredentialsDialog branding) and by
  WorkspacesArea. A 401 anywhere in the portal → "Sign in again" → retried; no more logout from Requests.
- `/m/<key>#/m/<key>`: `workspaceModules.hardNavigate(route)` → `/#<route>` + explicit reload when only the hash
  changes; used by WorkspaceSwitcherPanel + ReadOnlyBanner (2 test expectations '/legal'→'/#/legal').
- Logo upload exercised live: API upload (macOS "12.14.54 PM" filename) → branding signed URL → bytes equal →
  branded login page `<img>` loaded in the Browser pane (naturalWidth > 0); wrong type → 415. Works; no fix
  needed beyond routing its upload through withAuth.
- Tests: portalReauth.f5a.test.jsx (3), brandingUpload.f5a.test.jsx (2).

### Fix 7 — docs/PRODUCTION-GAPS.md — DONE
- vercel.json frame headers (exact JSON), CSP enforcement vs dc-runtime/ajv (`new Function`) with options,
  `/cfg` dev-proxy-only (rewrite + auth + private NocoBase), plus 7 F5a-found deployment notes.

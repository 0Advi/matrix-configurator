# F4a — backend integration: report

**Status: done.** A workspace designed in the configurator becomes a real tenant of the sandbox app
through the app's own provisioning path, and the app runs its published configuration: built-in
modules on/off, labels, order and supervisor-only from data; custom modules executed by a generic
runtime (stages, fields, tier approvals, gates, pinning, audit provenance). The stack was left
**running** (`app-stack/status.sh`: db, storage, backend, frontend up; ledger = 70).
No secrets appear in this report.

Contract for F4b: **`docs/F4-API.md`**. Every change to `app/`: **`app/SANDBOX-CHANGES.md`**
("Phase 2 — F4a"). Progress log: `docs/reports/F4a-progress.md`.

## Results

| Check | Before F4a | After F4a |
|---|---|---|
| Backend pytest (`ENABLE_DOCS=false`) | 610 passed, 1 skipped | **654 passed, 1 skipped** (+44 new, 0 new failures) |
| Backend pytest with the sandbox `.env` | 609 passed, 1 failed, 1 skipped | 653 passed, 1 failed, 1 skipped — the same failure: `test_app_does_not_publish_docs_by_default`, caused by `ENABLE_DOCS=true` in the sandbox `.env` |
| `node app-stack/smoke-existing.mjs` | 41/41 | **41/41** (run after every milestone) |
| `node app-stack/smoke-configurator.mjs` (new) | — | **67/67** |
| ruff gates the repo enforces (`C901` ≤ 15, `D101-3` on services, pyflakes) | pass | pass (vendored/copied F3 code exempted via per-file-ignores) |
| Ledger | 63 | 70 (F2's 6 + `20261004_7`), 0 failed statements, `_verify_schema` passed |

Extra probes: 3 concurrent `approve` calls on one case → 1×200, 2×409 `wrong_action`, hash chain
intact. A site created before the tenant's first publish is adopted into the live release by its
first custom-module case (`site_adopted_into_release`). A provisioned but never-published workspace
behaves like a legacy tenant (9 built-ins, `release: null`).

## M1 — schema in the sandbox
- F1's DB (schema.sql + replay of all 63 migrations) already had everything F2's live model needs
  (`current_tenant_id()`, `sites.project_excellence_status` / `financial_closure_status`,
  `project_reviews.qa_reports_viewed_by_project_at`, `quality_audit_reports`, reset-token columns), so
  no reconciliation was needed.
- The six files were copied **byte-identical** (sha256 recorded) into `app/backend/database/migrations/`.
  On restart the real runner logged `applied 20261004_1 (13) … _6 (5)`, `6 new migration file(s), 84
  statement(s) applied; 63 already in ledger`, `Schema verification passed`. The 5 hard-coded module
  CHECKs are gone; 10 new constraints (5 key-shape + 5 registry FKs) are all validated; RLS policies on
  the 6 new tenant tables; existing tenants back-filled with 10 built-ins; new tenants seeded by trigger.
- ORM: `SiteDelegation`'s `chk_site_delegations_module` removed (`models.py`).

## M2 — data-driven modules
- New `services/module_registry_service.py` is the only reader of `tenant_modules ⋈ module_catalog`.
- Replaced: both `Module = Literal[...]` (now a shape-validated `str`), `_VALID_MODULES` (×2),
  `_ORG_MODULES`, `_SUPERVISOR_ONLY_MODULES`, `if module == "nso"`, the JWT primary-membership query,
  the dept/invite-code lookups, and `require_module`.
- Disabled modules:
  - hidden from the org view, the pending list and the dept-code list;
  - refused on code rotation and on supervisor/executive approval (403);
  - their codes behave as revoked at signup (404);
  - never become the JWT module claim;
  - `require_module` refuses them for every role (403), using `disabled_modules` folded into
    `get_current_user`'s existing per-request query (no extra round trip).
- New `GET /api/workspace/modules`: enabled modules with label, kind, position, supervisor_only, route,
  the caller's roles and the live manifest's navigation.
- Existing tenants behave as before (41/41). **One deliberate visible change:** the Departments cards
  follow `position`, so Project Excellence now sits before Project. That is the order the SPA's own
  `WORKSPACE_MODULES` switcher already uses.

## M3 — platform provisioning + publish
- `POST /api/platform/workspaces` claims the configurator id, then calls the unchanged
  `tenancy_service.insert_workspace_request` + `approve_workspace_request`. It returns the workspace
  code and the one-time setup token.
  - **Idempotency: a second call answers 409 `already_provisioned`** with tenant_id and workspace_code
    (never the token again).
  - A failed attempt is marked `failed` and can be retried.
- `POST /api/platform/workspaces/{ref}/releases`:
  - Validation runs first (JSON Schema + module resolution + gate compile/lint + form compile +
    findings). Any error refuses the publish with 422 `manifest_invalid` + `findings`.
  - Then one transaction: insert release v n+1 (publisher = admin email from the token), run
    `cfg_activate_release()`, stamp `tenant_config_live.workspace_ref`, and write an audit row with
    provenance.
- Also added: `…/releases/validate` (dry run), `GET /api/platform/workspaces`, `GET …/{ref}` (status,
  code, live version, release history, registry, BA claim state), `GET …/{ref}/releases/{version}`.
- The platform key is checked server-side only. The only secret in any response is the one-time setup
  token.

## M4 — generic custom-module runtime
- `GET /api/m/{key}/members|records[?site_id]`, `POST /api/m/{key}/records`,
  `GET /api/m/{key}/records/{id}`, `POST …/{id}/actions`, `POST …/{id}/assign`.
- Each command is one transaction with the site row (open) or record row (act) locked `FOR UPDATE`.
  `expected_seq` gives an optimistic check.
- A refused open (closed gate) returns 409 `gate_closed`, with per-condition `met`/`reached` and the
  refusal message.
- Form values are validated with jsonschema on the backend: 422 `invalid_form` + `errors`.
- Writes:
  - `module_approvals` is append-only, with `is_override`;
  - every event goes to `audit_logs` with `config_release_id`, `module_key` and
    `provenance = {policy, release_version, manifest_sha256, event, inputs?, override?}`;
  - `audit_chain_valid` is recomputed from the DB.
- Pinning is proven: v2 published → the v1 case keeps v1's stage-2 chain `[supervisor,
  business_admin]`, while a new site runs v2 `[supervisor]`.

## How the F2/F3 rulings were implemented
| Ruling | Implementation |
|---|---|
| Copy F2's six files verbatim; watch the baseline hazard | Byte-identical copies; the ledger already had 63 rows, so they executed (log lines above). |
| Admin override: run `runtime.py` with `admin_override=True`; `is_override = ev['override']` | `runtime_for()` uses the default (True). `_write_approvals` sets `is_override` from the event. The DB guard accepted the flagged row (smoke step "override flagged …"). |
| Record an admin `submitted` as `submitted` (drop F3's rewrite to `approved`) | `_write_approvals` restores `verdict='submitted'` and drops the synthetic comment. Unit-tested for both the override case and the admin-only-stage case. |
| Gate facts = `site_module_outcomes.reached` (cumulative) + custom cases | `build_facts()`. Built-ins are also listed under their configurator alias (`pex`). `stages`/`fields` come from the custom `runtime_state`. |
| Runtime built from the site's pinned release, never the live one | Record release = site pin (a legacy site is adopted into live at its first case). The interpreter is cached per (release id, module). |
| Publish-time compile + lint; refuse on errors; hints become findings | `module_runtime/validate.py` (§M3). |
| Persist via F3 mapping functions onto F2 tables, audit in the locked transaction | `module_record_row`, `approval_row` (+ verdict fix), `runtime_state` = the whole state, stage upserts, audit per event. |
| Copy panzi-json-logic (keep LICENSE) + adapters (fix imports) + `jsonschema==4.26.0` & deps | `app/vendor/json_logic/` (+LICENSE, VERSION). The adapters' only edits are imports. Lock + pyproject updated; `start.sh` now re-syncs the venv when the lock changes. |

## Deviations from F2's proposal (and why)
1. **Extra migration `20261004_7_platform_workspaces.sql`.** F2's `tenant_config_live.workspace_ref`
   cannot exist before a live release (`release_id NOT NULL`). Provisioning must link the configurator
   id earlier, and must be idempotent and race-safe on it (claim row PK). The value is still mirrored
   into `tenant_config_live.workspace_ref` on every publish.
2. **Built-in routes.** `cfg_activate_release()` stores the manifest's built-in `route` (`/pex`,
   `/finance-ca`, …). The API serves the built-in's real SPA page instead (`/project-excellence`, …,
   custom → `/m/<key>`); the stored value stays as configuration data.
3. **Opening a case is refused while its gate is closed** (per the brief), instead of F3's
   "create locked case, refresh later". No locked records exist, so no refresh hook is needed.
4. **Legacy-site adoption:** the first custom case pins a NULL-pinned site to the live release, using
   F2's NULL → release path in `trg_sites_pin_release`, with audit policy `repin`. This keeps every
   later case on that site on the same version.

## Remaining gaps / caveats (for F5 and the lead)
1. **SEC-1 is still open.** `POST /auth/password-setup` sets a first password without any token. Both
   smokes still use it for the supervisor and the executive, which is the existing flow. The BA path in
   my smoke uses the setup code.
2. **Built-ins only honour enable/label/order/supervisor-only/delegation.** Their manifest gates, stages
   and approvers are not enforced (the bespoke code and `workflow_unlocks` are still hard-coded, F2
   §3). `manifest.permissions` is not enforced anywhere.
3. **Disabling a built-in only bites where `require_module` guards it:** legal, design, project,
   project_excellence, nso; financial-closure writes follow `project`. BD, finance_ca, launch_approval
   and financial-closure reads stay reachable. The UI must hide them; the backend should gain guards.
4. **Enablement follows the live release.** A module disabled or removed in a later release is closed
   even for cases opened on an older release (F2: "navigation from live, rules from pinned").
5. **Missing for custom modules:**
   - an upload endpoint for file fields (`MatrixFileWidget` has nowhere to store bytes);
   - a revoke endpoint for assignments/delegations;
   - notifications (the outbox is unused);
   - `stage_events` co-writes (SLA analytics do not see custom transitions);
   - site-tracker / queue integration (`site_stage_status_service`, `query_service`).
6. **Executives cannot list sites** (`/sites` returns 0 for them). They work from
   `GET /m/{key}/records` (assigned or delegated cases). Supervisors and BA list sites as before.
7. **JWT module claim = one primary module** (alphabetical among enabled memberships). `/m/*` routes
   check membership per request, so multi-module users work there, but built-in pages still use the
   claim.
8. **Provisioning edge cases:**
   - A crash between approval-commit and link-update leaves a tenant without a link. A stale claim
     (more than 10 min) can then be re-claimed, which would provision a second tenant.
   - A failed approval leaves its `workspace_requests` row pending.
9. **Shared publisher identity:** the publisher is the single platform-admin identity (email from env);
   `published_by_user_id` stays NULL.
10. **pytest writes to the sandbox DB:** `tests/test_migration_ledger.py` runs the real runner against
    the configured DB, so a test run applies pending migrations there. That is how `20261004_7` was
    first applied, by the same runner code.
11. **Rate limits:** two smoke-configurator runs plus one smoke-existing per 5 minutes is the most that
    fits (`password-reset/complete` / `password-setup` 5/300 s). Restart the apps to reset the limits.

## What F4b needs (details and examples in `docs/F4-API.md`)
**Configurator publish (platform admin, `X-Platform-Admin-Key`).**
- If `GET /platform/workspaces/{ref}` returns 404, call `POST /platform/workspaces` first. Show the
  workspace code and the setup code once.
- Then `POST /platform/workspaces/{ref}/releases {manifest, reason}`. Render `findings`: errors block
  the publish, warnings inform.
- `…/releases/validate` is the dry-run "Check" button.

**App chrome.**
- Build navigation from `GET /workspace/modules` (`route`, `label`, `navigation`, `my_roles`).
- Add a `/m/:moduleKey` route (HashRouter `/#/m/<key>`).
- `whoami.module` may be a custom key, so send those users to `/m/<key>`.
- `whoami.disabled_modules` lists the modules to hide.

**Generic module page.**
- List cases (`GET /m/{key}/records`; with `?site_id` it adds the gate preview).
- Open a case (409 `gate_closed` → locked screen from `gate.conditions`).
- Render the case detail with rjsf from `next_step.form.{schema,uiSchema}`, and buttons from
  `allowed_actions`.
- `POST …/actions`: send `expected_seq = record.seq`; map `errors` to rjsf `extraErrors`.
- Assign via `GET /m/{key}/members` and `POST …/assign`. This is required before an executive can act
  when `tiers.delegation` is true.
- History comes from `approvals` and `audit`; overrides carry `is_override` / `provenance.override`.

**Quirks.**
- `detail` is always a string, and machine-readable extras sit beside it.
- Pydantic body errors keep FastAPI's list shape.
- The org view now includes custom departments with `label`/`kind`.
- Disabled-module refusals are 403 and unknown modules are 404.

## Files
- **Changed in `app/backend`:**
  - `app/main.py`
  - `app/core/deps.py`
  - `app/rbac/guards.py`
  - `app/db/models.py`
  - `app/domain/schemas/business_admin.py`, `supervisor_codes.py`
  - `app/services/business_admin_service.py`, `supervisor_code_service.py`, `auth_repo.py`,
    `delegation_service.py`, `audit_service.py`
  - `pyproject.toml`, `requirements.lock.txt`
  - `tests/conftest.py`, `tests/test_observer_readonly.py`
- **New in `app/backend`:**
  - `app/core/problems.py`
  - `app/routers/{workspace,platform,module_runtime}.py`
  - `app/services/{module_registry_service,platform_workspace_service,module_runtime_service}.py`
  - `app/services/module_runtime/{__init__,gates,forms,runtime,validate}.py`
  - `app/services/module_runtime/manifest.schema.json`
  - `app/vendor/json_logic/**` (+ LICENSE, VERSION)
  - `database/migrations/20261004_{1..7}_*.sql`
  - `tests/test_configurator_integration.py`
  - `tests/fixtures/configurator_workspace_manifest.json`
- **Sandbox tooling:**
  - `app-stack/smoke-configurator.mjs` (new)
  - `app-stack/start.sh` (venv re-sync on lock change)
  - `app-stack/README.md` (one line)
- **Docs:**
  - `docs/F4-API.md`
  - `app/SANDBOX-CHANGES.md` (Phase 2 — F4a)
  - this report and `docs/reports/F4a-progress.md`
- **Evidence:** `app-stack/run/smoke/configurator-last-run.json` (no secrets; test-user passwords are in
  `configurator-last-run.secrets.json`, mode 600).

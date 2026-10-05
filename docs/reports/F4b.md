# F4b — frontend integration: report

**Status: done.** The whole journey runs in the browser on localhost:

1. The platform admin designs a workspace in the configurator inside the app's admin portal and publishes it.
2. The portal validates the design, provisions the tenant and stores the release. It shows the workspace code and a one-time setup code.
3. A fake workspace code is refused at login. The real code shows the company name.
4. The business admin claims the account with the setup code.
5. The business admin onboards a supervisor and an executive into a custom module.
6. A case runs through the stages and approvals designed in the configurator: submit, send back, resubmit, approve, complete.
7. That case's exit signal opens a downstream custom module's gate.

**F4b changed no backend file.**

Other documents:
- Change spec (every file, what changed and why): `app/SANDBOX-CHANGES.md`, section "Phase 2 — F4b".
- UI guide: `docs/F4b-UI.md`.
- Progress log: `docs/reports/F4b-progress.md`.
- Screenshots: `docs/reports/F4b-screens/` (22 files).

No secrets appear in this report.

## Results

| Check | Before F4b | After F4b |
|---|---|---|
| Frontend `npx vitest run` | 77 files, 624 tests: 622 pass, 2 fail | **84 files, 683 tests: 681 pass**, the same 2 fail (+59 new tests, 0 new failures) |
| `vite build` | passes | **passes**. `GenericRecordPage` chunk is 523 kB (rjsf + ajv). It is lazy-loaded, so the only effect is Vite's size warning. |
| `eslint src` | 0 errors, 33 warnings | **0 errors, 33 warnings** (no new warnings) |
| `node app-stack/smoke-existing.mjs` | 41/41 | **41/41**, re-run after F4b (no backend changes) |
| `node app-stack/smoke-configurator.mjs` | 67/67 | **67/67**, re-run after F4b |
| Browser journey (Claude Browser pane) | — | **completed end to end** (see below) |

**About the 2 failing tests.** They fail only because the sandbox `.env.local` sets `VITE_FEATURE_RENT_V2=true`:
- `launchApprovalRentV2` and `launchReviewRentV2`, both "flag OFF".
- With `VITE_FEATURE_RENT_V2=false` both files pass (9/9).

**No existing test was edited.**

## Milestones

### B1 — Configurator inside `/#/admin`
**What it does**
- `app/frontend/public/configurator/` is a copy of `web/public/`. The design file and the dc-runtime are byte-identical. Paths are prefixed with `/configurator`, and the font CSS uses relative paths. `web/` was not touched.
- The copy is embedded as a same-origin iframe in a new **Workspaces** tab.
  - The iframe is mounted the first time the tab is opened and then kept, hidden, so the canvas keeps its state while other tabs are in use.
  - The old approval queue tab is now called **Requests**. Requests, branding and password resets still work.
- A Vite proxy sends `/cfg` to `127.0.0.1:4300`. Drafts made in the app persist to NocoBase: the browser journey's workspace shows up in `GET /cfg/state`, with its release in `cfg_releases`.
- The platform-admin token is now kept **only in page memory**. It used to sit in `sessionStorage`, which the same-origin iframe could read.
- Orchestration (`app-stack/{lib,start,status,stop}.sh` and its README):
  - `start.sh` brings up NocoBase (the project-root compose project) and the configurator server as a daemon. Both are reused if already running.
  - `status.sh` shows 6 rows.
  - `stop.sh` takes a `--with-nocobase` flag.
  - Verified: an idempotent re-run of `start.sh`, and start/stop of the daemon on a spare port.

### B2 — Publish → provision → go live
**How a publish flows**
- `host-bridge.js` exists only in the in-app copy. It wraps v5's Publish button so the draft is sent to the portal first.
- The portal does the following:
  1. Calls `…/releases/validate`. Any error **stops v5's publish** and the findings are listed.
  2. Looks up the workspace with `GET /platform/workspaces/{ref}`. If the app has no tenant for it, the Provision dialog opens and calls `POST /platform/workspaces`.
  3. Shows the workspace code and setup code once, with a "share privately" note.
  4. Lets v5 publish.
  5. Stores v5's own `manifest()` with `POST …/releases`, using `source_ref = configurator:<ref>@v<N>`.
- A `manifest_invalid` refusal at step 5 is shown with Retry.

**Around the publish**
- **Check** runs a dry validation of the current draft.
- **Provisioned workspaces** lists each workspace with its release history, module registry and business-admin claim state.
- A 401 opens a re-auth dialog and retries the call.
- The iframe never receives the token. Every message checks both origin and source window.

**Demo workspaces (Blue Tokai, Starbucks, Burger King)**
- They provision and publish exactly like custom ones; their v5 id becomes the `configurator_ref`.
- All three v5 manifests validate with 0 errors.
- v5 keeps demo-workspace edits in memory only. What was published stays in the app.

### B3 — Workspace-code authenticity
- The code dialog refuses a well-formed fake code before any sign-in form is shown ("We couldn't find a workspace…").
- `/#/login/<fake>` shows **Workspace not found**.
- A real code shows the company name.
- The check reads the `name: null` answer of the existing `GET /tenancy/branding`, which is rate-limited. Nothing new is revealed.
- The first-password step gained a **Setup code** field. When it is filled, the account is claimed through `/auth/password-reset/complete`.

### B4 — Data-driven navigation
- `useWorkspaceModules()` calls `GET /workspace/modules` once per sign-in. It drives:
  - the custom module's sidebar, built from its published navigation;
  - a "Modules" section;
  - Payment and Launch, which are hidden when `finance_ca` / `launch_approval` are off;
  - the module switchers (observer banner, Workspace Access, the business-admin simulation bar);
  - the pending-approval tabs;
  - the Departments labels and icons.
- `whoami.disabled_modules` is kept in the session.
- Users whose `module` claim is a custom key land on `/#/m/<key>`. This covers the branded login, the index redirect and the guards.
- Legacy tenants fall back to the static list.

### B5 — Generic module pages
**`/m/:moduleKey`**
- Cases list with views (All / My turn / Awaiting approval / Closed).
- "Open a case" per site.
- A 409 `gate_closed` shows the **locked screen** built from `gate.conditions`.

**`/m/:moduleKey/records/:id`**
- The release the case is pinned to, plus the live version if newer.
- Stages with their tier chains and states.
- An rjsf form for submit steps. Client validation runs first; backend `errors` are mapped into rjsf `extraErrors`.
- Buttons come from `allowed_actions`, and every action sends `expected_seq`.
- A 409 conflict shows a "changed since you opened it" banner with Refresh.
- Assign (members of the module, when delegation is on).
- Approvals and audit trail, with provenance: policy, release version, actor role, override flag, chain check.
- The last send-back reason is shown to whoever acts next.

**Widgets**
- Person: a member picker filtered by tier.
- File: a clear "upload isn't available yet" notice plus a reference text field. This is a gap: there is no upload endpoint.

### B6 — Tests + browser journey
- 59 new tests, listed in `SANDBOX-CHANGES.md`. They cover:
  - the protocol on both sides, including forged and foreign messages and the stand-alone fallback;
  - the publish/provision/re-auth orchestration;
  - code authenticity and the setup-code claim;
  - data-driven lists;
  - the generic pages (locked screen, `expected_seq`, `invalid_form` mapping, stale banner, send back, assign).

## Browser journey (2026-10-05, screenshots in `docs/reports/F4b-screens/`)

| # | Step | Screen |
|---|---|---|
| 1 | Platform admin signs in → Workspaces: configurator + App panel | `01` |
| 2 | "+ New workspace" **Chai Point Retail** (`ws_chai_point_retail`) from the Blue Tokai template. NSO + Launch approval switched **off**. Custom **Vendor Onboarding** from the wizard's vendor template: stage 1 executive→**supervisor approval**, stage 2 supervisor, entry gate BD `submitted`, BA sign-off off. Custom **Store Fit-out**: blank template, gate Vendor Onboarding `approved`. | `02` |
| 3 | Check draft → 0 errors, 5 warnings | `03` |
| 4 | Publish v1 → Provision dialog → codes shown once → release v1 live, `CHAIPO-0458F2543F92FE4A` | `04` `05` `06` `07` |
| 5 | Fake code refused; real code shows "Chai Point Retail" | `20` `21` |
| 6 | Business admin claims the account with the setup code → BA portal. Departments lists the custom modules and NSO is gone. | `22` `23` |
| 7 | BA creates a BD site through the API (`POST /bd/drafts`). Store Fit-out → Open case → **locked screen** (gate closed). | `30` |
| 8 | Supervisor joins with the Vendor department code → BA approves → first password → lands on `/#/m/vendor_onboarding` | `24` |
| 9 | Supervisor generates an invite code (Team) → executive joins → supervisor approves. Supervisor opens the case (pinned v1) and assigns it. | `31` |
| 10 | Executive lands on the module and submits stage 1. An invalid GST number is caught by client validation; the corrected one is accepted. | `32` `33` |
| 11 | Supervisor **sends back** with a reason → executive resubmits → supervisor **approves** → stage 2 form (file-field gap shown) → **case completed**, chain verified | `34` `35` `36` |
| 12 | Store Fit-out's gate is now open → BA opens and approves the case → recorded as **override** | `37` |
| 13 | BA simulates BD: the Launch item is hidden (launch_approval off) | `25` |
| 14 | Admin token expiry, simulated with a forced 401 → re-auth dialog → retry succeeds | `08` |

**How the browser was driven (F5 should re-run this with real input)**
- The pane delivers no keyboard or mouse input while a viewport size is emulated. Steps were therefore driven with DOM events (`element.click()`, a native value setter plus `input`/`change` events), and the real React handlers ran.
- Platform-admin sign-in in the test tab answered the login call with a 30-minute token minted outside the browser from the sandbox credentials. The password never went through the browser or the driver.
- The real password check is covered by `smoke-existing`.
- The setup code was used once and is now consumed.
- Test-user passwords are in `app-stack/run/f4b-journey/secrets.json` (mode 600, gitignored).

## Backend changes
None.

## Running now / start / stop
`app-stack/status.sh` shows all six up:

| Component | Where | Started by |
|---|---|---|
| db | `127.0.0.1:54330` | app-stack |
| storage stub | `:54331` | app-stack |
| backend | `:8000` | app-stack |
| frontend | `:5173` | app-stack (restarted cleanly after the config change) |
| NocoBase | `:13000` | — |
| configurator server | `:4300` | an **external process** started earlier by the project-root `./start.sh` in a terminal. Left alone; `app-stack/stop.sh` will not stop it. |

- Start: `app-stack/start.sh`
- Stop: `app-stack/stop.sh [--apps] [--with-nocobase]`
- Status: `app-stack/status.sh`
- Tenants: 18.

**Note for the coordinator:** the "Chai Point Retail" draft (`ws_chai_point_retail`) and its tenant were **created by F4b's journey**, not by the user. It was not touched afterwards. `ws_aditya_test` was never touched.

## Known gaps and caveats for F5

**Works only on localhost**
1. `vercel.json` sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`, which would block the configurator iframe in production. The required change is documented in SANDBOX-CHANGES but not applied.
2. `/cfg` exists only on the Vite dev proxy. A deployed build has no design-time store, so drafts would stay in the browser.
3. The dc-runtime and ajv both use `new Function`. That is fine with today's report-only CSP and blocked once CSP is enforced (F3 lists three fixes).

**Security**
4. **SEC-1 is still open.** The setup code is optional on the first-password step, and supervisors and executives use the code-less path.
5. The workspace JWT is still in `sessionStorage` (existing behaviour), which the same-origin configurator page can read. That page is trusted code.
6. The Requests tab still logs out on a 401. Only the Workspaces area re-authenticates.

**Configurator ↔ app semantics**
7. App release numbers are independent of configurator versions; they are linked through `source_ref`.
8. If the release POST fails after v5 has published, the canvas says live vN while the app does not. The panel offers Retry, but the state diverges if the page is closed.
9. v5 publishes stand-alone if no portal acknowledges within 2.5 s. This only happens when the configurator is opened outside the portal.
10. v5's BD outcome list is submitted / allocated / approved / done. It has no `in progress`, which is what the app's shortlist produces. `allocated` is never reached in the app, so a gate on BD `allocated` can never open.
11. Demo-workspace edits are in-memory only in v5.
12. `/cfg/state` concurrency is one whole-blob `If-Match`. G1, the standalone configurator and the in-app copy all write it; a second writer gets the "Sync conflict · reload" pill.

**Runtime and UX gaps**
13. File fields have no upload endpoint; users type a reference instead.
14. There are no notifications for custom-module steps.
15. A stage's supervisor may fill the executive step (runtime rule; the UI shows a hint). Separation of duties then needs another approver: with a single supervisor only the BA (as override) can continue.
16. Disabling a built-in hides only its navigation. Page widgets, such as the Overview "Launch" tile, still show, and BD / finance_ca / launch / financial-closure are not backend-guarded (F4a).
17. Workspace Access does a full reload to `/m/<key>`, which leaves `/m/<key>#/m/<key>` in the address bar (the same pattern as the existing `/legal`).
18. Executives cannot list sites, so they work only from assigned cases.
19. The BD site for the journey was created through the API. The UI path is BA → Workspace Access → BD → New pipeline, and it was not exercised.

**Not exercised / pre-existing**
20. Branding logo upload was not exercised in the browser (no file input in the pane); the company name was.
21. The BA portal header shows "Workspace" instead of the company name (upstream: the JWT carries no name).
22. Executives see "Team" in the sidebar.
23. The first visit to a case page used to force a dev full reload. Fixed with `optimizeDeps`.

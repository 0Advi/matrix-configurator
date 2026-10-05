# F4b — frontend integration: progress log

Resume from the last entry. Final report: `docs/reports/F4b.md`.

## 2026-10-04 — start
- Read PHASE2-PLAN, F4-API, F4a, F1, web/ README+CHANGES, oss/for-F4, app frontend structure.
- Stack status at start: db/storage/backend/frontend up (ledger 70, 15 tenants); configurator :4300 up in
  `nocobase` mode (started by someone from the root `start.sh`, foreground); NocoBase containers healthy.
- **Baseline frontend tests** (`npx vitest run`, before any F4b change): 77 files, 624 tests —
  **622 passed, 2 failed**. Both failures are pre-existing and environmental:
  `launchApprovalRentV2.test.jsx` / `launchReviewRentV2.test.jsx` "flag OFF … V1 radiogroup" — the sandbox
  `.env.local` sets `VITE_FEATURE_RENT_V2=true`, which vitest picks up.
- Probe: v5's own `manifest()` for bluetokai / starbucks / burgerking and a template-based custom workspace
  all pass `POST /platform/workspaces/{ref}/releases/validate` (0 errors) → demo workspaces can be
  provisioned + published like custom ones.

## Plan
B1 configurator copy at `public/configurator/` + `/cfg` proxy + orchestration · B2 publish gate/hook in the
copy (`host-bridge.js`) + host orchestration in the admin portal · B3 code authenticity via branding lookup ·
B4 `useWorkspaceModules()` + data-driven chrome · B5 `/m/:moduleKey` generic pages (rjsf) · B6 tests + journey.

## Milestones B1–B5 coded (not yet browser-verified)
- B1: `app/frontend/public/configurator/` = copy of `web/public` (paths under `/configurator`, fonts css relative,
  `boot.js` installs `host-bridge.js`); Vite proxy `/cfg` → 127.0.0.1:4300 (verified: `/cfg/health` via 5173 → nocobase mode;
  `/configurator/index.html` boots, hydrates from NocoBase). Portal: `Workspaces` tab (iframe kept mounted), existing tab
  renamed `Requests`; admin token now memory-only (`AdminPortalPage.jsx`); helpers → `admin/adminApi.js`,
  `admin/CredentialsDialog.jsx` (login link fixed to `/#/login/<CODE>`).
- B2: `host-bridge.js` (frame) ⇄ `admin/workspaces/configuratorHost.js` (host): pre-publish gate (validate → provision
  dialog on 404 → codes once) and `published` → POST releases; Check button; re-auth dialog on 401; Provisioned list.
- B3: `landing/workspaceLookup.js` `isUnknownWorkspace()` — dialog refuses fake codes, login page shows "Workspace not
  found"; setup-code field on the first-password step (uses `/auth/password-reset/complete`).
- B4: `state/useWorkspaceModules.js`; sidebar/switchers/pending tabs/org labels data-driven; `/m/<key>` routing for custom claims.
- B5: `custom-module/{GenericModulePage,GenericRecordPage,GateLocked,widgets,kit}.jsx` + rjsf 6.11.0 (exact pins).
- `vite build` passes (GenericRecordPage chunk 523 kB incl. rjsf+ajv, lazy). Suite mid-run: only the 2 baseline failures
  remain after fixing 11 regressions (partial authToken mocks; raw-slug label).
- Browser note: the Claude Browser pane can't paste from the OS clipboard and keystrokes don't reach inputs under
  viewport emulation; typing the platform-admin password would put it in the transcript, and a loopback one-shot helper
  was refused by the permission classifier. Plan: browser-drive everything after the admin sign-in; see report.

## 2026-10-05 — resumed after a usage-limit interruption (working tree checked; nothing re-applied)
Already on disk before the interruption (verified): everything above **plus**
- orchestration: `app-stack/lib.sh` (CFG_PORT/NOCOBASE_PORT + `cfg_health`/`nocobase_up`/`nocobase_compose`),
  `start.sh` step 4 (NocoBase compose + wait/provision + `web/server.mjs` daemon `configurator`, `--no-configurator`),
  `status.sh` rows `nocobase` + `configurator` (external process detected), `stop.sh` (`configurator` daemon,
  `--with-nocobase`). Verified: idempotent `start.sh` no-op; daemon start/stop on a spare port (CFG_PORT=4301).
- new tests: `shared/__tests__/workspaceModules.f4b.test.js` (8), `landing/__tests__/workspaceAuthenticity.test.jsx` (7),
  `admin/workspaces/__tests__/{hostBridge.test.js (8), configuratorHost.test.js (7), WorkspacesArea.test.jsx (7)}`,
  `custom-module/__tests__/{moduleRuntimeApi.test.js (11), GenericModulePages.test.jsx (9)}` — all green.
- browser: fake code rejected in the code dialog (screen `20-fake-code-rejected.jpg`). Driving notes: keystrokes/clicks
  are NOT delivered while the pane emulates a viewport, so the journey uses DOM events (`element.click()`, native
  value setter + input event) under a 1600×950 emulation; platform-admin sign-in in the test tab answers the login
  call with a 30-min token minted outside the browser from the sandbox creds (password never in the browser/driver).
Next: B6 browser journey → screenshots → final test run → docs (`docs/F4b-UI.md`, `SANDBOX-CHANGES.md`, `F4b.md`).

## 2026-10-05 ~10:40 — B6 browser journey DONE (before the second interruption notice)
Whole journey run once in the Claude Browser pane (screens in `docs/reports/F4b-screens/`, 21 files):
platform-admin sign-in → Workspaces → **created custom workspace "Chai Point Retail" (`ws_chai_point_retail`)** from the
Blue Tokai template → NSO + Launch approval OFF → custom modules **Vendor Onboarding** (2 stages: executive→supervisor,
supervisor; gate BD `submitted`; BA sign-off off) and **Store Fit-out** (gate Vendor Onboarding `approved`) → Check (0 errors,
5 warnings) → Publish v1 → provision dialog → codes shown once → release v1 live (`CHAIPO-0458F2543F92FE4A`) → fake code
refused / real code shows "Chai Point Retail" → BA claimed with the setup code → BA Departments (custom modules listed, NSO
gone) → supervisor joined with the Vendor dept code, approved → executive joined with the supervisor code, approved →
supervisor opened the case (BD site created by the BA through the API) → assigned → executive submitted (client validation
shown) → supervisor sent back → executive resubmitted → supervisor approved → stage 2 → case completed → Store Fit-out
(locked earlier) opened and approved by the BA as an audited override. Re-auth dialog exercised (simulated 401).
NOTE for the coordinator: `ws_chai_point_retail` / tenant "Chai Point Retail" is F4b's journey workspace (created by me,
not by the user). Left as is; not modified further. Test-user passwords: `app-stack/run/f4b-journey/secrets.json` (600).
Refinements after the journey (all applied + tests green): custom-module labels in Team page / pending chip (built-ins
unchanged), friendlier rjsf messages (`transformErrors`), send-back reason + self-fill hint in Next step, verdict text,
App panel width `clamp(280px,30vw,380px)`, Vite `optimizeDeps` pre-bundles rjsf (the first case page triggered a dev
full reload), IndexRedirect follows the simulated module (BA simulation bar → BD bounced back before).
Next: full test run, build, docs (F4b-UI.md, SANDBOX-CHANGES, F4b.md), handback. No more edits in the configurator
(G1 shares `/cfg/state`).

## 2026-10-05 — DONE
Final: vitest 683 tests / 681 pass / same 2 env-caused failures (before 624/622); `vite build` ok; eslint 0 errors,
33 warnings (= before); smokes 41/41 + 67/67 re-run; frontend dev server restarted cleanly (optimizeDeps). Docs:
`docs/F4b-UI.md`, `app/SANDBOX-CHANGES.md` (Phase 2 — F4b), `app-stack/README.md`, `docs/reports/F4b.md`.
Stack left running (status.sh: 6/6 up; configurator :4300 = external process from the root start.sh).

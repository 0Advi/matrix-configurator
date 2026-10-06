# Project status — Matrix Configurator

**As of 2026-10-06** · Repo: https://github.com/0Advi/matrix-configurator (private) · `main` @ `741cfde`

Legend: ✅ done, verified by the lead and **pushed** · 🔄 in progress (on disk, **not pushed yet**) · ⬜ to do

- **Run it:** `./app-stack/start.sh` (everything: DB, storage stub, API :8000, web :5173, NocoBase :13000,
  configurator server :4300) · check with `./app-stack/status.sh`.
- **Logins:** `node show-logins.mjs` → `LOGINS.local.md` (local only, gitignored).
- **Compare with the original app:** `git diff original-matrix-bd-3d4f277 HEAD -- app/`; every change explained
  in `app/SANDBOX-CHANGES.md`.
- **What came from Operaton / NocoBase and where to see it:** `docs/ADOPTION-AUDIT.md`.

---

## 1. Done, verified and pushed ✅

### Phase 1 — standalone configurator (commit `9005da1`)
| # | Item | Where | Verified |
|---|---|---|---|
| 1.1 | Workspace Configurator (v5 design) running on localhost, unmodified, fully offline; a bug in the original artifact (it never saved) fixed from outside | `web/` · http://localhost:4300 | 54 unit + 22 E2E tests; browser |
| 1.2 | NocoBase 2.2.20 + Postgres in Docker as the design-time draft store; client library | `nocobase/`, `docker-compose.yml` | smoke 14/14 |
| 1.3 | Building blocks extracted from the design, the real app and NocoBase, with provenance | `building-blocks/` (`CATALOG.md`) | 109 tests |

### Phase 2 — the configurator drives a real, modular copy of the app (`9005da1`)
| # | Item | Where | Verified |
|---|---|---|---|
| 2.1 | **F1** Copy of the real Matrix app running fully on localhost (local DB, storage stub, fresh secrets) | `app/`, `app-stack/` | existing flow 41/41 |
| 2.2 | **F2** Schema audit (task 3): the real DB can't run configurator workspaces today; **6 additive migrations** fix that | `docs/schema-audit/` (`REPORT.md`) | 161 checks; applied via the app's runner |
| 2.3 | **F3** Provenance + licence audit of everything borrowed; OSS gap analysis; json-logic + form compiler + reference runtime; Operaton & SpiffWorkflow spikes | `docs/oss/`, `third_party/`, `THIRD_PARTY.md` | 36 tests |
| 2.4 | **F4a** Backend: migrations applied, data-driven module lists, platform provisioning + publish API, generic custom-module runtime (stages, tier approvals, gates, version pinning, audit provenance) | `app/backend/`, `docs/F4-API.md` | backend 654; configurator smoke 67/67 |
| 2.5 | **F4b** Frontend: configurator inside `/#/admin`, publish → provision → workspace code + setup code, "workspace not found" check on login, data-driven navigation, custom-module pages | `app/frontend/`, `docs/F4b-UI.md` | frontend 681/683*; browser journey |

### Phase 2b — from `operaton-plat` + visibility (`3e7c4cf`, `a015bc5`, `0f4028f`, `741cfde`)
| # | Item | Where | Verified |
|---|---|---|---|
| 2b.1 | **G1** AI-agent configurator: 27 ops as CLI + MCP server, editing the same drafts as the visual configurator | `agent-configurator/` | 49 tests; live CLI + MCP |
| 2b.2 | **G2** Catalogue cross-check: operaton-plat vs our model vs real code (D01–D33) | `docs/catalogue-crosscheck/` (`REPORT.md`) | 16 tests |
| 2b.3 | **G3** Migrate running cases (audited, dry-run first); "only for sites they created" rule; role-scoped saved views | `app/`, `docs/G3-API.md` | backend 683; G3 smoke 59/59 |
| 2b.4 | **N1** NocoBase made visible: "Matrix Configurator" menu (7 read-only pages), workflow (release → activity log), read-only role | `nocobase/` · http://localhost:13000 | provisioners idempotent; viewer writes → 403 |
| 2b.5 | **Approved fixes 01/02/03** applied: corrected flow model, catalogue migration fixing the "BD done opens too early" gate bug (D18) + unreachable outcomes (D19), stale approvals claim | `building-blocks/`, migration `20261005_4` | all suites green |
| 2b.6 | **Adoption audit** (user chose: Operaton = ideas only): every Operaton/NocoBase concept → code → localhost click-path | `docs/ADOPTION-AUDIT.md` | every path checked against the tree |
| 2b.7 | Login list generator | `show-logins.mjs` | gitignored output, mode 600 |
| 2b.8 | **W1** AI agent's `migrate_running` now calls the real migrations API (dry-run default; confirm + reason to execute; never re-sent) + `migration_status` op — 28 tools (`b570312`) | `agent-configurator/` | 64 tests; live dry run moved nothing |

\* The 2 failing frontend tests are rent-v2 "flag OFF" tests; they fail only because the sandbox turns that flag on, and pass 9/9 with it off.

### Latest verification baseline (lead, after the fixes)
| Suite | Result |
|---|---|
| Backend pytest | **683 passed**, 1 skipped |
| Frontend vitest | **695 / 697** (2 = sandbox flag, see *) · `vite build` passes |
| Smoke: existing flow / configurator / G3 | **41/41 · 67/67 · 59/59** |
| building-blocks · adapters · agent-configurator · crosscheck | **109 · 36 · 49 · 16** |
| Migration ledger | **74** (63 original + 6 schema-audit + platform workspaces + 3 G3 + catalogue fix) |
| Secret scan before every push | **0 hits** every time |

---

## 2. In progress — on disk, not pushed yet 🔄
| Task | Agent | Status |
|---|---|---|
| Caveat fixes (task 4) — see 3.1 below | F5a | SEC-1 fix under way: platform admin can now re-issue an unclaimed admin's setup code |

The lead pushes these only after verifying them.

---

## 3. Remaining tasks ⬜

### 3.1 Caveat fixes (F5a, running)
- [ ] **SEC-1** — close the first-password takeover: an approved-but-unclaimed account (business admin, supervisor, executive) can be claimed with just the workspace code + email. Require a one-time code (or capture the password at signup).
- [ ] Re-issue a setup code for unclaimed admins (e.g. **Agent Coffee**) — *in progress*.
- [ ] Disabled built-in modules must be **refused by the API**, not only hidden (BD, Finance/CA, Launch, Financial-closure reads) — includes real-app quirk D22.
- [ ] Release-migration robustness: recover headers stuck in `running`; decide on re-pinning sites with no running case.
- [ ] Generic runtime honours `X-Override-Role` like the rest of the app.
- [ ] File-upload fields in custom modules.
- [ ] Consistent re-auth in the admin portal (Requests tab logs out on 401); stray `/m/<key>#/m/<key>` URLs; exercise logo upload.
- [ ] `docs/PRODUCTION-GAPS.md`: `X-Frame-Options: DENY` in `vercel.json`, `/cfg` dev-proxy only, CSP vs `new Function`.

### 3.2 End-to-end proof (F5b — after F5a)
- [ ] Re-runnable **Playwright** E2E with **real** keyboard/mouse input: create workspace → publish → provision → fake/real code → claim business admin → onboard supervisor + executive → run the configured custom module (send-back, approve, complete) → publish v2 → migrate a running case.
- [ ] `docs/e2e/TRACE.md`: step-by-step trace with screenshots showing where the app is modular and where it isn't.
- [ ] Walk every click-path in `docs/ADOPTION-AUDIT.md` and mark it verified.

### 3.3 Wrap-up (lead)
- [x] Verify + push W1 (`b570312`). - [ ] Verify + push F5a, F5b; refresh README; final handover.
- [ ] Clean up sandbox test tenants (smoke runs create one per run) or provide a one-command reset.

### 3.4 Known limitations — not scheduled (decide later)
- Built-in modules honour on/off, labels, order, supervisor-only and delegation only; their own **stages / approvers / gates are still hard-coded**; `manifest.permissions` is not enforced.
- Custom modules: no notifications, no SLA events (`stage_events`), no tracker/queue integration.
- Login token carries **one** primary module (built-in pages rely on it).
- Saved-view filters run in Python, one list call per view — fine here; real project should filter in SQL and paginate.
- Standalone configurator (`web/`) keeps but doesn't show the creator-only flag; `building-blocks` manifest schema doesn't know `restricted_to` yet.
- Not adopted from Operaton (by decision): engine, BPMN interchange, Cockpit-style monitoring, job workers/timers.
- G2 patch **02b** (optional view change) not applied; NSO sign-off fields not moved to stage 3 (D30).
- Decisions needed before anything leaves the team: **licence of the dc-runtime/design export** (none stated); **legal review of NocoBase's licence** (§5.4).

### 3.5 For the REAL Matrix-bd project (your team — nothing here was changed in the real repo)
- [ ] **Fix SEC-1 in production** (confirmed in `origin/main`: `tenancy_service.py:326-360`, `auth.py:396-456`).
- [ ] Run `docs/schema-audit/live-db-drift-check.sql` (read-only) against the real DB.
- [ ] Fix the broken existing migrations `202606231` (policy guard) and `202606133` (`CREATE INDEX CONCURRENTLY` in a transaction); regenerate `verified.sql`; stop bootstrapping from the stale `schema.sql`.
- [ ] Apply the change set in order: `20261004_1…7` → `20261005_1…4` (+ F5a's) — plan in `docs/schema-audit/REPORT.md` §7 and `docs/reports/G3.md`.
- [ ] App changes per `app/SANDBOX-CHANGES.md` (data-driven modules, provisioning/publish API, generic runtime, frontend).
- [ ] Upstream quirks from the cross-check: D22 (supervisor routes check role but not module), D31, D32.

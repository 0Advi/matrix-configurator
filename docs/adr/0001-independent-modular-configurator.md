# ADR: Independent Modular Matrix Configurator

**Status:** Accepted (pending the step-0 decisions in §12) · **Date:** 2026-10-06 · **Task 18**
**Supersedes:** any conflicting statement in the Task 1–17 reports; where this ADR and a report disagree, this ADR wins.

| # | Input | Path |
|---|---|---|
| 1 | Clean-room independence audit | `docs/independence/AUDIT.md`, `inventory.json` |
| 2 | Universal module manifest | `docs/manifest/README.md`, `packages/manifest/` |
| 3 | Draft/release store | `docs/store/README.md`, `API.md`, `packages/store/` |
| 4 | Built-ins as templates | `docs/templates/README.md`, `templates/matrix-bd/` |
| 5 | Adapter interface | `docs/adapters/README.md`, `packages/adapters/` |
| 6 | Modular RBAC | `docs/rbac/README.md`, `packages/access/` |
| 7 | Runtime hardening | `docs/runtime/HARDENING.md` |
| 8 | Generic frontend | `docs/frontend/GENERIC-RUNTIME-SPEC.md` |
| 9 | Native builder | `docs/configurator/NATIVE-BUILDER-PLAN.md` |
| 10 | Event bus | `docs/events/EVENT-BUS.md` |
| 11 | Notifications / SLA | `docs/notifications/NOTIFICATIONS-SLA.md` |
| 12 | File fields | `docs/files/FILE-FIELDS.md` |
| 13 | Release migration | `docs/migrations/MIGRATION-HARDENING.md` |
| 14 | Production security | `docs/security/PRODUCTION-HARDENING.md` |
| 15 | Licensing | `docs/licensing/CLEANUP.md` |
| 16 | Modularity tests | `docs/testing/MODULARITY-TEST-PLAN.md` |
| 17 | Cutover | `docs/cutover/CUTOVER-PLAN.md` |

## 1. Decision

Build a **standalone, first-party workspace platform** in a new repository (working name `workspace-platform`) in which
**every module, built-in or custom, is data**. The single source of truth is:

> **manifest** (what a workspace is: subjects, roles, modules, stages, fields, gates, grants)
> → **release** (an immutable, validated, versioned snapshot of a manifest; one live per workspace)
> → **runtime** (generic engine that runs cases pinned to a release and records everything as events).

No code path may know a module key, a role name or a customer. The Matrix-bd sandbox (`app/`), the Claude dc-runtime
configurator and NocoBase are **archived, not shipped**.

## 2. Context

* The current product is a copy of the proprietary Matrix-bd app with a configurator bolted on: built-in modules are
  hard-coded pages and services, custom modules run on a partial generic runtime keyed to BD `sites` (T1, T7 RT-F01).
* Modules write each other's tables directly (37 coupling points, T10 §1); permissions are a fixed four-role ladder
  plus one `module` token claim (T6); the configurator is an unlicensed dc-runtime artifact in an iframe that syncs to
  source-available NocoBase (T9, T15).
* Tasks 2–6 already produced tested first-party replacements for the core (manifest 78, store 12, adapters 40,
  access 35, templates 24 tests); Tasks 7–17 planned the rest.

## 3. Non-goals

* Not a fork or cleanup of Matrix-bd; no Matrix-bd file is moved into the product (T17 §4, T15 §1).
* No general low-code/app builder: the domain is **case workflows** (stages, approvals, gates, outcomes) over subjects.
* No marketing site, no AI agent, no v5 importer as a product feature, no multi-region/multi-instance rate limiting in v1.0.
* No customer content in the product repo: Matrix-bd templates and its BD adapter live in a private customer repo (T4, T15, T17).
* No legal conclusions here — open licence questions go to legal review (T15 §5b).

## 4. Architecture

```
web/ (Vite + React)                      server/ (FastAPI)                           packages/ (pure, tested)
  shell · auth · ui                        core (config, db, problems, rate limit)      manifest  schema + validator R0–R13
  runtime pages  /m/:module/...  ───────►  identity (clean-room)                        store     drafts · releases · migrations
  admin/builder  /admin/workspaces/...     platform (provision, publish via store)      access    authorize() · Guard · ceiling
                                           runtime (cases, stages, approvals, gates)    adapters  sdk · host · lint
                                           events → record_facts, audit, subscribers    rules     gate/form compilers (JsonLogic)
                                           notify (timers, deliveries)  files (case_files)
PostgreSQL (RLS on app.workspace_id everywhere)          object storage (private bucket only)
```

Rules that bind every component:
1. **One decision function** — `authorize(principal, action, resource, policy)` (T6). Routes use only `Guard.check()`;
   services and adapters never check roles (adapters cannot see roles, lint AD002).
2. **One way between modules** — events (T10). No module writes another module's tables; gates read `record_facts`.
3. **One place for behaviour** — the pinned release. Behaviour the manifest cannot express goes through a declared,
   versioned adapter (T5), never a module-specific page or service.

## 5. Data model

Canonical first-party SQL, applied in order on an empty database (**resolves** the T3/T6/T10–T12/T17 numbering):

| File | Owns | Source |
|---|---|---|
| `0001_identity` | users, workspaces, members, invites, setup codes, **sessions** (revocable) | T17 rewrite + T14 SEC-01/03/04 |
| `0002_store` | `workspace_drafts`, `workspace_releases`, `workspace_modules`, `workspace_release_migrations` (+ items), `workspace_activity` (hash chain) | T3 (exists) + T13 §5.9 columns |
| `0003_runtime` | `subjects`, `cases` (pinned `release_id`, `seq`), `case_stage_passes`, `case_values`, `case_events` (per-case hash chain, anchored) | T7 §4 |
| `0004_access` | `workspace_role_assignments`, `module_memberships`, `workspace_access_versions` | T6 (exists) |
| `0005_events` | `workspace_events` (outbox + log), `event_subscriptions`, `event_inbox`, `event_dead_letters`, `record_facts` | T10 §4 |
| `0006_notify` | `case_timers`, `notification_deliveries`, `notification_attempts`, `notification_preferences` | T11 §7 |
| `0007_files` | `case_files`, `case_file_attachments`, `case_file_access_log`, `storage_purge_queue` | T12 §4 |

Invariants: every row carries `workspace_id` under forced RLS; cases are keyed by `case_id` and reference a declared
**subject** (never `sites`); stages and fields are addressed by **key**, never order (T7 RT-D01); field values hold ids
(files, people), never URLs; releases are immutable; audit chains are anchored at the tail (T7 RT-B09).

## 6. Runtime model

* **Port, don't rewrite**, the project's own generic runtime from the sandbox (T15 §3a, T17 §2) into `server/app/runtime`,
  re-keyed from sites to cases, and fix the T7 bugs on the way (RT-B01 roll-ups, RT-B03 reject outcome, RT-B05
  send-back, RT-B07 empty required values, RT-B09 chain tail, RT-B10 stale delegation, RT-B15 schema/runtime drift).
* A case is opened on the **live** release and stays **pinned** to it until a migration moves it (T3, T13).
  Every case action carries `expected_seq` (mandatory, T7 RT-F14 / T13 MH-B09); a mismatch is `409 stale`.
* State changes write the case row, a `case_events` row and a `workspace_events` row in **one transaction**.
* Gates (entry and stage) are compiled from the release and evaluated against `record_facts` only (T10 §7).
* Overrides exist only via the `override_step` grant, are recorded `as_override`, and never change the step or the
  tier's allowed actions (T6).
* SLA timers are durable rows claimed with `SKIP LOCKED`; breaches emit `module.sla.breached` + an audit row (T11).
* Event envelope (T10 §3) on every event: workspace, module, record/case id, subject, stage, actor, **release
  (id, version)**, timestamps, correlation/causation, idempotency key. For record events `release` is the release the
  record is pinned to **after** the event (so `module.record.migrated` carries the target, T13); `release.*` events have
  `record_id = null`. `module.file.downloaded` is an audit row, not a bus event (T12).

## 7. Configurator model

* A **native React builder** under `/admin/workspaces/:ws/...` (T9 §4) replaces the dc-runtime iframe, the bridge
  scripts, `/cfg` and NocoBase. No iframe, no `unsafe-eval`.
* Editors are **schema-driven** from `workspace-manifest/1`; findings from the validator are mapped by JSON path onto
  the exact control. Templates are data loaded from `GET /templates`, never code.
* Drafts save through the store API with revisions and optimistic concurrency (`revision_conflict` → merge dialog);
  publish runs validator R0–R13 + platform ceiling C1, then `store_publish`; history, diff and migration are store APIs.
* Old v5 drafts are imported once by a migration tool (`from_v5.convert`, findings kept as `IMPORT` info, T9 §8);
  the importer is not a product feature.

## 8. Security model

* **Identity:** the token carries identity only; roles and memberships are read from the DB on every request
  (`access_principal`, T6). Access tokens live **in memory**; refresh is an httpOnly, `SameSite=Strict` cookie bound to
  a server-side **session** that logout, password reset and deactivation revoke; refresh chains have an absolute
  lifetime (resolves T14 SEC-01, SEC-05 token storage).
* **Platform admins** are per-person accounts with MFA, signed with a **separate key and audience**, re-checked against
  the DB on every request; the platform operator can manage workspaces but never work cases (T6, T14 SEC-03/04, T17).
* **"View as"** is the `X-View-As` header and only narrows reads; `X-Override-Role/Module` are removed (T6, T14).
* **Rate limits** on login, refresh, setup/join codes and uploads, shared across instances via Postgres or Redis
  before any multi-instance deploy (T14 SEC-02); per-account lockout; minimum password length raised.
* **Web:** enforced CSP (no Report-Only), `frame-ancestors 'none'`, no `unsafe-eval`, no external runtime requests.
* **Files:** private bucket only (boot check refuses public), server-side type sniffing that fails closed, downloads
  only after `authorize(case.view)` with ≤ 60 s signed links (T12, fixes T14 upload bypass).
* Every denial is RFC 9457 problem+json with a stable code; every denial and override is audited with `explain()`.

## 9. Licensing model

* **Product code** is first-party, clean-room: the T2–T6 packages, the ported generic runtime written by this
  project (T15 §3a), and new code. The licence is chosen at step 0 (T15 §7); every package declares it.
* **Not allowed in the product:** proprietary Matrix-bd code, assets, schema or brand (`app/`, `building-blocks/from-matrix-bd/`,
  `z-matrix-design-system`); Claude dc-runtime (`support.js`, `*.dc.html`) in any form; NocoBase as a runtime,
  build or production dependency; any source without a licence (operaton-plat: ideas only, pending the ideas grant LR-06).
* **Ideas only** (behaviour may be re-specified, nothing copied): Matrix-bd flows (as templates, in the customer repo),
  the v5 configurator UX, operaton-plat concepts (T15 §6a). Clean-room rules in T15 §6b and T1 §6 apply.
* Permissive dependencies are kept with notices; copyleft/unknown ones (psycopg LGPL-3.0 test-only, certifi MPL-2.0)
  go to legal review before a distributed image ships. `THIRD_PARTY.md` is regenerated by a CI licence scan.

## 10. Migration model

Two different migrations, kept separate:

* **Running cases between releases** (T13). Dry run is mandatory and produces a frozen plan with `plan_sha256`;
  execute takes only `{migration_id, plan_sha256, reason}` and the `migrate_cases` grant. Stage/field identity comes
  from keys, explicit `stage_map`/`field_map`, or builder-recorded `migration_hints` — never names or order. Each case
  is migrated in its own transaction with before/after state in the journal; incompatible cases are **skipped with a
  reason code**, not corrupted. **Resolved conflict:** a case that changed after the dry run is skipped
  (`record_changed_since_plan`); only a change of source/target/live release refuses the whole plan (T13 replaces
  T3 API §5.2). One running migration per workspace; revert is a counter-migration within a window.
* **Sandbox → product** (T17). Product data starts fresh; v5 drafts and custom-workspace releases are imported once;
  the sandbox repo is archived read-only (tags `original-matrix-bd-3d4f277`, `sandbox-final-<sha>`); secrets,
  volumes and build output are deleted and the NocoBase key revoked.

## 11. Alternatives rejected

| Alternative | Rejected because |
|---|---|
| Harden the Matrix-bd copy into the product | Proprietary code, customer brand, fixed roles and site-keyed design (T1, T15) |
| Keep NocoBase as the draft/release store | Source-available licence forbids the hosting model; second data plane (T3, T15) |
| Keep the dc-runtime configurator in an iframe | No licence; same-origin frame can read tokens; needs `unsafe-eval` (T9, T14 SEC-06) |
| Keep built-in modules as hand-written pages/services beside the runtime | Two runtimes, cross-module writes, no release pinning (T7 RT-F02, T10) |
| Role ladder + one `module` claim with more special cases | Cannot express custom roles, borrowed tiers or multiple memberships (T6) |
| Cross-module calls inside one transaction instead of events | Couples modules' schemas and release cycles; gates would read foreign tables (T10) |
| Adapters with DB access for flexibility | Breaks release pinning and isolation; untestable (T5) |
| Rewrite the generic runtime from scratch | It is first-party and largely right; T7 lists targeted fixes |

## 12. Implementation phases

| Phase | Scope | Exit |
|---|---|---|
| **0 Decide** | Product name, licence, LR-06 ideas grant, legal review list (T15 §5b), templates → private customer repo | Decisions recorded in `docs/DECISIONS.md` |
| **1 Foundations** | New repo; move `packages/*`; `0001_identity` (sessions, per-person platform admins); Guard on all routes; CSP enforced | C1, C3 (0001–0004), C5 |
| **2 Runtime** | Port runtime to `0003_runtime` (case_id, keys, expected_seq, T7 fixes); `0005_events` with `record_facts` + audit subscribers; generic UI pages (T8) | Acceptance steps 1–6 green |
| **3 Builder** | Native builder (T9 P1–P2), store API endpoints incl. workspaces/templates/schema; v5 import tool | Builder E2E green; iframe, `/cfg`, `web/` gone |
| **4 Files + migration** | `0007_files` (T12), migration hardening (T13) | Acceptance steps 7–11 green |
| **5 Release v1.0.0** | Licence scan, independence check, archive sandbox | §13 all green |
| **6 v1.1** | Notifications/SLA dispatch (T11), saved views, adapters enabled, multi-instance rate limits, agent | T11 tests NT1–NT16 |

`0006_notify` tables ship in v1.0 so the SQL sequence stays contiguous; notification dispatch is switched on in v1.1.

**Resolved scope conflict:** T17 deferred files, running-case migration and events to after v1.0, but the
modularity acceptance suite (T16 §8) — which must pass for v1.0 — needs all three. They are therefore **in** v1.0
(phases 2 and 4); only notification dispatch, saved views, adapters and the agent stay deferred.

**Resolved location conflict:** the acceptance suite lives in the new repo at
`server/tests/acceptance/test_modularity_acceptance.py` (+ `tests/e2e/acceptance.spec.ts`), not under `app/` (T16 §8).

## 13. Final acceptance criteria

v1.0.0 ships only when all hold:

1. **Source of truth:** every module the product runs (including the reference templates) is loaded from a published
   release; deleting all module-specific code paths changes nothing (`tools/check-independence` blocker rules = 0).
2. **Modularity:** acceptance suite 12/12 on a non-Matrix-bd workspace — create workspace, add custom module, publish,
   open case, stage approval, gate next module, upload file, publish v2, migrate running case, disable module,
   disabled API refusal, no Matrix-bd dependency (T16 §8) — via `make test-modularity`, with no skipped slow tests.
3. **Not allowed, enforced in CI:** hard-coded module or role logic (independence check + adapter lint AD002);
   NocoBase as a production dependency; dc-runtime in production; proprietary Matrix-bd code, data or brand
   (T17 C1–C2, T15 §7).
4. **Isolation:** no module writes another module's tables (static check on SQL in `server/app/runtime`); gates read
   `record_facts` only; every audit row carries event id and release id.
5. **Security:** T14 go/no-go checklist all green (no BLOCKER open); CSP enforced; private bucket only.
6. **Migration safety:** dry run mandatory, reason required, before/after saved, skip-not-corrupt, repeat-safe (T13 §10).
7. **Licensing:** `LICENSE` chosen, `THIRD_PARTY.md` regenerated, licence scan clean, legal-review items closed.
8. **Operability:** fresh-database `0001`–`0007` apply and re-apply idempotently; `make -C deploy/local up` works on a
   clean machine; sandbox archived read-only with tags.

# First-party draft & release store

**Task 3** · 2026-10-06 · goal: remove NocoBase (and the configurator-v5 runtime) from the production
architecture and make drafting, publishing and releases first-party.

| File | What |
|---|---|
| `packages/store/sql/0002_store.sql` | Schema + functions + guards + RLS (PostgreSQL 13+, **no extensions**) |
| `packages/store/tests/` | 12 tests run against a real PostgreSQL 16.14: idempotent apply, revision conflicts, publish rules, immutability, single live release, module projection, diff, rollback, hash chain, migration lifecycle, stale recovery, RLS isolation |
| `docs/store/API.md` | REST contract: save / validate draft, publish, history, diff, migrate running cases, activity |
| `docs/store/openapi.yaml` | Same contract, OpenAPI 3.1 (validated) |

```bash
cd packages/store
STORE_TEST_DSN=postgresql://postgres@localhost:5432/postgres python -m pytest -q    # 12 passed
```

## 1. Tables

| Table | Holds | Key invariants (enforced in the database) |
|---|---|---|
| `workspace_drafts` | Every saved revision of a workspace's draft manifest, with its last validation report | Append-only (trigger). Revision numbers 1, 2, 3… per workspace. A save names the revision it edited; a stale save fails `revision_conflict` (optimistic concurrency = HTTP `If-Match`). Identical saves create nothing. |
| `workspace_releases` | Immutable published manifests, version 1, 2, 3… | Only `live → superseded` may change (trigger compares every other column). **Exactly one live** release per workspace (partial unique index). Must carry an `ok` validation report (CHECK). Format pinned to `workspace-manifest/1`. Rollback = a new version (`rollback_of_version`). |
| `workspace_modules` | Projection of the live release: one row per module key ever published | Rebuilt in the publish transaction. Modules removed from the manifest stay (`in_live_release = false`, `enabled = false`) because cases may reference them. Tracks `introduced_release_id` / `changed_release_id` by definition hash. |
| `workspace_release_migrations` (+ `…_items` journal) | Reviewed plans to move running cases to a newer release, and what each case went through | Plan and scope are frozen after the dry run; status only moves forward (`planned → running → done/failed`, `planned → cancelled/expired`). **One running migration per workspace** (partial unique index). Per-case journal is append-only with full before/after state. Stale running migrations (no heartbeat for 10 min) are failed by `store_recover_stale_migrations()`. |
| `workspace_activity` | Hash-chained log of every draft save, publish, module change and migration step | Append-only. `seq` and `hash` are computed by a trigger under an advisory lock — callers cannot forge or reorder the chain. |

Every table has `workspace_id` and **row-level security** (`app.workspace_id` set per request, `FORCE ROW LEVEL
SECURITY`). A test proves a workspace user can neither read nor write another workspace's rows.

### Functions (the only write paths the API uses)

| Function | Does |
|---|---|
| `store_save_draft(ws, expected_revision, manifest, actor, …)` | Concurrency check → new revision → activity |
| `store_publish(ws, draft_revision, expected_live_version, reason, validation, actor, …, rollback_of)` | Checks head revision, live version, `ok` validation, "nothing to publish" → supersede → insert → activity → `store_project_modules` |
| `store_project_modules(release, actor)` | Projection + `module_added / changed / enabled / disabled / removed` activity |
| `store_release_diff(ws, from, to)` | Module-level diff by definition hash (`added / removed / changed / unchanged`) |
| `store_recover_stale_migrations(interval)` | Fails running migrations without a heartbeat |

Errors are raised as `<code>: <message>` with a JSON `DETAIL` (`store_raise`), so the API maps them 1:1 to
`application/problem+json`.

## 2. How this replaces NocoBase

| NocoBase today (design-time store) | First-party replacement |
|---|---|
| `cfg_workspaces.state` — the v5 workspace document, overwritten on each save (ETag/If-Match in `web/server.mjs`) | `workspace_drafts` — **append-only revisions** of a `workspace-manifest/1` document; same If-Match flow, plus full history and undo |
| `cfg_workspaces.live_version / draft_version` | derived: live = `workspace_releases.status='live'`; draft = head revision |
| `cfg_releases` — append-only publish ledger (by convention) | `workspace_releases` — immutable **by trigger**, single live release **by index**, validation report required **by CHECK** |
| `cfg_modules`, `cfg_stages`, `cfg_gates` — projections rebuilt on save for NocoBase's admin UI | `workspace_modules` (projection of the *live* release) + JSONB queries on the manifest; stages and gates stay inside the module definition (keys, not positions) |
| `cfg_activity` + the NocoBase workflow "Release published → activity log" | `workspace_activity`, written **in the same transaction** as the change (a workflow can no longer miss an event), hash-chained; optional signed webhooks |
| NocoBase admin UI: 7 read-only "Matrix Configurator" pages, read-only role | The platform's own admin screens over `GET …/releases`, `…/diff`, `…/activity`, `…/modules`; the `view_audit` grant |
| NocoBase API key (`NOCOBASE_TOKEN`) for the configurator server and the agent | The platform's own auth; agents get scoped tokens with `edit_draft` only — publishing stays a human grant |
| App tables `tenant_config_releases`, `tenant_config_live`, `tenant_modules`, `platform_workspaces`, `module_release_migrations(_items)` (a second, parallel release store inside the app) | the same five store tables — **one** store for draft and runtime, instead of NocoBase (draft) + app tables (live) glued together by the configurator iframe |

The runtime never called NocoBase at request time (Phase-2 decision D2), so removing it changes only the
**configurator**, the **agent** and the **local stack**:

| Consumer | Change |
|---|---|
| Configurator UI | `GET/PUT /draft` (If-Match), `POST /draft/validate`, `POST /releases` — replaces `web/lib/store.mjs` (NocoBase) and the `/cfg` proxy |
| AI agent (`agent-configurator`) | same draft endpoints with `X-Client: agent`; `migrate_running` → `POST /migrations` (dry run) + `…/execute` |
| `app-stack` | drop the NocoBase + its Postgres containers and `provision*.mjs`; one Postgres for everything |
| Runtime | reads the pinned release from `workspace_releases`, navigation from `workspace_modules` |

## 3. Why this removes the licence risk

| Risk (Task 1, LR-01/02) | After |
|---|---|
| NocoBase License Agreement §5.4: no public low-code/no-code SaaS/PaaS built on NocoBase — a multi-tenant workspace builder is that use | NocoBase is **not used at all**: not as a service, not as a library, not as a data store. Nothing to comply with. |
| NocoBase §5.2: its branding must stay in its UI | No NocoBase UI ships |
| Commercial NocoBase plugins need a licence | None |
| dc-runtime (no licence) runs the configurator; v5 class run by the agent in `node:vm` | The store speaks `workspace-manifest/1`; the configurator and agent are rebuilt on this API (Task 1 steps 7) |
| Mixed licences in the data path | Everything in the path is first-party code on **PostgreSQL** (PostgreSQL Licence, permissive); the SQL uses only core features (`gen_random_uuid`, `sha256`, PL/pgSQL, RLS) — **no extensions** |

Clean-room note: the store was designed from this project's own requirements and its own earlier tables
(`tenant_config_releases`, `module_release_migrations`, written by this project in F4a/G3). **No NocoBase code,
schema or documentation text was used** — NocoBase was only ever reached through its public REST API, and
`cfg_*` collection shapes were this project's own definitions (`nocobase/lib/schema.mjs`).

## 4. Cut-over plan (from the sandbox)

1. **Create** the store tables (0002) next to the old ones.
2. **Import releases**: for each `tenant_config_releases` row (oldest first) → `from_v5.convert(manifest)` →
   validate → insert as `workspace_releases` with `imported_from = {release_id, version, manifest_sha256,
   schema_version: "configurator-v5"}` and activity `release_imported`. Built-in modules need their templates
   (Task 4) first, otherwise conversion reports them and the import stops for that workspace.
3. **Import drafts**: each `cfg_workspaces.state` (custom workspaces) → convert → `workspace_drafts` revision 1
   (`saved_via: import`). Demo seeds with brand names are **not** imported (Task 1 LR-04).
4. **Re-point** the runtime: case pinning reads `workspace_releases`; `workspace_modules` replaces `tenant_modules`.
5. **Switch** the configurator and agent to the new endpoints; remove `/cfg`, `web/lib/store.mjs`,
   `agent-configurator/lib/store.mjs`'s NocoBase backend.
6. **Remove** NocoBase from `docker-compose.yml` / `app-stack`; archive `nocobase/`; run
   `check-independence.mjs --only=nocobase` → 0.
7. Keep the old tables read-only for one release cycle, then drop them.

## 5. Decisions

| # | Decision | Alternative considered |
|---|---|---|
| S1 | Drafts are **append-only revisions** | single mutable row (NocoBase style) — loses history and makes "who changed what before publish" unanswerable |
| S2 | Validation runs in the API (Python `packages/manifest`), the DB only refuses a non-`ok` report | validator in PL/pgSQL — duplicate logic, harder to test, no adapter registry |
| S3 | Rollback publishes a new version | moving the live pointer back — breaks "versions only go up" and confuses case pinning |
| S4 | Module projection only for the **live** release | projecting every release — not needed; pinned cases read their release's manifest directly |
| S5 | Migration plan is frozen and its sha256 must be quoted to execute | execute-from-parameters — the executed plan could differ from the reviewed one |
| S6 | One store for design-time and run-time | NocoBase for drafts + app tables for releases (today) — two sources of truth glued by an iframe |

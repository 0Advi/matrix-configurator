# Third-party notices — matrix-configurator

This file lists everything in this project that was not written here, and how it is used. Full licence texts
ship next to each component; the paths are given below. The audit behind this list, with verified hashes, is
`docs/oss/PROVENANCE-AUDIT.md`.

Rule: only permissive-licensed source (MIT / Apache-2.0 / BSD / ISC, and OFL for fonts) is copied into this
repository. Everything else is used only as an unmodified external service or dependency.

## A. Shipped with the configurator web runtime (`web/public/vendor/`, served on localhost)

| Component | Version | Licence | Copyright | Licence file |
|---|---|---|---|---|
| React (UMD production build) | 18.3.1 | MIT | © Facebook, Inc. and its affiliates | `web/public/vendor/react@18.3.1/LICENSE` |
| ReactDOM (UMD production build) | 18.3.1 | MIT | © Facebook, Inc. and its affiliates | `web/public/vendor/react-dom@18.3.1/LICENSE` |
| @babel/standalone | 7.29.0 | MIT | © 2014-present Sebastian McKenzie and other contributors | `web/public/vendor/@babel/standalone@7.29.0/LICENSE` |
| IBM Plex Sans (woff2 via @fontsource/ibm-plex-sans) | 5.3.0 | SIL Open Font License 1.1 | © 2019 IBM Corp. Reserved Font Name "Plex" | `web/public/vendor/fonts/LICENSE-ibm-plex-sans.txt` |
| IBM Plex Mono (woff2 via @fontsource/ibm-plex-mono) | 5.3.0 | SIL Open Font License 1.1 | © 2017 IBM Corp. Reserved Font Name "Plex" | `web/public/vendor/fonts/LICENSE-ibm-plex-mono.txt` |

All files are byte-identical to the npm release tarballs. Hashes and SRI values are in
`web/public/vendor/VERSIONS.md`.

## B. Design artifacts and runtime from the user's Claude Design session (no licence file)

| Component | Identity | Terms |
|---|---|---|
| dc-runtime `support.js` | sha256 `8fe7df74…8cbe`; header: "GENERATED from dc-runtime/src/*.ts" | No licence is stated. It is Anthropic-authored runtime code exported with the user's design. It is used **unmodified, internally**, to run that design. Confirm the terms before any external distribution. |
| `Workspace Configurator v1–v5.dc.html`, `thumbnail.webp` | sha256 in `docs/oss/PROVENANCE-AUDIT.md` §2 | The user's own design output |

## C. Vendored for the module runtime (`third_party/`)

| Component | Version / commit | Licence | Copyright | Licence file |
|---|---|---|---|---|
| json-logic-js | 2.0.5 (`jwadhams/json-logic-js@c5c73601`) | MIT | © 2015 Jeremy Wadhams | `third_party/json-logic-js/LICENSE` |
| panzi-json-logic (`json_logic`) | 1.0.1 (`panzi/panzi-json-logic@f55bf413`) | MIT | © 2021 Mathias Panzenböck | `third_party/panzi-json-logic/LICENSE` |
| JSON Logic compat-tables (test suites, data only) | `json-logic/compat-tables@dfc0601e` | Apache-2.0 (no NOTICE upstream) | © JSON Logic contributors | `third_party/json-logic-compat-tables/LICENSE` |

None of these files is modified. Provenance details are in each `third_party/<name>/VERSION`.

## D. Dependencies (installed by package managers, not vendored)

| Component | Exact version | Licence | Used by |
|---|---|---|---|
| @rjsf/core, @rjsf/utils, @rjsf/validator-ajv8 | 6.11.0 | Apache-2.0 | `third_party/rjsf-check` (proof); to be added to `app/frontend` by F4 |
| └ transitive: ajv 8.20.0, ajv-formats 2.1.1, markdown-to-jsx 9.10.3, jsonpointer 5.0.1, fast-equals 6.1.0, @x0k/json-schema-merge 1.1.0, fast-deep-equal, json-schema-traverse, require-from-string, react-is, @types/json-schema | see `third_party/rjsf-check/package-lock.json` | MIT | — |
| └ transitive: fast-uri 3.1.8 / 4.2.1 | — | BSD-3-Clause | — |
| jsonschema | 4.26.0 (+ attrs 26.1.0, jsonschema-specifications 2025.9.1, referencing 0.37.0, rpds-py 2026.6.3) | MIT | backend stage-form validation (tests; to be added to `app/backend` by F4) |
| json-logic-js (npm) | 2.0.5 | MIT | to be added to `app/frontend` by F4 (same bytes as §C) |

## E. External services (Docker images, used unmodified; no code copied)

| Image | Pin | Licence | Notes |
|---|---|---|---|
| `nocobase/nocobase` | 2.2.20 (local digest `sha256:4d570583…0cff3`) | **NocoBase License Agreement** (bespoke, non-OSI; Apache-2.0 incorporated, supplementary terms prevail) | Design-time store only. Keep NocoBase branding in its UI (§5.2). **No public low-code/no-code SaaS/PaaS on it (§5.4)**; get a legal review before customer-facing use. |
| `postgres` | 16 (16.15; local digest `sha256:1a6ab3f5…4b54`) | PostgreSQL Licence; Docker Official Image files MIT | NocoBase's database |

## F. Evaluated in spikes only (not part of the project; nothing retained)

| Component | Version | Licence | Status |
|---|---|---|---|
| Operaton (`operaton/operaton` image) | 2.1.5, digest `sha256:ed5d6863…6892` | Apache-2.0 | Run once on 127.0.0.1:18080; container and image removed (`docs/oss/OPERATON-SPIKE.md`) |
| SpiffWorkflow | 3.2.0 (+ lxml) | **LGPL-3.0** (lxml BSD-3) | Installed in a scratch venv only. If ever adopted: unmodified pip dependency only. Never copy its source. |

## G. Internal material (not third-party; proprietary, do not publish)

* `app/`: sandbox copy of the private Matrix-bd repo at `3d4f277beb22c5be02c2abacea61b6afaee7cdeb`, with its
  own dependency tree. Licence census: `docs/oss/PROVENANCE-AUDIT.md` §4.
* `building-blocks/from-matrix-bd/*`: data and short excerpts extracted from the same commit, each excerpt
  marked with a `provenance:` header.

## H. Agent configurator (`agent-configurator/`, phase G1)

**Idea and op set adapted from the user's own repository** `github.com/Adityashandilya555/operaton-plat`
at `fc65499834cfa8d5e47ca2bb5266899117555d36` (pushed 2026-10-04; owned by the user, who asked for this reuse; the
repo carries no licence file). Read via `gh api …/contents` only. What was adapted — ideas and shape, no code copied
verbatim (that repo is Python/Operaton; ours is Node/v5 drafts):

| operaton-plat | Adapted as |
|---|---|
| `matrix.py` `op_*` functions + `OPS` registry, same ops exposed by `mcp_server.py` (FastMCP) | `lib/ops.mjs` op registry shared by `bin/cfg.mjs` (CLI) and `mcp-server.mjs` (MCP) |
| `validate()` on every save, errors returned to the agent | every mutating op validates (workspace.schema.json + v5 findings) and refuses new broken-flow findings |
| `op_show`, `op_catalogue`, `op_add_module(from_catalogue)`, `op_set_after`, `op_add/update/remove_task`, `op_add_field`, `op_publish`, `op_migrate_running`, `op_start_case/op_case_status` | `show_workspace`, `catalogue`, `add_builtin_module`, `set_gate` (`starts_after`), `add/update/remove_stage`, `add/update/remove_field`, `publish`, `migrate_running` (stub, phase G3); start/case ops not built |
| `op_remove_module` rewiring ("dependents now come after its predecessors") | `remove_module` `dependents: "inherit_gate"` |
| `mcp_server.py` server `instructions` (model + typical loop) and `docs/prompt-to-process.html` ("tools accept fixed shapes; bad configs are refused; you publish, not the agent") | `SERVER_INSTRUCTIONS` and tool descriptions; publish/destructive ops are dry runs unless `confirm: true` |
| `.mcp.json` | `agent-configurator/.mcp.example.json` (example only; no user/project settings edited) |

`workspace.json` of that repo (contains demo passwords) was not read or copied.

**npm dependencies** (installed, not vendored; exact pins in `agent-configurator/package-lock.json`):

| Component | Exact version | Licence | Used by |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.0 | MIT | `mcp-server.mjs` (stdio server), tests (SDK client) |
| └ transitive (93 packages: express 5, hono, ajv 8, zod 4.6.5, zod-to-json-schema, jose, cors, cross-spawn, eventsource, …) | see lock | 84 MIT · 7 ISC (inherits, isexe, once, setprototypeof, which, wrappy, zod-to-json-schema) · 2 BSD-3-Clause (fast-uri, qs) · 1 BSD-2-Clause (json-schema-typed) | pulled in by the SDK; only its stdio server/client paths are used |

No other code is bundled: the configurator logic is the project's own v5 class (`sources/design-artifact`, via
`building-blocks/lib/load-dc.mjs`), `building-blocks/from-design/validation.mjs` and `web/lib/env.mjs`, imported in place.

## I. Migrate running cases, creator rule, saved views (`app/`, phase G3)

**Ideas adapted from the user's own repository** `github.com/Adityashandilya555/operaton-plat` at
`fc65499834cfa8d5e47ca2bb5266899117555d36` (owned by the user, who asked for this reuse; no licence file). Read
only (G2's read-only download + `gh api …/contents`); **no code copied** — that repo drives Operaton over REST in
Python, ours is the app's own FastAPI runtime + Postgres.

| operaton-plat | Adapted as (G3) |
|---|---|
| `matrix.py` `op_migrate_running()` (l.826-847): for each older process-definition version, `/migration/generate` + `/migration/execute` onto the latest; per-version "moved n" / "could not move" | `POST /api/platform/workspaces/{ref}/migrations` — but per case: dry run first, explicit stage mapping, compatibility report, mandatory reason, one locked transaction per site, incompatible sites skipped, journal with the full pre-migration state, audited per case (`release_migration_service.py`, `module_runtime/migrate.py`, migration `20261005_1`). `docs/PLATFORM.md` §3/§5 ("running cases stay on their version unless migrated") is the rule we keep. |
| task `"assignee": "initiator"` → `operaton:assignee="${initiator}"` (`matrix.py` l.141, 234, 392, 411) on bd_site_details, bd_upload_loi, fin_ca_entry, launch_exec_verdict | stage `restricted_to: "site_creator"`; creator = `sites.submitted_by` OR `sites.assigned_to` (the real app's rule, per G2), business-admin override recorded; enforced in the runtime + the approvals guard (`20261005_2`); authored in the in-app configurator copy. Not ported: `skip_if initiator_in bdSupervisor` (obsolete in the real app). |
| `catalogue.json` `views` + `sync_views()` (l.628-645, Tasklist filters with per-group READ grants) and `op_add_view()` (l.805-811) | `module_views` (`20261005_3`): named views with filter, columns, audience roles, position, default; seeded per custom module on publish; business admin manages them in the app; applied server-side on top of the caller's scope. |

No new third-party packages (backend or frontend).

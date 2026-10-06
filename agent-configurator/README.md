# agent-configurator — the Workspace Configurator for AI agents (G1)

A set of `op_*`-style operations that design, validate and publish a Matrix workspace exactly like a
human does in the visual Workspace Configurator — exposed as a **CLI** and as an **MCP server**, both
over one core (`lib/ops.mjs`). Idea and op set adapted from the user's own
[operaton-plat](https://github.com/Adityashandilya555/operaton-plat) (`matrix.py` + `mcp_server.py`;
provenance in `../THIRD_PARTY.md` §H).

## Same drafts as the visual configurator

- **Design time** = the configurator server's `/cfg/state` (`web/server.mjs` on :4300, persisted in NocoBase):
  the v5 blob `{customWs, data}` the browser hydrates from. The in-app copy (`/#/admin` → Workspaces, :5173)
  reads the same store through its `/cfg` proxy. An agent's workspace appears there; a human's edits are
  what the agent reads next.
- Every op is read → change → check → write with the server **ETag / If-Match**. A 409 (someone saved in
  between) writes nothing and returns `conflict` + the current state; the agent re-reads and redoes the step.
  A browser tab that saved on a stale ETag gets the 409 itself (its pill shows "Sync conflict").
- **Merge-around invariant**: every write is checked to carry all other workspaces byte-identical and in order.
  `CFG_PROTECTED_WORKSPACES=id,id` makes ids read-only for the agent.
- Where v5 has the action, the agent performs it **through the real v5 class** (`building-blocks/lib/load-dc.mjs`):
  `createWorkspace`, `addBuiltin`, the 9-step wizard + `wizSave`, `applyToggle`, the Publish button. Other edits
  (stages, fields, gates, tiers, roll-up, permissions) are plain edits of the same shape. Findings, diff and
  manifest come from `building-blocks/from-design/validation.mjs`; tests prove they equal the class's own
  `findings()/diffList()/manifest()` on every draft the ops write.
- **Run time** = the Matrix app (D2). `publish` provisions the tenant on the first publish
  (`POST /api/platform/workspaces`), records the v5 publish in the draft store, posts the manifest as an immutable
  app release (`source_ref = configurator:<ref>@v<N>`, same as the in-app portal) and appends the design-time
  ledger (`cfg_releases`).

## Ops

| Op | What | operaton-plat |
|---|---|---|
| `list_workspaces` · `show_workspace` · `catalogue` | read drafts / built-ins, templates, vocabularies | `show`, `catalogue` |
| `create_workspace` · `delete_workspace`* | empty / Blue Tokai template / production Matrix-bd flow | `reset` |
| `add_builtin_module` · `enable_module` · `disable_module` · `remove_module`* | built-ins on/off (v5 refusal + cascade), remove with `inherit_gate` rewiring | `add_module(from_catalogue)`, `remove_module` |
| `add_custom_module` · `update_module` | v5 wizard in one call (stages, approvers, fields, gate, roll-up, exit); rename / icon | `add_module(tasks)` |
| `set_gate` | starts-after: conditions + all/any, cycle / dead-gate / unreachable checks | `set_after` |
| `add_stage` · `update_stage` · `remove_stage`* | custom-module stages | `add/update/remove_task` |
| `add_field` · `update_field` · `remove_field`* | fields + affects-outcome, app hint parsing | `add_field` |
| `set_tiers` · `set_approvers` · `set_outcome` · `set_permission` | tiers / supervisor-only / delegation, approver chain, roll-up + exit + stage outcomes, permissions within the ceiling | `add_group/add_user` (roles are fixed tiers here) |
| `validate` · `diff` | local (schema, v5 findings, app parity) + the app's dry run; draft vs live | `validate`, `check` |
| `publish`* · `release_status` | provision + publish (dry run unless `confirm: true`; one-time setup code returned once) · both sides + sync | `publish` |
| `migrate_running`* · `migration_status` | move in-flight custom-module cases (+ their sites' pins) onto a newer release via the app's G3 migrations API: dry run by default (per case compatible / blocked + reasons, stage before → after, fields, approvals carried); `confirm: true` + `reason` executes (per-site atomic, audited, never re-sent on retry); `scope`, `from_release_version`, `to_release_version`, `stage_map`, `restart_stage_on_chain_change` passed through; accepts app-only refs · executed runs and one run's journal | `migrate_running` |

\* destructive: dry run unless `confirm: true`. Every write refuses new broken-flow findings
(gate cycle, dead gate, unreachable outcome, no approver, key collision) unless `allow_new_findings: true`.

## CLI

```bash
node bin/cfg.mjs ops                                   # list ops
node bin/cfg.mjs help add_custom_module                # description + JSON Schema of the input
node bin/cfg.mjs create_workspace --json '{"name":"Agent Coffee","template":"bluetokai"}'
node bin/cfg.mjs run --file steps.json                 # [{op, args}, …] in one process = one admin sign-in
node bin/cfg.mjs migrate_running --json '{"workspace":"ws_…"}'   # dry run; add "confirm":true,"reason":"…" to execute
```

Output is one JSON document (`{ok, op, result}` / `{ok:false, error:{code, message, details}}`); exit 0 / 1 / 2.

## MCP (Claude Code)

Copy `.mcp.example.json` into the project's `.mcp.json` (or your own config), or:

```bash
claude mcp add matrix-workspace-configurator \
  -e MATRIX_APP_ENV_FILE=/Users/aditya/Desktop/bd/matrix-configurator/app/backend/.env \
  -- node /Users/aditya/Desktop/bd/matrix-configurator/agent-configurator/mcp-server.mjs
```

Then describe the workspace in plain language ("a café chain: BD, legal, then a fit-out QA step the executive
fills and a supervisor approves, no Project Excellence") and ask Claude to build it, validate it and show you the
publish plan. 28 tools, with read-only / destructive annotations and server instructions describing the model.

## Configuration

| Env | Default | |
|---|---|---|
| `CFG_URL` | `http://127.0.0.1:4300` | configurator server (must be in `nocobase` mode — local mode is refused) |
| `MATRIX_API_URL` | `http://127.0.0.1:8000/api` | app backend |
| `MATRIX_PLATFORM_ADMIN_EMAIL` / `_PASSWORD` | — | else `PLATFORM_ADMIN_EMAIL/PASSWORD` from env, else from `MATRIX_APP_ENV_FILE` (only those two keys are read) |
| `MATRIX_APP_ENV_FILE` | `../app/backend/.env` | sandbox file (gitignored) |
| `MATRIX_APP_URL` | `http://localhost:5173` | for the workspace login link |
| `CFG_AGENT_NAME` | `agent-configurator` | publisher shown in v5's version history (`<date> · agent:<name>`) |
| `CFG_PROTECTED_WORKSPACES` | — | workspace ids the agent may read but never change |

Secrets: credentials are used for the sign-in call only; the 30-minute admin token stays in process memory
(sign-in is rate-limited 10 / 5 min per IP, shared with the browser portal). No output carries the password or
token. The only secret ever returned is the one-time setup code of a first publish, once, with a warning.
App calls ride out a backend restart (~16 s backoff); provision/publish and a migration execute are never re-sent
after the app may have seen them (a migration dry run writes nothing and is retried like a read).

## Tests

`npm test` (= `node --test`, ~4 s, no network besides loopback): every op on real v5 data, step-by-step parity with
the v5 class, publish/provision/rollback/resend/rate-limit/token-expiry against a fake platform API, the real
configurator server handler (fake NocoBase) for ETag conflicts and the merge-around invariant, retry behaviour,
`migrate_running` / `migration_status` against a fake of the app's migrations API (dry-run default, confirm + reason,
execute sent once, error mapping, protected ids), an MCP round trip with the SDK client and the CLI as child processes.

## Limits

- `start_case` / `case_status` (operaton-plat's test drive) are not implemented: they need a workspace user's token.
- Built-in modules: only enabled / name / order / supervisor-only / delegation reach the app; their gates, stages and
  approvers are descriptive (F4-API §5). Navigation editing has no op yet (v5's nav matrix).
- v5 quirks kept: diff lines say "custom" for every newly created module; stage removal decisions default to
  "finish on the live version". Deviations: real dates in `created` and in the publish history line (v5 hard-codes
  `03 Oct 2026` / `11 Sep 2026 · platform:ops@matrix.io`).
- No delete API for app tenants: `delete_workspace` removes the draft only (the design-time ledger is append-only).

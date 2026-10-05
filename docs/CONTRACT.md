# Matrix Configurator — Integration Contract (v0)

Single source of truth for the parallel workstreams. If you need to deviate,
document the deviation at the bottom of this file under "Deviations" with a reason.

## Project root
`/Users/aditya/Desktop/bd/matrix-configurator` — a SEPARATE project. It is a git repo
(local only, no remote).

## Hard rules (all workstreams)
1. **Never modify the existing application.** `/Users/aditya/Desktop/bd/Matrix-bd`,
   `/Users/aditya/Desktop/bd/Matrix-bd-current`, `/Users/aditya/Desktop/bd/Matrix-bd-scale-preview`
   are READ-ONLY. Allowed: `cat`, `grep`, `find`, `ls`, `git -C <repo> show|log|ls-tree|diff` on
   EXISTING refs. Forbidden: any write, and any state-changing git command
   (`checkout`, `switch`, `worktree`, `fetch`, `pull`, `stash`, `commit`, `reset`, `clean`, `branch`).
2. **Write only inside your owned paths** (below). Temp files go in your own temp dir.
3. `sources/` is pristine input — never edit it; copy what you need into your area.
4. No CDN at runtime for the web app — everything it needs is served from localhost.
5. Credentials live only in `.env` (gitignored). Never print secrets in reports or logs.

## Ownership
| Workstream | Owns (write) |
|---|---|
| A · web runtime | `web/` |
| B · NocoBase backend | `nocobase/`, `docker-compose.yml`, `.env.example`, `.env` |
| C · building blocks | `building-blocks/` |
| Integrator (lead) | `README.md`, `docs/`, root scripts (`start.sh`, `stop.sh`) |

## Ports
| Service | URL |
|---|---|
| NocoBase (Docker) | http://localhost:13000 (API at `/api`) |
| Postgres | internal to compose only (not published to host) |
| Configurator web | http://localhost:4300 |

## Environment (`.env`, template in `.env.example`)
```
NOCOBASE_URL=http://localhost:13000
NOCOBASE_ROOT_EMAIL=<generated local admin email>
NOCOBASE_ROOT_PASSWORD=<generated>
NOCOBASE_TOKEN=            # optional long-lived API key; if empty, sign in with ROOT creds
WEB_PORT=4300
```

## NocoBase collections (owned by B; created idempotently by `nocobase/scripts/provision.mjs`)
All prefixed `cfg_`. NocoBase adds `id`, `createdAt`, `updatedAt` automatically.

| Collection | Fields |
|---|---|
| `cfg_workspaces` | `slug` string **unique**, `name` string, `initials` string, `is_custom` boolean, `live_version` integer, `draft_version` integer, `state` json |
| `cfg_releases` | `workspace_slug` string, `version` integer, `reason` text, `manifest` json, `published_by` string — append-only |
| `cfg_modules` | `workspace_slug` string, `module_key` string, `name` string, `glyph` string, `kind` string, `status` string, `route` string, `data` json |
| `cfg_gates` | `workspace_slug` string, `from_key` string, `to_key` string, `condition` json |
| `cfg_stages` | `workspace_slug` string, `module_key` string, `position` integer, `name` string, `outcome` string, `terminal` boolean, `data` json |

`cfg_workspaces.state` holds the configurator's per-workspace document (authoritative).
`cfg_modules/gates/stages` are **projections** (read models) rebuilt from `state` on save,
so NocoBase's admin UI shows real records. `cfg_releases` is an immutable publish ledger.

## Node client library (owned by B): `nocobase/lib/client.mjs`
ESM, zero dependencies (global `fetch`, Node ≥18). Reads env if options omitted.
Auth: uses `NOCOBASE_TOKEN` if set, else signs in with ROOT creds, caches the token,
and re-signs once on HTTP 401.

```js
import { createClient } from '../nocobase/lib/client.mjs';
const nb = createClient({ baseUrl, token, email, password }); // all optional → env

await nb.health()                              // → boolean (never throws)
await nb.list(collection, { filter, sort, pageSize }) // → rows[] (handles pagination)
await nb.get(collection, filter)               // → row | null
await nb.create(collection, values)            // → row
await nb.update(collection, filterByTk, values)// → row
await nb.destroy(collection, filter)           // → void
await nb.replaceWhere(collection, filter, rows)// delete matching rows, insert `rows`

// workspace helpers
await nb.listWorkspaces()                      // → cfg_workspaces rows
await nb.upsertWorkspace({ slug, name, initials, is_custom, live_version, draft_version, state })
await nb.deleteWorkspace(slug)
await nb.appendRelease({ workspace_slug, version, reason, manifest, published_by })
await nb.listReleases(slug)
```
B must also ship `nocobase/scripts/smoke.mjs` proving every method against the live instance.

## Web server (owned by A): `web/server.mjs`
Zero-dependency Node `http` server on `WEB_PORT`. Loads `.env` from the project root itself
(no dotenv dependency). Imports `../nocobase/lib/client.mjs`.

| Route | Behaviour |
|---|---|
| `GET /cfg/health` | `{ ok: true, mode: 'nocobase' \| 'local', nocobase: boolean }` |
| `GET /cfg/state` | the exact blob v5 stores under `localStorage['wsconfig_v5_custom']`, rebuilt from `cfg_workspaces`; `{}` if none |
| `PUT /cfg/state` | persist that blob → upsert `cfg_workspaces` + rebuild projections |
| `POST /cfg/releases` | append to `cfg_releases` |
| `GET /cfg/releases?ws=<slug>` | list releases |
| everything else | static files from `web/public/` |

**Graceful degradation is mandatory:** if NocoBase is unreachable the app still works,
`mode` is `local`, and persistence stays in the browser's `localStorage` exactly like the
original artifact.

Projection (v5 state → `cfg_modules/gates/stages`) lives in `web/lib/projection.mjs`
(A owns it because A owns knowledge of the v5 state shape).

## Deviations
_(append here)_

### From Workstream A (web runtime)
- Local mode: `GET/PUT /cfg/state` and `/cfg/releases` return **503 `{mode:'local'}`** instead of `{}` — the bridge treats it as "use localStorage".
- `/cfg/state` carries an **ETag**; `PUT` honours `If-Match` and returns **409** with the current etag on a stale write (two-tab protection).
- `POST /cfg/releases` → **201**, or **200 `{duplicate:true}`** for a repeat of the same (workspace, version); only contract fields are stored.
- `/cfg/health` adds `client` and `projection` fields.
- `cfg_modules.status` may also be `disabled` (module switched off in a workspace).
- `cfg_workspaces.state` is stored as `{format, workspace, order, data}` so the v5 blob round-trips byte-for-byte.
- On start the server upserts the three **demo workspaces** (`bluetokai`, `starbucks`, `burgerking`) as reference rows with `is_custom=false` + projections, so NocoBase's admin UI shows real data. They never appear in `GET /cfg/state`. Disable with `CFG_SEED_BUILTINS=0`.
- API accepts only loopback `Host` headers and JSON bodies. `CFG_MODE=local` forces local mode.
- Correction to the brief: v5's demo workspaces are bluetokai/starbucks/burgerking; `thirdwave`/`chaayos` exist only in the `startWorkspace` prop list and have no data.

### From Workstream B (NocoBase backend)
- `get`/`destroy` also accept a primary key; `create` accepts an array (bulk insert).
- `deleteWorkspace` also removes that workspace's `cfg_modules/gates/stages` rows (keeps `cfg_releases`).
- `listReleases()` with no slug returns all releases, oldest first. Client also exposes `request()` and `authMode`.
- JSON fields are Postgres **`json`** (not `jsonb`) so key order is preserved.

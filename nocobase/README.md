# NocoBase backend (Workstream B)

Local [NocoBase](https://github.com/nocobase/nocobase) instance (Docker) used as the persistence and
platform layer of the Workspace Configurator, plus a zero-dependency Node client
(`lib/client.mjs`) that the web server imports. The interface contract is `docs/CONTRACT.md`.

```
docker-compose.yml          postgres:16 + nocobase/nocobase:2.2.20
.env / .env.example         credentials and settings (.env is gitignored)
nocobase/
  lib/client.mjs            the client (contract API)
  lib/schema.mjs            cfg_* collection definitions (used by provision/reset)
  lib/env.mjs               tiny .env loader used by the scripts
  scripts/provision.mjs     idempotent: collections + fields + root API key
  scripts/smoke.mjs         exercises every client method against the live instance
  scripts/wait-for-nocobase.mjs   poll until healthy (for start scripts)
  scripts/reset.mjs         delete all cfg_* rows (keeps the instance)
```

## Quick start

```sh
# from the project root (matrix-configurator/)
docker compose up -d                              # first boot installs NocoBase (about 1-3 min)
node nocobase/scripts/wait-for-nocobase.mjs       # exits 0 once /api/__health_check is 200
node nocobase/scripts/provision.mjs               # safe to re-run; prints "no changes" when done
node nocobase/scripts/smoke.mjs                   # optional end-to-end check, cleans up after itself
```

Or use the `npm` scripts from `nocobase/`: `npm run wait`, `npm run provision`, `npm run smoke`,
`npm run reset -- --yes`. There are no dependencies to install.

`docker compose stop` / `start` keeps all data. **`docker compose down -v` deletes the database and
storage volumes.** After that, start the stack again and re-run `provision.mjs`.

## How the instance is configured

| Item | Value |
|---|---|
| NocoBase image | `nocobase/nocobase:2.2.20` (the slim 2.x release tag, with nginx included) |
| Postgres image | `postgres:16`, with `wal_level=logical` as in NocoBase's reference compose file |
| Admin UI and API | http://localhost:13000 (API at `/api`). Host port 13000 maps to nginx on container port 80. Bound to `127.0.0.1` only. |
| Postgres | **Not published to the host.** It is only reachable as `postgres:5432` inside the compose network. |
| Volumes | `matrix-configurator_postgres_data`, `matrix-configurator_nocobase_storage` |
| Health | `GET /api/__health_check` returns `200 ok` once the app is running. The compose healthcheck uses this endpoint. |
| Edition | Community edition only. No commercial plugins are enabled or required. |

Environment (`.env` at the project root; the template is `.env.example`):

| Key | Used by | Meaning |
|---|---|---|
| `NOCOBASE_URL` | client | `http://localhost:13000` |
| `NOCOBASE_ROOT_EMAIL`, `NOCOBASE_ROOT_PASSWORD` | compose (`INIT_ROOT_EMAIL/PASSWORD`), client | root account. It is applied **only on the first install**. |
| `NOCOBASE_TOKEN` | client | long-lived root API key, written by `provision.mjs` |
| `WEB_PORT` | web | 4300 |
| `NOCOBASE_APP_KEY` | compose (`APP_KEY`) | signs all tokens. Changing it invalidates sessions **and** the API key; re-run `provision.mjs` to mint a new key. |
| `NOCOBASE_ROOT_USERNAME`, `NOCOBASE_ROOT_NICKNAME` | compose (`INIT_ROOT_USERNAME/NICKNAME`) | first install only |
| `NOCOBASE_TZ` | compose (`TZ`) | default `UTC` |
| `NB_DB_NAME`, `NB_DB_USER`, `NB_DB_PASSWORD` | compose | Postgres credentials |
| `NOCOBASE_HTTP_PORT` | compose | host port (default 13000) |

### Admin UI

Open http://localhost:13000 and sign in with `NOCOBASE_ROOT_EMAIL` / `NOCOBASE_ROOT_PASSWORD`
from the project-root `.env`. The collections are listed under
**Data sources → Main → Collections** (in the settings / plugin-settings menu) as "Configurator · Workspaces / Releases /
Modules / Gates / Stages". To browse records, add a page with a **Table** block on one of these
collections.

To inspect the database directly:
`docker compose exec postgres psql -U "$NB_DB_USER" "$NB_DB_NAME"` (values come from `.env`).

## Collections

`provision.mjs` creates these through the collection-manager API (`collections:create`), using the
same `general` template the admin UI uses. Every collection also gets the UI's preset fields:
`id` (snowflake ID, a JS-safe integer), `createdAt`, `updatedAt`, `createdBy`/`createdById`, and
`updatedBy`/`updatedById`.

| Collection | Fields (interface → Postgres type) |
|---|---|
| `cfg_workspaces` | `slug` input → varchar **UNIQUE NOT NULL** (`cfg_workspaces_slug_key`), `name`, `initials` (varchar), `is_custom` boolean, `live_version`, `draft_version` integer (int4), `state` **json** |
| `cfg_releases` | `workspace_slug` varchar, `version` integer, `reason` text, `manifest` json, `published_by` varchar. Append-only. |
| `cfg_modules` | `workspace_slug`, `module_key`, `name`, `glyph`, `kind`, `status`, `route` (varchar), `data` json |
| `cfg_gates` | `workspace_slug`, `from_key`, `to_key` (varchar), `condition` json |
| `cfg_stages` | `workspace_slug`, `module_key` (varchar), `position` integer, `name`, `outcome` (varchar), `terminal` boolean, `data` json |

JSON fields use Postgres `json`, not `jsonb`, on purpose. `json` stores the text verbatim, so
objects round-trip exactly, **including key order**. `jsonb` would re-sort keys.

Provisioning only adds what is missing. It never alters or drops existing collections or fields.
Type drift is printed as a warning.

## Client API (`lib/client.mjs`)

```js
import { createClient, NocoBaseError } from '../nocobase/lib/client.mjs';
const nb = createClient({ baseUrl, token, email, password, timeoutMs }); // all optional → process.env
```

The client reads `process.env` and does **not** load `.env` itself. The caller loads `.env` first.
The scripts use `nocobase/lib/env.mjs` (`loadEnv()`) for this.

| Method | Returns | Notes |
|---|---|---|
| `health({ deep = true } = {})` | `boolean` | Never throws. A deep check requires the app to be running **and** an authenticated read of `cfg_workspaces` to succeed (credentials work and the instance is provisioned). `{ deep: false }` only checks that the app is up. |
| `list(collection, { filter, sort, pageSize, limit, fields, appends })` | `rows[]` | Follows every page. `pageSize` is the batch size per request (default 200). `limit` caps the total. |
| `get(collection, filterOrPk)` | `row \| null` | Takes a filter object or a primary-key value. |
| `create(collection, values)` | `row` | Pass an array to insert many rows in **one** request; this returns `rows[]`. |
| `update(collection, filterByTk, values)` | `row \| null` | Partial update by `id`. Returns `null` if no row matched. A JSON field is **replaced** as a whole, not merged. |
| `destroy(collection, filterOrPk)` | `void` | Throws if the filter is empty. Use `{ id: { $ne: null } }` to match every row on purpose. |
| `replaceWhere(collection, filter, rows)` | `rows[]` | Destroys the matching rows, then bulk-inserts `rows`. This is **two requests, not one transaction.** |
| `listWorkspaces()` | `rows[]` | Sorted by slug. |
| `upsertWorkspace({ slug, ... })` | `row` | Keyed on `slug`. Only contract fields are written; `undefined` fields are left untouched. If a concurrent insert wins the race (unique constraint), it updates instead. |
| `deleteWorkspace(slug)` | `void` | Deletes the workspace **and** its `cfg_modules/gates/stages` projection rows. `cfg_releases` (the ledger) is kept. |
| `appendRelease({ workspace_slug, version, reason, manifest, published_by })` | `row` | |
| `listReleases(slug?)` | `rows[]` | Oldest first (`version`, then `id`). Without a slug it returns all releases. |
| `request(method, 'resource:action', { query, body })` | raw `{ data, meta }` | Escape hatch for any other NocoBase endpoint. |

Errors are thrown as `NocoBaseError` with `.status` (HTTP status, or 0 for a network error or
timeout), `.code` (the NocoBase error code, e.g. `INVALID_TOKEN`) and `.body`.

### NocoBase behaviour worth knowing

* **Filter syntax.** The client sends filters as JSON in the query string. Examples:
  `{ slug: 'acme' }`, `{ version: { $gt: 3 } }`, `{ slug: { $in: ['a','b'] } }`,
  `{ $or: [{ a: 1 }, { b: 2 }] }`, and `{ name: { $includes: 'x' } }` or `$startsWith`, `$ne`,
  `$empty`, `$notEmpty`. Note that `{ x: { $ne: 'v' } }` also matches `NULL`.
* **Sort.** Pass a field name or an array of field names; prefix `-` for descending
  (`['-version', 'id']`).
* **Pagination.** NocoBase returns `{ data, meta: { count, page, pageSize, totalPage } }`, and
  `list()` hides this. NocoBase's own default page size is 20.
* **IDs** are snowflake IDs, about 4e14, so they are safe JS numbers. Use `row.id` for
  `update` / `destroy`.
* **Returned rows** also contain `createdAt`, `updatedAt`, `createdById` and `updatedById`.
  Unset fields come back as `null`.
* **Unique slug.** Creating a duplicate `slug` returns HTTP 400 ("Slug already exists").
  `upsertWorkspace` handles this case.
* **Body size.** NocoBase caps request bodies at **10 MB** by default (`REQUEST_BODY_LIMIT`). A
  12 MB `state` returns HTTP 413; 4 MB works. To raise the cap, add `REQUEST_BODY_LIMIT: 25mb`
  to the `nocobase` service environment.
* `cfg_releases` is append-only by convention, not enforced. NocoBase allows deletes for the root
  role. Enforce it with an ACL role (see below) if needed.

## Auth model

1. **API key (preferred).** `provision.mjs` creates a root-role API key named
   `matrix-configurator` (API Keys plugin, built into the community preset, `expiresIn: never`).
   It writes the key to `.env` as `NOCOBASE_TOKEN`. The client sends it as
   `Authorization: Bearer …`. On re-run, provisioning keeps a valid key and replaces one that was
   rejected.
2. **Root sign-in (fallback).** If `NOCOBASE_TOKEN` is empty, or the key is rejected with 401,
   the client calls `POST /api/auth:signIn` with header `X-Authenticator: basic` and body
   `{ account: <email>, password }`. It caches the session token and follows NocoBase's
   `x-new-token` renewal header (session tokens last 1 day and are renewable for 7). On any 401 it
   re-signs in **once** and retries the request.

The root role bypasses ACL. For anything beyond local development, use a narrower role and key
(see below).

## Extending with workflows and ACL

Both plugins are built in and enabled in the community image, and the `cfg_*` tables are normal
NocoBase collections. Workflows and permissions therefore apply to every write made through this
client.

**Workflow: react to a publish.** In the admin UI, go to **Workflow → New → Collection event**,
set Collection to `Configurator · Releases`, set Trigger on to "After record added", then add
nodes. For example, an **HTTP request** node posts `{{$context.data.manifest}}` to a deploy hook,
or a **Notification** node alerts admins. The same workflow can be created through the API:

```js
const wf = await nb.request('POST', 'workflows:create', { body: {
  title: 'On release published', type: 'collection', enabled: true, sync: false,
  config: { collection: 'cfg_releases', mode: 1 /* 1=create, 2=update, 4=destroy */ },
}});
// then add nodes with POST workflows/<wf.data.id>/nodes:create  { type: 'request' | 'notification' | ... }
```

Another useful trigger is `mode: 2` on `cfg_workspaces` with `changed: ['live_version']`, which fires
when a workspace goes live.

**ACL: a non-root role.** Under **Users & Permissions → Roles**, create e.g. `configurator`. In
**Data source permissions → Main**, grant view/create/update on `cfg_workspaces`, `cfg_modules`,
`cfg_gates` and `cfg_stages`, and only view/create on `cfg_releases`. That makes the ledger truly
append-only. Assign the role to a service user, sign in as that user, and create an API key bound to
the `configurator` role; use it as `NOCOBASE_TOKEN`. The API equivalent is roughly
`POST /api/roles:create { name: 'configurator', title: 'Configurator' }`, followed by
`POST /api/roles/configurator/dataSourceResources:create { dataSourceKey: 'main', name: 'cfg_releases', usingActionsConfig: true, actions: [{ name: 'view' }, { name: 'create' }] }`.

## License note

The NocoBase kernel and plugins are distributed under the **NocoBase License Agreement**
(https://www.nocobase.com/agreement), a bespoke licence that is **not** OSI-approved. Some source
files also reference AGPL-3.0 and commercial dual-licensing. This setup uses only the official
community Docker image and its built-in, enabled plugins. No commercial plugins are installed or
enabled, and none are needed. Review the agreement before redistributing or offering this as a
hosted service.

## Troubleshooting

* Run `docker compose ps`; both services should show `(healthy)`. On first boot, wait for
  `node nocobase/scripts/wait-for-nocobase.mjs`.
* Check the app logs with `docker compose logs --tail 200 nocobase`. Warnings like
  `[PubSubManager] adapter is not exist` are normal for a single node.
* If `health()` is false but `health({ deep: false })` is true, either the credentials or
  `NOCOBASE_TOKEN` are wrong, or `provision.mjs` has not run yet.
* The root password in `.env` is only applied on the **first** install. If you change it later,
  change it in the admin UI too, or wipe the volumes with `docker compose down -v`.

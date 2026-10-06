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
  lib/ui-spec.mjs           the "Matrix Configurator" admin-UI menu: group + 7 read-only page blueprints
  scripts/provision.mjs     idempotent: collections + fields + root API key
  scripts/provision-workflow.mjs  idempotent: cfg_activity + workflow "Release published → activity log" (+ backfill, --prove)
  scripts/provision-ui.mjs        idempotent: admin-UI menu group "Matrix Configurator" + 7 read-only pages
  scripts/provision-acl.mjs       idempotent: read-only role configurator_viewer (+ --test-user, live check)
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
node nocobase/scripts/provision-workflow.mjs      # cfg_activity + publish workflow (after provision.mjs)
node nocobase/scripts/provision-ui.mjs            # admin menu "Matrix Configurator" (after provision-workflow.mjs)
node nocobase/scripts/provision-acl.mjs --test-user   # read-only role + local test user (after provision-ui.mjs)
node nocobase/scripts/smoke.mjs                   # optional end-to-end check, cleans up after itself
```

Or use the `npm` scripts from `nocobase/`: `npm run wait`, `npm run provision`, `npm run provision:all`
(all four provisioners in order), `npm run provision:workflow | provision:ui | provision:acl`, `npm run smoke`,
`npm run reset -- --yes`. There are no dependencies to install. Every provisioner is idempotent: a second run
prints "no changes — already provisioned".

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
| `NOCOBASE_VIEWER_EMAIL`, `NOCOBASE_VIEWER_PASSWORD` | `provision-acl.mjs --test-user` | local test user with only the read-only `configurator_viewer` role (generated; never printed) |

### Admin UI: where to see the configurator in NocoBase

Sign in at **http://localhost:13000** with `NOCOBASE_ROOT_EMAIL` / `NOCOBASE_ROOT_PASSWORD` from the
project-root `.env`. The top menu bar has a group **Matrix Configurator**; its pages are in the left sidebar.
Every page has a stable URL (`/admin/<pageSchemaUid>`), so you can also open it directly:

| Click path (after sign-in) | URL | Shows |
|---|---|---|
| Matrix Configurator → **Overview** | `/admin/mcfg-overview` | what NocoBase stores for the configurator, with links |
| Matrix Configurator → **Workspaces** | `/admin/mcfg-workspaces` | `cfg_workspaces`: name, slug, custom?, live/draft version, last updated. Click a **name** (or **View**) → read-only drawer with every field including the `state` JSON |
| Matrix Configurator → **Releases** | `/admin/mcfg-releases` | `cfg_releases`, newest first: workspace, version, reason, published by, created at. Filter by workspace. Click the **version** (or **View**) → drawer with the `manifest` JSON |
| Matrix Configurator → **Modules** / **Gates** / **Stages** | `/admin/mcfg-modules`, `-gates`, `-stages` | the projection tables, with a filter form (workspace slug; plus kind/status, from/to key, module key). Click a row's name (or **View**) → drawer with its `data` / `condition` JSON |
| Matrix Configurator → **Activity** | `/admin/mcfg-activity` | `cfg_activity`, the log the NocoBase **workflow** writes on every new release (see below) |
| ⚙ (top right) → **Workflow** → "Matrix Configurator · Release published → activity log" → **Configure** | `/admin/settings/workflow` | the workflow canvas (trigger → Query record → Create record); the **Executed** count opens its execution history |
| ⚙ → **Users & Permissions** → Roles & Permissions → **Configurator viewer** | `/admin/settings/users-permissions` | the read-only role (Data sources → Main → Configure; Desktop routes) |
| ⚙ → **Data sources** → Main → Collections | | the raw collection definitions ("Configurator · …") |

Each table page offers only **Filter**, **Refresh** and **View**. There is no Add / Edit / Delete / bulk action
on purpose: the configurator (http://localhost:4300) owns every write and validates a draft before it saves it;
editing `state` here would bypass that. (Root can still switch on the UI editor and add buttons by hand;
`provision-ui.mjs` detects such buttons on its next run and rebuilds the page read-only.)

Screenshots of every page: `docs/reports/N1-screens/`.

How the pages are built (NocoBase 2.2.20 "modern" pages, `plugin-flow-engine`): each page is a
`desktopRoutes` row of type `flowPage` under a `group` route, whose content is a tree of flow models
(`RootPageModel → RootPageTabModel → BlockGridModel → TableBlockModel / FilterFormBlockModel`, popups as
`ChildPageModel → DetailsBlockModel`) stored in `flowModels`. `provision-ui.mjs` writes them through the
server-side `flowSurfaces` API, the same one NocoBase's own UI-builder uses: `flowSurfaces:createMenu`
(group) → `flowSurfaces:createPage` (with fixed `pageSchemaUid`s, hence the stable URLs) →
`flowSurfaces:applyBlueprint` (`mode: "replace"`, blueprint from `lib/ui-spec.mjs`) →
`flowSurfaces:removeNode` for every action that is not Filter / Refresh / View. (`applyBlueprint` always injects
Add new, Delete, Edit and bulk-delete buttons; there is no switch to turn that off.) A hash of each page spec is
kept in `desktopRoutes.options.matrixConfigurator.specHash`, so a re-run only rebuilds pages whose spec
changed or that are no longer read-only. `--force` rebuilds everything, and `--remove` deletes the group and
its pages.

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
| `cfg_activity` *(NocoBase-owned, created by `provision-workflow.mjs`; not part of the contract)* | `event`, `summary`, `workspace_slug`, `workspace_name`, `published_by` (varchar), `version` integer, `reason` text, `release_id` bigint, `published_at` timestamptz. Written only by the workflow |

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

## Workflow: every publish is logged by NocoBase (`provision-workflow.mjs`)

The community **Workflow** plugin (built in and enabled) runs a workflow named
**"Matrix Configurator · Release published → activity log"**:

| Part | Configuration |
|---|---|
| Trigger | **Collection event** on `cfg_releases`, *After record added* (`mode: 1`), **asynchronous**, so a slow or failed run never blocks a publish. Condition: `workspace_slug` does not contain `__smoke`, so `smoke.mjs` throwaway releases are ignored |
| Node 1 | **Query record**: the `cfg_workspaces` row whose `slug` = `{{$context.data.workspace_slug}}` (may be empty, e.g. for a tenant that was never a configurator workspace) |
| Node 2 | **Create record** in `cfg_activity`: `event`, `summary` ("<slug> v<version> published by <who>"), `workspace_slug`, `workspace_name` (from node 1), `version`, `reason`, `published_by`, `release_id`, `published_at` |

`cfg_activity` is owned by NocoBase. The configurator never writes it, and it is not in the contract
`COLLECTIONS`, so `provision.mjs`, `reset.mjs` and the client ignore it. Its definition is
`ACTIVITY_COLLECTION` in `lib/schema.mjs`. On the first run the script also backfills releases that have no
activity entry yet by running the same workflow manually (`workflows:execute`, request body
`{ "data": <releaseId> }`). Skip this with `--no-backfill`. The workflow never changes `cfg_workspaces`; a
"last published" field there would bump the configurator's `updatedAt` and race with its saves.

Proof run: `node nocobase/scripts/provision-workflow.mjs --prove` inserts **one** marked test release
(`workspace_slug: "__n1_workflow_test__"`), waits for the workflow's `cfg_activity` row (about 0.5 s), prints
it, and deletes **both** rows again. This is the one documented exception to "`cfg_releases` is append-only".
See it in the UI: **⚙ → Workflow → … → Configure** shows the canvas, the **Executed** count lists the runs, and
**Matrix Configurator → Activity** shows the entries. If the live workflow differs from the script and has
already run, NocoBase keeps executed versions immutable; re-run with `--revise` to create and enable a
corrected revision.

Other triggers worth adding the same way: `mode: 2` on `cfg_workspaces` with `changed: ['live_version']`
(a workspace goes live), or an **HTTP request** / **Notification** node after node 2 (deploy hook, admin alert).

## ACL: read-only role `configurator_viewer` (`provision-acl.mjs`)

| Layer | Setting |
|---|---|
| System | snippets `!pm`, `!pm.*`, `!ui.*`: no plugin manager, no settings pages, no UI editor |
| Menu | only the **Matrix Configurator** group, its 7 pages and their tabs (`roles/<role>/desktopRoutes:set`). New menus are not granted automatically (`allowNewMenu: false`) |
| Tables | global strategy for data source `main`: **no actions**. Independent permission **view** (all fields) on `cfg_workspaces`, `cfg_releases`, `cfg_modules`, `cfg_gates`, `cfg_stages`, `cfg_activity`. No create / update / destroy / export |

`--test-user` creates (or repairs) the local user `configurator-viewer`, which has **only** this role. Its
e-mail and generated password go to the gitignored project `.env` (`NOCOBASE_VIEWER_EMAIL` /
`NOCOBASE_VIEWER_PASSWORD`) and are never printed. Whenever those credentials exist, every run ends with a
live check made as that user. The user must be able to sign in, see only the Matrix Configurator menu, and list
all six collections. Each of these must return **403**: update / destroy / create / export on cfg_*,
`flowModels:save` (UI editor), `collections:create` and `workflows:list`. The write probes cannot change data
even if ACL were wrong: update and destroy target id 0, and the create probe uses `__n1_acl_probe__` and is
deleted again. Sign in as that user to see the same pages without the ⚙ settings and UI-editor icons.

For the configurator's own service account, a narrower write role is the next step. Grant
view/create/update/destroy on `cfg_workspaces` and the projections, and only view/create on `cfg_releases` (an
append-only ledger, enforced). Create an API key while signed in as that user and use it as `NOCOBASE_TOKEN`
instead of the root key. API: `roles:create`, then
`roles/<role>/dataSourceResources:create { dataSourceKey: 'main', name, usingActionsConfig: true, actions: [...] }`.

## License note

The NocoBase kernel and plugins are distributed under the **NocoBase License Agreement**
(https://www.nocobase.com/agreement), a bespoke licence that is **not** OSI-approved. It incorporates
Apache-2.0 but adds supplementary terms that prevail; some source files also reference AGPL-3.0 and commercial
dual-licensing. See `building-blocks/from-nocobase/concept-map.md` for §5.2 (branding) and §5.4 (no public
no-/low-code SaaS). This setup uses **community features only**: the official community Docker image and its
built-in, enabled plugins (collection manager, flow-engine pages, Workflow with Query/Create nodes, ACL, API
keys). No commercial plugin is installed, enabled or attempted. Do not enable commercial plugins such as
*Workflow: Approval*. Review the agreement before redistributing or offering this as a hosted service.

## Troubleshooting

* Run `docker compose ps`; both services should show `(healthy)`. On first boot, wait for
  `node nocobase/scripts/wait-for-nocobase.mjs`.
* Check the app logs with `docker compose logs --tail 200 nocobase`. Warnings like
  `[PubSubManager] adapter is not exist` are normal for a single node.
* If `health()` is false but `health({ deep: false })` is true, either the credentials or
  `NOCOBASE_TOKEN` are wrong, or `provision.mjs` has not run yet.
* No "Matrix Configurator" menu after sign-in: run `provision-workflow.mjs`, then `provision-ui.mjs`. If the
  `configurator_viewer` user sees no menu, re-run `provision-acl.mjs`. Route ids change when pages are
  recreated, for example after `provision-ui.mjs --remove`.
* `docker compose down -v` wipes the menu, workflow and role along with the data. `npm run provision:all`
  (from `nocobase/`) restores all of them.
* The root password in `.env` is only applied on the **first** install. If you change it later,
  change it in the admin UI too, or wipe the volumes with `docker compose down -v`.

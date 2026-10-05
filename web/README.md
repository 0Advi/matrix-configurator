# web — Workspace Configurator runtime (Workstream A)

Runs the Claude Design **Workspace Configurator v5** prototype as a real app on
<http://localhost:4300>, fully offline, persisting to the local NocoBase (Workstream B) and
falling back to the browser's `localStorage` exactly like the original artifact when NocoBase
is not available.

```bash
cd web
npm start          # node server.mjs → http://127.0.0.1:4300 (reads ../.env itself)
npm test           # node --test, no NocoBase needed
npm run e2e        # live check against the running server + NocoBase (see below)
```

Zero runtime dependencies (Node ≥ 18.17; developed on Node 26). Nothing is fetched from a CDN
at runtime: React, ReactDOM, Babel and the IBM Plex fonts are vendored under
`public/vendor/` (versions + hashes in `public/vendor/VERSIONS.md`).

## Layout

```
server.mjs                 HTTP server: /cfg API + static files from public/
lib/env.mjs                .env loader (no dependency; real env vars win)
lib/store.mjs              NocoBase-backed store: mode detection, If-Match, async projections
lib/projection.mjs         v5 blob <-> cfg_workspaces rows; stash -> cfg_modules/gates/stages
lib/static.mjs             static files (MIME map, no traversal/dotfiles/listings)
lib/v5-model.mjs           evaluates the real v5 logic class in Node (seeds, tests)
public/index.html          entry page (loading screen + status pill host)
public/main.js             entry module: await startBridge(), then bootConfigurator()
public/storage-bridge.js   hydration + localStorage interceptor + status pill (browser)
public/sync-engine.js      sync state machine (DOM-free; shared with tests)
public/bridge-core.js      pure helpers: hydration decision, publish detection, manifest, debounce
public/boot.js             boots configurator.dc.html on support.js (offline + fixes)
public/configurator.dc.html  v5 design document — byte-identical copy
public/support.js          dc-runtime — byte-identical copy
public/vendor/             react, react-dom, @babel/standalone, IBM Plex (woff2) + VERSIONS.md
scripts/e2e-nocobase.mjs   live end-to-end check (needs server + NocoBase)
test/                      node:test suites (+ helpers; fake-nocobase.mjs is TEST-ONLY)
CHANGES.md                 every adaptation of the design files, and why
```

## Boot / hydration sequence

The v5 constructor reads `localStorage['wsconfig_v5_custom']` **synchronously**, so the app must
not mount before the browser copy has been reconciled with the server.

1. `index.html` shows "Loading configurator…" and loads `main.js`, which awaits
   `startBridge()` (status pill: "Connecting…") and only then `bootConfigurator()`.
2. `startBridge()`:
   - installs a wrapper on `Storage.prototype.setItem` (writes pass through untouched; writes to
     `wsconfig_v5_custom` are then reported to the sync engine),
   - `GET /cfg/health` (4 s timeout). Not `nocobase` → **local mode**, nothing touched.
   - `GET /cfg/state` (6 s timeout) → blob + `ETag`, then `decideHydration()`:

     | server | browser | → action |
     |---|---|---|
     | none | none | `none` |
     | none | has state | `push` — first-run migration (releases back-filled from v5 history) |
     | has state | none | `pull` — written into localStorage |
     | equal | equal | `pull` (no-op) |
     | has state | differs, browser clean | `pull` (server is newer) |
     | has state | differs, browser dirty on the current server ETag | `push` (offline edits) |
     | has state | differs otherwise | `conflict` — server wins, browser copy saved to `wsconfig_v5_custom__conflict_backup` |
3. `bootConfigurator()` (see `CHANGES.md` for each step): maps the runtime's unpkg URLs to
   `/vendor` via `window.__resources`, loads React/ReactDOM from `/vendor` with the runtime's own
   SRI hashes, fetches `configurator.dc.html`, loads `support.js` (its auto-boot is a no-op
   because the page has no `<x-dc>` yet), inserts `<x-dc>` + the logic script, calls
   `__dcBoot()`, installs the **prevState shim** and hands over the raw template (Google Fonts
   links rewritten to the vendored stylesheet). React renders; the loading screen fades out.

## Persistence model

- **What v5 persists:** only custom workspaces (created with "+ New workspace"). The blob:

  ```js
  {
    customWs: [ { id: 'ws_third_wave', name: 'Third Wave', slug: 'third-wave', start: 'template'|'empty', created: '03 Oct 2026' } ],
    data: {
      ws_third_wave: {
        modules: [...],               // draft modules (the canvas)
        perms:   [...],
        live:    { modules, perms },  // last published snapshot
        liveV: 1, draftV: 2,
        history: [ { version: 'v1', meta: '11 Sep 2026 · platform:ops@matrix.io', reason: '…', lines: [...] } ]
      }
    }
  }
  ```

  It is written by v5's `componentDidUpdate` whenever `customWs`, `wsData`, `modules` or
  `liveV` change. The three demo workspaces are never persisted by v5 (edits reset on reload).
- **Browser → server:** every write is debounced (600 ms trailing, 3 s max-wait so a node drag
  still saves) into `PUT /cfg/state` with `If-Match: <last server ETag>`. The raw localStorage
  string is sent, so the server stores it key-order-exact.
- **Server → NocoBase:** each custom workspace is one `cfg_workspaces` row
  (`slug`, `name`, `initials` = first two letters like the v5 picker, `is_custom: true`,
  `live_version`, `draft_version`, `state = { format: 'wsconfig_v5_custom/1', workspace: <customWs entry>, order, data: <stash> }`).
  Only rows whose content changed are written; workspaces missing from the blob are deleted.
  `GET /cfg/state` rebuilds the blob from these rows — byte-identical to what the browser
  stored (NocoBase `json` columns keep key order; verified live).
- **Projections** (`lib/projection.mjs`), rebuilt asynchronously per changed workspace with
  `replaceWhere(…, { workspace_slug })`, from the **draft** modules:
  - `cfg_modules`: `module_key`, `name`, `glyph` (icon), `kind` (`builtin`/`custom`),
    `status` (`live` | `draft` | `pending_engineering` | `disabled` when switched off),
    `route` (`/m/<key>` for custom, `/<key-with-dashes>` for built-in — v5's manifest rule),
    `data` (the rest of the module: tiers, roll-up, nav, pages, position, … + `stage_count`, `in_live`).
  - `cfg_gates`: one row per gate condition: `from_key` (source module), `to_key` (gated module),
    `condition = { outcome, match, position, of, refusal, touched }`.
  - `cfg_stages`: `module_key`, `position` (1-based), `name`, `outcome`, `terminal` (last stage),
    `data = { id, approvers, fields, sites }`.
  A projection failure is logged and shown in `/cfg/health → projection.lastError`; it never
  fails the save.
- **Built-in demo workspaces** (Blue Tokai, Starbucks, Burger King) are upserted once per server
  start as `is_custom: false` reference rows with projections (evaluated from the real v5 logic),
  so NocoBase's admin UI has real data immediately. They are excluded from `GET /cfg/state`.
  Disable with `CFG_SEED_BUILTINS=0`.
- **Releases:** a publish in v5 raises `liveV`. When a save succeeds the bridge compares the
  previous server blob with the new one (`detectPublishes`) and, per new version, posts
  `{ workspace_slug, version, reason, manifest, published_by }` to `POST /cfg/releases`:
  `reason` is the text the user typed (from v5's history entry), `manifest` mirrors v5's
  `manifest()` for the published snapshot, `published_by` is the identity in the history entry
  (v5 hard-codes `platform:ops@matrix.io`). Pending releases are kept in
  `localStorage['wsconfig_v5_custom__sync']` until the server accepts them; the server dedupes
  on `(workspace_slug, version)`, so retries are safe.
- **Status pill** (bottom-left): Saved · NocoBase / Unsaved changes… / Saving… / Local only /
  Sync error (click: retry) / Sync conflict · reload / Newer data on server · reload. Steady
  states collapse to a dot after 4 s; hover for details.

## API (`server.mjs`)

| Route | Behaviour |
|---|---|
| `GET /cfg/health` | `{ ok: true, mode: 'nocobase'\|'local', nocobase, client: 'loaded'\|'missing'\|'disabled'\|'error', projection: { pending, runs, lastRunAt, lastError } }` — cached, stale-while-revalidate |
| `GET /cfg/state` | the blob (`{}` if none) + `ETag`; **503 `{mode:'local'}` in local mode** |
| `PUT /cfg/state` | body = blob (`Content-Type: application/json`, ≤ 5 MiB); optional `If-Match` → **409 `{etag}`** if stale; 200 `{ ok, etag, changed, deleted }`; 400 invalid; 503 local |
| `POST /cfg/releases` | 201 created / **200 `{duplicate: true}`** if that version exists; 400 invalid; 503 local |
| `GET /cfg/releases?ws=slug` | rows (oldest first); 400 without `ws`; 503 local |
| anything else | static files from `public/` (`/` → `index.html`), GET/HEAD only |

Upstream NocoBase errors → 502. HTML responses carry a same-origin `Content-Security-Policy`
(`default-src 'self'`, plus `'unsafe-eval'` for the dc-runtime's `new Function`), so the
browser itself refuses any CDN script, stylesheet, font or fetch. A browser navigation to
`/configurator.dc.html` is redirected to `/` (the raw document would boot standalone, without
the bridge); `boot.js`'s `fetch()` of it is served normally. The `/cfg/*` API only accepts loopback `Host` headers
(DNS-rebinding guard; extend with `WEB_ALLOWED_HOSTS=a,b`), and POST/PUT require
`application/json` (blocks simple cross-site form posts). The server binds `127.0.0.1` by
default (`WEB_HOST` to change).

**Mode detection:** the server lazily imports `../nocobase/lib/client.mjs` and calls its deep
`health()` (app up + authenticated read of `cfg_workspaces`). Missing client module, bad
credentials, unprovisioned collections or a stopped container all mean `local`. Both are
re-checked continuously, so the server can start before NocoBase and switch to `nocobase`
without a restart; the browser bridge re-checks every 15 s while in local mode and uploads
offline edits when it can do so safely.

### Environment

Read from `../.env` (or `CFG_ENV_FILE`); real environment variables take precedence.

| Var | Default | |
|---|---|---|
| `WEB_PORT` | `4300` | |
| `WEB_HOST` | `127.0.0.1` | |
| `NOCOBASE_URL`, `NOCOBASE_TOKEN`, `NOCOBASE_ROOT_EMAIL`, `NOCOBASE_ROOT_PASSWORD` | — | passed to `createClient()` |
| `CFG_MODE` | auto | `local` forces local mode (never talks to NocoBase), e.g. for `start.sh --local` |
| `CFG_SEED_BUILTINS` | on | `0` disables seeding the demo workspaces |
| `CFG_MAX_BODY_BYTES` | 5 MiB | request body cap |
| `CFG_CLIENT_MODULE` | `../nocobase/lib/client.mjs` | alternate client module path |
| `WEB_ALLOWED_HOSTS` | — | extra hostnames allowed to call `/cfg/*` |

## Tests

`npm test` (≈ 3 s, no network besides loopback):

- `projection.test.mjs` — projections and blob⇄rows round-trip on **real v5 seed data and real
  v5 flows** (the logic class is evaluated in Node by `lib/v5-model.mjs`).
- `bridge.test.mjs` — the stock-runtime `componentDidUpdate` bug and the shim, offline template
  rewrite, vendor map vs `support.js`, publish detection (reason, manifest == v5 `manifest()`),
  hydration decision table, debounce/max-wait.
- `sync-engine.test.mjs` — the browser engine end-to-end against the real handler + store:
  first-run migration, pull, debounced saves, release posting, two-tab 409 conflict + backup,
  offline edits pushed after NocoBase returns, local mode.
- `server.test.mjs` — the real `server.mjs` spawned on a random port in local mode (routes, 503s,
  415/413/400/404/405/403, MIME types, traversal attempts, no CDN references) and the handler in
  nocobase mode against a **test-only** in-memory client.
- `vendor.test.mjs` — vendored files match the runtime's SRI; design files are pristine copies;
  every font URL resolves.

`npm run e2e` drives the same bridge code against the running server and the **live** NocoBase:
migration of a real v5 blob, rows + projections checked through `nocobase/lib/client.mjs`,
byte-identical `GET`, releases (back-filled, direct POST, duplicate), stale `If-Match` → 409.
It refuses to run if the server already has custom workspaces, and removes everything it
created (its two `e2e-*` workspaces and their release rows) at the end.

## Limitations

- Persistence covers **custom workspaces only** (v5 behaviour). Demo-workspace edits are
  session-only; their NocoBase rows are read-only reference data refreshed from the design.
- After boot the bridge can only **push**: the running app's in-memory state would overwrite
  anything pulled into localStorage. If the server changes underneath an open tab (another tab
  or browser saved), that tab's next save gets a 409, the pill turns red ("Sync conflict ·
  reload"), and further edits stay local until reload — where the server copy wins and the
  browser copy is kept in `wsconfig_v5_custom__conflict_backup`. No merge.
- Concurrency control is per whole blob, not per workspace.
- `published_by` and the history date are whatever v5 records (hard-coded
  `platform:ops@matrix.io`, `11 Sep 2026`); NocoBase's `createdAt` has the real time.
- If two publishes land in one debounce window (practically impossible — publishing needs a
  typed reason), only the newest release carries a manifest; v5 keeps no intermediate snapshot.
- On tab close the last ≤600 ms of edits are sent with a `keepalive` PUT only if the blob is
  under 60 KB (browser limit); otherwise they are uploaded on the next visit (dirty flag).
- Projections are eventually consistent (they run after the save responds).
- No authentication: the server is meant for localhost only (loopback bind + Host check).

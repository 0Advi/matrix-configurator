# Matrix Configurator — local working model

> **Comparing with the original Matrix app?** The first commit of this repo (tag
> `original-matrix-bd-3d4f277`) is the **unmodified** Matrix-bd `origin/main` @ `3d4f277` under `app/`.
> Everything after it is our work. So:
>
> ```bash
> git diff original-matrix-bd-3d4f277 HEAD --stat -- app/   # every file we changed in the app
> git diff original-matrix-bd-3d4f277 HEAD -- app/backend/database/migrations/   # the DB changes
> ```
>
> The human-readable change spec (file · what · why, per phase) is **`app/SANDBOX-CHANGES.md`**; the plan,
> status and findings are in **`docs/PHASE2-PLAN.md`**; per-phase reports are in **`docs/reports/`**.

## Repository map

| Path | What | Phase |
|---|---|---|
| `sources/` | the original configurator design artifact (v1–v5) — never edited | 1 |
| `web/` | standalone configurator on :4300 (v5 unmodified + offline runtime + sync) | 1 |
| `nocobase/` | NocoBase (design-time draft store) client, provisioning, smoke | 1 |
| `building-blocks/` | provenance-tracked blocks extracted from the design, the real app, NocoBase | 1 |
| `app/` | **sandbox copy of the real Matrix app**, made modular (data-driven modules, provisioning + publish API, generic custom-module runtime, configurator inside `/#/admin`) | 2 |
| `app-stack/` | runs the sandbox on localhost (Postgres, storage stub, API :8000, web :5173) + smoke tests | 2 |
| `agent-configurator/` | AI-agent configurator: 27 ops as CLI + MCP server, same drafts as the visual configurator | 2b |
| `third_party/` | vendored permissive pieces (json-logic) + our adapters (gates, forms, reference runtime) | 2 |
| `docs/schema-audit/` | task 3: can the real DB run this? + 6 proposed migrations, validated | 2 |
| `docs/oss/` | task 2: provenance audit, OSS gap analysis, Operaton/SpiffWorkflow spikes | 2 |
| `docs/catalogue-crosscheck/` | operaton-plat vs our model vs real code (D01–D33) + proposed patches | 2b |

Phase 2 run instructions: `app-stack/README.md`. The Phase 1 standalone configurator is described below.

A runnable version of the **Workspace Configurator** design (v5), backed by a local
**NocoBase** instance, plus a catalogue of reusable building blocks extracted from the
design, the production Matrix app, NocoBase and the platform-refoundation proposal.

This is a **separate project for future development**. It does not modify the Matrix
application (`../Matrix-bd*`); those repos were only ever read.

## Run it

Requirements: Docker Desktop, Node.js 20+ (tested on 26).

```bash
./start.sh            # NocoBase + Postgres (Docker) + configurator → http://localhost:4300
./start.sh --local    # configurator only; saves stay in this browser (no Docker needed)
./stop.sh             # stops everything, KEEPS data   (wipe: docker compose down -v)
```

| What | Where |
|---|---|
| Configurator | http://localhost:4300 |
| NocoBase admin UI | http://localhost:13000 — login is `NOCOBASE_ROOT_EMAIL` / `NOCOBASE_ROOT_PASSWORD` in `.env` |

`start.sh` starts Docker Desktop if needed, waits for NocoBase, provisions its tables
(idempotent), then runs the web server in the foreground (Ctrl-C to stop it). If NocoBase
can't start, the configurator still runs in local mode.

**Fresh machine:** `.env` is generated and gitignored. Elsewhere, copy `.env.example` to
`.env`, fill in the values, then run `./start.sh` — provisioning creates the NocoBase API key
and writes it to `.env` as `NOCOBASE_TOKEN`.

## How it fits together

```
Browser ── v5 design, unmodified (byte-identical to the artifact)
   │        + boot.js (offline React/Babel/fonts, one runtime fix)
   │        + storage bridge (hydrate before mount, debounced saves, publish → release)
   ▼
Web server :4300  (web/server.mjs, zero dependencies)
   │   /cfg/health · /cfg/state (ETag/If-Match) · /cfg/releases · static files
   ▼
NocoBase 2.2.20 :13000  (Docker, community edition, API-key auth)
   │   cfg_workspaces   per-workspace document — authoritative (json, key order kept)
   │   cfg_releases     immutable publish ledger (version, reason, manifest)
   │   cfg_modules / cfg_gates / cfg_stages   projections for the admin UI & future workflows
   ▼
Postgres 16  (Docker network only, never published to the host)
```

Everything is served from localhost — no CDN at runtime. Full interface contract and the
documented deviations: [`docs/CONTRACT.md`](docs/CONTRACT.md).

## Folder layout

| Path | What |
|---|---|
| `sources/` | the original artifact (zip + extracted v1–v5 + runtime) — never edited |
| `web/` | runnable configurator, server, sync engine, tests — see `web/README.md`, `web/CHANGES.md` |
| `nocobase/` | NocoBase client library, provisioning, smoke test — see `nocobase/README.md` |
| `building-blocks/` | extracted, provenance-tracked blocks — start at `building-blocks/CATALOG.md` |
| `docs/` | integration contract |

## Building blocks (highlights)

- **`from-matrix-bd/matrix-bd-flow.json`** — the production Blue Tokai flow as configurator
  data (9 modules, 36 stages, 113 fields). `flow-adapter.mjs` turns it into a v5 workspace
  with zero findings. **`SEED-VS-REALITY.md`** compares it with the design's seed.
- **`from-design/`** — seeds, vocabularies, JSON Schemas, validation rules proven identical to
  v5's own code, design tokens, and the v1→v5 design lineage.
- `rbac`, `approvals` (17 workflow + 6 access approvals), `rent-terms`, `auth-tenancy`,
  `route-guards` (218 routes), DB value vocabularies, app design tokens.
- `from-nocobase/concept-map.md` and `from-proposal/primitives-map.md`.

## Verified

| Check | Result |
|---|---|
| Web unit/integration tests (`cd web && npm test`) | 54/54 |
| Web ↔ live NocoBase end-to-end (`cd web && npm run e2e`) | 22/22 |
| NocoBase client smoke test (`node nocobase/scripts/smoke.mjs`) | 14/14 |
| Building blocks (`cd building-blocks && npm test` — run *inside* the folder) | 109/109 |
| Browser, full stack | renders, 0 console errors, 0 external requests, UI edit persisted to NocoBase |

## Things to know

- **The original v5 artifact never saved.** Its `componentDidUpdate(pp, ps)` reads
  `ps.customWs`, but the runtime only passes one argument, so every save threw. `web/public/boot.js`
  fixes it from the outside; the design file itself is unchanged.
- **Only custom workspaces persist** (v5's design). Edits to the three demo workspaces
  (Blue Tokai, Starbucks, Burger King) live in memory; they're mirrored into NocoBase as
  read-only reference rows (`is_custom=false`).
- Publish attribution is hard-coded in v5 (`platform:ops@matrix.io`); the real publish time
  is the release row's `createdAt`.
- Two tabs editing at once: the second save gets a conflict and asks for a reload (no merge).
- The web server has **no auth** and binds to 127.0.0.1 only — local use only.
- **Licence:** NocoBase's kernel ships under the bespoke, non-OSI "NocoBase License Agreement".
  Its §5.4 restricts offering a public low-code SaaS/PaaS built on it, and the multi-step
  Approval plugin is commercial. Fine for this local model; get a legal opinion before any
  customer-facing use. Details in `nocobase/README.md` and `building-blocks/from-nocobase/`.

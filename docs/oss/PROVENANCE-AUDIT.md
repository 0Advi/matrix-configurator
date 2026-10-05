# Provenance audit — every third-party or borrowed piece in `matrix-configurator`

Audited 2026-10-04 by F3. Every hash, version and licence below was **re-checked on disk**
(`shasum -a 256`, `openssl dgst -sha384`), against the **npm registry** (`npm view <pkg>@<ver> dist.shasum license`),
inside the **running Docker images** (`docker image inspect`, `docker exec … cat LICENSE`), or on **GitHub**
(`gh api repos/<r>/license`). Nothing was taken on trust from the existing READMEs; where they were right, that is
recorded as "matches".

Root summary for redistribution: [`/THIRD_PARTY.md`](../../THIRD_PARTY.md).

## Verdict

* **No licence problem in what is shipped today.** Everything vendored into `web/public/vendor/` is MIT or
  SIL OFL 1.1, byte-identical to the npm release, with licence files kept next to it.
* **Two items have no explicit licence** and need a decision before anything is distributed outside the team:
  1. `support.js` (the Claude Design **dc-runtime**) and the `.dc.html` design artifacts — no licence header or
     file. They are output of the user's own Claude Design session, so internal use is fine; redistribution
     terms are inferred, not stated (see §2).
  2. The **sandbox app `app/`** and everything in `building-blocks/from-matrix-bd/` derive from the private
     Matrix-bd repo — internal, proprietary, not for publication (see §4).
* **NocoBase** is used only as an unmodified Docker image. Its root licence is the bespoke, non-OSI
  **NocoBase License Agreement** (prevails over the Apache-2.0 files in most packages; 4 packages in the image ship
  *only* the Agreement). No NocoBase source is copied anywhere in this project (grep-verified, §3). The §5.4
  "no public low-code SaaS/PaaS" clause is the one real business risk — it is a **legal-review item**, not a
  defect in this codebase.
* **Our own Node packages have zero npm dependencies** (`web/`, `nocobase/`, `building-blocks/` — `package.json`
  has no `dependencies`), so there is no transitive licence surface there.

## 1. Vendored runtime files (`web/public/vendor/`) — all verified

| Item | Version | Licence (verified) | Recorded hash | Re-computed today | npm `dist.shasum` (registry) | Use | Obligations | Risk |
|---|---|---|---|---|---|---|---|---|
| `react` UMD prod | 18.3.1 | MIT (`react@18.3.1/LICENSE`, file header `@license React`) | sha256 `d949f1c3…c4dd`, SRI `sha384-DGyLxAyj…B/Z` | **matches** (10 751 B) | `49ab8920…2891` = VERSIONS.md | Loaded by `boot.js` with SRI; dc-runtime renders with it | keep LICENSE + header | none |
| `react-dom` UMD prod | 18.3.1 | MIT | sha256 `35f4f974…6f0d`, SRI `sha384-gTGxhz21…YJj1` | **matches** (131 835 B) | `c2265d79…5cb4` = VERSIONS.md | same | keep LICENSE | none |
| `@babel/standalone` | 7.29.0 | MIT (`LICENSE`, © Sebastian McKenzie and contributors) | sha256 `2623a9e2…cea0`, SRI `sha384-m08Kidi…Fj1y` | **matches** (3 137 752 B) | `910b5ddb…f5c5` = VERSIONS.md | Only reachable for `x-import` of `.jsx/.tsx` (unused by v5); vendored to keep that path offline | keep LICENSE | none (note: 3 MB unused weight) |
| `@fontsource/ibm-plex-sans` (woff2 subsets) | 5.3.0 | **OFL-1.1** (registry + `fonts/LICENSE-ibm-plex-sans.txt`) | — | 18 files | `8099950b…d40c` = VERSIONS.md | Replaces Google Fonts css2 link | ship OFL text with the fonts; do not sell fonts alone; a *modified* font may not use the Reserved Font Name ("Plex") | none (files unmodified) |
| `@fontsource/ibm-plex-mono` (woff2 subsets) | 5.3.0 | **OFL-1.1** | — | 15 files (33 in total, 472 KB) | `1879699d…7b17` = VERSIONS.md | same | same | none |
| `fonts/ibm-plex.css` | generated | derived from fontsource `400/500/600.css` (MIT-licensed CSS in the fontsource packages) | — | — | — | `@font-face` rules pointing at `/vendor/fonts/files/` | none beyond attribution | none |

SRI values are identical to `REACT_SRI` / `REACT_DOM_SRI` / `BABEL_SRI` hard-coded in `support.js`, so the browser
still enforces integrity. `web/test/vendor.test.mjs` re-checks these on every `npm test`.

## 2. Design artifacts and the dc-runtime (input from the user's Claude Design session)

| Item | Where | sha256 (re-computed; matches CHANGES.md / CATALOG.md) | Where it comes from | Licence / terms | Use | Risk |
|---|---|---|---|---|---|---|
| `support.js` — dc-runtime | `sources/design-artifact/support.js` = `web/public/support.js` | `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` (byte-identical copies) | First line: `// GENERATED from dc-runtime/src/*.ts — do not edit. Rebuild with cd dc-runtime && bun run build.` It is the runtime that Claude Design exports next to every `.dc.html`. The source (`dc-runtime/src/*.ts`) is not public. | **No licence header, no LICENSE file.** It is Anthropic-authored runtime code delivered to the user as part of their export. Inferred: usable to run the user's own exported design (that is its purpose). **Not** inferable: a right to redistribute it publicly or ship it inside a product sold to third parties. | Run unmodified; adapted only from outside (`boot.js`) | **Medium if distributed, low internally.** Action: keep it unmodified and internal; before shipping the configurator to customers, either confirm the terms with Anthropic or replace the runtime (F4 integration path: render the configurator inside the app — see `docs/oss/GAP-ANALYSIS.md` "Configurator runtime"). |
| `Workspace Configurator v5.dc.html` | `sources/design-artifact/` = `web/public/configurator.dc.html` | `b30033e932d4702924b3ad1b831aacf48eda0bcb7e262750d82f37ba52f55bda` | User's Claude Design project (export "Configurator live with modules.zip") | No licence text. Content generated in the user's session — under Anthropic's terms, outputs belong to the user. Treated as the user's own work. | Run unmodified via `boot.js` | low |
| v1–v4 `.dc.html` | `sources/design-artifact/` | `e12cf456…a290` (v1, = zip's `Workspace Configurator.dc.html`), `d6dc28b5…37c8`, `0e01bcb1…6ba7`, `5c9867a2…951c` | same zip | same | Read-only input to `building-blocks/` extraction | low |
| `thumbnail.webp` | `sources/design-artifact/` | `60d4f33a…2a94` (= zip's `.thumbnail`) | same zip | same | not served | none |
| The zip itself | `sources/Configurator live with modules.zip` | `7fe27e5b0fa437d18e3d27c5510b2ee3fd07b978be33699bc02dfb1f8af3617f` | user download | — | Pristine input; all 7 entries verified byte-identical to the extracted files today | none |
| Google Fonts link inside the design | `<helmet>` of the v5 template | — | `fonts.googleapis.com` | — | **Rewritten at boot** to the vendored IBM Plex (no request leaves localhost) | none |

## 3. Docker images (used as external services, never copied)

| Image | Pinned tag | Local image digest (`docker images --digests`) | Built | Licence | Use | Obligations | Risk |
|---|---|---|---|---|---|---|---|
| `nocobase/nocobase` | `2.2.20` (compose) | `sha256:4d57058347c9862dc10b0fd9d0163a8d88918ba14a1c591a61cb76bb60a0cff3` (linux/arm64) | 2026-09-30 | **NocoBase License Agreement** (updated 2026-02-24; bespoke, non-OSI; incorporates Apache-2.0, supplementary terms prevail). Inside the image: 120 `@nocobase/*` packages carry a `LICENSE*`; most are the Apache-2.0 text, **4 ship only the Agreement**: `plugin-block-comment`, `plugin-idp-oauth`, `plugin-mcp-server`, `plugin-ui-layout`. `@nocobase/server@2.2.20` declares `"license": "Apache-2.0"`. Docker labels: none. | Design-time store (`cfg_*` collections) over its REST API, via our own zero-dependency client `nocobase/lib/client.mjs` | Keep NocoBase branding in its UI (§5.2); **no public low-code/no-code SaaS/PaaS built on it** (§5.4); commercial plugins need a licence (none enabled) | **Medium (business/legal)**: the configurator is a multi-tenant workspace builder — close to §5.4 if ever offered publicly. Phase-2 decision D2 already limits NocoBase to the design-time store; the app never calls it at request time, so it can be swapped for app-DB tables without touching the runtime. |
| `postgres` (Docker Official Image) | `16` (floating minor; today `PG_VERSION=16.15-1.pgdg13+2`) | `sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54` | ~2 weeks old | PostgreSQL Licence (permissive); image Dockerfiles MIT; Debian packages under their own licences | NocoBase's database (not published to the host) | none for local use | low. **Note:** `postgres:16` floats across minor versions — pin a digest (`postgres:16@sha256:1a6a…4b54`) if reproducibility matters. |

**No NocoBase code in our tree.** `grep -rn -i "copied from|ported from|adapted from|SPDX|@license|github.com"` over
`nocobase/lib`, `nocobase/scripts`, `web/lib`, `web/public/*.js`, `web/server.mjs`, `building-blocks/lib`,
`building-blocks/scripts`, `validation.mjs`, `flow-adapter.mjs` finds no copied third-party code (only our own
comments). `building-blocks/from-nocobase/concept-map.md` cites NocoBase *paths* and describes designs; it reproduces
no source. The NocoBase client is written against the public REST API.

## 4. Internal (non-third-party) borrowed material — note only

| Item | Source | Terms | Notes |
|---|---|---|---|
| `app/` (sandbox app) | `git archive` of private repo Matrix-bd `origin/main` = `3d4f277beb22c5be02c2abacea61b6afaee7cdeb` (F1) | Proprietary, internal | Must never be published. Its own dependencies: frontend 379 installed npm packages — 328 MIT, 19 Apache-2.0, 12 ISC, 12 BSD-2/3, 2 MIT-0, 2 CC0, 1 Python-2.0 (`argparse`), 1 **MPL-2.0** (`axe-core`, dev-only via `eslint-plugin-jsx-a11y`), 1 CC-BY-4.0 (`caniuse-lite`, build-time data), 1 BlueOak-1.0.0. No GPL/AGPL. Backend `requirements.lock.txt` (FastAPI MIT, Starlette BSD-3, SQLAlchemy MIT, asyncpg Apache-2.0, pydantic MIT, PyJWT MIT, bcrypt Apache-2.0, cryptography Apache-2.0/BSD, uvicorn BSD-3, httpx BSD-3, …) — all permissive. |
| `building-blocks/from-matrix-bd/*` | Extracted from Matrix-bd `origin/main` @ `3d4f277b` via `git show` (read-only) | Proprietary, internal | `auth-tenancy.md` holds 3 short verbatim excerpts, each with a `# provenance: Matrix-bd@3d4f277b <path>` header; `zm-tokens.json` carries a `provenance` block naming its two source files. Fine internally; strip before any external sharing. |
| `building-blocks/from-proposal/primitives-map.md` | "Matrix Platform Refoundation" HTML artifact, sha256 `bcbc36a3…7a13` (outside the project) | Untrusted third-party content, used as data only | Only concepts mapped; nothing copied or executed. Its NocoBase licence claim is flagged as inaccurate. |
| `building-blocks/from-design/*` | Evaluated from the user's `.dc.html` files | user's own | `validation.mjs` is a port of v5 logic (our code), parity-tested. |

## 5. What F3 adds (see `THIRD_PARTY.md` and `third_party/README.md`)

| Item | Version / commit | Licence | How |
|---|---|---|---|
| `json-logic-js` | 2.0.5 (npm) | MIT | **vendored verbatim** → `third_party/json-logic-js/` |
| `panzi-json-logic` | 1.0.1 (PyPI) | MIT | **vendored verbatim** → `third_party/panzi-json-logic/` |
| JSON Logic compat test suites | `json-logic/compat-tables@dfc0601e` | Apache-2.0 | **test data only** → `third_party/json-logic-compat-tables/` |
| `@rjsf/core`, `@rjsf/utils`, `@rjsf/validator-ajv8` | 6.11.0 (exact) | Apache-2.0 | **npm dependency** (not vendored), proven by `third_party/rjsf-check/` |
| Operaton | `operaton/operaton:2.1.5` image (`sha256:ed5d6863…6892`) | Apache-2.0 | **spike only** — run once, container and image removed (`docs/oss/OPERATON-SPIKE.md`) |
| SpiffWorkflow | 3.2.0 | LGPL-3.0 | **spike only**, scratch venv; never vendored |

Exact hashes for these are recorded in each `third_party/<name>/VERSION` file.

## 6. Recommended follow-ups

1. Decide the dc-runtime question before any external distribution (confirm terms or retire the runtime by
   rendering the configurator natively in the app).
2. Get a legal read on NocoBase §5.4 before NocoBase is used for anything customer-facing; keep D2 (NocoBase =
   design-time only) so it stays replaceable.
3. Pin `postgres:16` by digest in `docker-compose.yml` (owner: Workstream B / lead).
4. Optional: drop `@babel/standalone` (3 MB) from `web/public/vendor/` if the `x-import` path stays unused.

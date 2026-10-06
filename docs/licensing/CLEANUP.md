# Licensing cleanup report

**Task 15** · 2026-10-06 · scope: make `matrix-configurator` safe to become an independent product repo.

This is a technical inventory, **not legal advice**. Where a decision depends on contract, ownership or
licence interpretation, the action says **legal review**.

Inputs (reused, not redone): `THIRD_PARTY.md`, `docs/oss/PROVENANCE-AUDIT.md` (F3, hashes verified),
`docs/ADOPTION-AUDIT.md`, and the Task 1 clean-room audit `docs/independence/AUDIT.md` +
`inventory.json` (55 items). IDs in the **Ref** column (`MB-`, `OW-`, `LR-`, `AS-`) point to that inventory.
New items found in this pass are tagged `LC-nn`.

Method: listed each directory in scope, located every `LICENSE*`/`COPYING*`/`NOTICE*` file, read the
dependency manifests and lockfile `license` fields, and skimmed READMEs and file headers. No code was read in full.

**Licence files found in the whole tree (outside `node_modules`): 14.** They are all third-party:
5 in `web/public/vendor/`, the same 5 in `app/frontend/public/configurator/vendor/`, 3 in `third_party/`, and
1 in `app/backend/app/vendor/json_logic/`. **The repo has no root `LICENSE`.** None of the first-party code has
a licence file, and no first-party `package.json` or `pyproject.toml` sets a `license` field.

---

## 1. Must remove

These must not be in the independent repo in any form (see §6 for which ones may survive as ideas only).

| # | Path | Licence (as found) | Action | Reason | Ref |
|---|---|---|---|---|---|
| 1.1 | `app/` (**sandbox copy of the proprietary Matrix-bd app**, `3d4f277b`): `backend/`, `frontend/`, `docs/`, `Makefile`, `pyproject.toml`, `package-lock.json`, `.github/`, `.claude/`, `CLAUDE.md`, `CODEBASE_REVIEW.md`, `DEPLOYMENT.md`, `left_out_tasks.md`, `SANDBOX-CHANGES.md` | **none found** (proprietary, internal, per PROVENANCE-AUDIT §4) | Delete. Port only the files that are ours (§3, §6), and of the 55 modified files only our hunks | Proprietary third-party source. About 900 of its 1 016 files are Matrix-bd's | LR-05, MB-01…MB-16 |
| 1.2 | `app/frontend/public/landing/{pipeline,scale}` (286 files) | **none found** (Matrix-bd + a second dc-runtime build, sha256 `505f94e0…2efe`) | Delete | Matrix-bd pages, and they run on the unlicensed dc-runtime | MB-14, LR-02 |
| 1.3 | `app/z-matrix-design-system/`, `app/frontend/public/{brand-logo.jpeg,colors_and_type.css}`, `ZM_TOKENS` | **none found** | Delete (the replacement is in §2) | Matrix-bd brand identity and design system | MB-13 |
| 1.4 | `app/frontend/src/assets/lottie/*.json` | **none found** | Delete with `app/` | Animation asset of unknown origin (LC-01) | LC-01 |
| 1.5 | `app/backend/database/migrations/20261004_2`, `20261005_4` (module_catalog rows) | ours, but the content is Matrix-bd data | Delete | The built-ins become private templates | MB-18 |
| 1.6 | **Claude dc-runtime** `support.js`, sha256 `8fe7df74…8cbe`, in 3 byte-identical copies: `sources/design-artifact/`, `web/public/`, `app/frontend/public/configurator/` | **none found** (header: "GENERATED from dc-runtime/src/*.ts"; Anthropic-authored export) | Delete everywhere | No stated redistribution terms. The configurator UI and the agent (via `node:vm`) both execute it | LR-02 |
| 1.7 | **`*.dc.html`**: `sources/design-artifact/Workspace Configurator v1–v5.dc.html`, `web/public/configurator.dc.html`, `app/frontend/public/configurator/configurator.dc.html` | **none found** (the user's own Claude Design output) | Delete from the product. Keep in the sandbox repo as a visual reference | They only run on the dc-runtime, and they embed brand seeds | LR-03 |
| 1.8 | `sources/Configurator live with modules.zip`, `sources/design-artifact/thumbnail.webp` | **none found** | Delete from the product | Pristine export of 1.6 and 1.7 | LR-03 |
| 1.9 | **dc-runtime vendor bundles**: `web/public/vendor/{react@18.3.1,react-dom@18.3.1,@babel/standalone@7.29.0}` and the copy under `app/frontend/public/configurator/vendor/` | MIT (LICENSE present) | Delete | The licence is fine. These exist only so the dc-runtime can run offline. React comes from npm (§3b) | LR-10 |
| 1.10 | `building-blocks/lib/load-dc.mjs` | ours, no licence file | Delete | It executes the design file's `class Component` (dc code) in `node:vm` | LR-02 |
| 1.11 | `building-blocks/from-matrix-bd/*` (13 files, including `auth-tenancy.md` with 3 verbatim excerpts, `matrix-bd-flow.json`, `zm-tokens.json`, `flow-adapter.mjs`) | **none found** (proprietary extracts with `provenance:` headers) | Delete | Extracted from the Matrix-bd source | MB-17, LR-05 |
| 1.12 | `building-blocks/scripts/{extract-matrix-bd.mjs,build-matrix-bd-flow.mjs,route_guards.py}`, `building-blocks/test/matrix-bd.test.mjs` | ours, no licence file | Delete | They exist only to extract or test Matrix-bd material | MB-17 |
| 1.13 | `building-blocks/from-nocobase/concept-map.md` | ours, but it cites NocoBase paths | Delete | Describes NocoBase internals. Not needed once NocoBase is gone | LR-01 |
| 1.14 | `building-blocks/from-proposal/primitives-map.md` | **none found** (source: an untrusted third-party HTML artifact, sha256 `bcbc36a3…7a13`) | Delete | Its source has unknown authorship and terms | LC-02 |
| 1.15 | `building-blocks/from-design/seed-workspaces.json`, the v5 seeds, and every fixture naming **Blue Tokai / Starbucks / Burger King** (136 files; one hit remains in `templates/matrix-bd/bd.template.json`) | n/a (trademarks; Blue Tokai is a real customer's flow) | Delete, then use neutral examples (`acme-retail`) | Trademark and confidentiality exposure | LR-04 |
| 1.16 | `templates/matrix-bd/` (10 templates, `workspace.manifest.json`, `adapters.registry.json`, `build_templates.py`, tests) | ours, no licence file. Derived from `from-matrix-bd/matrix-bd-flow.json` | **Out of the product repo.** Move to a private customer repo. **Legal review** before it exists anywhere (§5) | Its own header says "CUSTOMER content … never in the product's templates/" (AUDIT §8.3) | LC-03 |
| 1.17 | `packages/adapters/examples/matrix_bd_bd/` + `packages/adapters/tests/test_bd_adapter.py` | ours, no licence file | Move to the customer repo with 1.16. **Legal review** | The docstring reproduces Matrix-bd behaviour and cites its source (`bd_service._apply_staggered_escalation`, `schemas/site.py`) | LC-04 |
| 1.18 | `docs/oss/OPERATON-SPIKE.md`, `docs/oss/spikes/`, the SpiffWorkflow venv | Apache-2.0 / LGPL-3.0 (nothing retained) | Delete (docs only) | Not part of the product | LR-16 |
| 1.19 | `app/frontend/{.env.production,vercel.json}`, `app/backend/{railway.json,.env.example}`, all `.env` / `*.secrets.json` | n/a | Delete. Never copy them | Matrix-bd deployment config and credentials | MB-16 |

## 2. Must replace

| # | Path | Licence (as found) | Action | Reason | Ref |
|---|---|---|---|---|---|
| 2.1 | **NocoBase 2.2.20**: `nocobase/`, the NocoBase services in `docker-compose.yml` / `app-stack/`, `web/lib/store.mjs`, the agent's NocoBase client | **NocoBase License Agreement**: bespoke, source-available, non-OSI. §5.4: no public low-code/no-code SaaS/PaaS. §5.2: keep its branding | Replace with first-party `packages/store` (Task 3, already on this branch). Delete every NocoBase file and image reference | A multi-tenant workspace builder falls in the §5.4 class. **Legal review** if it is kept even internally after launch | LR-01 |
| 2.2 | The configurator host `web/` (`server.mjs`, `lib/*`, `public/{boot,bridge-core,storage-bridge,sync-engine,main,host-bridge}.js`, `index.html`) and its copy in `app/frontend/public/configurator/` | ours, no licence file | Replace with a native React editor on the store API | It exists only to host the dc-runtime (1.6) | OW-07 |
| 2.3 | `building-blocks/from-design/{manifest.schema.json,workspace.schema.json,vocabularies.json,validation.mjs,tokens.*}` | ours (derived from the user's design), no licence file | Replace with `packages/manifest` | Superseded by the universal manifest | OW-08 |
| 2.4 | The Matrix-bd design system (1.3) | **none found** | Replace with new first-party tokens. IBM Plex may stay (§4) | Brand identity | MB-13 |
| 2.5 | Supabase-shaped auth (`supabaseAuth.js`, `00-supabase-shim.sql`) | **none found** (Matrix-bd) | First-party auth and tenant RLS, a spec-only rewrite (§6) | Matrix-bd design | AS-07, MB-15 |
| 2.6 | Brand seeds and fixtures (1.15) | n/a | Neutral examples (`packages/manifest/examples/acme-retail.manifest.json` already exists) | Trademark | LR-04 |
| 2.7 | The names "Matrix" / "z-matrix": `z-matrix-new-store`, `z-matrix-backend`, `matrix-configurator-web`, `@matrix-configurator/building-blocks`, `third_party/matrix-adapters` | n/a | Rename once the product name is decided. **Legal review** (trademark clearance) | Ties the product to Matrix-bd (warning rule `matrix-name`) | AUDIT §8.1 |
| 2.8 | The `postgres:16` floating tag | PostgreSQL Licence | Pin the image by digest | Provenance and reproducibility (licence is fine) | LR-15 |

## 3. Safe to keep

### 3a. First-party code (written on this branch, clean-room)

The authorship test is `git diff original-matrix-bd-3d4f277`. None of these has a licence file yet (see §7).

| Path | Licence (as found) | Action | Reason | Ref |
|---|---|---|---|---|
| `packages/manifest/` (schema, validator, `examples/acme-retail`) | none found (no `license` field) | Keep. Add the repo licence | First-party, clean-room. Dependency: `jsonschema` (MIT) | Task 2 |
| `packages/manifest/workspace_manifest/from_v5.py` | none found | Keep only if sandbox releases are migrated. Otherwise drop | It converts the user's own v5 format. It mentions `site` and the tier ladder, so run the checker on it | OW-08 |
| `packages/store/` | none found | Keep | First-party. Replaces NocoBase | Task 3 |
| `packages/adapters/` (excluding `examples/matrix_bd_bd`, 1.17) | none found | Keep | First-party adapter interface | Task 5 |
| `packages/access/` | none found | Keep | First-party permission guards | Task 6 |
| `docs/` (excluding `docs/oss/` spikes, and Matrix-bd extracts quoted inside reports) | none found | Keep after scrubbing Matrix-bd identifiers. Rewrite references to removed paths | First-party documentation | OW-10 |
| `third_party/matrix-adapters/` (gate/form compilers, runtime) | none found | Keep as a port into `packages/rules`, renamed | First-party glue. Strip the Matrix-bd keys from its fixtures | OW-11 |
| Our generic layer inside `app/` (`services/module_runtime/*`, `module_runtime_service`, `release_migration_service`, `module_views_service`, `platform_workspace_service`, the 4 new routers, migrations `20261004_1`–`20261006_1`, `modules/custom-module`, `modules/admin/workspaces`, `moduleRuntimeApi.js`, `useWorkspaceModules.js`) | none found | **Port**: copy our files and hunks only, then re-point `sites` to `cases` | Written by this project (about 4 400 lines of Python, 1 950 of SQL, 2 500 of JS), with about 120 lines coupled to Matrix-bd | OW-01…OW-05, AS-01 |
| `agent-configurator/` CLI/MCP shell | none found | Port without dc-runtime or NocoBase | Ours. The op set is based on ideas from LR-06 (§4) | OW-06 |
| `app-stack/` scripts | none found | Rewrite as `deploy/local` | Ours, but wired to NocoBase and the Supabase shim | OW-09 |

### 3b. Permissive dependencies (installed by package managers, not vendored)

The npm licences come from the lockfile `license` fields (`app/frontend/package-lock.json`, 444 packages).
The Python licences are **upstream PyPI metadata, not verified on disk**: confirm them with a licence scan (§7).
`app/package-lock.json` is empty (`"packages": {}`), and `web/package.json` has no dependencies.

| Dependency (manifest) | Version | Licence | Action | Reason |
|---|---|---|---|---|
| react, react-dom, react-router-dom, vite, @vitejs/plugin-react, axios, lottie-react (`app/frontend`) | 18.3.1 / 18.3.1 / 6.30.4 / 5.4.21 / 4.7.0 / 1.16.1 / 2.4.1 | MIT | Keep if the new web app uses them | Permissive |
| @rjsf/core, @rjsf/utils, @rjsf/validator-ajv8 (`app/frontend`, `third_party/rjsf-check`) | 6.11.0 | Apache-2.0 | Keep. Ship a NOTICE if the bundle is distributed | Permissive |
| Dev: eslint, eslint-plugin-{react,react-hooks,jsx-a11y}, vitest, jsdom, @testing-library/* | locked | MIT | Keep (dev only) | Permissive |
| Transitive npm, totals | 444 pkgs | 387 MIT · 22 Apache-2.0 · 12 ISC · 9 BSD-2 · 6 BSD-3 · 2 MIT-0 · 2 CC0-1.0 · 1 BlueOak-1.0.0 · 1 Python-2.0 (`argparse`, dev) | Keep | Permissive. The 3 exceptions are in §5 |
| @modelcontextprotocol/sdk + 93 transitive (`agent-configurator`) | 1.32.0 | MIT (84 MIT, 7 ISC, 2 BSD-3, 1 BSD-2) | Keep | Permissive (LR-12) |
| fastapi, starlette, uvicorn, pydantic(+core, settings), sqlalchemy, asyncpg, PyJWT, bcrypt, cryptography, python-multipart, httpx, httpcore, filetype, jsonschema(+specifications, referencing, rpds-py, attrs) (`app/backend` lock) | locked | MIT / BSD-3 / Apache-2.0 | Keep the ones the new server uses | Permissive (LR-13) |
| anyio, h11, httptools, uvloop, watchfiles, websockets, click, idna, dnspython, cffi, pycparser, greenlet, PyYAML, python-dotenv, annotated-types, annotated-doc, typing-inspection, setuptools, wheel | locked | MIT / BSD-3 / ISC / Apache-2.0 | Keep | Permissive |
| typing_extensions | 4.15.0 | PSF-2.0 | Keep | Permissive |
| email-validator | 2.3.0 | Unlicense | Keep | Public-domain dedication |
| `packages/manifest` → jsonschema | ≥4.18 | MIT | Keep | Permissive |
| Test-only: pytest, pytest-asyncio, aiosqlite | locked | MIT / Apache-2.0 / MIT | Keep | Permissive |
| postgres image | 16.15 | PostgreSQL Licence (image files MIT) | Keep, pinned by digest | Permissive (LR-15) |

## 4. Keep only with notices

| # | Path | Licence (as found) | Action | Reason | Ref |
|---|---|---|---|---|---|
| 4.1 | `third_party/json-logic-js/` (2.0.5, `c5c73601`) | MIT (LICENSE present) | Keep verbatim with its LICENSE and VERSION. List it in the regenerated THIRD_PARTY.md | Vendored source. MIT requires the notice | LR-07 |
| 4.2 | `third_party/panzi-json-logic/` (1.0.1) **and** its copy `app/backend/app/vendor/json_logic/` | MIT (LICENSE present in both) | Keep one copy (`packages/rules/vendor/`) with its LICENSE | Same | LR-07 |
| 4.3 | `third_party/json-logic-compat-tables/` (`dfc0601e`, test data) | Apache-2.0 (LICENSE present; no upstream NOTICE) | Keep in tests only, with its LICENSE | Apache-2.0 §4: keep the licence and mark changes | LR-08 |
| 4.4 | IBM Plex Sans/Mono woff2 (`web/public/vendor/fonts/`, @fontsource 5.3.0) + `ibm-plex.css` | SIL OFL 1.1 (two LICENSE files) + MIT (fontsource CSS) | Keep with the OFL texts. Do not rename or modify under "Plex". Do not sell the fonts on their own | OFL conditions | LR-09 |
| 4.5 | Apache-2.0 npm/PyPI deps in bundles (rjsf, asyncpg, bcrypt, cryptography, python-multipart) | Apache-2.0 | Ship the licence/NOTICE text in distributed bundles and images | Apache-2.0 §4 | LR-11, LR-13 |
| 4.6 | **Ideas** from `github.com/Adityashandilya555/operaton-plat` @ `fc654998` (agent op set, migrate-running, creator rule, saved views; THIRD_PARTY §H/§I) | **none found** (the repo has no licence file) | Keep as **ideas only** (no code was copied). Keep the attribution note and get a one-line written grant from the repo owner. **Legal review** whether a grant is enough for the chosen product licence | The repo owner (`Adityashandilya555`) is not the org (`0Advi`) | LR-06 |
| 4.7 | **Ideas** from Operaton (versioned deployments, instance migration, `${initiator}`, tasklist filters) | Apache-2.0 | Ideas only. Optional acknowledgement | No code or engine is used | ADOPTION-AUDIT §2 |

## 5. Unknown/legal review

### 5a. Copyleft, source-available and unknown-licence items (kept separate from the permissive list in §3b)

| # | Item / path | Licence (as found) | Class | Action | Reason |
|---|---|---|---|---|---|
| 5.1 | NocoBase 2.2.20 (`nocobase/`, image) | NocoBase License Agreement | **source-available**, non-OSI | Replace (2.1). **Legal review** of any interim use | §5.4 SaaS/PaaS ban, §5.2 branding |
| 5.2 | **Claude dc-runtime** `support.js` (4 copies, 2 builds) | **none found** | **unknown** | Remove (1.2, 1.6). **Legal review** only if any future reuse is proposed | Redistribution terms not stated |
| 5.3 | `*.dc.html` v1–v5, export zip, thumbnail | **none found** | unknown (the user's own output) | Remove from the product (1.7, 1.8). **Legal review** of ownership if they are ever published | Inferred, not stated, terms |
| 5.4 | **Matrix-bd app copy `app/`** + `building-blocks/from-matrix-bd` | **none found** (proprietary) | proprietary | Remove (1.1, 1.11). **Legal review**: confirm who owns Matrix-bd and what the team may reuse | Blocking for any release |
| 5.5 | `templates/matrix-bd/` + `packages/adapters/examples/matrix_bd_bd/` | none found (ours, **derived from Matrix-bd flows**) | derived work? | **Legal review**: is a data model derived by studying Matrix-bd's proprietary code and flows a derivative or a confidentiality issue? Until then, keep it outside the product repo | Built from extracted source data (1.16, 1.17) |
| 5.6 | `operaton-plat` repo (ideas source) | **none found** | unknown | Written grant + **legal review** (4.6) | No licence |
| 5.7 | `building-blocks/from-proposal` source artifact | **none found** | unknown | Remove (1.14) | Unknown author and terms |
| 5.8 | `app/frontend/src/assets/lottie/workspace-community.json` | **none found** | unknown | Remove with `app/` (1.4) | Typical sources (e.g. LottieFiles) have their own terms |
| 5.9 | psycopg / psycopg[binary] ≥3.1 (test extra of `packages/access`, `packages/store`) | LGPL-3.0 (upstream metadata; the binary wheel bundles libpq and OpenSSL) | **weak copyleft** | OK as an unmodified pip dependency in tests. **Legal review** before shipping it in a distributed image. Never vendor it | LGPL relinking/notice duties if distributed |
| 5.10 | SpiffWorkflow 3.2.0 (spike only) | LGPL-3.0 | weak copyleft | Nothing retained. Never copy it | LR-16 |
| 5.11 | certifi 2026.5.20 (`app/backend` lock) | MPL-2.0 (upstream metadata) | weak copyleft, file-level | OK unmodified. Keep the licence notice. Modified files must stay MPL | MPL-2.0 |
| 5.12 | axe-core 4.12.1 (dev, via eslint-plugin-jsx-a11y) | MPL-2.0 (lockfile) | weak copyleft | Dev only, not shipped. OK | LR-14 |
| 5.13 | caniuse-lite 1.0.30001793 (build-time, via browserslist) | CC-BY-4.0 (lockfile) | attribution licence | Build data only, not in output bundles. Attribute if it is ever shipped | LR-14 |
| 5.14 | **First-party code with no licence**: the repo root and `packages/*`, `templates/`, `web/`, `building-blocks/`, `agent-configurator/`, `docs/` | **none found** | unlicensed (ours) | Owner decides the product licence (AUDIT §8.2). **Legal review** of the choice and of contributor/IP assignment | Without a licence, the rights are unclear for users and contributors |

### 5b. Questions for legal review (no advice given here)
1. Ownership and permitted reuse of Matrix-bd material, including knowledge gained from studying it (5.4, 5.5).
2. Whether NocoBase may be used at all, even internally, after the product launches (5.1).
3. Whether the user's Claude Design outputs and the dc-runtime may be redistributed (5.2, 5.3). The plan removes them anyway.
4. The form of the grant for `operaton-plat` ideas (5.6).
5. Trademark clearance for the product name (2.7) and removal of third-party marks (1.15).
6. LGPL/MPL obligations if container images ship psycopg or certifi (5.9, 5.11).

## 6. Clean-room rewrite requirements

### 6a. What may be adapted as ideas only, and what is reusable as code

| Category | Sources | May be used | May NOT be used |
|---|---|---|---|
| **Ideas only** (no code, text, schemas, SQL, assets or test data copied) | Matrix-bd (`app/`, `from-matrix-bd`), NocoBase, the dc-runtime and `.dc.html` designs, `operaton-plat`, Operaton, SpiffWorkflow, the proposal artifact | Concepts, behaviour described in a written spec written by us, public API *shapes*, general workflow patterns | Any file, excerpt, DDL, identifier set, UI markup, copy text, brand token, image or fixture, and line-by-line translation into another language |
| **Reusable as code** | Code this project wrote (diff vs `original-matrix-bd-3d4f277`): `packages/*`, the generic layer in `app/` (only our hunks), `third_party/matrix-adapters`, `agent-configurator` shell, `docs/` | Copy and port, then strip every Matrix-bd identifier | Our hunks inside Matrix-bd files must be lifted out alone, never with the surrounding Matrix-bd code |
| **Reusable as code, with notice** | json-logic-js, panzi-json-logic, compat-tables, IBM Plex, npm/PyPI permissive deps | Verbatim, with their licence files (§4) | Modification without marking changes (Apache-2.0), or renaming the Plex fonts (OFL) |

### 6b. Rules for each rewrite

| Area | Basis | Rule | Ref |
|---|---|---|---|
| Identity (tenants, users, invites, auth, setup codes, password reset, audit log, outbox) | Matrix-bd | **Spec-only rewrite**: one person writes the behaviour spec, someone who has not worked on Matrix-bd auth code implements it, and the schema is new (no Matrix-bd DDL) | MB-07, MB-08, MB-09, MB-15, AUDIT §8.4 |
| Business-admin, team and landing UI | Matrix-bd | Spec-only rewrite. No markup, copy or assets reused | MB-12 |
| Case model (`sites` → `cases`), roles, outcomes, tiers, locale, onboarding, URL space | Matrix-bd assumptions in our code | Rewrite generically from the manifest | AS-01…AS-10 |
| Configurator UI | the dc-runtime design | Build a native React editor from screenshots and the written spec. Do not port the `class Component` | LR-02, LR-03 |
| Draft store | NocoBase | Already first-party (`packages/store`). Use no NocoBase schema names (`cfg_*`) or ACL scripts | LR-01 |
| Matrix-bd as a customer | `templates/matrix-bd` | Lives only in a private customer repo, after legal review (5.5) | AUDIT §8.3 |
| Evidence | all of the above | Keep the specs, the reviewer's sign-off and a `check-independence.mjs` run (all blocker rules = 0) as clean-room records | AUDIT §3 |

## 7. Final independent-repo checklist

- [ ] Owner decisions recorded in `docs/DECISIONS.md`: product name, product licence, operaton-plat grant (AUDIT §8).
- [ ] **Legal review** completed for every item in §5b. Outcomes recorded.
- [ ] Create the new repo from the target layout only. **No git history** from this sandbox.
- [ ] Copy over nothing from §1. Specifically absent: `app/` (Matrix-bd), all `support.js`, all `*.dc.html`, `sources/`, `web/public/vendor/{react*,@babel}`, `nocobase/`, `building-blocks/{from-matrix-bd,from-nocobase,from-proposal,lib/load-dc.mjs}`, `templates/matrix-bd/`, `packages/adapters/examples/matrix_bd_bd/`.
- [ ] Every §2 replacement is in place. No NocoBase image or service in compose. No Supabase shim.
- [ ] The root `LICENSE` is added, and a `license` field is set in every `package.json` and `pyproject.toml`.
- [ ] `THIRD_PARTY.md` is regenerated from scratch: only the §4 items plus a dependency table. No §B, E, G or H rows for removed items.
- [ ] Vendored files keep their LICENSE and VERSION files and stay byte-identical (re-hash them).
- [ ] Automated licence scan in CI (npm + pip): fails on unknown, GPL or AGPL, and on source-available licences. Flags MPL, LGPL and CC-BY for review.
- [ ] `node docs/independence/check-independence.mjs --json` on the new tree: **every blocker rule = 0 files** (matrix-bd-*, brands, nocobase, dc-runtime).
- [ ] Grep for `3d4f277`, `Matrix-bd`, `z-matrix`, `ZM_`, `Blue Tokai`, `Starbucks`, `Burger King`, `nocobase`, `dc-runtime`, `support.js`: no hits outside THIRD_PARTY.md and decision records.
- [ ] No secrets: no `.env*`, `*.secrets.json`, `railway.json` or `vercel.json` from the sandbox.
- [ ] Docker images are pinned by digest (postgres).
- [ ] Clean-room evidence (specs, reviewer sign-off, checker output) is archived with the first release.

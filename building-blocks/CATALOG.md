# Building-blocks catalog (Workstream C)

Reusable, provenance-tracked blocks for the Workspace Configurator. There are no runtime dependencies (Node ≥ 20);
`npm test` → `node --test`.

**Sources and pins**

| Tag | Source | Pin |
|---|---|---|
| **[v5]** | `sources/design-artifact/Workspace Configurator v5.dc.html` (shipped design) | sha256 `b30033e932d4702924b3ad1b831aacf48eda0bcb7e262750d82f37ba52f55bda` |
| **[v1–v4]** | earlier `.dc.html` versions | sha256 `e12cf456…`, `d6dc28b5…`, `0e01bcb1…`, `5c9867a2…` (full hashes in `from-design/VERSION-EVOLUTION.md`) |
| **[mbd]** | Matrix-bd, read-only via `git show origin/main:<path>` | `3d4f277beb22c5be02c2abacea61b6afaee7cdeb` (2026-09-17, "Merge pull request #503") |
| **[nb]** | `github.com/nocobase/nocobase` via `gh api` (read-only) | tag `v2.2.20` = `68b8d4a3b6e8cbfb4e17bd44d5acf0dd3ce01202` |
| **[prop]** | "Matrix Platform Refoundation" HTML artifact (untrusted, data only) | sha256 `bcbc36a37d0297229514869ad9ec3c3e84296627a9724bcd0a5a2366290e7a13` |

**Status legend:**
* **verified**: evaluated from the original or parsed from source, and checked by a test.
* **verified (read)**: transcribed from source with citations; not machine-checked end to end.
* **inferred**: interpretation or design that goes beyond the source.

`Matrix-bd-current` and `Matrix-bd-scale-preview` are **orphaned worktree snapshots**. Their `.git` files point at
`Matrix-bd/.git/worktrees/<name>`, which no longer exists. Blob matching places them around 2026-07-10…13 and
2026-06-02 respectively, both older than `origin/main`, so they add nothing and were used only to establish that.

---

## from-design/ — the shipped v5 design, evaluated

| Block | What it is | Provenance | Reuse | Status |
|---|---|---|---|---|
| `seed-workspaces.json` | The three v5 seed workspaces (`bluetokai` live v7 / draft v8; `starbucks`, `burgerking` draft v1 via replay). Each carries its **document** (`stashOf` = per-workspace state), manifest, findings, diff vs live, flow order and replay steps. Also includes a real `localStorage['wsconfig_v5_custom']` blob from `createWorkspace()` + `addBuiltin()`, the 4 wizard-template manifests, legacy `thirdwave` / `chaayos` picker entries (v2/v3 only: **no tenant data exists**) and the unknown-tenant fall-through quirk. | [v5] evaluated by `scripts/extract-design.mjs` through `lib/load-dc.mjs` | Fixtures and seed data for the web runtime / NocoBase provisioning | verified |
| `vocabularies.json` | Outcomes, icons, field kinds (+ validation hints), reserved module keys and pattern, reserved workspace slugs and pattern, start modes, bands, planned capabilities G1–G4, wizard steps, roll-up strategies, badge sources, roles and colours, tiers, module kinds/states, finding/diff tags, permission ceiling + `usedBy`, built-in and custom module defaults, the built-in module catalogue, tenant metadata | [v5] evaluated (a few static lists transcribed; the source method is named in each key) | Single import for UI pickers and validation | verified |
| `manifest.schema.json` | JSON Schema (2020-12) of `manifest()`, the workspace draft manifest and the payload for `cfg_releases.manifest`. `$defs.moduleDraftManifest` = `wizManifest()` | [v5] derived; tested against every seed, the wizard templates, live/draft mode and post-`wizSave` | Validate releases before append | verified |
| `workspace.schema.json` | JSON Schema of the per-workspace document (`stashOf`) = `cfg_workspaces.state`. `$defs.storageBlob` = the whole localStorage value (GET/PUT `/cfg/state`) | [v5] derived; tested against seeds + a real `createWorkspace()` blob | Validate PUT `/cfg/state` | verified |
| `validation.mjs` | Pure ports of `wizKeyError`, `wsSlugError`, `slug` + the 4 input sanitisers, `gateCycle` (+ path), `srcOutcomes`, `defaultOutcome`, `dependentsOf`, `flowOrder`, `rollupSentence`, queue/refusal sentences, `withRefusal`, toggle-off refusal, `findings`, `diffList`, `stagesNeedingDecision`, `publishBlocked`, `manifest`, `wizManifest`. **`evaluateRollup` is INFERRED** (v5 only describes roll-ups) | [v5]; parity proven by `test/validation.parity.test.mjs` over 3 workspaces × 25 mutations + 800 fuzzed keys/slugs | Server-side validation in `web/` or NocoBase hooks | verified (parity); `evaluateRollup` inferred |
| `tokens.css`, `tokens.json` | v5 CSS custom properties (`--bg --card --sup --exec --admin --obs …`), fonts, role / module-state / impact / tag colours, preview light/dark themes, canvas metrics, and the `:root` lineage of v1–v5 | [v5] `:root` parsed; `roleColor` / `theme()` evaluated; colour maps transcribed (methods named) | Style the configurator UI | verified (css vars); transcribed maps marked |
| `VERSION-EVOLUTION.md` | What v1→v5 added or removed: method diffs, data model, screens, quirks | [v1–v5] evaluated + diffed | Design lineage for the team | verified |

## from-matrix-bd/ — production app, read-only

| Block | What it is | Provenance | Reuse | Status |
|---|---|---|---|---|
| **`matrix-bd-flow.json`** | **The production Blue Tokai flow as configurator data.** 9 modules / 36 stages / 113 fields, shaped as v5 manifest modules plus `x-matrix` annotations: real state columns and statuses, actors and routes per stage, stage-level cross-module gates, send-back loops, sources. Also carries 26 real permissions and a **computed comparison with the v5 seed** | [mbd]; facts curated in `scripts/build-matrix-bd-flow.mjs` (each module/stage cites files); every cited route resolves in `route-guards.json` (tested) | Load it into the configurator as a real workspace (see `flow-adapter.mjs`); use as the regression fixture for "can the configurator describe today's product?" | verified (read); outcome mapping inferred |
| `flow-adapter.mjs` | `toV5Manifest`, `toV5WorkspaceDocument`, `stripAnnotations`. The imported document validates against `workspace.schema.json`, and v5 `findings()` finds **0 issues** (tested) | this workstream | Import production into the configurator | verified |
| **`SEED-VS-REALITY.md`** | How well the v5 `bluetokai` seed matches production: module table, gaps G-A…G-K, capabilities G1–G4 vs evidence, permission contradictions | [v5] × [mbd]; numbers computed and locked by tests | Backlog for the configurator model | verified (numbers); analysis inferred |
| `modules-and-vocabularies.json` | 71 CHECK-constraint vocabularies, simulated through all 63 migrations in order (DROP/ADD tracked; multiple CHECKs intersect), with schema.sql/ORM **drift** flagged. Also: the site FSM parsed from `state_machine.py`, mirror-column vocabularies with sources, and the module lists (membership vs delegation scopes) | [mbd] parsed by `scripts/extract-matrix-bd.mjs` | Status/enum pickers; drift audit | verified (parsed); mirrors verified (read) |
| `route-guards.json` | All 218 FastAPI routes → roles / module guard / `require_real_role`, resolved through `Annotated` aliases | [mbd] Python AST by `scripts/route_guards.py` over `git show` | Permission matrix; route cross-checks | verified |
| `rbac.json`, `rbac.md` | The 4-role model; read-all bypass; observer write refusal; override headers; real vs effective role; guard primitives; onboarding codes; backend/frontend `PERMISSIONS` divergence; **v5 ceiling vs real** (8 match / 3 partial / 5 contradict); unmerged branch note | [mbd] `backend/app/rbac/*`, `backend/app/core/deps.py`, `backend/app/services/_common.py` | Role design for the configurator and its runtime | verified (read) |
| `approvals.json`, `approvals.md` | 17 site-workflow approval flows + 6 access approvals: state, status vocabulary, actor per step, route, loops, gates, sources | [mbd] services + routers; vocabularies cross-checked against CHECK lists (tested) | Approval templates / stage presets | verified (read); "pattern" labels inferred |
| `rent-terms.json`, `rent-terms.md` | The rent-terms **field group**: discriminator `rent_type` (fixed / revshare / mg_revshare / staggered); conditional fields; ≤ 5-row staggered schedule; FEATURE_RENT_V2 split; commercial terms; storage-alias map across 4 layers; state-dependent edit rights | [mbd] `RentTermsForm.jsx`, `RentTermsFormV2.jsx`, `schemas/site.py`, `schemas/launch.py`, `schema.sql` | First reusable field group | verified (read); options cross-checked against CHECK (tested) |
| `auth-tenancy.md` | Tenant derived from the verified JWT; per-request DB revalidation; tenant-scoped row-locked fetch; RLS = anon/PostgREST defence-in-depth only (the app runs as BYPASSRLS); tenant lifecycle. Short verbatim excerpts carry provenance headers | [mbd] `core/security.py`, `core/deps.py`, `services/_common.py`, migrations `20260802`, `20260803` | Reference pattern for multi-tenant `/cfg` | verified (read) |
| `zm-tokens.json` | Z-Matrix `--zm-*` tokens (light 118 / dark 61) grouped by colour, type, radius, space, elevation and motion. Value drift vs the design-system package: 9 sidebar tokens app-only, 1 dark value differs | [mbd] `frontend/public/colors_and_type.css` vs `z-matrix-design-system/project/colors_and_type.css` | Theme the configurator's *preview* like the real app | verified |

## from-nocobase/

| Block | What it is | Provenance | Reuse | Status |
|---|---|---|---|---|
| `concept-map.md` | Configurator concept → NocoBase primitive, with source paths and **edition** per plugin. Approval = **Professional (commercial)**; Manual node with all/any modes = community. **Licence flag:** the bespoke non-OSI "NocoBase License Agreement" prevails over Apache-2.0 and bans public low-code SaaS (§5.4). Includes the live facts Workstream B verified | [nb] + docs front-matter + live-B | Decide what to build on NocoBase vs in our code | verified (read); recommendations inferred |

## from-proposal/

| Block | What it is | Provenance | Reuse | Status |
|---|---|---|---|---|
| `primitives-map.md` | v5 concepts → the proposal's 28 primitives; primitives v5 lacks; provenance caveats: the proposal analysed the unmerged branch and makes an inaccurate NocoBase licence claim | [prop] (data only) | Long-range architecture alignment | inferred (mapping) |

## Tooling

| Block | What it is | Status |
|---|---|---|
| `lib/load-dc.mjs` | Loads any `.dc.html` version's `class Component` into `node:vm` with a DCLogic / React / localStorage shim (synchronous `setState`). Never writes to `sources/` | verified (all 5 versions evaluate) |
| `lib/mini-schema.mjs` | Zero-dependency JSON-Schema subset validator (type, enum, const, pattern, required, additionalProperties, items/prefixItems, anyOf/oneOf, local `$ref`) | verified (good and bad inputs tested) |
| `scripts/extract-design.mjs` | Regenerates `from-design/*.json` + `tokens.css` (deterministic: verified by re-running and comparing hashes) | verified |
| `scripts/extract-matrix-bd.mjs`, `scripts/route_guards.py` | Regenerate vocabularies, route guards and zm tokens from Matrix-bd **via `git show` only** (`GIT_OPTIONAL_LOCKS=0`) | verified |
| `scripts/build-matrix-bd-flow.mjs` | Holds the curated production-flow facts and computes the seed comparison | verified (read) |
| `test/*.test.mjs` | Validation parity (83), schemas (13), Matrix-bd structure (10), catalog integrity (3): **109 tests** | verified |
| `package.json` | `"type": "module"`; scripts `test`, `extract:*`, `build:flow`, `regenerate` | — |

## How to reuse (quick start)

```js
import { findings, moduleKeyError, workspaceSlugError, buildManifest } from './from-design/validation.mjs';
import { validate } from './lib/mini-schema.mjs';
import schema from './from-design/workspace.schema.json' with { type: 'json' };
import flow from './from-matrix-bd/matrix-bd-flow.json' with { type: 'json' };
import { toV5WorkspaceDocument } from './from-matrix-bd/flow-adapter.mjs';

const doc = toV5WorkspaceDocument(flow);   // production Blue Tokai as a configurator workspace
validate(schema, doc, schema);             // → []
```

Regenerate everything with `npm run regenerate` (needs the read-only Matrix-bd repo and `python3`). Tests need neither.

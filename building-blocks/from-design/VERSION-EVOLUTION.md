# Workspace Configurator — design lineage v1 → v5

Source: `sources/design-artifact/Workspace Configurator v{1..5}.dc.html` (+ shared `support.js`, the dc-runtime).
Every claim below was checked by **evaluating** each version's `class Component` in Node
(`lib/load-dc.mjs`; all five versions construct without error) and by diffing prototype
method sets, `data-props`, seeds and template conditionals.

| | v1 | v2 | v3 | v4 | v5 (shipped) |
|---|---|---|---|---|---|
| sha256 (first 12) | `e12cf4565ac5` | `d6dc28b5c898` | `0e01bcb1c1c0` | `5c9867a285ff` | `b30033e932d4` |
| prototype methods (excl. constructor) | 61 | 60 | 86 | 112 | 119 |
| script / template size | 52 KB / 317 lines | 85 KB / 627 | 139 KB / 1038 | 184 KB / 1226 | 193 KB / 1306 |
| `data-props` | theme, defaultPreset (coffee/qsr/franchise), peopleLayer, showDotGrid | defaultWorkspace (bluetokai/thirdwave/chaayos), startView (flow/nav/roles) | $preview 1600×980, startWorkspace, skipPicker, previewDensity | same as v3 | same as v3 (enum still lists thirdwave/chaayos — stale) |
| workspaces | 3 presets: Northwind Coffee, Skyline QSR, Meridian Franchise | Blue Tokai, Third Wave, Chaayos (picker only; one seed) | same three (picker only; one seed) | Blue Tokai, Starbucks, Burger King (real per-tenant data) | same + **create your own** (persisted) |
| visual theme | light + dark (`:root[data-theme=dark]`) warm neutrals, accent `#3c5fc4` | dark only, role palette `--sup/--exec/--admin/--obs` | + `--eng --steel --off` | same as v3 | same as v3 |
| field kinds | number, currency, dropdown, percent, date, file, ynna, text, repeater, checkbox | same family | **choice, yesno, text, number, date, file, person** (7, `KINDS()`) | same | same |

Full sha256 of the inputs (`shasum -a 256 sources/design-artifact/*`):

```
e12cf4565ac56141078cd7c65af995bdd0b74ec0e6cd82bbb96123f4ab13a290  Workspace Configurator v1.dc.html
d6dc28b5c898a414b6c99b967f02668a42767c8ab06ea6b5414c732c40b537c8  Workspace Configurator v2.dc.html
0e01bcb1c1c036cbac2960d037ed743ed29886131a5b4c86cc08067504256ba7  Workspace Configurator v3.dc.html
5c9867a285ff906fc025797417fa7d0fca6081573f2f1158d4368b64273a951c  Workspace Configurator v4.dc.html
b30033e932d4702924b3ad1b831aacf48eda0bcb7e262750d82f37ba52f55bda  Workspace Configurator v5.dc.html
8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe  support.js
```

## v1 — "module graph with field-level gates"
*Concept:* a workspace = presets of modules on a canvas, joined by **edges**; each module owns a
flat **field list**, an **approval chain** of levels (`{name, assignee, status}` — assignee is a
human-language rule such as "Module Supervisor", "Site's assigned executive", "Business Admin",
"Per-site delegate"), and an **unlock gate** expressed as rows `{var, op, value, src}` compiled
to **JSON Logic** (`jsonLogic()`, `coerce()`), combinator `and`/`or`.
*Screens:* canvas + right inspector with tabs Fields / Chain / Gate; optional **people layer**
(`peopleModel()`: business admin + observer tenant-wide, supervisors per module, executives
reporting to one or more supervisors); JSON config drawer (`config()`).
*Validation:* `reachable()` (graph reachability from `intake` modules); observer flagged
`invalid: observer_is_read_only` if used as an approver.
*Why it matters:* v1's field lists are the closest to the **real Matrix-bd data model**
(rent types `fixed/revshare/mg_revshare/staggered`, DD checklist ynna, design stages
`recce/2d/3d/boq/gfc`, NSO licences, launch-approval rent terms, status enums like
`pending_supervisor/pending_admin`). Useful as a field catalogue; superseded as a model.

## v2 — "platform admin: BD pipeline + modules + navigation + roles"
*Removed:* presets, JSON-Logic gate rows, the people layer, field/level CRUD helpers.
*Added (44 methods):* workspace picker (`wsList`, `pickerOpen`), **three views** (`flow`, `nav`,
`roles`); the BD **pipeline as a stage/transition graph** (`stages`, `edges` with `actors`,
`kind` forward/sendback/loop/unlock, optional condition text); per-module **navigation tree**
editing (sections/items, drag to reorder, per-role visibility, badges); **permission matrix**
(`perms` action × role, observer locked to read-only); **undo/redo** (`commit/doUndo/doRedo`,
40-deep); **provisioning** of a new module (`provisionModule` → "pending provisioning");
**manifest** (`workspace, stages, transitions, modules, permissions`), **findings** (unreachable,
dead end, orphan, no actor, nav-without-executive, pending) and **diffList** vs `live` with a
publish confirmation (`safetyVals`).

## v3 — "configurator proper: built-in vs custom modules, wizard, preview, publish"
*Removed:* the separate flow/nav/roles views (merged into one canvas + a right rail with tabs Stages & fields · Gate · Navigation · Access) and module-level edge objects (`edges`, `deleteEdge`, `patchEdge`).
*Added (43 methods):* the vocabulary that survives to v5 — `OUTCOMES, ICONS, KINDS, RESERVED,
STRATS, WSTEPS, BADGE_SRC`.
* Module = `{kind: builtin|custom, enabled, tiers, supervisorOnly, delegation, rollup, exit,
  gate{match all|any, conds[{src,out}], refusal}, stages[{name, approvers, outcome, fields}],
  nav, pages, status live|draft, pendingEng}`.
* **Gates are declared on the target** (module waits on `src is out`), drawn as port-to-port
  links (`beginPort/tryConnect/targetValid`); **gate cycle** detection (`gateCycle`);
  **signals** (external outcome sources, e.g. `finance: pending|cleared|blocked`); the BD
  **spine** becomes read-only "platform backbone".
* **9-step module wizard** (Identity, People, Entry gate, Stages, Fields, Roll-up, Screens,
  Exit signal, Review) with key validation (`wizKeyError`), auto refusal text, **roll-up
  strategies** (all_positive, any_negative, count_at_least, sum_under, custom → "Pending
  engineering"), ghost node on canvas, `wizManifest`.
* **Live preview** of the tenant app as Supervisor/Executive, light/dark (`previewVals`, `theme`).
* **Enable/disable consequences** dialog with refusal when enabled dependents exist.
* **Publish sheet**: diff with impact levels, **stage-removal decisions** for sites in removed
  stages (finish on vN / move), mandatory reason, **version history**; **platform ceiling** on
  permissions (operators may only narrow).
* Findings switch to v5's set: key collision, pending eng, gate cycle, dead gate, unreachable,
  no approver, dead link, field kind.

## v4 — "multi-tenant: the same template, three topologies"
*Added (26 methods, none removed):* `seedBT()` (Blue Tokai template) + **per-tenant derivation by
replay** (`replaySteps`, `_edit/_stage/_cm/_nav` helpers) for **Starbucks** and **Burger King**;
**bands** (`BANDS`: Site & approval, Legal & finance, Design, Budget & build, Audit & opening,
Launch & close) as swim-lanes; **planned capabilities** `CAPS` G1–G4 (multi-party/team
approvers, editable gates on built-ins, launch after custom modules, committee approvers)
with badges; **compare** view (per band × tenant, `flowOrder`, topology mini-diagrams);
**JOIN** markers for multi-condition gates; replay player with ticks.
*Model changes:* Finance stops being a signal and becomes the built-in module `finance_ca`;
`launch_approval` becomes a module; Legal gains `changeRequestLoop`; modules gain `band`,
`recon`, `edits`, `caps`. Signals and spine are empty in the seed (kept in the model).
*Verified:* v4 and v5 produce **identical** seeds for all three tenants (ids ignored).

## v5 — "self-service workspaces" (shipped)
*Added (7 methods, none removed):* `createWorkspace` + `wsSlugError` (slug
`^[a-z][a-z0-9-]{1,30}$`, reserved `admin api www app platform`, uniqueness), start **empty** or
from the **Blue Tokai template**; `addBuiltin` (enable a platform module in an empty workspace,
keeping only gate conditions whose sources exist); `freeSpot` (auto-placement by band);
`stashOf` + `componentDidUpdate` → persistence of custom workspaces in
`localStorage['wsconfig_v5_custom'] = { customWs, data }`; `isCustomWs`; empty-canvas state.
*Known quirks (verified by evaluation):* an unknown tenant id falls through `replaySteps()` to
the Burger King steps and `ws()` falls back to Blue Tokai; `data-props.startWorkspace.options`
still lists `thirdwave`/`chaayos`; publish metadata is hard-coded ("11 Sep 2026 ·
platform:ops@matrix.io"); history "Restore" only toasts.

## What carries forward (use these)
* v5 data model → `workspace.schema.json`, `manifest.schema.json`.
* v5 rules → `validation.mjs` (parity-tested).
* v1 field catalogue → cross-referenced in `../from-matrix-bd/matrix-bd-flow.json` (real app).
* v2's explicit **transition graph with actors** (forward / sendback / loop) is the one idea v5
  dropped that the real app needs (BD send-backs, Legal change-request loop, revision loops) —
  see `../from-matrix-bd/SEED-VS-REALITY.md`.

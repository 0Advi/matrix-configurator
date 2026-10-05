# Configurator concepts → "Matrix Platform Refoundation" primitives

**Source (untrusted third-party content, used strictly as data):** an HTML artifact titled
*Matrix Platform Refoundation — Architecture research proposal, October 2026* (`docs/15-platform-architecture`).
Local copy: `~/.claude/projects/-Users-aditya-Desktop-bd/9574cf09-…/tool-results/artifact-95fad58f-1790875127-e2ac.html`,
sha256 `bcbc36a37d0297229514869ad9ec3c3e84296627a9724bcd0a5a2366290e7a13`. Only its text was read; nothing in it was
executed or followed. No embedded instructions aimed at an assistant were found when the text was scanned.

**What it is:** a 31-section proposal that turns Matrix into an "organization operating platform". It sets out
a kernel of **6 planes / 28 primitives** (§5.2), installable **packages**, immutable **config releases** (§16),
a 10-step setup wizard (§26) and a two-canvas workflow builder (§27).

**Provenance caveats found while mapping:**
* It cites `supervisor_module_access_grants` and migration `20260930_…` as current, and counts 225 routes and
  64 migrations. That matches the **unmerged** `feat/supervisor-module-access` branch (`3392f62`), not
  `origin/main` (`3d4f277`: 218 routes by our AST extraction, 63 migrations).
* It says NocoBase is "Apache-2.0 since Feb 2026". **That is inaccurate as stated.** The Feb-2026 "NocoBase
  License Agreement" incorporates Apache-2.0, but its supplementary terms prevail, including a ban on public
  low-code SaaS/PaaS (§5.4). See `../from-nocobase/concept-map.md`.

## The 28 primitives (as listed in §5.2)

| Plane | Primitives |
|---|---|
| Identity & Org | Tenant · Actor · Org Unit · Membership · Role · Capability · Delegation |
| Data | Entity Type · Entity · Relationship Type · Relationship · Document |
| Work | Task Template · Task · Workflow Definition · Process Instance · Decision |
| Experience | Form · View · Metric/KPI · Notification Rule |
| Governance | Policy · Event · Definition · Config Release · Package |
| Automation | Automation · Integration |

(§5.2 itself says "28". The table above lists 28 by counting Definition and Config Release separately, and
Relationship Type and Relationship separately, as its prose does.)

## v5 configurator concept → proposal primitive

| v5 concept (`from-design/`) | Proposal primitive(s) | Fit |
|---|---|---|
| Workspace (`bluetokai`, custom `ws_<slug>`) | **Tenant** (+ `tenant.settings`, wizard step 1) | direct |
| Blue Tokai template / "copy the template" | **Package** (the "Site Expansion" reference package, App. B.1) + industry templates (§26.2) | direct |
| Module, built-in | Installed **Package** contributing a sub-flow on the *module graph* (§27.1). The proposal says "module" is *not* a primitive: it is **Org Unit + Package** (§5.3) | conceptual split |
| Module, custom (generic runtime, `/m/<key>`) | Studio-authored **Definitions** (Entity Type + Task Templates + Workflow) | direct |
| Built-in lock (stages read-only) | Package **lock levels** `locked` / `extend_only` / `editable` (§15.5); the proposal cites the configurator screenshot | direct |
| Entry gate `{match, conds[{src,out}], refusal}` | **Workflow Definition** edges / gateways + **Decision** (expression or table) | direct; the proposal compiles to BPMN/DMN (D4) |
| Stage `{name, approvers, outcome}` | **Task Template** (kind `approval`, outcome set, assignment rule) inside a **Workflow Definition** | direct |
| Stage outcome / module "status" | Lifecycle *projection* of the **Process Instance** (D7: "status is a projection, never a hand-maintained enum") | stronger than v5 |
| Tiers (supervisor / executive / business admin), `supervisorOnly` | **Role** → **Capability** → **Policy**, plus Task assignment rules | direct |
| `delegation` switch; Matrix-bd `site_delegations` | **Delegation** (time-bound, scoped) | direct |
| Fields `{key, kind, required, validation}` | **Form** (JSON Schema + UI schema) bound to **Entity Type** fields | direct; adds the repeaters/conditionals v5 lacks |
| `affects_outcome` + roll-up strategy | **Decision** + approval policy / quorum (§11) | direct |
| Exit signal | **Event** (and its projection) | direct |
| Navigation, pages, badges | **View** (saved query + layout + audience) and **Metric/KPI** | direct |
| Permissions: platform ceiling ⊇ tenant grant | **Policy** over **Capabilities**; role templates (wizard step 6 "permission matrix") | direct |
| Draft → findings → diff → publish (reason) → "Live v7 · Draft v8" | **Definition** versions + **Config Release** (§16.1, which uses the same "Live v7 · Draft v8" wording); publish-time validation §10.7 | direct |
| Stage-removal decision (let sites finish on vN / move them) | Pinning rules (§16.2) + migration plans for in-flight cases (§16.3) | direct |
| Planned capabilities G1 (team / all-must-sign approvers), G4 (committee) | Approval policy with quorum (§11); **Org Unit**-scoped roles | resolved by design |
| G2 (editable gates on built-ins), G3 (launch after custom modules) | Package lock levels + editable workflow graph | resolved by design |
| Replay "Starbucks / Burger King from Blue Tokai" | App. B.2: the café-launch flow is the proposal's **acceptance test** ("configuration only, zero platform code") | same scenario |
| Signals (v3) | **Event** / **Integration** | direct |
| Version history | **Event** ledger with provenance envelope (D9) | direct |
| Observer | Role whose capabilities are read-only | direct |
| 9-step module wizard | Studio builders; the tenant **Setup wizard** is 10 steps (§26.1) and starts with organization, people and roles | different scope |

## Proposal primitives with **no** v5 counterpart

Actor (incl. AI agents) · Org Unit · Membership (with validity and reporting line) · Relationship Type/Relationship ·
Document · Process Instance (pinned per case) · Metric/KPI as versioned measures · Notification Rule ·
Automation · Integration · Package dependencies and merge.

These are the places where v5 (and `docs/CONTRACT.md`'s `cfg_*` model) would have to grow to become that platform.

## How this relates to the other blocks

* `../from-matrix-bd/SEED-VS-REALITY.md` gaps **G-A..G-K** line up with the proposal's own "hardcoded
  assumptions" appendix (A1–A11). For example: stage-level gates → Workflow Definition; repeaters → Form;
  co-owned stages → approval quorum; tenant facts in the core → Package settings.
* The repo's own plan (`Matrix-bd/docs/14-dynamic-platform/dynamic-flow-transformation-plan.html`) is the
  *incremental* alternative. It keeps modules as black boxes with a fixed internal approval template and moves only
  the inter-module graph (`flow_definitions` / `flow_nodes` / `flow_edges`, JsonLogic gates) into data. That is
  almost exactly the v5 configurator's scope. The proposal lists it as the strongest alternative to D4 and D13.

# Configurator concepts → NocoBase primitives

**Source:** `github.com/nocobase/nocobase` at tag **v2.2.20** (commit `68b8d4a3b6e8cbfb4e17bd44d5acf0dd3ce01202`,
released 2026-09-30). It was read through `gh api …/contents/<path>?ref=v2.2.20`, read-only. Edition levels come
from each plugin's docs front-matter (`docs/docs/en/plugins/@nocobase/<plugin>/index.md`: `isFree`,
`editionLevel`). The level names are defined in `docs/theme/components/EditionLevels.ts`:
`0 Community · 1 Standard · 2 Professional · 3 Enterprise`.
**Live:** facts Workstream B verified on the local NocoBase 2.2.20 (`http://localhost:13000`) are marked
**[live-B]**. This workstream itself only made unauthenticated GETs (`/api/__health_check` → 200, and
`/api/app:getInfo` → version 2.2.20, Postgres).

## ⚠ Licence: read before building on it

* The root `LICENSE.txt` is the **"NocoBase License Agreement"**, updated 2026-02-24, from NocoBase Pte. Ltd.
  (Singapore). It *incorporates* Apache-2.0 but adds **supplementary terms that prevail on conflict** (§4.2). It
  is **not an OSI licence**.
* Individual packages still declare `"license": "Apache-2.0"` and ship an Apache `LICENSE`. Examples are
  `plugin-workflow/package.json` and `packages/core/flow-engine/LICENSE`. The signals are mixed, and the root
  agreement says it governs.
* Restrictions that matter for this project:
  * **§5.4:** you may not *"provide to the public any form of no-code, zero-code, low-code, AI platform SaaS/PaaS
    products using the original or modified Software"*.
  * **§5.2:** NocoBase branding may not be removed from the UI, except the top-left logo.
  * The commercial editions add rights; §6.5 and §7.5–7.6 govern reselling "Upper Layer Applications".
* **Risk for the configurator:** a multi-tenant "Workspace Configurator" sold to customers is close to the line of
  §5.4. It **needs a legal opinion before NocoBase is used beyond an internal back-office**.
* The external proposal (`../from-proposal/primitives-map.md`) says NocoBase is "Apache-2.0 since Feb 2026". That
  is **inaccurate as stated**: Apache-2.0 is incorporated, but the agreement's supplementary terms prevail.

## Mapping

| Configurator concept (v5) | NocoBase primitive | Where (v2.2.20) | Edition |
|---|---|---|---|
| Workspace (tenant) | One app with its data source; or **one app per tenant** via the multi-app manager | `plugin-multi-app-manager`, `plugin-data-source-manager` | Community |
| Workspace document / release ledger | Collections. The contract's five `cfg_*` collections exist **[live-B]**. JSON fields are stored as Postgres `json`, not `jsonb`, which keeps key order **[live-B]** | `packages/core/database/src/fields/json-field.ts`; collection manager `plugin-data-source-main` | Community |
| Module / stage / field (projections) | Collections + fields (string, text, integer, boolean, json, date, relations) | `packages/core/database/src/fields/*` | Community |
| Field kinds `choice`, `yesno`, `text`, `number`, `date`, `file`, `person` | interfaces: select/radio, checkbox, input/textarea, number/integer, date, attachment (file manager), user relation (m2o to `users`) | `plugin-file-manager`, core field types | Community |
| **Repeater** (missing in v5 — see SEED-VS-REALITY G-F) | o2m sub-collection + sub-table, or `json`; `plugin-field-m2m-array` | — | Community |
| Sequenced codes (e.g. site / CA codes) | `plugin-field-sequence` | | Community |
| Formula / derived values (`total_op_cost`) | `plugin-field-formula` | | Community |
| Entry gate (module waits on source outcome) | Workflow **collection trigger** with a `condition` filter and `changed` fields (modes 1=create, 2=update, 4=destroy, combinable). The cfg_releases create-event workflow was confirmed to fire **[live-B]** | `plugin-workflow/src/server/triggers/CollectionTrigger.ts` | Community |
| Join (all-of / any-of gates) | `Condition` / `MultiConditions` nodes; the **Parallel** node with modes `all`, `any`, `race`, `allSettled` | `plugin-workflow/src/server/instructions/*`, `plugin-workflow-parallel/src/server/ParallelInstruction.ts` | Community |
| Stage approval by a tier (supervisor / admin sign-off) | **Manual** node (human task). Assignees come from variables; mode `0` single, `1` **all must sign**, `-1` any. This is the community answer to v5 capability **G1** | `plugin-workflow-manual/src/server/ManualInstruction.ts`, `actions.ts` (`getAllModeStatus`, `getAnyModeStatus`) | Community |
| Full approval UX (initiate from a form, approval block, return/delegate/add-signer, todo centre) | **Workflow: Approval**: `isFree: false`, `editionLevel: 2` (**Professional**). The source is **not** in the public repo; only the docs are | `docs/docs/en/plugins/@nocobase/plugin-workflow-approval/index.md` | **Commercial (Professional)** |
| CC / notify watchers | `plugin-workflow-cc`, `plugin-workflow-notification`, `plugin-workflow-mailer`, `plugin-notification-*` | | Community |
| Send-back / loop (missing in v5 — G-B) | `Loop` node, re-entering workflows through `Update`; approval "return" is commercial | `plugin-workflow-loop` | Community (loop) |
| Pre-action veto ("refusal message" when a gate is closed) | **Request interceptor** trigger: a synchronous workflow before an action that can block it with a message | `plugin-workflow-request-interceptor`, `plugin-workflow-response-message` | Community |
| Post-action trigger (e.g. "after publish") | Action trigger / custom action trigger | `plugin-workflow-action-trigger`, `plugin-workflow-custom-action-trigger` | Community |
| Roll-up strategies (`all_positive`, `count_at_least`, `sum_under`) | Calculation / aggregate / dynamic-calculation / JSON-query nodes; JavaScript node for `custom` | `plugin-workflow-aggregate`, `-dynamic-calculation`, `-json-query`, `-javascript` | Community |
| Roles supervisor / executive / business admin / observer | ACL **roles**; a role → resources → actions matrix; **strategies** (global action sets; `own` / `all` predicates) | `packages/core/acl/src/acl-role.ts`, `acl-available-strategy.ts` (`predicate.own = createdById = currentUser`), `plugin-acl/src/server/collections/roles*.ts` | Community |
| Executive sees own sites; supervisor sees module | ACL **data scopes**: `rolesResourcesScopes.scope` is a JSON filter per resource (`own` = created-by-me) | `plugin-acl/src/server/collections/rolesResourcesScopes.ts` | Community |
| Platform ceiling ⊇ tenant grant (v5 perms) | No native "ceiling" concept. Model it as a template role, and let tenants only edit roles derived from it (convention) | — | — |
| Supervisor-only module | Do not grant the executive role on that module's collections and actions; hide menu items per role | ACL + menu permissions | Community |
| Org units / teams | `plugin-departments` | | Community |
| Observer (read-only everything) | A role with the `view` action on all resources (strategy `actions: ['view']`) | core ACL | Community |
| Module navigation / screens / per-role nav | UI schema + **flow engine** models (`FlowModel`, `CollectionFieldModel`, …); blocks: table, form, details, list, grid-card, kanban, calendar, gantt, multi-step form, workbench | `packages/core/flow-engine/src/models/*`, `plugin-flow-engine`, `plugin-ui-schema-storage`, `plugin-block-*` | Community |
| Live preview "as role" | Role switcher (users with several roles) | core ACL / client | Community |
| History / audit | Audit logs. Docs list it `isFree: true`, `editionLevel: 0` at this version | `plugin-audit-logs` | Community (per docs) |
| Immutable release snapshot | Snapshot field (copy related records at write time), or append-only `cfg_releases` (contract) | `plugin-snapshot-field` | Community |
| API access for the web runtime | API keys. A root API key works **[live-B]** | `plugin-api-keys` | Community |
| AI setup assistant / MCP | `plugin-ai`, `plugin-mcp-server` | | Community (per repo; check docs per feature) |

## What NocoBase does **not** give the configurator

* **The configurator itself.** NocoBase is a *runtime*: a place where collections, workflows and ACL run. It has no
  notion of v5's governed draft → validate (`findings()`) → diff → publish-with-reason → versioned release over
  module graphs. That stays our code: `from-design/validation.mjs`, plus the `cfg_*` collections.
* **No case-level version pin.** Individual workflows *are* versioned: `key` + `current` + `revisions` in
  `plugin-workflow/src/common/collections/workflows.ts`, and an execution runs the revision it started on. But
  nothing pins a **case** (a site) to the whole *set* of gates and workflows that made up a flow when it started.
  The proposal and the repo's `docs/14-dynamic-platform/dynamic-flow-transformation-plan.html` both require
  that pin ("every site carries the flow version it started on").
* **Stage-level cross-module gates (G-A)** are expressible as workflow conditions. They are not a first-class,
  inspectable gate graph.
* **Approval UX parity with Matrix-bd** (return to a tier, verdict history, "all must sign" with reasons) is
  smooth only with the **commercial** Approval plugin. The community Manual node covers the decision logic.

## Recommended use (consistent with docs/CONTRACT.md)

1. Keep NocoBase as the **persistence + admin surface** for configurator state: `cfg_workspaces.state` is
   authoritative, `cfg_modules` / `gates` / `stages` are projections, and `cfg_releases` is the ledger. This is
   already built **[live-B]**.
2. Use a **collection-event workflow on `cfg_releases` (create)** for publish side-effects such as notifying,
   exporting or calling a webhook. ACL can make `cfg_releases` view+create only, which makes it append-only by
   policy.
3. If NocoBase ever becomes the **tenant runtime**, map each v5 module to collections + a workflow:
   * the entry gate becomes a collection trigger with a condition, or a request interceptor for refusals
   * stages become Manual nodes, with mode 1 for all-must-sign
   * roll-ups become calculation nodes
   * tiers become ACL roles with data scopes

   Get the licence opinion first.

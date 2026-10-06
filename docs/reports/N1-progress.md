# N1 progress — make NocoBase visible (admin UI pages, workflow, ACL)

## Step 0 — discovery (done)
- Live: NocoBase 2.2.20, `desktopRoutes` empty (no menu at all), `flowSurfaces:listNavigationTargets` →
  `capabilities.multiPortal=false`, layouts `admin-layout-model` (desktop, default) and `mobile-layout-model`.
- Data: 5 workspaces, 2 releases, 55 modules, 56 gates, 147 stages. `state` JSON 22–50 KB each.
- 2.x mechanism chosen: plugin-flow-engine's **`flowSurfaces`** server API (v2.2.20
  `packages/plugins/@nocobase/plugin-flow-engine/src/server/flow-surfaces/`): `applyBlueprint` (whole page:
  menu group + flowPage route + RootPageModel/tabs/blocks/popups), `get`, `removeNode`, `destroyPage`,
  `updateMenu`. Same API used by NocoBase's own AI builder skills (github.com/nocobase/skills,
  `nocobase-ui-builder`).
- Caveat found in source (`flow-surfaces/default-block-actions.ts`): `applyBlueprint` always merges default
  actions into tables (filter/refresh/bulkDelete/addNew + view/edit/delete) and details (edit). No public
  opt-out → provisioner removes the write actions afterwards with `flowSurfaces:removeNode`.

## Step 1 — workflow (done)
- `nocobase/scripts/provision-workflow.mjs`: creates `cfg_activity` (def `ACTIVITY_COLLECTION` in lib/schema.mjs,
  NOT in `COLLECTIONS`, so provision/reset/client are unaffected) + workflow "Matrix Configurator · Release
  published → activity log" (collection trigger cfg_releases mode 1, async, condition `workspace_slug $notIncludes
  "__smoke"` so smoke.mjs leaves no junk; nodes: query cfg_workspaces by slug → create cfg_activity).
- Backfill of the 2 existing releases via `workflows:execute` (body = `{ data: <releaseId> }`; NOTE: wrapping it
  in `{ values: … }` silently loads the FIRST row — hit that bug once, deleted the 3 wrong cfg_activity rows, fixed).
- Run 3 → "no changes". `--prove`: test release `__n1_workflow_test__` → activity row after 565 ms, execution
  status 1, both test rows deleted (0 left).

## Step 2 — admin UI pages (done)
- `nocobase/lib/ui-spec.mjs` (group + 7 page blueprints) + `nocobase/scripts/provision-ui.mjs`.
  flowSurfaces `createMenu(group)` → `createPage` with FIXED uids (`pageSchemaUid` = `mcfg-<page>`, so URLs are
  stable: /admin/mcfg-workspaces …) → `applyBlueprint mode=replace` (replace mode does not auto-save popup
  templates; injected addNew/edit declared with `tryTemplate:false` → 0 templates) → `removeNode` on every top-most
  action whose `use` is not Filter/Refresh/View/FilterForm* (6 per page). Spec hash in
  `desktopRoutes.options.matrixConfigurator.specHash`; re-run → "no changes". Self-heals if someone adds a write
  button (inspectPage → rebuild).
- Scratch experiments (page "N1 Scratch", group "N1 Scratch Group", 6 auto templates) were all destroyed.

## Step 3 — ACL (done)
- `nocobase/scripts/provision-acl.mjs [--test-user]`: role `configurator_viewer` (snippets !pm !pm.* !ui.*,
  allowNewMenu=false, strategy none), "view" (all fields) on the 6 cfg_* collections, routes = group + 7 pages +
  7 tabs. Test user `configurator-viewer` (role only that one), creds in gitignored .env (NOCOBASE_VIEWER_*).
- Live check as that user: 6× list 200; update/destroy/create/export/flowModels:save/collections:create/
  workflows:list all 403. Second run → "no changes" (snippets are stored sorted — spec fixed accordingly).

## Step 4 — evidence, restart, docs (done)
- Screenshots 01–17 in docs/reports/N1-screens (headless Chrome via CDP; Browser pane is 348×424 → unreadable;
  sign-in via API token injection, no credentials typed/printed).
- ONE NocoBase restart at 22:09:47 UTC, healthy after 18 s; all provisioners "no changes", --prove fired (589 ms),
  ACL check passes, configurator /cfg/health still nocobase:true.
- `provision-ui --remove` → rebuild → acl: back to 418 flowModels, 0 templates. smoke.mjs 14/14, no activity junk.
- README updated (click-paths, mechanisms, workflow, ACL, licence). npm scripts provision:{workflow,ui,acl,all}.
- Final report: docs/reports/N1.md.

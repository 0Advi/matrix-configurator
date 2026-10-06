// Admin-UI spec for NocoBase 2.2.20: the "Matrix Configurator" menu group and its read-only pages.
// Consumed by nocobase/scripts/provision-ui.mjs (pages) and provision-acl.mjs (route permissions).
//
// Pages are NocoBase 2.x "modern" (flow-engine) pages: a desktopRoutes `flowPage` route under a `group`
// route, a RootPageModel → RootPageTabModel → BlockGridModel tree in `flowModels`. They are written through
// the plugin-flow-engine `flowSurfaces` API (createMenu / createPage / applyBlueprint replace / removeNode),
// the same server API NocoBase's own UI-builder uses. Each page body below is a flowSurfaces *blueprint tab*.
//
// Read-only by design: the Workspace Configurator owns every write (it validates drafts before saving), so
// these pages expose list / filter / refresh / view only. applyBlueprint always injects default write
// actions (addNew, bulkDelete, edit, delete; see flow-surfaces/default-block-actions.ts) — the blueprint
// declares the ones with popups explicitly with `tryTemplate: false` (so no popup templates get generated)
// and provision-ui.mjs removes every action that is not in READ_ONLY_ACTION_USES afterwards.

export const GROUP = {
  title: 'Matrix Configurator',
  icon: 'ApartmentOutlined',
  tooltip: 'Workspace Configurator data stored in NocoBase (read-only views)',
};

/** Flow-model `use` names allowed in any `actions` slot of our pages. Everything else is removed. */
export const READ_ONLY_ACTION_USES = new Set([
  'FilterActionModel',
  'RefreshActionModel',
  'ViewActionModel',
  'FilterFormSubmitActionModel',
  'FilterFormResetActionModel',
  'FilterFormCollapseActionModel',
]);

/** Bump to force every page to be rebuilt on the next provisioning run. */
export const SPEC_VERSION = 1;

const WRITE_ACTION_STUBS = [{ type: 'addNew', popup: { tryTemplate: false } }];
const WRITE_RECORD_ACTION_STUBS = [{ type: 'edit', popup: { tryTemplate: false } }];

/** Read-only details block for the clicked record, shown in a drawer. */
function drawer(title, collection, fields) {
  return {
    title,
    mode: 'drawer',
    tryTemplate: false,
    blocks: [
      {
        key: 'details',
        type: 'details',
        resource: { binding: 'currentRecord', collectionName: collection },
        fields,
        recordActions: WRITE_RECORD_ACTION_STUBS,
      },
    ],
  };
}

/**
 * One read-only table page: optional filter form (by workspace), a table whose `clickField` column and
 * "View" action open the details drawer.
 */
function tablePage({ title, collection, columns, clickField, details, drawerTitle, sorting, pageSize = 20, filterFields = [] }) {
  const popup = drawer(drawerTitle, collection, details);
  const table = {
    key: 'table',
    type: 'table',
    collection,
    title,
    settings: { sorting, pageSize, enableRowSelection: false }, // no row checkboxes: there are no bulk actions
    fields: columns.map((f) => (f === clickField ? { field: f, popup } : f)),
    actions: ['filter', 'refresh', ...WRITE_ACTION_STUBS],
    recordActions: [{ type: 'view', popup }, ...WRITE_RECORD_ACTION_STUBS],
  };
  const blocks = [];
  if (filterFields.length) {
    blocks.push({
      key: 'filter',
      type: 'filterForm',
      collection,
      title: 'Filter',
      fields: filterFields.map((f) => ({ key: `f_${f}`, field: f, target: 'table' })),
      actions: filterFields.length >= 4 ? ['submit', 'reset', 'collapse'] : ['submit', 'reset'],
    });
  }
  blocks.push(table);
  return {
    key: 'main',
    title,
    blocks,
    ...(filterFields.length ? { layout: { rows: [['filter'], ['table']] } } : {}),
  };
}

const OVERVIEW_MD = `## Matrix Configurator · data in NocoBase

NocoBase is the **design-time store** of the Workspace Configurator (http://localhost:4300). Every save in the
configurator is written here through the NocoBase REST API (\`nocobase/lib/client.mjs\`); the Matrix app keeps
its own run-time copy of each *published* release and never calls NocoBase at request time.

| Page | Collection | What it is |
|---|---|---|
| [Workspaces](/admin/mcfg-workspaces) | \`cfg_workspaces\` | one row per workspace; \`state\` (JSON) is the authoritative configurator draft |
| [Releases](/admin/mcfg-releases) | \`cfg_releases\` | append-only publish ledger (version, reason, publisher, manifest JSON) |
| [Modules](/admin/mcfg-modules) · [Gates](/admin/mcfg-gates) · [Stages](/admin/mcfg-stages) | \`cfg_modules\` / \`cfg_gates\` / \`cfg_stages\` | read models rebuilt from \`state\` on every save |
| [Activity](/admin/mcfg-activity) | \`cfg_activity\` | written by the NocoBase **workflow** "Matrix Configurator · Release published → activity log" on every new release |

**Read-only on purpose.** The configurator validates a draft before it saves it; editing \`state\` here would
bypass that. Change workspaces in the configurator, not in this admin UI.

Workflow: ⚙ Settings → Workflow. Role \`configurator_viewer\` can open these pages but cannot modify anything.
These pages, the workflow and the role are provisioned by \`nocobase/scripts/provision-ui.mjs\`,
\`provision-workflow.mjs\` and \`provision-acl.mjs\` (community edition only).`;

/** Ordered pages of the group. `pageSchemaUid` is stable → stable URLs: /admin/<pageSchemaUid>. */
export const PAGES = [
  {
    key: 'overview',
    title: 'Overview',
    icon: 'InfoCircleOutlined',
    pageSchemaUid: 'mcfg-overview',
    tab: {
      key: 'main',
      title: 'Overview',
      blocks: [{ key: 'about', type: 'markdown', title: 'About this menu', settings: { content: OVERVIEW_MD } }],
    },
  },
  {
    key: 'workspaces',
    title: 'Workspaces',
    icon: 'AppstoreOutlined',
    pageSchemaUid: 'mcfg-workspaces',
    collections: ['cfg_workspaces'],
    tab: tablePage({
      title: 'Workspaces',
      collection: 'cfg_workspaces',
      columns: ['name', 'slug', 'is_custom', 'live_version', 'draft_version', 'updatedAt'],
      clickField: 'name',
      drawerTitle: 'Workspace (read-only)',
      details: ['name', 'slug', 'initials', 'is_custom', 'live_version', 'draft_version', 'createdAt', 'updatedAt', 'state'],
      sorting: ['slug'],
    }),
  },
  {
    key: 'releases',
    title: 'Releases',
    icon: 'TagsOutlined',
    pageSchemaUid: 'mcfg-releases',
    collections: ['cfg_releases'],
    tab: tablePage({
      title: 'Releases',
      collection: 'cfg_releases',
      columns: ['workspace_slug', 'version', 'reason', 'published_by', 'createdAt'],
      clickField: 'version',
      drawerTitle: 'Release (read-only)',
      details: ['workspace_slug', 'version', 'reason', 'published_by', 'createdAt', 'manifest'],
      sorting: ['-createdAt', '-id'],
      filterFields: ['workspace_slug'],
    }),
  },
  {
    key: 'modules',
    title: 'Modules',
    icon: 'BlockOutlined',
    pageSchemaUid: 'mcfg-modules',
    collections: ['cfg_modules'],
    tab: tablePage({
      title: 'Modules',
      collection: 'cfg_modules',
      columns: ['workspace_slug', 'module_key', 'name', 'glyph', 'kind', 'status', 'route'],
      clickField: 'name',
      drawerTitle: 'Module (read-only)',
      details: ['workspace_slug', 'module_key', 'name', 'glyph', 'kind', 'status', 'route', 'updatedAt', 'data'],
      sorting: ['workspace_slug', 'id'],
      pageSize: 50,
      filterFields: ['workspace_slug', 'kind', 'status'],
    }),
  },
  {
    key: 'gates',
    title: 'Gates',
    icon: 'BranchesOutlined',
    pageSchemaUid: 'mcfg-gates',
    collections: ['cfg_gates'],
    tab: tablePage({
      title: 'Gates',
      collection: 'cfg_gates',
      columns: ['workspace_slug', 'from_key', 'to_key', 'updatedAt'],
      clickField: 'from_key',
      drawerTitle: 'Gate (read-only)',
      details: ['workspace_slug', 'from_key', 'to_key', 'updatedAt', 'condition'],
      sorting: ['workspace_slug', 'id'],
      pageSize: 50,
      filterFields: ['workspace_slug', 'from_key', 'to_key'],
    }),
  },
  {
    key: 'stages',
    title: 'Stages',
    icon: 'OrderedListOutlined',
    pageSchemaUid: 'mcfg-stages',
    collections: ['cfg_stages'],
    tab: tablePage({
      title: 'Stages',
      collection: 'cfg_stages',
      columns: ['workspace_slug', 'module_key', 'position', 'name', 'outcome', 'terminal'],
      clickField: 'name',
      drawerTitle: 'Stage (read-only)',
      details: ['workspace_slug', 'module_key', 'position', 'name', 'outcome', 'terminal', 'updatedAt', 'data'],
      sorting: ['workspace_slug', 'module_key', 'position'],
      pageSize: 50,
      filterFields: ['workspace_slug', 'module_key'],
    }),
  },
  {
    key: 'activity',
    title: 'Activity',
    icon: 'HistoryOutlined',
    pageSchemaUid: 'mcfg-activity',
    collections: ['cfg_activity'],
    requiresCollection: 'cfg_activity', // created by provision-workflow.mjs
    tab: tablePage({
      title: 'Activity (workflow log)',
      collection: 'cfg_activity',
      columns: ['published_at', 'summary', 'workspace_slug', 'workspace_name', 'version', 'published_by', 'createdAt'],
      clickField: 'summary',
      drawerTitle: 'Activity entry (read-only)',
      details: ['event', 'summary', 'workspace_slug', 'workspace_name', 'version', 'published_by', 'reason', 'release_id', 'published_at', 'createdAt'],
      sorting: ['-published_at', '-id'],
      filterFields: ['workspace_slug'],
    }),
  },
];

/** All collections shown on the pages (for ACL). */
export const UI_COLLECTIONS = [...new Set(PAGES.flatMap((p) => p.collections || []))];

#!/usr/bin/env node
// Idempotently provision the NocoBase admin-UI menu "Matrix Configurator" (NocoBase 2.2.20 modern pages):
//
//   group  Matrix Configurator
//     ├─ Overview    /admin/mcfg-overview     what NocoBase stores for the configurator, links
//     ├─ Workspaces  /admin/mcfg-workspaces   cfg_workspaces, drawer with the `state` JSON
//     ├─ Releases    /admin/mcfg-releases     cfg_releases newest first, drawer with the `manifest` JSON
//     ├─ Modules     /admin/mcfg-modules      cfg_modules  + filter by workspace
//     ├─ Gates       /admin/mcfg-gates        cfg_gates    + filter by workspace
//     ├─ Stages      /admin/mcfg-stages       cfg_stages   + filter by workspace
//     └─ Activity    /admin/mcfg-activity     cfg_activity (written by the workflow, see provision-workflow.mjs)
//
// Mechanism (plugin-flow-engine `flowSurfaces` API, v2.2.20):
//   createMenu(type=group) → createPage(pageSchemaUid fixed) → applyBlueprint(mode=replace) → removeNode for every
//   non-read-only action that applyBlueprint injected. Page specs live in nocobase/lib/ui-spec.mjs.
// Idempotency: each page route stores a hash of its spec in desktopRoutes.options.matrixConfigurator. A page is
// rebuilt only if the hash changed or the live page is no longer read-only / incomplete (e.g. someone added an
// "Add new" button in the UI editor). Re-running with nothing to do prints "no changes".
//
//   node nocobase/scripts/provision-ui.mjs [--force] [--only=workspaces,releases] [--remove]
//
// --force   rebuild every page even if unchanged      --remove  delete the menu group and its pages (asks nothing)

import { createHash } from 'node:crypto';
import { createClient } from '../lib/client.mjs';
import { loadEnv } from '../lib/env.mjs';
import { GROUP, PAGES, READ_ONLY_ACTION_USES, SPEC_VERSION } from '../lib/ui-spec.mjs';

loadEnv();
const argv = process.argv.slice(2);
const args = new Set(argv);
const only = argv.find((a) => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean);
const log = (...m) => console.log('[provision-ui]', ...m);
const changes = [];
const warnings = [];
const nb = createClient();
const MARK = 'matrixConfigurator';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const specHash = (page) =>
  createHash('sha256').update(canon({ v: SPEC_VERSION, title: page.title, icon: page.icon, tab: page.tab, ro: [...READ_ONLY_ACTION_USES].sort() })).digest('hex').slice(0, 16);

async function fs(action, body) {
  const res = await nb.request('POST', `flowSurfaces:${action}`, { body });
  return res?.data;
}

async function waitUntilUp(seconds = 120) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (await nb.health({ deep: false })) return;
    await sleep(2000);
  }
  throw new Error(`NocoBase at ${nb.baseUrl} is not up`);
}

// ------------------------------------------------------------------ routes

async function findGroup() {
  const rows = await nb.list('desktopRoutes', { filter: { type: 'group', title: GROUP.title, parentId: { $empty: true } } });
  if (rows.length > 1) {
    const marked = rows.filter((r) => r.options?.[MARK]?.group);
    if (marked.length === 1) return marked[0];
    throw new Error(`${rows.length} top-level menu groups titled "${GROUP.title}"; remove the duplicates first`);
  }
  return rows[0] || null;
}

async function setRouteOptions(route, patch) {
  const options = { ...(route.options || {}), [MARK]: { ...(route.options?.[MARK] || {}), ...patch } };
  await nb.request('POST', 'desktopRoutes:update', { query: { filterByTk: route.id }, body: { options } });
}

async function ensureGroup() {
  let group = await findGroup();
  if (!group) {
    const created = await fs('createMenu', { type: 'group', title: GROUP.title, icon: GROUP.icon, tooltip: GROUP.tooltip });
    group = await nb.get('desktopRoutes', created.routeId);
    await setRouteOptions(group, { group: true, provisionedBy: 'nocobase/scripts/provision-ui.mjs' });
    changes.push(`created menu group "${GROUP.title}" (route ${group.id})`);
    return nb.get('desktopRoutes', group.id);
  }
  if (group.icon !== GROUP.icon || (group.tooltip || '') !== GROUP.tooltip) {
    await fs('updateMenu', { menuRouteId: group.id, title: GROUP.title, icon: GROUP.icon, tooltip: GROUP.tooltip });
    changes.push(`updated menu group icon/tooltip`);
  }
  if (!group.options?.[MARK]?.group) await setRouteOptions(group, { group: true, provisionedBy: 'nocobase/scripts/provision-ui.mjs' });
  return group;
}

// ------------------------------------------------------------------ page tree helpers

function* walk(node, parentUse = null, subKey = null) {
  if (!node || typeof node !== 'object') return;
  yield { node, parentUse, subKey };
  for (const [k, v] of Object.entries(node.subModels || {})) {
    for (const child of Array.isArray(v) ? v : [v]) yield* walk(child, node.use, k);
  }
}

const isWriteAction = ({ node, subKey }) => subKey === 'actions' && !READ_ONLY_ACTION_USES.has(node.use);

/** Top-most write actions only (their popups/forms/submit buttons go with them). */
function writeActions(tree) {
  const out = [];
  const visit = (node, subKey) => {
    if (!node || typeof node !== 'object') return;
    if (isWriteAction({ node, subKey })) return void out.push(node);
    for (const [k, v] of Object.entries(node.subModels || {})) for (const c of Array.isArray(v) ? v : [v]) visit(c, k);
  };
  visit(tree, null);
  return out;
}

async function readPage(pageSchemaUid) {
  const res = await nb.request('GET', 'flowSurfaces:get', { query: { pageSchemaUid } });
  return res?.data?.tree || null;
}

/** Problems that make a live page deviate from "read-only and complete". */
function inspectPage(tree, page) {
  const problems = [];
  if (!tree) return ['page model missing'];
  const nodes = [...walk(tree)];
  const writes = writeActions(tree);
  if (writes.length) problems.push(`${writes.length} non-read-only action(s): ${[...new Set(writes.map((n) => n.use))].join(', ')}`);
  const wantTypes = page.tab.blocks.map((b) => b.type);
  const uses = new Set(nodes.map(({ node }) => node.use));
  const typeToUse = { table: 'TableBlockModel', filterForm: 'FilterFormBlockModel', markdown: 'MarkdownBlockModel', details: 'DetailsBlockModel' };
  for (const t of wantTypes) if (typeToUse[t] && !uses.has(typeToUse[t])) problems.push(`missing ${typeToUse[t]}`);
  if (page.collections?.length && wantTypes.includes('table') && !uses.has('DetailsBlockModel')) problems.push('missing details drawer');
  return problems;
}

/** Remove every injected write action (addNew, bulkDelete, edit, delete, …). Repeats until none is left. */
async function stripWriteActions(pageSchemaUid) {
  let removed = 0;
  for (let round = 0; round < 5; round++) {
    const tree = await readPage(pageSchemaUid);
    const targets = writeActions(tree);
    if (!targets.length) return removed;
    for (const node of targets) {
      await fs('removeNode', { target: { uid: node.uid } });
      removed++;
    }
  }
  throw new Error(`${pageSchemaUid}: write actions still present after 5 rounds`);
}

// ------------------------------------------------------------------ pages

async function collectionExists(name) {
  return (await nb.list('collections', { filter: { name }, fields: ['name'] })).length > 0;
}

async function ensurePage(group, page) {
  if (page.requiresCollection && !(await collectionExists(page.requiresCollection))) {
    warnings.push(`page "${page.title}" skipped: collection ${page.requiresCollection} missing (run provision-workflow.mjs first)`);
    return null;
  }
  const hash = specHash(page);
  let route = (await nb.list('desktopRoutes', { filter: { schemaUid: page.pageSchemaUid } }))[0];
  let created = false;
  if (!route) {
    const res = await fs('createPage', {
      title: page.title,
      icon: page.icon,
      parentMenuRouteId: group.id,
      pageSchemaUid: page.pageSchemaUid,
      pageUid: `${page.pageSchemaUid}-page`,
      tabSchemaUid: `${page.pageSchemaUid}-tab`,
      tabSchemaName: `${page.pageSchemaUid}-tab`,
      tabTitle: page.tab.title,
      displayTitle: true,
    });
    route = await nb.get('desktopRoutes', res.routeId);
    created = true;
  } else {
    if (route.parentId !== group.id) warnings.push(`page "${page.title}" is not under the "${GROUP.title}" group (left where it is)`);
    if (route.title !== page.title || route.icon !== page.icon) {
      await fs('updateMenu', { menuRouteId: route.id, title: page.title, icon: page.icon });
      changes.push(`page "${page.title}": updated title/icon`);
    }
  }

  const live = created ? null : await readPage(page.pageSchemaUid).catch(() => null);
  const problems = created ? ['new page'] : inspectPage(live, page);
  const stale = route.options?.[MARK]?.specHash !== hash;
  if (!args.has('--force') && !stale && problems.length === 0) return route;

  await fs('applyBlueprint', {
    version: '1',
    mode: 'replace',
    target: { pageSchemaUid: page.pageSchemaUid },
    page: { title: page.title, displayTitle: true },
    tabs: [page.tab],
  });
  const removed = await stripWriteActions(page.pageSchemaUid);
  const after = inspectPage(await readPage(page.pageSchemaUid), page);
  if (after.length) throw new Error(`page "${page.title}" still not as specified after rebuild: ${after.join('; ')}`);
  route = await nb.get('desktopRoutes', route.id);
  await setRouteOptions(route, { page: page.key, specHash: hash, provisionedBy: 'nocobase/scripts/provision-ui.mjs' });
  const why = created ? 'created' : args.has('--force') ? 'rebuilt (--force)' : stale ? 'rebuilt (spec changed)' : `repaired (${problems.join('; ')})`;
  changes.push(`page "${page.title}" /admin/${page.pageSchemaUid}: ${why}, ${removed} injected write action(s) removed`);
  log(`page "${page.title}": ${why}`);
  return route;
}

/** Keep the pages in spec order inside the group. */
async function ensureOrder(group, routes) {
  const children = await nb.list('desktopRoutes', { filter: { parentId: group.id }, sort: ['sort'] });
  const ours = children.filter((c) => routes.some((r) => r && r.id === c.id)).map((c) => c.id);
  const want = routes.filter(Boolean).map((r) => r.id);
  if (canon(ours) === canon(want)) return;
  // move each page after its predecessor (desktopRoutes:move is what the menu drag & drop uses)
  for (let i = 1; i < want.length; i++) {
    await nb.request('POST', 'desktopRoutes:move', {
      body: { sourceId: want[i], targetId: want[i - 1], sortField: 'sort', method: 'insertAfter' },
    });
  }
  changes.push('re-ordered pages in the group');
}

/** Popup templates auto-generated for cfg_* collections that nothing uses any more (left by a failed run). */
async function removeOrphanTemplates() {
  const templates = await nb.list('flowModelTemplates', { filter: { collectionName: { $in: PAGES.flatMap((p) => p.collections || []) } } }).catch(() => []);
  for (const t of templates) {
    if (!/\(Auto generated\)$/.test(t.name || '')) continue;
    const used = await nb.list('flowModelTemplateUsages', { filter: { templateUid: t.uid }, limit: 1 });
    if (used.length) continue;
    await fs('destroyTemplate', { uid: t.uid });
    changes.push(`removed unused auto-generated popup template "${t.name}"`);
  }
}

async function removeAll() {
  const group = await findGroup();
  for (const page of PAGES) {
    const route = (await nb.list('desktopRoutes', { filter: { schemaUid: page.pageSchemaUid } }))[0];
    if (!route) continue;
    await fs('destroyPage', { uid: `${page.pageSchemaUid}-page` }).catch(async (err) => {
      warnings.push(`destroyPage ${page.pageSchemaUid}: ${err.message}`);
    });
    changes.push(`removed page "${page.title}"`);
  }
  if (group) {
    const left = await nb.list('desktopRoutes', { filter: { parentId: group.id } });
    if (left.length) warnings.push(`group kept: it still has ${left.length} other item(s)`);
    else {
      await nb.request('POST', 'desktopRoutes:destroy', { query: { filterByTk: group.id } });
      changes.push(`removed menu group "${GROUP.title}"`);
    }
  }
  await removeOrphanTemplates();
}

try {
  await waitUntilUp();
  if (args.has('--remove')) {
    await removeAll();
  } else {
    const group = await ensureGroup();
    const routes = [];
    for (const page of PAGES) {
      if (only && !only.includes(page.key)) {
        routes.push((await nb.list('desktopRoutes', { filter: { schemaUid: page.pageSchemaUid } }))[0] || null);
        continue;
      }
      routes.push(await ensurePage(group, page));
    }
    await ensureOrder(group, routes);
    await removeOrphanTemplates();
    const ok = [];
    for (const page of PAGES) {
      const tree = await readPage(page.pageSchemaUid).catch(() => null);
      if (tree && inspectPage(tree, page).length === 0) ok.push(page.title);
    }
    log(`verified: ${ok.length}/${PAGES.length} pages present and read-only (${ok.join(', ')}) under "${GROUP.title}" → ${nb.baseUrl}/admin/${PAGES[0].pageSchemaUid}`);
  }
  for (const w of warnings) console.warn('[provision-ui] WARNING:', w);
  if (changes.length === 0) log('no changes — already provisioned');
  else {
    for (const c of changes) log(`change: ${c}`);
    log(`${changes.length} change(s) applied`);
  }
} catch (err) {
  console.error('[provision-ui] FAILED:', err?.message || err);
  if (err?.body) console.error(JSON.stringify(err.body).slice(0, 1500));
  process.exit(1);
}

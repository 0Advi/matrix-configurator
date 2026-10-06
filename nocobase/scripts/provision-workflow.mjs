#!/usr/bin/env node
// Idempotently provision the NocoBase workflow that turns every publish into an activity-log entry:
//
//   1. collection `cfg_activity` (NocoBase-owned; see ACTIVITY_COLLECTION in lib/schema.mjs)
//   2. workflow "Matrix Configurator · Release published → activity log" (community Workflow plugin):
//        trigger  collection event on `cfg_releases`, mode 1 = after record added, async,
//                 condition: workspace_slug does not include "__smoke" (smoke.mjs throwaway releases)
//        node 1   Query record  — look up the workspace in `cfg_workspaces` by slug (may be empty)
//        node 2   Create record — append to `cfg_activity` (event, summary, workspace, version,
//                 reason, published_by, release_id, published_at)
//   3. backfill: releases that have no activity entry yet are run through the same workflow
//      manually (workflows:execute), so the log is complete. Skip with --no-backfill.
//
// Re-running is a no-op when everything is in place. If the live workflow differs from the spec and it
// has never run, it is fixed in place; if it has executions, a new workflow *revision* is created,
// configured and enabled (NocoBase keeps executed versions immutable) — only with --revise.
//
//   node nocobase/scripts/provision-workflow.mjs [--no-backfill] [--revise] [--prove]
//
// --prove  end-to-end proof: inserts ONE clearly marked test row into cfg_releases
//          (workspace_slug "__n1_workflow_test__"), waits for the workflow's cfg_activity entry,
//          prints it, then deletes BOTH test rows. (cfg_releases is append-only by convention; this
//          test row is the documented exception.)

import { createClient } from '../lib/client.mjs';
import { loadEnv } from '../lib/env.mjs';
import { ACTIVITY_COLLECTION, presetFields } from '../lib/schema.mjs';

loadEnv();
const args = new Set(process.argv.slice(2));
const log = (...m) => console.log('[provision-workflow]', ...m);
const changes = [];
const warnings = [];
const nb = createClient(); // root API key (or root sign-in fallback)

const WORKFLOW_TITLE = 'Matrix Configurator · Release published → activity log';
const WORKFLOW_DESCRIPTION =
  'Fires after a row is added to cfg_releases (every Publish in the Workspace Configurator). ' +
  'Looks up the workspace and appends an entry to cfg_activity. Provisioned by nocobase/scripts/provision-workflow.mjs; ' +
  'edit the script, not this workflow, or the next provisioning run reports drift.';
const TRIGGER_CONFIG = {
  collection: 'cfg_releases',
  mode: 1, // 1 = after record added
  changed: [],
  condition: { $and: [{ workspace_slug: { $notIncludes: '__smoke' } }] },
  appends: [],
};
const QUERY_KEY = '{{QUERY_NODE_KEY}}';
/** Node chain (main branch, in order). `{{QUERY_NODE_KEY}}` is replaced by node 1's live key. */
const NODES = [
  {
    type: 'query',
    title: 'Look up workspace',
    config: {
      collection: 'cfg_workspaces',
      multiple: false,
      params: {
        filter: { $and: [{ slug: { $eq: '{{$context.data.workspace_slug}}' } }] },
        sort: [],
        page: 1,
        pageSize: 20,
        appends: [],
      },
      failOnEmpty: false,
    },
  },
  {
    type: 'create',
    title: 'Append to activity log',
    config: {
      collection: 'cfg_activity',
      usingAssignFormSchema: false,
      assignFormSchema: {},
      params: {
        values: {
          event: 'release_published',
          summary: '{{$context.data.workspace_slug}} v{{$context.data.version}} published by {{$context.data.published_by}}',
          workspace_slug: '{{$context.data.workspace_slug}}',
          workspace_name: `{{$jobsMapByNodeKey.${QUERY_KEY}.name}}`,
          version: '{{$context.data.version}}',
          reason: '{{$context.data.reason}}',
          published_by: '{{$context.data.published_by}}',
          release_id: '{{$context.data.id}}',
          published_at: '{{$context.data.createdAt}}',
        },
        appends: [],
      },
    },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stable JSON (sorted keys) for comparisons. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const withKey = (config, key) => JSON.parse(JSON.stringify(config).split(QUERY_KEY).join(key));

async function waitUntilUp(seconds = 120) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (await nb.health({ deep: false })) return;
    await sleep(2000);
  }
  throw new Error(`NocoBase at ${nb.baseUrl} is not up`);
}

// ------------------------------------------------------------------ 1. collection

async function ensureActivityCollection() {
  const def = ACTIVITY_COLLECTION;
  const [current] = await nb.list('collections', { filter: { name: def.name }, appends: ['fields'] });
  if (!current) {
    await nb.request('POST', 'collections:create', {
      body: {
        name: def.name,
        title: def.title,
        description: def.description,
        template: 'general',
        logging: true,
        autoGenId: false,
        createdAt: true,
        updatedAt: true,
        createdBy: true,
        updatedBy: true,
        sortable: false,
        titleField: def.titleField,
        fields: [...presetFields(), ...def.fields],
      },
    });
    changes.push(`created collection ${def.name}`);
    log(`created collection ${def.name}`);
    return;
  }
  const have = new Map((current.fields || []).map((f) => [f.name, f]));
  for (const field of def.fields) {
    const f = have.get(field.name);
    if (!f) {
      await nb.request('POST', `collections/${def.name}/fields:create`, { body: field });
      changes.push(`added field ${def.name}.${field.name}`);
    } else if (f.type !== field.type) {
      warnings.push(`${def.name}.${field.name}: type is ${f.type}, expected ${field.type} (left unchanged)`);
    }
  }
}

// ------------------------------------------------------------------ 2. workflow

async function findWorkflow() {
  const rows = await nb.list('workflows', {
    filter: { title: WORKFLOW_TITLE, type: 'collection', current: true },
    appends: ['nodes', 'versionStats'],
  });
  if (rows.length > 1) warnings.push(`${rows.length} current workflows titled "${WORKFLOW_TITLE}"; using id ${rows[0].id}`);
  return rows[0] || null;
}

/** Main-chain nodes in execution order. */
function chain(nodes = []) {
  const byUpstream = new Map(nodes.filter((n) => n.branchIndex == null).map((n) => [n.upstreamId ?? null, n]));
  const out = [];
  for (let n = byUpstream.get(null); n; n = byUpstream.get(n.id)) out.push(n);
  return out.length === nodes.length ? out : null; // null → branches/orphans we did not create
}

function diffWorkflow(wf) {
  const problems = [];
  if (wf.description !== WORKFLOW_DESCRIPTION) problems.push('description');
  if (wf.sync !== false) problems.push('sync');
  if (canon(wf.config) !== canon(TRIGGER_CONFIG)) problems.push('trigger config');
  const nodes = chain(wf.nodes);
  if (!nodes || nodes.length !== NODES.length) {
    problems.push('node chain');
    return problems;
  }
  const queryKey = nodes[0].key;
  NODES.forEach((spec, i) => {
    const n = nodes[i];
    if (n.type !== spec.type || n.title !== spec.title || canon(n.config) !== canon(withKey(spec.config, queryKey))) {
      problems.push(`node ${i + 1} (${spec.title})`);
    }
  });
  return problems;
}

/** (Re)build the node chain of an editable (never executed) workflow version. */
async function buildNodes(workflowId, existing = []) {
  // remove from the tail so no node is left dangling
  for (const n of [...(chain(existing) || existing)].reverse()) {
    await nb.request('POST', 'flow_nodes:destroy', { query: { filterByTk: n.id } });
  }
  let upstreamId = null;
  let queryKey = null;
  for (const spec of NODES) {
    const res = await nb.request('POST', `workflows/${workflowId}/nodes:create`, {
      body: { type: spec.type, title: spec.title, upstreamId, branchIndex: null, config: withKey(spec.config, queryKey ?? QUERY_KEY) },
    });
    const node = res.data;
    if (spec.type === 'query') {
      queryKey = node.key;
      // the key only exists after creation; nodes created later reference it
    }
    upstreamId = node.id;
  }
}

async function ensureWorkflow() {
  let wf = await findWorkflow();
  if (!wf) {
    const res = await nb.request('POST', 'workflows:create', {
      body: {
        title: WORKFLOW_TITLE,
        description: WORKFLOW_DESCRIPTION,
        type: 'collection',
        sync: false,
        enabled: false,
        options: { deleteExecutionOnStatus: [], stackLimit: 1 },
        config: TRIGGER_CONFIG,
      },
    });
    wf = res.data;
    await buildNodes(wf.id);
    await nb.request('POST', 'workflows:update', { query: { filterByTk: wf.id }, body: { enabled: true } });
    changes.push(`created workflow #${wf.id} "${WORKFLOW_TITLE}" (collection trigger on cfg_releases, 2 nodes, enabled)`);
    log(`created workflow #${wf.id}`);
    return findWorkflow();
  }

  const problems = diffWorkflow(wf);
  if (problems.length) {
    const executed = wf.versionStats?.executed ?? 0;
    if (executed === 0) {
      await nb.request('POST', 'workflows:update', {
        query: { filterByTk: wf.id },
        body: { description: WORKFLOW_DESCRIPTION, config: TRIGGER_CONFIG },
      });
      await buildNodes(wf.id, wf.nodes);
      changes.push(`fixed workflow #${wf.id} in place (${problems.join(', ')})`);
    } else if (args.has('--revise')) {
      const rev = await nb.request('POST', 'workflows:revision', { query: { filterByTk: wf.id, filter: { key: wf.key } } });
      const next = rev.data;
      if (next.key !== wf.key) throw new Error('workflows:revision returned a different key; aborting');
      const full = await nb.request('GET', 'workflows:get', { query: { filterByTk: next.id, appends: ['nodes'] } });
      await nb.request('POST', 'workflows:update', {
        query: { filterByTk: next.id },
        body: { description: WORKFLOW_DESCRIPTION, config: TRIGGER_CONFIG },
      });
      await buildNodes(next.id, full.data.nodes);
      await nb.request('POST', 'workflows:update', { query: { filterByTk: next.id }, body: { enabled: true } });
      changes.push(`workflow #${wf.id} drifted (${problems.join(', ')}); created and enabled revision #${next.id}`);
    } else {
      warnings.push(
        `workflow #${wf.id} differs from the spec (${problems.join(', ')}) and has ${executed} execution(s); ` +
          're-run with --revise to create a corrected revision',
      );
    }
    wf = await findWorkflow();
  }
  if (!wf.enabled) {
    await nb.request('POST', 'workflows:update', { query: { filterByTk: wf.id }, body: { enabled: true } });
    changes.push(`enabled workflow #${wf.id}`);
    wf = await findWorkflow();
  }
  return wf;
}

// ------------------------------------------------------------------ 3. backfill

async function backfill(wf) {
  const releases = await nb.list('cfg_releases', { sort: ['id'], fields: ['id', 'workspace_slug', 'version'] });
  const logged = new Set((await nb.list('cfg_activity', { fields: ['release_id'] })).map((a) => String(a.release_id)));
  const missing = releases.filter((r) => !logged.has(String(r.id)) && !String(r.workspace_slug).includes('__smoke'));
  if (args.has('--no-backfill')) {
    if (missing.length) log(`backfill skipped (--no-backfill); ${missing.length} release(s) have no activity entry`);
    return;
  }
  for (const r of missing) {
    // Manual execution of the same workflow: the collection trigger loads the release by id.
    const res = await nb.request('POST', 'workflows:execute', { query: { filterByTk: wf.id }, body: { data: r.id } }); // the request body IS the trigger context (values)
    const status = res?.data?.execution?.status ?? res?.execution?.status;
    changes.push(`backfilled activity for release #${r.id} (${r.workspace_slug} v${r.version}) via workflows:execute (execution status ${status})`);
  }
}

// ------------------------------------------------------------------ --prove

async function prove(wf) {
  const SLUG = '__n1_workflow_test__';
  const before = await nb.list('cfg_activity', { filter: { workspace_slug: SLUG } });
  if (before.length) await nb.destroy('cfg_activity', { workspace_slug: SLUG });
  const release = await nb.appendRelease({
    workspace_slug: SLUG,
    version: 1,
    reason: 'N1 workflow proof — test row, deleted right after the check',
    manifest: { test: true },
    published_by: 'n1:provision-workflow --prove',
  });
  log(`[prove] inserted test release #${release.id} (${SLUG}) into cfg_releases`);
  let entry = null;
  const t0 = Date.now();
  while (!entry && Date.now() - t0 < 30000) {
    await sleep(500);
    [entry] = await nb.list('cfg_activity', { filter: { release_id: release.id } });
  }
  try {
    if (!entry) throw new Error('no cfg_activity entry appeared within 30s — workflow did not fire');
    const [exec] = await nb.list('executions', { filter: { key: wf.key }, sort: ['-id'], limit: 1 }).catch(() => []);
    log(
      `[prove] workflow fired after ${Date.now() - t0}ms → cfg_activity #${entry.id}: ` +
        JSON.stringify({ event: entry.event, summary: entry.summary, release_id: entry.release_id, published_at: entry.published_at }),
    );
    if (exec) log(`[prove] latest execution #${exec.id}: status ${exec.status} (1 = resolved)`);
  } finally {
    await nb.destroy('cfg_activity', { workspace_slug: SLUG });
    await nb.destroy('cfg_releases', { workspace_slug: SLUG });
    const left = (await nb.list('cfg_releases', { filter: { workspace_slug: SLUG } })).length + (await nb.list('cfg_activity', { filter: { workspace_slug: SLUG } })).length;
    log(`[prove] deleted both test rows (cfg_releases + cfg_activity); remaining test rows: ${left}`);
  }
}

try {
  await waitUntilUp();
  await ensureActivityCollection();
  const wf = await ensureWorkflow();
  await backfill(wf);
  const [releases, activity] = [await nb.list('cfg_releases', { fields: ['id'] }), await nb.list('cfg_activity', { fields: ['id'] })];
  log(`verified: workflow #${wf.id} enabled=${wf.enabled}, ${wf.nodes?.length} nodes; cfg_releases ${releases.length} rows, cfg_activity ${activity.length} rows`);
  if (args.has('--prove')) await prove(wf);
  for (const w of warnings) console.warn('[provision-workflow] WARNING:', w);
  if (changes.length === 0) log('no changes — already provisioned');
  else {
    for (const c of changes) log(`change: ${c}`);
    log(`${changes.length} change(s) applied`);
  }
} catch (err) {
  console.error('[provision-workflow] FAILED:', err?.message || err);
  if (err?.body) console.error(JSON.stringify(err.body).slice(0, 800));
  process.exit(1);
}

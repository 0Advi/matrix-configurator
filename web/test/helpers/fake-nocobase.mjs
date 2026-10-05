// TEST-ONLY in-memory stand-in for nocobase/lib/client.mjs (contract API of docs/CONTRACT.md).
// Never used at runtime: the server only ever loads the real client. Rows are stored as
// JSON text so values round-trip like they would through NocoBase's `json` columns.
let nextId = 1000;

function matches(row, filter) {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(row[k]);
    return row[k] === v;
  });
}

export function createFakeNocoBase() {
  const tables = new Map();
  const calls = [];
  const state = { up: true, failNext: null };
  const table = (c) => { if (!tables.has(c)) tables.set(c, []); return tables.get(c); };
  const store = (v) => JSON.parse(JSON.stringify(v));
  const now = () => new Date().toISOString();
  const guard = async (name) => {
    calls.push(name);
    if (!state.up) throw new Error('NocoBase unreachable (fake)');
    if (state.failNext && state.failNext.op === name) { const e = state.failNext.error; state.failNext = null; throw e; }
  };

  const client = {
    async health() { return state.up; },
    async list(c, { filter } = {}) { await guard('list'); return store(table(c).filter(r => matches(r, filter))); },
    async get(c, filter) { await guard('get'); const r = table(c).find(x => matches(x, filter)); return r ? store(r) : null; },
    async create(c, values) {
      await guard('create');
      const one = (v) => { const row = Object.assign({ id: nextId++, createdAt: now(), updatedAt: now() }, store(v)); table(c).push(row); return store(row); };
      return Array.isArray(values) ? values.map(one) : one(values);
    },
    async update(c, id, values) {
      await guard('update');
      const r = table(c).find(x => x.id === id);
      if (!r) return null;
      Object.assign(r, store(values), { updatedAt: now() });
      return store(r);
    },
    async destroy(c, filter) {
      await guard('destroy');
      if (!filter || !Object.keys(filter).length) throw new TypeError('destroy: non-empty filter required');
      tables.set(c, table(c).filter(r => !matches(r, filter)));
    },
    async replaceWhere(c, filter, rows) {
      await client.destroy(c, filter);
      return rows.length ? client.create(c, rows) : [];
    },
    async listWorkspaces() { return client.list('cfg_workspaces'); },
    async upsertWorkspace(ws) {
      const existing = await client.get('cfg_workspaces', { slug: ws.slug });
      return existing ? client.update('cfg_workspaces', existing.id, ws) : client.create('cfg_workspaces', ws);
    },
    async deleteWorkspace(slug) {
      await client.destroy('cfg_workspaces', { slug });
      for (const c of ['cfg_modules', 'cfg_gates', 'cfg_stages']) await client.destroy(c, { workspace_slug: slug });
    },
    async appendRelease(r) { return client.create('cfg_releases', r); },
    async listReleases(slug) { return (await client.list('cfg_releases', slug ? { filter: { workspace_slug: slug } } : {})).sort((a, b) => a.version - b.version); }
  };
  return { client, tables, calls, state, rows: (c) => store(table(c)) };
}

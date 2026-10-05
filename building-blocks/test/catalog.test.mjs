// CATALOG.md must index every block and give each one a provenance tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = fs.readFileSync(path.join(ROOT, 'CATALOG.md'), 'utf8');

test('every block file is listed in CATALOG.md', () => {
  const dirs = ['from-design', 'from-matrix-bd', 'from-nocobase', 'from-proposal', 'lib', 'scripts'];
  const missing = [];
  for (const d of dirs) for (const f of fs.readdirSync(path.join(ROOT, d))) {
    const p = d.startsWith('from-') ? f : `${d}/${f}`;
    if (!catalog.includes('`' + p + '`') && !catalog.includes(p)) missing.push(`${d}/${f}`);
  }
  assert.deepEqual(missing, []);
});

test('every from-* catalog row carries a provenance tag and a status', () => {
  const rows = catalog.split('\n').filter(l => /^\| (\*\*)?`[^`]+\.(json|md|mjs|css)`/.test(l) && !/^\| `(lib|scripts|test)\/|^\| `package\.json`/.test(l));
  assert.ok(rows.length >= 15, 'rows ' + rows.length);
  for (const r of rows) {
    assert.match(r, /\[(v5|v1–v5|mbd|nb|prop)\]|this workstream/, r.slice(0, 80));
    assert.match(r, /verified|inferred/, r.slice(0, 80));
  }
});

test('pinned identifiers in CATALOG.md match the blocks', () => {
  const flow = JSON.parse(fs.readFileSync(path.join(ROOT, 'from-matrix-bd/matrix-bd-flow.json'), 'utf8'));
  const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'from-design/seed-workspaces.json'), 'utf8'));
  assert.ok(catalog.includes(flow.provenance.sha));
  assert.ok(catalog.includes(seeds.provenance.sha256));
});

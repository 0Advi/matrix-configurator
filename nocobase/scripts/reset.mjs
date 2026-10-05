#!/usr/bin/env node
// Delete all ROWS from the cfg_* collections. Keeps the NocoBase instance, the collection
// definitions, users and the API key. Requires --yes.
//
//   node nocobase/scripts/reset.mjs --yes

import { createClient } from '../lib/client.mjs';
import { loadEnv } from '../lib/env.mjs';
import { COLLECTION_NAMES } from '../lib/schema.mjs';

loadEnv();
if (!process.argv.includes('--yes')) {
  console.error(`[reset] this deletes every row in: ${COLLECTION_NAMES.join(', ')}\n[reset] re-run with --yes to confirm`);
  process.exit(2);
}

const nb = createClient();
try {
  for (const name of COLLECTION_NAMES) {
    const before = (await nb.list(name, { fields: ['id'] })).length;
    // `id IS NOT NULL` matches every row; the client refuses an empty filter by design.
    await nb.destroy(name, { id: { $ne: null } });
    console.log(`[reset] ${name}: deleted ${before} row(s)`);
  }
} catch (err) {
  console.error('[reset] FAILED:', err?.message || err);
  process.exit(1);
}

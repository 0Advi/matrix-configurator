#!/usr/bin/env node
// Poll until NocoBase is up (GET /api/__health_check → 200). First boot can take minutes.
//
//   node nocobase/scripts/wait-for-nocobase.mjs [--timeout=600] [--deep]
//
// --deep also requires an authenticated read of cfg_workspaces (i.e. provisioned + creds OK).
// Exit 0 when healthy, 1 on timeout.

import { createClient } from '../lib/client.mjs';
import { loadEnv } from '../lib/env.mjs';

loadEnv();
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}`));
const timeoutSec = Number(arg('timeout')?.split('=')[1] || 600);
const deep = Boolean(arg('deep'));
const nb = createClient();
const started = Date.now();
let lastNote = 0;

process.stdout.write(`[wait] waiting for NocoBase at ${nb.baseUrl}${deep ? ' (deep)' : ''}, timeout ${timeoutSec}s `);
while (Date.now() - started < timeoutSec * 1000) {
  if (await nb.health({ deep })) {
    console.log(`\n[wait] NocoBase is up after ${Math.round((Date.now() - started) / 1000)}s`);
    process.exit(0);
  }
  if (Date.now() - lastNote > 10000) {
    process.stdout.write('.');
    lastNote = Date.now();
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error(`\n[wait] timed out after ${timeoutSec}s — check: docker compose ps && docker compose logs --tail 100 nocobase`);
process.exit(1);

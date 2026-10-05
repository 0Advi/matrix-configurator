#!/usr/bin/env node
// Test bridge: lets the Python tests drive the JS side. Reads one JSON document on stdin.
//   node cli.mjs eval              [{rule, data}, ...]  -> [{ok, result} | {ok:false, error}, ...]
//   node cli.mjs compile-manifest  manifest             -> compileManifest(manifest)
//   node cli.mjs gates             {gates:[...], facts}  -> [checkGate(g, facts), ...]
//   node cli.mjs rollups           [{rollup, checks, sum}] -> [verdict, ...]
import { createRequire } from 'node:module';
import { compileManifest, checkGate, rollupVerdict, compileGate, compileRollup } from './gates.mjs';

const require = createRequire(import.meta.url);
const jsonLogic = require('../json-logic-js/logic.js');

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
const cmd = process.argv[2];
let out;
if (cmd === 'eval') {
  out = input.map(({ rule, data }) => {
    try {
      const r = jsonLogic.apply(rule, data ?? null);
      // JSON cannot carry NaN/Infinity: tag them so the comparison stays exact.
      if (typeof r === 'number' && !Number.isFinite(r)) return { ok: true, special: String(r) };
      return { ok: true, result: r === undefined ? null : r };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
} else if (cmd === 'compile-manifest') out = compileManifest(input);
else if (cmd === 'compile-gates') out = input.map(g => compileGate(g));
else if (cmd === 'compile-rollups') out = input.map(r => compileRollup(r));
else if (cmd === 'gates') out = input.gates.map(g => checkGate(g, input.facts));
else if (cmd === 'rollups') out = input.map(x => rollupVerdict(x.rollup, x.checks, x.sum ?? null));
else { console.error('usage: cli.mjs eval|compile-manifest|compile-gates|compile-rollups|gates|rollups'); process.exit(2); }
process.stdout.write(JSON.stringify(out));

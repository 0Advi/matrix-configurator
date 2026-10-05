// Test-only bridge: node test/lint-bridge.mjs lint  <  [rule, ...]  ->  [hasProblems, ...]
import { lint } from '../gates.mjs';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const rules = JSON.parse(Buffer.concat(chunks).toString('utf8'));
process.stdout.write(JSON.stringify(rules.map(r => lint(r).length > 0)));

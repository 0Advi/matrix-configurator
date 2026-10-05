#!/usr/bin/env node
// CLI front door of the agent configurator (same core as mcp-server.mjs).
//
//   node bin/cfg.mjs ops                               list operations (one line each)
//   node bin/cfg.mjs help <op>                         description + input schema of one op
//   node bin/cfg.mjs <op> --json '{"workspace":"…"}'   run one op (also: <op> '{…}' or --file args.json)
//   node bin/cfg.mjs run --file steps.json [--keep-going]
//                                                      run [{ "op": "...", "args": {...} }, …] in ONE process
//                                                      (one platform-admin sign-in for the whole batch)
//
// Output: one JSON document on stdout — { ok: true, op, result } or { ok: false, op, error: {code, message, details?} }.
// Exit codes: 0 ok · 1 op error · 2 usage error. Nothing secret is printed except the one-time setup code
// that the first publish returns (by design, once).
import { readFileSync } from 'node:fs';
import { createContext, runOp, listOps, OPS_BY_NAME } from '../lib/ops.mjs';
import { errorPayload } from '../lib/errors.mjs';

function usage(msg) {
  const lines = [
    msg ? 'error: ' + msg : null,
    'usage: cfg <op> [--json \'{...}\' | \'{...}\' | --file args.json]',
    '       cfg ops | cfg help <op> | cfg run --file steps.json [--keep-going]',
  ].filter(Boolean);
  process.stderr.write(lines.join('\n') + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { positional: [], json: undefined, file: undefined, keepGoing: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = argv[++i];
    else if (a.startsWith('--json=')) out.json = a.slice(7);
    else if (a === '--file') out.file = argv[++i];
    else if (a.startsWith('--file=')) out.file = a.slice(7);
    else if (a === '--keep-going') out.keepGoing = true;
    else out.positional.push(a);
  }
  return out;
}

function readJSONArg(text, what) {
  try { return JSON.parse(text); } catch (e) { usage(`${what} is not valid JSON (${e.message})`); }
}

const print = obj => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

async function main() {
  const p = parseArgs(process.argv.slice(2));
  const [cmd, maybeJson] = p.positional;
  if (!cmd || cmd === '--help' || cmd === '-h') usage();

  if (cmd === 'ops') {
    for (const o of listOps()) process.stdout.write(`${o.name.padEnd(20)} ${o.readOnly ? 'read ' : o.destructive ? 'DESTR' : 'write'}  ${o.title}\n`);
    return 0;
  }
  if (cmd === 'help') {
    const o = OPS_BY_NAME[p.positional[1]];
    if (!o) usage('unknown op ' + (p.positional[1] || ''));
    print({ name: o.name, title: o.title, readOnly: !!o.readOnly, destructive: !!o.destructive, description: o.description, input: o.input });
    return 0;
  }

  const ctx = createContext();
  if (cmd === 'run') {
    if (!p.file) usage('run needs --file steps.json');
    const steps = readJSONArg(readFileSync(p.file, 'utf8'), p.file);
    if (!Array.isArray(steps)) usage('steps file must be a JSON array of {op, args}');
    const results = [];
    let failed = false;
    for (const s of steps) {
      try {
        results.push({ ok: true, op: s.op, result: await runOp(ctx, s.op, s.args || {}) });
      } catch (e) {
        failed = true;
        results.push({ ok: false, op: s.op, error: errorPayload(e) });
        if (!p.keepGoing) break;
      }
    }
    print({ ok: !failed, steps: results });
    return failed ? 1 : 0;
  }

  let args = {};
  if (p.json !== undefined) args = readJSONArg(p.json, '--json');
  else if (p.file) args = readJSONArg(readFileSync(p.file, 'utf8'), p.file);
  else if (maybeJson !== undefined) args = readJSONArg(maybeJson, 'argument');
  try {
    print({ ok: true, op: cmd, result: await runOp(ctx, cmd, args) });
    return 0;
  } catch (e) {
    print({ ok: false, op: cmd, error: errorPayload(e) });
    return 1;
  }
}

main().then(code => { process.exitCode = code; }, e => { print({ ok: false, error: errorPayload(e) }); process.exitCode = 1; });

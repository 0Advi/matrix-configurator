// Both front doors as separate processes: the MCP server over stdio driven by the official SDK
// client, and the CLI — each against the in-process configurator server and the fake platform API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startCfgServer, startFakeApp, envFor, userBlob, userFingerprint } from '../testkit/fakes.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
let cfg, app, fp0;
before(async () => { cfg = await startCfgServer(userBlob()); app = await startFakeApp(); fp0 = userFingerprint((await cfg.state()).blob); });
after(async () => { await cfg.close(); await app.close(); });

const parse = r => JSON.parse(r.content[0].text);

test('MCP round trip: list tools, design, validate, publish, status', async () => {
  let stderr = '';
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(PKG, 'mcp-server.mjs')], env: { PATH: process.env.PATH, ...envFor(cfg, app) }, stderr: 'pipe' });
  transport.stderr && transport.stderr.on('data', d => { stderr += d; });
  const client = new Client({ name: 'g1-test', version: '1.0.0' });
  await client.connect(transport);
  const texts = [];
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); texts.push(r.content[0].text); return r; };
  try {
    assert.match(client.getInstructions(), /SAME draft store as the visual Workspace Configurator/);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 28);
    const pub = tools.find(t => t.name === 'publish');
    assert.equal(pub.annotations.destructiveHint, true);
    assert.equal(tools.find(t => t.name === 'migrate_running').annotations.destructiveHint, true);
    assert.equal(tools.find(t => t.name === 'migrate_running').annotations.readOnlyHint, false);
    assert.equal(tools.find(t => t.name === 'migration_status').annotations.readOnlyHint, true);
    assert.equal(tools.find(t => t.name === 'show_workspace').annotations.readOnlyHint, true);
    assert.ok(pub.inputSchema.properties.provision.properties.admin_email);

    const bad = await call('create_workspace', { nom: 'x' });
    assert.equal(bad.isError, true);
    assert.equal(parse(bad).error.code, 'invalid_input');

    assert.equal(parse(await call('create_workspace', { name: 'MCP Cafe' })).saved, true);
    assert.equal(parse(await call('add_builtin_module', { workspace: 'mcp-cafe', key: 'bd' })).saved, true);
    const cm = parse(await call('add_custom_module', { workspace: 'mcp-cafe', name: 'Barista Training', starts_after: ['bd'], stages: [{ name: 'Training', approvers: ['executive', 'supervisor'], fields: [{ label: 'Certified', kind: 'yesno', affects_outcome: true }] }] }));
    assert.equal(cm.module.route, '/m/barista_training');
    const v = parse(await call('validate', { workspace: 'mcp-cafe' }));
    assert.equal(v.verdict, 'ready');
    const dry = parse(await call('publish', { workspace: 'mcp-cafe', reason: 'pilot', provision: { admin_email: 'owner@mcp-cafe.test' } }));
    assert.equal(dry.dry_run, true);
    assert.equal(dry.provisioning.will_provision, true);
    const done = parse(await call('publish', { workspace: 'mcp-cafe', reason: 'pilot', confirm: true, provision: { admin_email: 'owner@mcp-cafe.test' } }));
    assert.equal(done.app_release.version, 1);
    assert.ok(done.provisioned.setup_code);
    const st = parse(await call('release_status', { workspace: 'mcp-cafe' }));
    assert.equal(st.in_sync, true);
    const mig = parse(await call('migrate_running', { workspace: 'mcp-cafe' }));
    assert.equal(mig.dry_run, true, 'migrate_running is a dry run by default');
    assert.equal(mig.workspace.id, 'ws_mcp_cafe');
    assert.equal(app.st.migrations.length, 0);
    const noReason = await call('migrate_running', { workspace: 'mcp-cafe', confirm: true });
    assert.equal(noReason.isError, true);
    assert.equal(parse(noReason).error.code, 'invalid_input');
    assert.equal(parse(await call('migration_status', { workspace: 'mcp-cafe' })).count, 0);
  } finally {
    await client.close();
  }
  const all = texts.join('\n') + stderr;
  assert.equal(all.includes(app.creds.password), false);
  for (const t of app.st.tokens) assert.equal(all.includes(t), false);
  assert.equal(app.st.logins, 1, 'one sign-in for the whole session');
  assert.deepEqual(userFingerprint((await cfg.state()).blob), fp0);
});

test('CLI: ops, help, single op, batch run with one sign-in, exit codes', async () => {
  const env = { PATH: process.env.PATH, ...envFor(cfg, app) };
  // async: the fake servers live in this process and must keep answering while the CLI runs
  const cli = (...a) => new Promise(resolve => execFile(process.execPath, [path.join(PKG, 'bin', 'cfg.mjs'), ...a], { env, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr })));
  const ops = await cli('ops');
  assert.equal(ops.status, 0);
  assert.match(ops.stdout, /publish\s+DESTR/);
  assert.equal(JSON.parse((await cli('help', 'add_field')).stdout).name, 'add_field');
  assert.equal((await cli()).status, 2);
  const c = await cli('create_workspace', '--json', '{"name":"CLI Cafe"}');
  assert.equal(c.status, 0, c.stderr);
  assert.equal(JSON.parse(c.stdout).result.workspace.id, 'ws_cli_cafe');
  const e = await cli('show_workspace', '{"workspace":"nope"}');
  assert.equal(e.status, 1);
  assert.equal(JSON.parse(e.stdout).error.code, 'not_found');

  const dir = mkdtempSync(path.join(tmpdir(), 'g1-cli-'));
  try {
    const steps = path.join(dir, 'steps.json');
    writeFileSync(steps, JSON.stringify([
      { op: 'add_builtin_module', args: { workspace: 'cli-cafe', key: 'bd' } },
      { op: 'add_custom_module', args: { workspace: 'cli-cafe', name: 'Menu Check', starts_after: ['bd'] } },
      { op: 'validate', args: { workspace: 'cli-cafe' } },
      { op: 'release_status', args: { workspace: 'cli-cafe' } },
      { op: 'delete_workspace', args: { workspace: 'cli-cafe', confirm: true } },
    ]));
    const logins = app.st.logins;
    const r = await cli('run', '--file', steps);
    assert.equal(r.status, 0, r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(out.steps.length, 5);
    assert.equal(out.steps[2].result.verdict, 'ready');
    assert.equal(app.st.logins - logins, 1, 'one sign-in for the whole batch');
    assert.equal(r.stdout.includes(app.creds.password), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

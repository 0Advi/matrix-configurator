// The platform API client rides out a backend restart (connection refused / 502-504 for ~15 s)
// without ever re-sending a provision or publish the app may already have processed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAppClient } from '../lib/app-api.mjs';

function freePort() {
  return new Promise(r => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const creds = () => ({ email: 'a@example.test', password: 'pw-test-only' });
function backend(port, handler) {
  const s = http.createServer(handler);
  return new Promise(r => s.listen(port, '127.0.0.1', () => r(s)));
}
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const token = 'x.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1800 })).toString('base64url') + '.y';

test('a backend that comes back within the budget is waited for (connection refused → retry)', async () => {
  const port = await freePort();
  let server;
  setTimeout(async () => {
    server = await backend(port, (req, res) => {
      if (req.url.endsWith('/tenancy/admin/login')) return json(res, 200, { token });
      return json(res, 200, { ok: true, errors: 0, warnings: 0, findings: [], modules: [] });
    });
  }, 1200);
  const c = createAppClient({ apiUrl: `http://127.0.0.1:${port}/api`, credentials: creds });
  const v = await c.validate('ws_x', { modules: [] });
  assert.equal(v.ok, true);
  assert.ok(c.retryCount >= 1);
  await new Promise(r => server.close(r));
});

test('502/503 are retried for reads and the dry run, never for publish/provision', async () => {
  const port = await freePort();
  const hits = { validate: 0, publish: 0, provision: 0 };
  let flaky = 2;
  const server = await backend(port, (req, res) => {
    if (req.url.endsWith('/tenancy/admin/login')) return json(res, 200, { token });
    if (req.url.endsWith('/validate')) { hits.validate++; return flaky-- > 0 ? json(res, 502, { detail: 'bad gateway' }) : json(res, 200, { ok: true, errors: 0 }); }
    if (req.url.endsWith('/releases')) { hits.publish++; return json(res, 502, { detail: 'bad gateway' }); }
    if (req.url.endsWith('/platform/workspaces')) { hits.provision++; return json(res, 503, { detail: 'starting' }); }
    return json(res, 404, {});
  });
  try {
    const c = createAppClient({ apiUrl: `http://127.0.0.1:${port}/api`, credentials: creds, sleep: () => Promise.resolve() });
    assert.equal((await c.validate('ws_x', {})).ok, true);
    assert.equal(hits.validate, 3);
    await assert.rejects(c.publish('ws_x', { manifest: {} }), e => e.code === 'app_error');
    assert.equal(hits.publish, 1, 'publish sent once');
    await assert.rejects(c.provision({ configurator_ref: 'ws_x' }), e => e.code === 'app_error');
    assert.equal(hits.provision, 1, 'provision sent once');
  } finally { await new Promise(r => server.close(r)); }
});

test('a backend that stays down is reported as unavailable after the budget', async () => {
  const port = await freePort();
  const c = createAppClient({ apiUrl: `http://127.0.0.1:${port}/api`, credentials: creds, retryBudgetMs: 1500 });
  const t0 = Date.now();
  await assert.rejects(c.getWorkspace('ws_x'), e => e.code === 'unavailable' && /may be restarting/.test(e.message));
  assert.ok(Date.now() - t0 >= 450, "waited before giving up");
});

// Bridge logic: debounce, publish detection, manifest, hydration decisions, and the boot
// adaptations (prevState shim, offline template rewrite) — against the real v5 logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectPublishes, buildManifest, decideHydration, createDebouncer, publisherFromMeta,
  canonicalJSON, sameBlob, parseBlob, hasState
} from '../public/bridge-core.js';
import { installPrevStateShim, offlineTemplate, extractTemplate, VENDOR, SRI, FONT_CSS } from '../public/boot.js';
import { loadV5, createWorkspaceVia, publishVia, readBlob, DC_FILE } from './helpers/v5-harness.mjs';

function fakeClock() {
  let t = 0;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    }
  };
}

// ---------------------------------------------------------------- runtime bug + shim
test('stock dc-runtime semantics: v5 componentDidUpdate throws and never persists', () => {
  const h = loadV5({ reactPrevState: false });
  const c = h.create();
  assert.throws(() => c.setState({ vw: 1200 }), /Cannot read properties of undefined \(reading 'customWs'\)/);
  assert.equal(h.storage.getItem('wsconfig_v5_custom'), null);
});

test('prevState shim makes v5 persist under the stock runtime calling convention', () => {
  const h = loadV5({ reactPrevState: false }); // runtime passes prevProps only
  assert.equal(installPrevStateShim(h.Component), true);
  assert.equal(installPrevStateShim(h.Component), false, 'idempotent');
  const c = h.create();
  c.componentDidMount(); // the runtime calls this after the first commit
  c.setState({ vw: 1200 }); // no-op update: nothing persisted, nothing thrown
  assert.equal(h.storage.getItem('wsconfig_v5_custom'), null);
  createWorkspaceVia(c, { name: 'Third Wave', slug: 'third-wave', start: 'template' });
  const blob = readBlob(h.storage);
  assert.equal(blob.customWs[0].slug, 'third-wave');
  assert.equal(blob.data.ws_third_wave.modules.length, 9);
});

test('prevState shim passes a real prevState through untouched', () => {
  let seen;
  class L { componentDidUpdate(pp, ps) { seen = ps; } }
  installPrevStateShim(L);
  const l = new L();
  l.state = { a: 1 };
  const real = { a: 0 };
  l.componentDidUpdate({}, real);
  assert.equal(seen, real);
});

// ---------------------------------------------------------------- offline template
test('offline template rewrite removes every Google Fonts reference', () => {
  const src = readFileSync(DC_FILE, 'utf8');
  const tpl = extractTemplate(src);
  assert.ok(tpl.trimStart().startsWith('<helmet>'));
  assert.ok(/fonts\.googleapis\.com/.test(tpl), 'v5 template references Google Fonts');
  const out = offlineTemplate(tpl);
  assert.equal(/fonts\.(googleapis|gstatic)\.com/.test(out), false);
  assert.equal(out.split(`<link rel="stylesheet" href="${FONT_CSS}">`).length - 1, 1);
  const out2 = offlineTemplate(tpl, { pageHasFonts: true });
  assert.equal(/<link\b/i.test(out2.slice(0, 2000)), false);
  assert.equal(out.length < tpl.length, true);
  assert.equal(/https?:\/\//.test(out), false, 'no absolute URLs left in the template');
});

test('vendor map covers exactly the CDN URLs hard-coded in support.js', () => {
  const support = readFileSync(new URL('../public/support.js', import.meta.url), 'utf8');
  const urls = [...support.matchAll(/"(https:\/\/unpkg\.com\/[^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(Object.keys(VENDOR).sort(), urls);
  for (const [cdn, local] of Object.entries(VENDOR)) assert.equal(local, '/vendor/' + cdn.replace('https://unpkg.com/', ''));
  // SRI constants in boot.js equal the ones in support.js
  const sri = Object.fromEntries([...support.matchAll(/var (\w+)_SRI = "([^"]+)"/g)].map(m => [m[1], m[2]]));
  assert.equal(SRI['/vendor/react@18.3.1/umd/react.production.min.js'], sri.REACT);
  assert.equal(SRI['/vendor/react-dom@18.3.1/umd/react-dom.production.min.js'], sri.REACT_DOM);
});

// ---------------------------------------------------------------- publish detection
test('publish in the real v5 flow is detected with the typed reason and v5 manifest', () => {
  const h = loadV5();
  const c = h.create();
  createWorkspaceVia(c, { name: 'Third Wave', slug: 'third-wave', start: 'template' });
  const before = readBlob(h.storage);
  assert.deepEqual(detectPublishes(null, before), [], 'creating a workspace is not a publish');

  publishVia(c, 'Customer request #9001 — go live');
  const after = readBlob(h.storage);
  const rel = detectPublishes(before, after);
  assert.equal(rel.length, 1);
  assert.equal(rel[0].workspace_slug, 'third-wave');
  assert.equal(rel[0].version, 1);
  assert.equal(rel[0].reason, 'Customer request #9001 — go live');
  assert.equal(rel[0].published_by, 'platform:ops@matrix.io');
  assert.equal(rel[0].lines.length, 4);
  // identical to what v5's own "Draft manifest" shows right after publishing
  assert.deepEqual(rel[0].manifest, JSON.parse(JSON.stringify(c.manifest())));
  assert.deepEqual(detectPublishes(after, after), [], 'no publish when liveV did not move');
});

test('two publishes inside one debounce window yield two releases, manifest only on the newest', () => {
  const h = loadV5();
  const c = h.create();
  createWorkspaceVia(c, { name: 'Third Wave', slug: 'third-wave', start: 'template' });
  const before = readBlob(h.storage);
  publishVia(c, 'first');
  c.patchModule('bd', { name: 'BD (renamed)' });
  publishVia(c, 'second');
  const rel = detectPublishes(before, readBlob(h.storage));
  assert.deepEqual(rel.map(r => [r.version, r.reason, !!r.manifest]), [[1, 'first', false], [2, 'second', true]]);
  assert.equal(rel[1].manifest.workspace.live_version, 'v2');
  assert.equal(rel[1].manifest.modules.find(m => m.key === 'bd').name, 'BD (renamed)');
});

test('first-run migration backfills releases from v5 history', () => {
  const h = loadV5();
  const c = h.create();
  createWorkspaceVia(c, { name: 'Third Wave', slug: 'third-wave', start: 'template' });
  publishVia(c, 'one');
  createWorkspaceVia(c, { name: 'Other', slug: 'other', start: 'empty' });
  const rel = detectPublishes({}, readBlob(h.storage));
  assert.deepEqual(rel.map(r => [r.workspace_slug, r.version, r.reason]), [['third-wave', 1, 'one']]);
});

test('buildManifest mirrors v5 manifest() for the draft too', () => {
  const h = loadV5();
  const c = h.create();
  const id = createWorkspaceVia(c, { name: 'Third Wave', slug: 'third-wave', start: 'template' });
  const stash = readBlob(h.storage).data[id];
  const cw = c.state.customWs[0];
  assert.deepEqual(buildManifest(cw, stash, { source: 'draft' }), JSON.parse(JSON.stringify(c.manifest())));
});

test('publisherFromMeta parses v5 history meta', () => {
  assert.equal(publisherFromMeta('11 Sep 2026 · platform:ops@matrix.io'), 'platform:ops@matrix.io');
  assert.equal(publisherFromMeta(''), 'platform:ops@matrix.io');
});

// ---------------------------------------------------------------- hydration decisions
test('decideHydration covers local, none, pull, push, conflict', () => {
  const A = { customWs: [{ id: 'ws_a', slug: 'a' }], data: { ws_a: { liveV: 0 } } };
  const B = { customWs: [{ id: 'ws_b', slug: 'b' }], data: {} };
  const d = (o) => decideHydration(Object.assign({ mode: 'nocobase', serverBlob: {}, serverEtag: '"e0"', localRaw: null, meta: null }, o)).action;
  assert.equal(d({ mode: 'local' }), 'local');
  assert.equal(d({}), 'none');
  assert.equal(d({ localRaw: JSON.stringify(A) }), 'push', 'first-run migration');
  assert.equal(d({ serverBlob: A }), 'pull');
  assert.equal(d({ serverBlob: A, localRaw: JSON.stringify(A) }), 'pull', 'already in sync');
  assert.equal(d({ serverBlob: A, serverEtag: '"e1"', localRaw: JSON.stringify(B), meta: { dirty: true, base: '"e1"' } }), 'push', 'offline edits on top of current server');
  assert.equal(d({ serverBlob: A, serverEtag: '"e2"', localRaw: JSON.stringify(B), meta: { dirty: true, base: '"e1"' } }), 'conflict');
  assert.equal(d({ serverBlob: A, localRaw: JSON.stringify(B), meta: { dirty: false, base: '"e1"' } }), 'pull', 'clean browser copy is just stale');
  assert.equal(d({ serverBlob: A, localRaw: JSON.stringify(B), meta: null }), 'conflict', 'unknown provenance: back up, server wins');
  assert.equal(d({ serverBlob: A, localRaw: 'not json' }), 'pull');
});

test('blob helpers', () => {
  assert.equal(canonicalJSON({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
  assert.ok(sameBlob({ a: 1, b: 2 }, { b: 2, a: 1 }));
  assert.equal(parseBlob('nope'), null);
  assert.equal(parseBlob('[]'), null);
  assert.equal(hasState({}), false);
  assert.equal(hasState({ customWs: [{}] }), true);
});

// ---------------------------------------------------------------- debounce
test('debouncer: trailing 600ms, coalesces bursts', () => {
  const clk = fakeClock();
  let n = 0;
  const d = createDebouncer(() => n++, { wait: 600, maxWait: 3000, setTimer: clk.setTimer, clearTimer: clk.clearTimer, now: clk.now });
  d.trigger(); clk.advance(300); d.trigger(); clk.advance(300); d.trigger();
  assert.equal(n, 0);
  clk.advance(599); assert.equal(n, 0);
  clk.advance(1); assert.equal(n, 1);
  assert.equal(d.pending, false);
});

test('debouncer: maxWait forces a flush during continuous writes (node drag)', () => {
  const clk = fakeClock();
  const fired = [];
  const d = createDebouncer(() => fired.push(clk.now()), { wait: 600, maxWait: 3000, setTimer: clk.setTimer, clearTimer: clk.clearTimer, now: clk.now });
  for (let i = 0; i < 400; i++) { d.trigger(); clk.advance(16); } // ~6.4s of 60fps writes
  assert.deepEqual(fired, [3000, 6008]); // the second burst starts at the first write after the flush (t=3008)
  clk.advance(600);
  assert.equal(fired.length, 3);
});

test('debouncer: flushNow and cancel', () => {
  const clk = fakeClock();
  let n = 0;
  const d = createDebouncer(() => n++, { setTimer: clk.setTimer, clearTimer: clk.clearTimer, now: clk.now });
  d.trigger(); d.flushNow(); assert.equal(n, 1);
  d.trigger(); d.cancel(); clk.advance(5000); assert.equal(n, 1);
});

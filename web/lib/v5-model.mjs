// Evaluates the REAL v5 `class Component extends DCLogic` (from public/configurator.dc.html)
// in Node with a minimal DCLogic/React shim. Used by:
//   - the server, to seed the three built-in demo workspaces into NocoBase (read-only
//     reference rows; v5 itself never persists them), and
//   - the tests, to run projection / publish detection against real v5 data.
//
// The shim's setState applies updates synchronously and then calls
// componentDidUpdate(props, prevState) — React class-component semantics, which is what
// public/boot.js restores in the browser (see CHANGES.md, "prevState shim").
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DC_FILE = fileURLToPath(new URL('../public/configurator.dc.html', import.meta.url));

export function extractLogicSource(html) {
  const m = /<script\b[^>]*\bdata-dc-script\b[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) throw new Error('no <script data-dc-script> in document');
  return m[1];
}

export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: k => { map.delete(k); },
    clear: () => map.clear(),
    get length() { return map.size; },
    key: i => [...map.keys()][i] ?? null
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.file]            dc document to load (default: public/configurator.dc.html)
 * @param {object} [opts.storage]         localStorage stand-in (default: fresh in-memory)
 * @param {boolean} [opts.reactPrevState] pass prevState to componentDidUpdate (default true);
 *                                        false reproduces the stock dc-runtime (prevProps only)
 */
export function loadV5(opts = {}) {
  const html = readFileSync(opts.file || DC_FILE, 'utf8');
  const src = extractLogicSource(html);
  const storage = opts.storage || createMemoryStorage();
  const reactPrevState = opts.reactPrevState !== false;
  const timers = [];

  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(update, cb) {
      const prev = this.state;
      const patch = typeof update === 'function' ? update(prev) : update;
      this.state = Object.assign({}, prev, patch);
      if (this.__mounted) {
        if (reactPrevState) this.componentDidUpdate(this.props, prev);
        else this.componentDidUpdate(this.props);
      }
      if (cb) cb();
    }
    forceUpdate() {}
    componentDidMount() {}
    componentDidUpdate() {}
    componentWillUnmount() {}
    renderVals() { return {}; }
  }
  const React = { createRef: () => ({ current: null }) };
  const fakeWindow = { innerWidth: 1500, addEventListener() {}, removeEventListener() {} };
  const fakeSetTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const fakeClearTimeout = () => {};
  const fakeNavigator = { clipboard: { writeText() {} } };

  // The document is our own shipped file (public/configurator.dc.html), not user input.
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'DCLogic', 'StreamableLogic', 'React', 'localStorage', 'window', 'setTimeout', 'clearTimeout', 'navigator',
    src + '\n;return Component;'
  );
  const Component = factory(DCLogic, DCLogic, React, storage, fakeWindow, fakeSetTimeout, fakeClearTimeout, fakeNavigator);

  function create(props = {}) {
    const c = new Component(Object.assign({ startWorkspace: 'bluetokai', skipPicker: false, previewDensity: 'comfortable' }, props));
    c.__mounted = true; // later setState calls behave like post-mount React updates
    return c;
  }
  return { Component, create, storage, timers };
}

/**
 * The three demo workspaces v5 ships with (wsList minus custom ones), each as
 * { workspace: {id, name, slug}, initials, stash } where stash has the same shape v5 uses
 * for custom workspaces ({modules, perms, live, liveV, draftV, history}).
 */
export function builtinWorkspaces(opts = {}) {
  const { create } = loadV5(opts);
  const c = create({ startWorkspace: 'bluetokai' });
  const list = c.wsList().filter(w => !w.custom);
  return list.map(w => {
    if (c.state.ws !== w.id) c.loadTenant(w.id);
    const meta = c.tenantMeta(w.id) || {};
    return {
      workspace: { id: w.id, name: w.name, slug: w.slug },
      initials: meta.initials || String(w.name).slice(0, 2).toUpperCase(),
      stash: c.stashOf(c.state)
    };
  });
}

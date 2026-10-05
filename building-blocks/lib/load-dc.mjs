// Loads the ORIGINAL `class Component extends DCLogic` from a design-artifact
// `.dc.html` file and evaluates it in an isolated Node `vm` context with a
// minimal shim (DCLogic, React.createRef, fake localStorage, no-op timers).
//
// This is how every JSON file under from-design/ is generated and how the
// parity tests compare the ported validation functions against the source.
// Read-only: it never writes to sources/.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DESIGN_DIR = path.resolve(HERE, '../../sources/design-artifact');

export function artifactPath(version = 5) {
  return path.join(DESIGN_DIR, `Workspace Configurator v${version}.dc.html`);
}

export function readArtifact(version = 5) {
  const file = artifactPath(version);
  const html = fs.readFileSync(file, 'utf8');
  const sha256 = crypto.createHash('sha256').update(html).digest('hex');
  const script = html.match(/<script type="text\/x-dc" data-dc-script[^>]*>([\s\S]*?)\n<\/script>/);
  const template = html.match(/<x-dc>([\s\S]*?)<\/x-dc>/);
  const style = html.match(/<helmet>[\s\S]*?<style>([\s\S]*?)<\/style>[\s\S]*?<\/helmet>/);
  const props = html.match(/data-dc-script data-props="([^"]*)"/);
  return {
    file,
    sha256,
    html,
    script: script ? script[1] : '',
    template: template ? template[1] : '',
    style: style ? style[1] : '',
    dataProps: props ? JSON.parse(props[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')) : null,
  };
}

function makeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    clear: () => store.clear(),
    _dump: () => Object.fromEntries(store),
  };
}

/**
 * Evaluate the artifact's Component class.
 * @param {number} version 1..5
 * @param {{ localStorage?: object }} [opts]
 * @returns {{ Component: Function, localStorage: object, sha256: string, file: string }}
 */
export function loadComponent(version = 5, opts = {}) {
  const art = readArtifact(version);
  const localStorage = makeLocalStorage(opts.localStorage || {});
  class DCLogic {
    constructor(props) { this.props = props || {}; }
    // Synchronous setState so methods that update state can be exercised in tests.
    setState(update, cb) {
      const patch = typeof update === 'function' ? update(this.state, this.props) : update;
      if (patch) this.state = Object.assign({}, this.state, patch);
      if (typeof cb === 'function') cb();
    }
  }
  const sandbox = {
    DCLogic,
    React: { createRef: () => ({ current: null }) },
    localStorage,
    setTimeout: () => 0,
    clearTimeout: () => {},
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    console,
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(art.script + '\n;globalThis.Component = Component;', sandbox, { filename: path.basename(art.file) });
  return { Component: sandbox.Component, localStorage, sha256: art.sha256, file: art.file };
}

/** Deep JSON clone that also strips functions (e.g. replay `apply`). */
export function plain(x) { return JSON.parse(JSON.stringify(x)); }

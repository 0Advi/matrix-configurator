// Boots the v5 design document (configurator.dc.html) full-page on the stock dc-runtime
// (support.js), fully offline. Neither file is modified; everything is adapted from here
// through the runtime's own hooks. See ../CHANGES.md for the rationale of each step.
//
// Sequence (run AFTER storage-bridge.js has hydrated localStorage):
//   1. window.__resources maps the runtime's unpkg URLs to /vendor (its offline hook).
//   2. React + ReactDOM are loaded from /vendor with the runtime's own SRI hashes, so
//      support.js finds window.React/ReactDOM and never builds a CDN <script>.
//   3. The dc document is fetched as text; the template is taken verbatim from the
//      <x-dc>…</x-dc> source (like the runtime's parseDcText) and its Google Fonts
//      <link>s are rewritten to the vendored IBM Plex stylesheet.
//   4. support.js is loaded while the page has NO <x-dc> yet, so its auto-boot is a no-op.
//   5. An empty <x-dc> + the logic <script data-dc-script> are inserted and window.__dcBoot()
//      is called; synchronously after it (before React's first render) we
//        - install the prevState shim on the logic class, and
//        - hand the runtime the raw template via __dcUpdate(root, 'html', …).
export const DC_URL = '/configurator.dc.html';
export const SUPPORT_URL = '/support.js';

export const VENDOR = {
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js': '/vendor/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': '/vendor/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js': '/vendor/@babel/standalone@7.29.0/babel.min.js'
};
// Same values as REACT_SRI / REACT_DOM_SRI in support.js; the vendored files are the exact
// npm tarball bytes, so the hashes match (verified in test/vendor.test.mjs).
export const SRI = {
  '/vendor/react@18.3.1/umd/react.production.min.js': 'sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z',
  '/vendor/react-dom@18.3.1/umd/react-dom.production.min.js': 'sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1'
};
export const FONT_CSS = '/vendor/fonts/ibm-plex.css';

/** The template source between <x-dc …> and the LAST </x-dc>, exactly as the runtime's parseDcText does. */
export function extractTemplate(src) {
  const open = /<x-dc(?:\s[^>]*)?>/.exec(src);
  if (!open) return null;
  const close = src.lastIndexOf('</x-dc>');
  if (close === -1 || close < open.index) return null;
  return src.slice(open.index + open[0].length, close);
}

/**
 * Replace the Google Fonts <link>s (preconnects + stylesheet) with the vendored stylesheet.
 * With `pageHasFonts` (index.html already links it) the stylesheet link is dropped instead,
 * so the @font-face rules are not registered twice.
 */
export function offlineTemplate(template, { pageHasFonts = false } = {}) {
  let replaced = false;
  return template.replace(/<link\b[^>]*\bhref\s*=\s*["']https?:\/\/fonts\.(?:googleapis|gstatic)\.com[^"']*["'][^>]*>\s*/gi, (tag) => {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag) || replaced || pageHasFonts) return '';
    replaced = true;
    return `<link rel="stylesheet" href="${FONT_CSS}">\n`;
  });
}

/**
 * The stock runtime calls logic.componentDidUpdate(prevProps) — without React's second
 * argument, prevState. v5's componentDidUpdate(pp, ps) dereferences ps.customWs, so every
 * update throws (caught and logged by the runtime) and v5 never reaches its
 * localStorage.setItem. This wraps the class so componentDidUpdate receives the logic state
 * as of the previous commit, matching React semantics. No-op if the runtime already passes it.
 */
export function installPrevStateShim(Logic) {
  const proto = Logic && Logic.prototype;
  if (!proto || proto.__cfgPrevStateShim) return false;
  const didUpdate = proto.componentDidUpdate;
  if (typeof didUpdate !== 'function' || didUpdate.length < 2) return false;
  const didMount = proto.componentDidMount;
  const committed = new WeakMap();
  Object.defineProperty(proto, 'componentDidMount', {
    configurable: true, writable: true,
    value: function componentDidMount(...args) {
      committed.set(this, this.state);
      return typeof didMount === 'function' ? didMount.apply(this, args) : undefined;
    }
  });
  Object.defineProperty(proto, 'componentDidUpdate', {
    configurable: true, writable: true,
    value: function componentDidUpdate(prevProps, prevState) {
      const ps = prevState !== undefined ? prevState : (committed.get(this) || {});
      committed.set(this, this.state);
      return didUpdate.call(this, prevProps, ps);
    }
  });
  Object.defineProperty(proto, '__cfgPrevStateShim', { value: true });
  return true;
}

function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; }
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(url + ' returned HTTP ' + res.status);
  return res.text();
}

// setTimeout rather than requestAnimationFrame: rAF never fires in a background tab
function nextFrame() { return new Promise((r) => setTimeout(r, 16)); }

export async function bootConfigurator({ docUrl = DC_URL, supportUrl = SUPPORT_URL } = {}) {
  window.__resources = Object.assign({}, window.__resources || {}, VENDOR);

  const reactReady = window.React && window.ReactDOM
    ? Promise.resolve()
    : Promise.all(Object.keys(SRI).map((src) => loadScript(src, SRI[src])));
  const [src] = await Promise.all([fetchText(docUrl), reactReady]);

  const template = extractTemplate(src);
  if (template == null) throw new Error(docUrl + ' has no <x-dc> block');
  const parsed = new DOMParser().parseFromString(src, 'text/html');
  const logicEl = parsed.querySelector('script[data-dc-script]');
  if (!logicEl) throw new Error(docUrl + ' has no <script data-dc-script>');
  if (document.querySelector('x-dc')) throw new Error('page already contains an <x-dc> element');

  await loadScript(supportUrl);
  for (let i = 0; typeof window.__dcBoot !== 'function'; i++) {
    if (i > 200) throw new Error('dc-runtime did not initialise');
    await new Promise((r) => setTimeout(r, 10));
  }

  const mount = document.createElement('x-dc');
  const script = document.createElement('script');
  script.type = 'text/x-dc';
  script.setAttribute('data-dc-script', '');
  const props = logicEl.getAttribute('data-props');
  if (props != null) script.setAttribute('data-props', props);
  script.textContent = logicEl.textContent;
  document.body.append(mount, script);

  window.__dcBoot();
  const root = window.__dcRootName();
  const entry = window.__dcRegistry && window.__dcRegistry[root];
  if (!entry || !entry.Logic) throw new Error('logic failed to evaluate: ' + (entry && entry.logicError || 'unknown error'));
  installPrevStateShim(entry.Logic);
  const pageHasFonts = !!document.querySelector(`link[rel="stylesheet"][href="${FONT_CSS}"]`);
  window.__dcUpdate(root, 'html', offlineTemplate(template, { pageHasFonts }), false);

  // resolve once React has committed the first real frame
  for (let i = 0; i < 300; i++) {
    await nextFrame();
    const host = document.querySelector('#dc-root > .sc-host');
    if (host && host.childElementCount > 0 && !host.querySelector(':scope > .sc-placeholder')) break;
  }
  return root;
}

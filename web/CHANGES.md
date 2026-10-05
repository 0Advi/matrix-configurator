# Changes to the Claude Design files

## Summary

**Neither design file is modified.** Both are byte-identical copies of the inputs
(`test/vendor.test.mjs` checks this against `sources/`):

| File | Source | sha256 |
|---|---|---|
| `public/configurator.dc.html` | `sources/design-artifact/Workspace Configurator v5.dc.html` | `b30033e932d4702924b3ad1b831aacf48eda0bcb7e262750d82f37ba52f55bda` |
| `public/support.js` (dc-runtime) | `sources/design-artifact/support.js` | `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` |

Everything needed to run them offline and persist through the server is done **from the
outside** in `public/boot.js`, using hooks the runtime already exposes on `window`
(`__resources`, `__dcBoot`, `__dcRootName`, `__dcRegistry`, `__dcUpdate`). A future design
export can therefore be dropped in by copying the two files again.

## Adaptations made at boot (public/boot.js)

### 1. React / ReactDOM / Babel from `/vendor` instead of unpkg (support.js unchanged)

`support.js` hard-codes three unpkg URLs with SRI hashes (`REACT_URL`, `REACT_DOM_URL`,
`BABEL_URL`, lines ~1143-1148) and resolves them through `cdnScriptFor(url, sri)`, which
first looks the URL up in `window.__resources` (the runtime's own offline/bundle hook).

- `boot.js` sets `window.__resources = { <unpkg url>: '/vendor/<same path>' }` for all three.
- It also loads React and ReactDOM itself, from `/vendor`, **with the runtime's original SRI
  hashes** (`integrity` + `crossorigin`). The vendored files are the exact npm tarball bytes,
  so the hashes match and integrity stays enforced. `loadReactUmd()` then sees
  `window.React && window.ReactDOM` and never creates a CDN `<script>`.
- Babel is only requested by the runtime for `x-import` of `.jsx/.tsx` modules, which v5 does
  not use; if that path is ever hit, `__resources` sends it to `/vendor` (without SRI, which is
  how the runtime treats any `__resources` entry).

The unpkg strings that remain in `support.js` are therefore unreachable defaults.

### 2. Google Fonts → vendored IBM Plex (configurator.dc.html unchanged)

The template's `<helmet>` contains three `<link>`s to `fonts.googleapis.com` /
`fonts.gstatic.com` (two `preconnect`s and the css2 stylesheet). `boot.js` reads the template
as text and, before handing it to the runtime, rewrites them (`offlineTemplate()`):
the preconnects are dropped and the stylesheet becomes `/vendor/fonts/ibm-plex.css` (or is
dropped when `index.html` already links that file, so `@font-face` rules aren't registered
twice). The browser makes **zero** requests to non-localhost hosts (verified in the browser's
network log).

### 3. Template taken from the raw source text

When a dc document boots itself, the runtime first compiles the DOM-parsed `<x-dc>` and then
re-fetches `location.href` to recompile from the raw text (the HTML parser would mangle
`<select>`/`<table>` content; the runtime's `encodeCase` handles the raw text). Because the app
is served from `index.html`, not from the dc file, `boot.js` does that step explicitly:
it extracts the text between `<x-dc>` and the last `</x-dc>` (same rule as the runtime's
`parseDcText`) and passes it via `__dcUpdate(root, 'html', template)` right after `__dcBoot()`,
before React's first render. (`__resources` being set also stops the runtime from re-fetching
`index.html`.)

### 4. prevState shim — v5's persistence never ran under the stock runtime (bug fix)

v5 persists custom workspaces in `componentDidUpdate(pp, ps)`:

```js
componentDidUpdate(pp, ps) {
  const s = this.state;
  if (ps.customWs === s.customWs && ...) return;   // ← ps is undefined
  ...
  localStorage.setItem('wsconfig_v5_custom', JSON.stringify({ customWs: s.customWs, data }));
}
```

but the stock runtime calls it as `this.logic.componentDidUpdate(prevProps)` — **without React's
second argument**. `ps.customWs` throws `TypeError: Cannot read properties of undefined (reading
'customWs')` on every state update (caught and logged by the runtime as a console error), so
`localStorage.setItem` is never reached: **the original artifact never persisted anything.**
(Reproduced in `test/bridge.test.mjs`, "stock dc-runtime semantics".)

`installPrevStateShim(Logic)` wraps the logic class's `componentDidMount` /
`componentDidUpdate` so the latter receives the logic state as of the previous commit — exactly
React's `prevState`. It is a no-op if a future runtime passes `prevState` itself, or if a
logic class doesn't declare a second parameter. The shim is installed synchronously after
`__dcBoot()` (the class is evaluated by then) and before the first render/mount.

### 5. Manual boot order

`support.js` auto-boots on load if the page contains `<x-dc>`. `boot.js` loads it while the page
has **no** `<x-dc>` (auto-boot is a no-op), then inserts an empty `<x-dc>` plus the logic
`<script type="text/x-dc" data-dc-script data-props=…>` copied from the dc file, and calls
`window.__dcBoot()` itself. This is what lets `storage-bridge.js` hydrate localStorage first and
lets steps 3 and 4 run before the first render.

## Known behaviours of v5 that are kept as-is

- v5 persists **only custom (user-created) workspaces**. Edits to the three demo workspaces
  (Blue Tokai, Starbucks, Burger King) live in memory and reset on reload, exactly as designed.
- Publish metadata in v5 is hard-coded: history entries say `11 Sep 2026 · platform:ops@matrix.io`.
  Releases therefore record `published_by = platform:ops@matrix.io`; the real publish time is
  the row's `createdAt` in NocoBase.
- The "New workspace" dialog in v5 still says "Saved in this browser." (template text).
- `wsList()` in v5 lists bluetokai / starbucks / burgerking. The `startWorkspace` prop's enum
  says `bluetokai` / `thirdwave` / `chaayos`, but v5 has no seed for the latter two
  (`replaySteps()` falls through to the Burger King steps for any tenant other than Starbucks).
  The app boots with the default (`bluetokai`) and the picker, so this is never hit.

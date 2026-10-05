# Vendored runtime dependencies

Downloaded **once** from the npm registry with `npm pack` (registry.npmjs.org tarballs) on
2026-10-03 and committed here so the app never touches a CDN at runtime. Paths mirror the
unpkg URLs that `support.js` (the dc-runtime) has hard-coded, which makes the redirect in
`boot.js` (`window.__resources`) a 1:1 mapping.

| Package | Version | npm tarball shasum (sha1) | File served | sha256 | SRI (sha384) |
|---|---|---|---|---|---|
| `react` | 18.3.1 | `49ab892009c53933625bd16b2533fc754cab2891` | `react@18.3.1/umd/react.production.min.js` (10 751 B) | `d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd` | `sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z` |
| `react-dom` | 18.3.1 | `c2265d79511b57d479b3dd3fdfa51536494c5cb4` | `react-dom@18.3.1/umd/react-dom.production.min.js` (131 835 B) | `35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d` | `sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1` |
| `@babel/standalone` | 7.29.0 | `910b5ddbab5a3b1ea0b9f1853b1c928c7519f5c5` | `@babel/standalone@7.29.0/babel.min.js` (3 137 752 B) | `2623a9e22809915ce789b4461154e277ddce520d5a4320c14d44332a5d0dcea0` | `sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y` |
| `@fontsource/ibm-plex-sans` | 5.3.0 | `8099950b404e625f65e7bd833bcb84ffe6bcd40c` | `fonts/files/ibm-plex-sans-*-{400,500,600}-normal.woff2` (18 files) | — | — |
| `@fontsource/ibm-plex-mono` | 5.3.0 | `1879699d104602d5331e28e103f33c3b1b766b17` | `fonts/files/ibm-plex-mono-*-{400,500,600}-normal.woff2` (15 files) | — | — |

The SRI values are **identical** to `REACT_SRI`, `REACT_DOM_SRI` and `BABEL_SRI` in
`support.js` — the vendored files are byte-for-byte what unpkg serves for those versions —
so integrity is still enforced (`boot.js` loads React/ReactDOM with these `integrity`
attributes). `test/vendor.test.mjs` re-checks the hashes.

`@babel/standalone` is only fetched by the runtime for `x-import` of `.jsx/.tsx` modules,
which the v5 document does not use; it is vendored so that code path also stays offline.

## Fonts

`fonts/ibm-plex.css` was generated from the fontsource `400.css`, `500.css` and `600.css`
of both packages (all unicode-range subsets: latin, latin-ext, cyrillic, cyrillic-ext,
greek — sans only — and vietnamese), keeping only the `woff2` sources and rewriting URLs to
`/vendor/fonts/files/…`. It replaces
`https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap`,
the stylesheet the design links (same families, same weights, `font-display: swap`).
33 files, ~472 KB total; the browser downloads only the subsets a page actually uses.

## Licenses

- React, ReactDOM, @babel/standalone: MIT (`*/LICENSE`).
- IBM Plex Sans / Mono: SIL Open Font License 1.1 (`fonts/LICENSE-ibm-plex-*.txt`).

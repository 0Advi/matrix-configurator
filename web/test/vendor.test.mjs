// Offline assets: vendored files match the runtime's SRI, the design files are pristine
// copies, and every font file the stylesheet references exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PUB = fileURLToPath(new URL('../public/', import.meta.url));
const SOURCES = fileURLToPath(new URL('../../sources/design-artifact/', import.meta.url));
const read = (p) => readFileSync(path.join(PUB, p));
const sri = (buf) => 'sha384-' + createHash('sha384').update(buf).digest('base64');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

test('vendored React/ReactDOM/Babel match the SRI hashes hard-coded in support.js', () => {
  const support = read('support.js').toString('utf8');
  const consts = Object.fromEntries([...support.matchAll(/var (\w+?)_(URL|SRI) = "([^"]+)"/g)].map(m => [m[1] + '_' + m[2], m[3]]));
  for (const name of ['REACT', 'REACT_DOM', 'BABEL']) {
    const url = consts[name + '_URL'];
    assert.ok(url && url.startsWith('https://unpkg.com/'), name);
    const local = 'vendor/' + url.replace('https://unpkg.com/', '');
    assert.equal(sri(read(local)), consts[name + '_SRI'], local);
  }
});

test('configurator.dc.html and support.js are byte-identical to the v5 design export', { skip: !existsSync(SOURCES) && 'sources/ not present' }, () => {
  assert.equal(sha256(read('configurator.dc.html')), sha256(readFileSync(path.join(SOURCES, 'Workspace Configurator v5.dc.html'))));
  assert.equal(sha256(read('support.js')), sha256(readFileSync(path.join(SOURCES, 'support.js'))));
});

test('every font file referenced by ibm-plex.css exists, all woff2, no remote URLs', () => {
  const css = read('vendor/fonts/ibm-plex.css').toString('utf8');
  const refs = [...css.matchAll(/url\(([^)]+)\)/g)].map(m => m[1]);
  assert.equal(refs.length, 33);
  for (const r of refs) {
    assert.match(r, /^\/vendor\/fonts\/files\/ibm-plex-(sans|mono)-[a-z-]+-(400|500|600)-normal\.woff2$/);
    assert.ok(existsSync(path.join(PUB, r)), r);
  }
  for (const fam of ['IBM Plex Sans', 'IBM Plex Mono']) {
    for (const w of ['400', '500', '600']) {
      assert.ok(new RegExp(`font-family: '${fam}';[^}]*font-weight: ${w};`).test(css), fam + ' ' + w);
    }
  }
  assert.equal(/https?:/.test(css), false);
});

test('VERSIONS.md records the vendored versions and hashes', () => {
  const md = read('vendor/VERSIONS.md').toString('utf8');
  for (const s of ['react` | 18.3.1', 'react-dom` | 18.3.1', '@babel/standalone` | 7.29.0', '@fontsource/ibm-plex-sans` | 5.3.0', '@fontsource/ibm-plex-mono` | 5.3.0']) assert.ok(md.includes(s), s);
  for (const f of ['react@18.3.1/umd/react.production.min.js', 'react-dom@18.3.1/umd/react-dom.production.min.js', '@babel/standalone@7.29.0/babel.min.js']) {
    assert.ok(md.includes(sha256(read('vendor/' + f))), 'sha256 of ' + f);
  }
});

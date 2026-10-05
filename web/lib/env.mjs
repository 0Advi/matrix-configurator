// Minimal .env loader (no dependency). Existing process.env values always win.
import { readFileSync } from 'node:fs';

/** Parse dotenv-style text into an object. Supports comments, `export `, and quoted values. */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.lastIndexOf(q) > 0) {
      val = val.slice(1, val.lastIndexOf(q));
      if (q === '"') val = val.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = val.search(/\s#/);
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

/** Load `file` into process.env without overriding variables that are already set. */
export function loadEnvFile(file, env = process.env) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { loaded: false, keys: [] }; }
  const parsed = parseEnv(text);
  const keys = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined) { env[k] = v; keys.push(k); }
  }
  return { loaded: true, keys };
}

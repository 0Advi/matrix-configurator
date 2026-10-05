// Minimal zero-dependency `.env` loader for the nocobase/ scripts.
// The web server has its own loader; this one exists so the scripts can run standalone.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the project root (`matrix-configurator/`). */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Absolute path of the project `.env` file. */
export const ENV_PATH = resolve(PROJECT_ROOT, '.env');

/**
 * Parse `KEY=VALUE` lines (comments, blank lines and optional surrounding quotes handled).
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load the project `.env` into `process.env` without overriding variables that are already set.
 * @param {string} [path]
 * @returns {Record<string, string>} the parsed file (empty if missing)
 */
export function loadEnv(path = ENV_PATH) {
  if (!existsSync(path)) return {};
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return parsed;
}

/**
 * Set (or append) one `KEY=value` line in the `.env` file, preserving everything else.
 * @param {string} key
 * @param {string} value
 * @param {string} [path]
 */
export function setEnvValue(key, value, path = ENV_PATH) {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  const next = re.test(text) ? text.replace(re, () => line) : `${text}${text.endsWith('\n') || !text ? '' : '\n'}${line}\n`;
  writeFileSync(path, next, { mode: 0o600 });
}

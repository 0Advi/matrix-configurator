// Runtime configuration. Everything has a localhost default; nothing secret is ever logged.
//
//   CFG_URL                    configurator server (design-time store)      default http://127.0.0.1:4300
//   MATRIX_API_URL             Matrix app backend API base                  default http://127.0.0.1:8000/api
//   MATRIX_PLATFORM_ADMIN_EMAIL / MATRIX_PLATFORM_ADMIN_PASSWORD
//                              platform-admin sign-in for validate/publish/release_status.
//                              If unset, PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD are read from
//                              process.env, then from MATRIX_APP_ENV_FILE (only those two keys are
//                              read from that file — nothing else is loaded into the environment).
//   MATRIX_APP_ENV_FILE        default <project>/app/backend/.env (gitignored sandbox file)
//   MATRIX_APP_URL             app frontend, used to build the workspace login link  default http://localhost:5173
//   CFG_AGENT_NAME             who the agent publishes as in v5's history line        default agent-configurator
//   CFG_PROTECTED_WORKSPACES   comma-separated workspace ids the agent may read but never change or delete
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseEnv } from '../../web/lib/env.mjs';

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT_DIR = path.resolve(PACKAGE_DIR, '..');

export function loadConfig(env = process.env) {
  const appEnvFile = env.MATRIX_APP_ENV_FILE || path.join(PROJECT_DIR, 'app', 'backend', '.env');
  return {
    cfgUrl: (env.CFG_URL || 'http://127.0.0.1:4300').replace(/\/+$/, ''),
    apiUrl: (env.MATRIX_API_URL || 'http://127.0.0.1:8000/api').replace(/\/+$/, ''),
    appUrl: (env.MATRIX_APP_URL || 'http://localhost:5173').replace(/\/+$/, ''),
    agentName: env.CFG_AGENT_NAME || 'agent-configurator',
    protectedWorkspaces: String(env.CFG_PROTECTED_WORKSPACES || '').split(',').map(x => x.trim()).filter(Boolean),
    // Credentials are resolved lazily (only when an op needs the app) and never returned.
    adminCredentials: () => resolveAdminCredentials(env, appEnvFile),
  };
}

/** → { email, password } or null. Reads only the two platform-admin keys. Never logs. */
export function resolveAdminCredentials(env, appEnvFile) {
  let email = env.MATRIX_PLATFORM_ADMIN_EMAIL || env.PLATFORM_ADMIN_EMAIL || '';
  let password = env.MATRIX_PLATFORM_ADMIN_PASSWORD || env.PLATFORM_ADMIN_PASSWORD || '';
  if ((!email || !password) && appEnvFile) {
    let parsed = {};
    try { parsed = parseEnv(readFileSync(appEnvFile, 'utf8')); } catch { parsed = {}; }
    email = email || parsed.PLATFORM_ADMIN_EMAIL || '';
    password = password || parsed.PLATFORM_ADMIN_PASSWORD || '';
    parsed = null;
  }
  return email && password ? { email, password } : null;
}

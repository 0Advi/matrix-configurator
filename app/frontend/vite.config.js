/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // F4b: pre-bundle the form renderer used by the generic module page (lazy route). Without
  // this, the dev server discovers it on first visit and force-reloads the page mid-session.
  optimizeDeps: { include: ['@rjsf/core', '@rjsf/utils', '@rjsf/validator-ajv8'] },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
      // F4b: the in-app Workspace Configurator (public/configurator/, embedded in /#/admin →
      // Workspaces) keeps its drafts in NocoBase through the configurator server's /cfg API.
      // Same-origin via this proxy, so the configurator page needs no CORS. 127.0.0.1, not
      // localhost: that server binds IPv4 loopback only. Dev-server only — a production build
      // has no /cfg and the configurator falls back to browser storage (see docs/F4b-UI.md).
      '/cfg': { target: process.env.CFG_PROXY_TARGET || 'http://127.0.0.1:4300', changeOrigin: true },
    },
  },
  // Vitest config — dev/test only, does not affect `vite build`.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    css: false,
    // Pin the real (non-mock) code paths during tests so the suite is
    // deterministic regardless of a developer's local .env.local. With
    // VITE_USE_MOCK=true (an offline-dev setting) guards/session short-circuit,
    // flipping env-dependent tests like guards.test.jsx. CI has no .env.local.
    env: { VITE_USE_MOCK: 'false' },
  },
});

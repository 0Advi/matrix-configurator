# Production gaps — what a real deployment needs beyond localhost

Written by F5a (2026-10-06). Everything below works on localhost today, so none of it was changed in
the sandbox. Each item is a gap that would break or weaken the system **outside localhost**,
followed by the exact change a real deployment needs.

Paths are relative to the real project (`Matrix-bd`, mirrored in `app/`). The sandbox change spec is
`app/SANDBOX-CHANGES.md`.

---

## 1. `vercel.json` blocks the embedded configurator (`X-Frame-Options: DENY`)

**What happens.** `frontend/vercel.json` sends two headers on every path (`/(.*)`):

- `X-Frame-Options: DENY`
- `frame-ancestors 'none'` (inside the report-only CSP)

The platform-admin portal (`/#/admin` → **Workspaces**) loads the configurator as a same-origin
iframe of `/configurator/index.html`. In production the browser would refuse to render that frame,
and the Workspaces tab would show an empty box.

`X-Frame-Options` is enforced today. `frame-ancestors` is report-only today, so it would only bite
once the CSP is enforced (see §2).

**Change.** Give `/configurator/*` its own header rule, and keep `DENY` for everything else.

- Take the configurator path out of the catch-all with a negative look-ahead, so the two rules can
  never compete (Vercel applies every rule whose `source` matches).
- Only the configurator document needs to allow framing. The SPA (`/index.html`) is the parent, so it
  keeps `DENY`.

```jsonc
"headers": [
  {
    "source": "/((?!configurator/).*)",          // was "/(.*)"
    "headers": [
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "X-Frame-Options", "value": "DENY" },
      { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
      { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains" },
      { "key": "Content-Security-Policy-Report-Only",
        "value": "default-src 'self'; connect-src 'self' https:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" }
    ]
  },
  {
    "source": "/configurator/(.*)",
    "headers": [
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "X-Frame-Options", "value": "SAMEORIGIN" },
      { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
      { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains" },
      { "key": "Content-Security-Policy-Report-Only",
        "value": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self' 'unsafe-eval'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'" }
    ]
  }
]
```

**Verify after deploying:**

```bash
curl -sI https://<app>/configurator/index.html | grep -i -E 'x-frame|frame-ancestors'
# expect SAMEORIGIN and frame-ancestors 'self'

curl -sI https://<app>/ | grep -i x-frame
# expect DENY
```

---

## 2. An enforced CSP breaks the dc-runtime and ajv (`new Function`)

**What happens.** Two pieces of code generate code at runtime:

| Code | Where | Why it needs eval |
|---|---|---|
| The configurator's dc-runtime | `frontend/public/configurator/support.js` lines ~844 and ~1218 | `new Function(...)` compiles the design's JSX after the vendored Babel transforms it in the browser |
| rjsf's ajv validator | `@rjsf/validator-ajv8`, loaded by `src/modules/custom-module/GenericRecordPage.jsx` (lazy chunk) | ajv compiles each JSON Schema into a function with `new Function` |

The current CSP is **report-only** with `script-src 'self'`. Nothing breaks today; violation reports
are sent.

Once the CSP is switched to `Content-Security-Policy` (enforced), both pieces stop working:

- the configurator renders nothing;
- every custom-module case page throws when it renders its stage form.

**Change.**

1. **Configurator document.** Allow `'unsafe-eval'` for `/configurator/(.*)` only, as in the second
   rule of §1. It is an isolated, platform-admin-only document; the SPA stays strict. The cleaner
   long-term option is to precompile the design at build time (Babel ahead of time) and drop
   in-browser compilation. Then `'unsafe-eval'` can go.
2. **The SPA (custom-module forms).** Pick one:
   - **(a) Recommended — server-side validation only in the browser.** Replace
     `@rjsf/validator-ajv8`'s `validator` in `GenericRecordPage.jsx` with a validator that does not
     compile, for example a thin `ValidatorType` whose `validateFormData` returns no errors.
     - The backend already validates every submission with `jsonschema`. Its `422 invalid_form`
       errors are mapped onto the fields (`toExtraErrors`), so users still see field-level messages,
       one round trip later.
     - No CSP relaxation is needed.
   - **(b)** Keep ajv and add `'unsafe-eval'` to the SPA's `script-src`. This is weaker, because it
     covers the whole app.
   - **(c)** Precompiled ajv validators (`@rjsf/validator-ajv8/precompiledValidator`). This does
     **not** fit: the schemas come from published releases at runtime, not at build time.
3. Then switch `Content-Security-Policy-Report-Only` → `Content-Security-Policy`, after a week of clean
   reports.

**Check before enforcing:**

- `img-src https:` must cover the storage host. Logos and custom-module files are served from signed
  storage URLs on the Supabase project host. That host is `https:`, so it is covered.
- `connect-src` must include the API origin if it differs (it is `https:`, so it is covered).

---

## 3. `/cfg` exists only on the Vite dev proxy

**What happens.** The embedded configurator saves its drafts (design-time store, decision D2)
through `/cfg/*`:

- `/cfg/health`, `/cfg/state` (`If-Match` ETag), `/cfg/releases`
- see `public/configurator/sync-engine.js` and `bridge-core.js`

On localhost, `frontend/vite.config.js` proxies `/cfg` to the configurator server (`web/server.mjs`,
:4300), which stores drafts in NocoBase.

A production build is static, so it has **no `/cfg`**. Then:

- `/cfg/health` fails, and the configurator falls back to **local mode** (drafts in the browser's
  storage, per device, per browser);
- the NocoBase history and the shared drafts (the visual configurator and the AI-agent configurator
  editing the same document) are lost.

Publishing to the app still works, because it goes through the app's own `/api/platform/*` with the
admin token.

**Change (all four are needed):**

1. **Deploy the configurator server and NocoBase** as private services. NocoBase must never be public
   (see N1: sign-up is on by default; turn it off).
2. **Route `/cfg` same-origin.** Add a rewrite **before** the SPA catch-all in `vercel.json`:

   ```jsonc
   "rewrites": [
     { "source": "/cfg/(.*)", "destination": "https://<configurator-server-host>/cfg/$1" },
     { "source": "/(.*)", "destination": "/index.html" }
   ]
   ```

3. **Authenticate `/cfg`.** Today the configurator server trusts anyone who can reach it (it binds to
   127.0.0.1). Behind a rewrite it is public, so it must verify the platform-admin JWT (same
   `aud=platform-admin`, same secret as the backend's `decode_admin_token`).
   - The host bridge would pass the token per request in an `Authorization` header.
   - The iframe must still never *store* it. Today the iframe receives no token at all: see
     `host-bridge.js`.
4. **Keep the NocoBase API key server-side only.** It is in the configurator server's environment,
   never in the bundle.

---

## 4. Other gaps found while fixing caveats (F5a)

| # | Gap | Production change |
|---|---|---|
| 4.1 | **SEC-1 rollout.** The fix (staff passwords chosen at signup; `/auth/password-setup` requires a one-time setup code) changes the API contract. An old frontend's code-less first-password call now gets 422. | Deploy backend and frontend together. Then list the accounts that are approved but unclaimed: `SELECT t.workspace_code, u.email, u.role FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.is_active AND u.password_hash IS NULL;` Issue each one a code: business admins of configurator workspaces through **Issue a new setup code**; everyone else through the reset queue. Until then, nobody (attacker included) can claim them. |
| 4.2 | **Custom-module files share the `site-files` bucket** (`module-files/<tenant>/…`). Downloads use 5-minute signed URLs. | The bucket must stay **private**. Never make it public: signed URLs are the only access path. Add a lifecycle rule or a sweeper for objects whose `module_files` row is gone, for example after a failed insert whose best-effort delete also failed. |
| 4.3 | **Upload limits.** A file field is limited by its own hint (for example "max 10MB"), capped by `MAX_UPLOAD_BYTES` (25 MB). The proxy or platform in front of the API has its own body limit. | Set the platform's request-body limit to at least `MAX_UPLOAD_BYTES`. Otherwise large uploads fail with an opaque 413 from the edge, not the app's message. Consider per-user upload quotas: the endpoint is authenticated but not rate-limited. |
| 4.4 | **Release-migration recovery assumes heartbeats.** A migration that has had no heartbeat for 10 min is marked failed at startup or before the next run. | Keep `STALE_AFTER_SECONDS` well above the slowest single-site transaction. With several API instances this is safe: a live run heartbeats after every site. |
| 4.5 | **In-memory rate limiter** (upstream) is per process. | Already flagged upstream (#225). Behind more than one instance, use a shared store (Redis) or the edge's rate limiting. |
| 4.6 | **Platform-admin identity is one shared login** (email and password from env). Publishes, re-issued setup codes and migrations all record that single email. | Use per-person platform-admin accounts if several people operate the portal. Without them the audit cannot tell who did what. |
| 4.7 | **Migrations ledger.** `20261006_1_module_files.sql` must run after F2's `20261004_*` and G3's `20261005_*`. It depends on `module_records`, `tenant_modules`, `cfg_forbid_mutation()` and `current_tenant_id()`. | Same rule as DB-1 in `docs/PHASE2-PLAN.md`: the real repo cannot rebuild its DB from migrations alone, so apply on a DB that already has the Phase-2 schema. |

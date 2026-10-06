# Production security hardening report

Task 14. This report lists what blocks an independent production deployment of the Matrix-bd app (sandbox copy in
`app/`) and the security fixes it needs. It changes no code.

**Scope (read in full):** `app/backend/app/core/*`, `app/backend/app/rbac/*`, `app/backend/app/routers/auth.py`,
`app/backend/app/routers/platform.py`, `app/frontend/vercel.json`, `docs/PRODUCTION-GAPS.md`, `THIRD_PARTY.md`, and
a `localStorage|sessionStorage` grep of `app/frontend/src/services/api/authToken.js`.
**Referenced, not re-audited:** `docs/rbac/README.md` (target: `authorize()`, `Guard`, token = identity only,
`X-View-As`) and `docs/configurator/NATIVE-BUILDER-PLAN.md` §3 (the iframe configurator and `/cfg` are retired).
**Not inspected (out of scope, must be verified separately):** the tenancy router (`POST /tenancy/admin/login`:
password compare, rate limit), `app/main.py` (CORS middleware, API response headers), `services/auth_repo.py`
(join-code and reset-token entropy and expiry), where the SPA keeps the platform-admin token, and the uvicorn start
command (`--proxy-headers`, `--forwarded-allow-ips`, worker count).

**Labels.** **BLOCKER**: fix before an independent production deployment. **IMPROVEMENT**: fix soon; not a go/no-go
item. All paths are under `app/backend/app/` unless shown otherwise.

---

## 1. Auth risks

How auth works today: the user signs in with (workspace_code, email, password) at `POST /auth/login`
(`routers/auth.py:160`). The backend mints its own HS256 JWT signed with `SUPABASE_JWT_SECRET`
(`core/security.py:86` `issue_token`). The token lives 24 h (`TOKEN_TTL_SECONDS`, `security.py:37`) and carries
role, tenant, module and supervisor claims. `get_current_user` (`core/deps.py:117`) re-reads `users.role` and
`is_active` on every request (`deps.py:167-211`), so deactivating an account takes effect at once.

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| SEC-01 | **BLOCKER** | **Sessions cannot be revoked, and a refresh chain never ends.** `decode_token_for_refresh` accepts a token up to 48 h past `exp` (`REFRESH_GRACE_SECONDS`, `security.py:193`; `verify_exp: False`, `security.py:213`). `/auth/refresh` then mints a new 24 h token (`auth.py:662-726`). A stolen token can be refreshed forever. Tokens have no `jti`, `token_version` or session id (`security.py:116-124`). `/auth/logout` does nothing on the server (`auth.py:729-735`). `password_reset_complete` changes the hash but leaves existing tokens valid (`auth.py:421-425`). The only kill switch is `is_active = false`. | `security.py:196-226`, `auth.py:662-735`, `deps.py:206` |
| SEC-07 | IMPROVEMENT | **One flag turns on every insecure mode.** `ALLOW_INSECURE_DEFAULTS` allows the public placeholder JWT secret (`config.py:171`) and the unauthenticated demo executive (`config.py:184`, `deps.py:139-149`). Nothing ties it to the environment, so one wrong env var in prod gives full auth bypass. `PASSWORDLESS_DEMO_CODES` (`config.py:92`, `auth.py:213,225`) has the same problem: a listed workspace signs in with email + code and no password. | `config.py:38,92,162-212` |
| SEC-08 | IMPROVEMENT | **JWT hygiene.** The only check on the secret is that it is not the placeholder; its length is never checked (`config.py:171`). There is no `iss` claim, so user tokens look like any Supabase-Auth token with `aud=authenticated` (`security.py:117-118`). Error details echo PyJWT messages (`security.py:82,159`). | `security.py:133-160` |
| SEC-09 | IMPROVEMENT | **Account enumeration.** For a valid workspace code, login returns **404** for an email that is not a member (`auth.py:193-199`, by design). `/login/check` treats a caller as trusted when it sends `X-Matrix-Internal: 1` plus a matching `Origin` (`auth.py:277-298`); curl can set both, so the opaque reply is easy to bypass. Only per-IP rate limits slow enumeration. | `auth.py:183-199,265-344` |
| SEC-10 | IMPROVEMENT | **Weak password floor:** `min_length=6` (`auth.py:95,113,137`). bcrypt reads only the first 72 bytes (`core/passwords.py:22-23`), which is fine. | `auth.py:95,113,137` |
| SEC-11 | IMPROVEMENT | **Signup logs the email in clear text** (`auth.py:635-638`), which breaks the "#82 log user id, not email" rule followed at `auth.py:371-372`. | `auth.py:636` |

## 2. RBAC risks

Today's model: `require_role`, `require_module` and `require_real_role` (`rbac/guards.py`) check the effective
`role`/`module`. `X-Override-Role` and `X-Override-Module` can rewrite those values (`deps.py:74-114`).
`READ_ALL_ROLES = {business_admin, observer}` passes every role and module guard (`rbac/roles.py:43`,
`guards.py:28,130`). An observer is read-only only because non-GET requests are refused (`deps.py:48-71`). The
target model (`docs/rbac/README.md`: `authorize()`, `Guard`, identity-only token, `X-View-As` that only narrows reads)
removes all of this in its P4 phase. The fixes below are therefore small guards, not a refactor.

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| SEC-15 | IMPROVEMENT | **A business admin's `X-Override-Role` is not validated.** Any string becomes `claims["role"]` (`deps.py:103-107`), including values outside `Role` (the docstring at `security.py:141` lists `system`). Today it does not escalate: `real_role` stays `business_admin`. Still, an unknown role string must not reach services. | `deps.py:103-107` |
| SEC-16 | IMPROVEMENT | **A supervisor's executive switch crosses modules.** `module_to_check = x_override_module or claims["module"]` (`deps.py:161`) decides which `has_executive_access` row is read. For a supervisor, `_apply_workspace_override` never changes `module` (`deps.py:113-114`). A supervisor with executive access in module A can send `X-Override-Module: A` and `X-Override-Role: executive`, and then acts as executive in their token's module B. | `deps.py:161,199,113` |
| SEC-17 | IMPROVEMENT | **The module claim comes from the token and can be up to 24 h stale.** The role is re-read from the DB, but `require_module` compares `current_user["module"]` (`guards.py:126-130`), and that value comes from the JWT (`security.py:110-111`). A user removed from a module keeps access until the token expires or is refreshed. | `guards.py:124-135`, `deps.py:209-221` |
| SEC-21 | IMPROVEMENT | **Observer read-only depends on the HTTP method alone** (`deps.py:35,67`). A GET with side effects, or a mutating route that skips `get_current_user`, would leak write access. `tests/test_observer_readonly.py` (cited at `deps.py:55`) is the only guard, so keep it mandatory in CI. | `deps.py:48-71`, `guards.py:20-33` |

## 3. Platform-admin risks

**How a platform admin is recognised.** There is **no allowlist and no per-person identity**:

1. One env credential: `PLATFORM_ADMIN_EMAIL` (default `admin@matrix.bluetokai.com`) and `PLATFORM_ADMIN_PASSWORD`
   (`config.py:125-126`). The portal returns 503 when the password is unset or equals the retired default
   (`config.py:132-141`).
2. Login (tenancy router, not inspected) calls `issue_admin_token(email=...)`. That mints an HS256 JWT with
   `sub="platform-admin"`, `aud="platform-admin"` and a 30 min TTL (`security.py:43,46-63`), **signed with the same
   `SUPABASE_JWT_SECRET` as every tenant token** (`security.py:63`).
3. Each `/platform/*` route accepts any token in `X-Platform-Admin-Key` that verifies with that secret and audience
   (`routers/platform.py:38-52`, `security.py:66-83`). The `email` claim is used as the audit actor
   (`platform.py:92,111,129,164`) and is never checked against config.

**Spoofing risk.** Anyone who holds `SUPABASE_JWT_SECRET` can mint a platform-admin token with any email. That
includes Supabase dashboard users, any service given the secret, and the configurator server, which
`docs/PRODUCTION-GAPS.md` §3.3 proposes to give "the same secret". The same holder can also mint tenant tokens for
any user in any tenant. Audiences separate the two token kinds; they do not separate the keys.

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| SEC-03 | **BLOCKER** | **Platform-admin and tenant tokens share one HMAC secret,** and that secret is also the Supabase project's JWT secret (module docstring `security.py:1-6`; `security.py:63,75`). If the secret leaks, the attacker controls the whole platform. PRODUCTION-GAPS §3.3 would copy the secret to one more service. | `security.py:46-83` |
| SEC-04 | **BLOCKER** | **One shared admin password, with no MFA, IP restriction or revocation,** guards provisioning, publishing, migrations and **re-issuing the business admin's setup code** (`platform.py:126-129`). A re-issued code lets the holder take over an unclaimed tenant. Every action is logged under the same email (PRODUCTION-GAPS 4.6). A token stays valid for 30 min after the password is rotated. The admin-login rate limit is not visible in scope. | `config.py:118-148`, `platform.py:38-52,126-129` |
| SEC-19 | IMPROVEMENT | **Leftovers and unbounded input.** The comment at `config.py:119-130` still describes a static `X-Platform-Admin-Key` equal to the password, and `effective_platform_admin_token` (`config.py:143-148`) is never used in the files in scope. Confirm no route still accepts it, then delete it. `PublishIn.manifest` / `ValidateIn.manifest` are `dict[str, Any]` with no size cap (`platform.py:74-81`). `/platform/*` has no rate limit. | `config.py:119-148`, `platform.py:74-81` |

## 4. CSP/frame risks

`app/frontend/vercel.json:13-27` sends one header set on `/(.*)`: `X-Frame-Options: DENY`, `nosniff`,
`Referrer-Policy`, HSTS (2 y, `includeSubDomains`), and **`Content-Security-Policy-Report-Only`** with
`script-src 'self'`, `connect-src 'self' https:`, `img-src 'self' data: https:` and `frame-ancestors 'none'`. It has
**no `frame-src`**, so frames fall back to `default-src 'self'`, and **no `report-uri`/`report-to`**. The SPA keeps
the user JWT in **`sessionStorage`** (`matrix.access_token`, `authToken.js:15,23,30`), where any script running on
the origin can read it.

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| SEC-05 | **BLOCKER** | **The CSP is not enforced, and its reports go nowhere.** It is Report-Only and names no reporting endpoint, so violations reach only the browser console. The "week of clean reports" gate in PRODUCTION-GAPS §2.3 therefore cannot be met. With the bearer token in `sessionStorage`, any XSS steals a session that can be refreshed forever (SEC-01). | `vercel.json:22-23`, `authToken.js:10-31` |
| SEC-06 | **BLOCKER** | **Do not ship the iframe configurator or `/cfg` to production.** (a) PRODUCTION-GAPS §1-2 proposes `X-Frame-Options: SAMEORIGIN` and `script-src 'unsafe-eval'` for `/configurator/*`, calling it "isolated". A **same-origin** frame shares the parent tab's `sessionStorage` and DOM, so it is not isolated: `eval` there reaches the user token. (b) The `/cfg` server "trusts anyone who can reach it" (PRODUCTION-GAPS §3.3), and NocoBase has sign-up on by default (PRODUCTION-GAPS §3.1). A `/cfg/(.*)` rewrite would expose draft read/write to the internet. Today `vercel.json:7-12` has **no** `/cfg` rewrite and keeps `DENY`. That state is safe: the configurator shows an empty frame or falls back to local mode. NATIVE-BUILDER-PLAN §3.1 retires the iframe, `postMessage`, `/cfg` and `'unsafe-eval'`, so ship that instead. | `vercel.json:7-27`; PRODUCTION-GAPS §1-3 |
| SEC-18 | IMPROVEMENT | **The CSP allow-lists are broad.** `connect-src https:` allows sending data to any host, and `img-src https:` loads images from any host. Narrow both to the API origin and the Supabase project host. Add `frame-src 'none'` once the native builder ships, plus `Permissions-Policy` and `Cross-Origin-Opener-Policy: same-origin`. The rjsf/ajv `new Function` issue (PRODUCTION-GAPS §2.2) must be solved with option (a), validation on the server only, **before** the CSP is enforced. | `vercel.json:23` |
| SEC-20 | IMPROVEMENT | **Token storage.** `sessionStorage` is better than `localStorage`: it stays in one tab and is cleared when the tab closes (`authToken.js:10-11`). An enforced CSP is still the only defence. The long-term fix is an `HttpOnly; Secure; SameSite=Strict` refresh cookie plus a short in-memory access token; plan it with RBAC P2 rather than here. Where the platform-admin token is stored has not been checked. | `authToken.js:10-35` |

## 5. Rate-limit/session risks

The limiter (`core/ratelimit.py`) is an **in-process** dict keyed by `(request.client.host, path)`
(`ratelimit.py:16,21-27,45`). Its counts are not shared between workers or instances and reset on restart. The IP
is whatever uvicorn resolves. Behind Railway or Vercel without scoped `--forwarded-allow-ips`, it is the proxy's IP,
so all users share one bucket. With `*`, the client chooses the IP through `X-Forwarded-For` (warning at
`ratelimit.py:22-26`).

| Endpoint | Limit (per IP+path, per process) | Gap |
|---|---|---|
| `POST /auth/login` (`auth.py:163`) | 10 / 60 s | No per-account or per-workspace limit, no lockout. A 6-char password minimum (SEC-10). |
| `POST /auth/login/check` (`auth.py:304`) | 20 / 60 s | Enumeration (SEC-09). |
| `POST /auth/signup/{supervisor,observer,executive}` (`auth.py:499,529,565`) | 5 / 300 s | A **404 tells the caller whether a join code is valid** (`auth.py:512-515,547-550,578-581`). No per-code limit and no global limit. |
| `POST /auth/password-reset/{request,complete}`, `/auth/password-setup` (`auth.py:350,411,433`) | 5 / 300 s | No per-request attempt counter on the reset/setup token (`auth.py:394-404`). |
| `POST /auth/refresh` (`auth.py:662`) | **none** | Unlimited re-minting (SEC-01). |
| `/platform/*` | **none** | Only the 30 min admin JWT (SEC-19). |
| Uploads (`core/uploads.py:87`) | **none** | Each request holds up to 25 MB in RAM (`uploads.py:111-121`). No per-user quota (PRODUCTION-GAPS 4.3). |

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| SEC-02 | **BLOCKER** | **Login brute force is limited only per IP, in memory, per process.** The limit multiplies with each worker or instance, resets on deploy, and is bypassed by rotating IPs. If the proxy-header settings are wrong, it either blocks everyone at once or lets the client spoof its IP. Without a per-account throttle, a 6-char password is within brute-force reach. | `ratelimit.py:16-59`, `auth.py:163,220-224` |
| SEC-12 | IMPROVEMENT | **Join codes and reset/setup tokens can be guessed.** A 404 shows a signup code is valid. Code entropy and expiry are in `auth_repo` (not inspected). Reset and setup tokens have `min_length=8` (`auth.py:99,114`) and no attempt counter. | `auth.py:376-405,507-592` |
| SEC-13 | IMPROVEMENT | **`/auth/refresh` has no rate limit, and sessions have no maximum lifetime.** The original sign-in time is not carried forward, and `iat` is reset on every refresh (`security.py:119`). | `auth.py:662-670` |
| SEC-14 | IMPROVEMENT | **Upload hardening.** (a) There is no rate limit or quota, and each upload is fully buffered in RAM. (b) For strong-magic types, `filetype.guess()` returning **`None` is accepted**: `if kind is not None and …` (`uploads.py:126`). Bytes with no recognisable signature (HTML, script) pass as `image/png` or `application/pdf`. (c) A missing `content_type` on a non-`UploadFile` input skips the allowlist (`uploads.py:97-104`). | `uploads.py:87-141` |

## 6. Required fixes

Each fix is narrow and fits the RBAC migration (`docs/rbac/README.md` P0-P4). None of them is a refactor.

| ID | Fix (exact place) |
|---|---|
| SEC-01 | Add `users.sessions_valid_after timestamptz` (migration). In `deps.py:get_current_user`, select it in `_FULL_QUERY` (`deps.py:167-198`) and reject when `claims.iat < sessions_valid_after`. `decode_token` must expose `iat`: `_session_from_claims` (`security.py:164-188`) passes it through. Apply the same check in `auth.py:refresh` after `get_active_user_for_refresh` (`auth.py:695`). Bump the column in `password_reset_complete` (`auth.py:421`), `password_setup` (`auth.py:479`), a real `logout` (`auth.py:734`; that needs `CurrentUser`), and on deactivation. Carry `auth_time` from `issue_token` (`security.py:86`) through refresh, and reject in `decode_token_for_refresh` (`security.py:196`) when `now - auth_time > 30 d`. |
| SEC-02 | In `core/ratelimit.py`, add a `rate_limit_key(key_fn, times, seconds)` variant. Use it in `auth.py:login` keyed on `(workspace_code.upper(), email)`: 5 failures per 15 min, counted only on the 401 branches (`auth.py:215-224`). Back `_WINDOWS` with Redis (`REDIS_URL`) when it is set; otherwise refuse to start with `WEB_CONCURRENCY>1`. Set `--proxy-headers --forwarded-allow-ips=<platform proxy CIDR>` in the start command and check it with a startup log of `request.client.host`. |
| SEC-03 | Add a `PLATFORM_ADMIN_JWT_SECRET` setting (`config.py` §Platform admin, ≥32 bytes, required when the portal is enabled). Use it in `issue_admin_token` (`security.py:63`) and `decode_admin_token` (`security.py:75`). Add `iss="matrix-platform-admin"` and require it. Never give `SUPABASE_JWT_SECRET` to any other service. If `/cfg` ever ships, it gets only a verify path for the admin secret. |
| SEC-04 | Replace the single pair with `PLATFORM_ADMINS="email:bcrypt_hash,…"` (`config.py:125-148`). Issue `sub=<email>` and a `jti` (`security.py:54-60`). `platform_admin()` (`platform.py:38-49`) re-checks that the email is still in the allowlist on every call. Rate-limit the admin login (tenancy router) with `rate_limit(times=5, seconds=300)` and the per-account key from SEC-02. Restrict `/platform/*` and `/tenancy/admin/*` by source IP or require MFA at the edge. |
| SEC-05 | In `app/frontend/vercel.json:22`, switch to the enforced `Content-Security-Policy` header and add a reporting endpoint (`report-to`/`report-uri`), first with a short Report-Only phase **that actually collects reports**. Before that, replace the ajv validator in `GenericRecordPage.jsx` (PRODUCTION-GAPS §2.2 (a)). |
| SEC-06 | Keep `vercel.json` **without** a `/cfg` rewrite and with `X-Frame-Options: DENY` / `frame-ancestors 'none'` on `/(.*)`. Do **not** apply PRODUCTION-GAPS §1 (the SAMEORIGIN rule) or §3.2 (the `/cfg` rewrite) to production. Gate the Workspaces → configurator tab off in prod builds until the native builder (NATIVE-BUILDER-PLAN §3) lands. If an interim iframe is unavoidable, serve it from a **separate origin** with `sandbox="allow-scripts"` (no `allow-same-origin`), and authenticate `/cfg` with the SEC-03 admin secret. |
| SEC-07 | Add `environment: str = "development"` to `config.py`. In `_refuse_insecure_production_config` (`config.py:162`), when it is `production`, refuse to start if `allow_insecure_defaults`, `allow_anon_demo_user`, `enable_docs`, `cors_allow_localhost` or `passwordless_demo_codes` is set. |
| SEC-08 | `config.py:171`: require `len(supabase_jwt_secret) >= 32`. `security.py:117-123`: add an `iss` claim and require it in `decode_token` and `decode_token_for_refresh`. Replace `f"Invalid token: {exc}"` (`security.py:82,159,218`) with a fixed message and log the exception. |
| SEC-09 | `auth.py:193-199`: return the same soft 202 as the unknown-code branch. `_is_trusted_internal` (`auth.py:265`): treat the result as UX routing only and document that it can be spoofed, or drop the detailed states. |
| SEC-10 | `auth.py:95,113,137`: `min_length=12`. Optionally add a check against a breached-password list. |
| SEC-11 | `auth.py:636`: log `user_id` and `tenant_id` only. |
| SEC-12 | `auth.py:510,545,576`: return the same 202 for invalid codes, and add a per-code limiter. Add `attempts` to `password_reset_requests` and invalidate the row after 5 failures in `_verified_reset_request` (`auth.py:376-405`). |
| SEC-13 | `auth.py:662`: `dependencies=[Depends(rate_limit(times=30, seconds=300))]`. |
| SEC-14 | `uploads.py:126`: for `content_type in _STRONG_MAGIC`, **reject when `kind is None`**. `uploads.py:103`: require a content type for every input. Add `rate_limit(times=30, seconds=60)` on each upload route and a per-tenant storage quota. Set the edge body limit to at least `MAX_UPLOAD_BYTES`. |
| SEC-15 | `deps.py:104-105`: accept `override_role` only if it is in `{r.value for r in Role}`; otherwise return 400. |
| SEC-16 | `deps.py:161`: for a non-admin, non-observer `db_role`, set `module_to_check = claims.get("module")` and ignore `X-Override-Module`. |
| SEC-17 | Fold the membership read into `_FULL_QUERY` (`deps.py:167`) and set `claims["module"]` from the DB, as already done for role. RBAC P2 supersedes this. |
| SEC-18 | `vercel.json:23`: set `connect-src 'self' https://<api-host>`, `img-src 'self' data: https://<project>.supabase.co`, and `frame-src 'none'`. Add `Permissions-Policy: camera=(), microphone=(), geolocation=()` and `Cross-Origin-Opener-Policy: same-origin`. |
| SEC-19 | Delete `effective_platform_admin_token` and the stale comment (`config.py:119-130,143-148`) once no reference remains. Cap the manifest size: reject a body over 1 MB in `PublishIn`/`ValidateIn` (`platform.py:74-81`). |
| SEC-20 | Track the move to a refresh token in an HttpOnly cookie under RBAC P2. Document where the admin token is stored in the SPA. |
| SEC-21 | Make `tests/test_observer_readonly.py` a required check. Add GET-route side-effect review to the PR template. |

## 7. Tests to add

All files go under `app/backend/tests/`.

| Test file | Asserts | Covers |
|---|---|---|
| `test_session_revocation.py` | After a password reset, setup or logout, the old token gets 401 at `/auth/whoami` and at `/auth/refresh`. A refresh more than 30 d after `auth_time` gets 401. A token within the 48 h grace still refreshes when it is otherwise valid. | SEC-01, SEC-13 |
| `test_login_lockout.py` | 6 wrong passwords for one account from 6 different `client.host` values get 429. A correct login for a different account is unaffected. | SEC-02 |
| `test_ratelimit_proxy.py` | A spoofed `X-Forwarded-For` does not change the bucket key (`ratelimit._client_ip`). | SEC-02 |
| `test_admin_token_isolation.py` | A token signed with `SUPABASE_JWT_SECRET` and `aud=platform-admin` is **rejected** by `platform_admin()`. A user token is rejected on `/platform/*`. An admin token is rejected by `get_current_user`. A token whose email is not in `PLATFORM_ADMINS` gets 401. | SEC-03, SEC-04 |
| `test_config_prod_guard.py` | `ENVIRONMENT=production` together with any insecure flag raises an error at `Settings()`. A secret shorter than 32 bytes raises. | SEC-07, SEC-08 |
| `test_auth_enumeration.py` | Login with a valid code and an unknown email returns the same status and body as with an unknown code. Signup with an invalid code returns the same 202 as with a valid one. | SEC-09, SEC-12 |
| `test_reset_token_attempts.py` | The 6th wrong `reset_token` invalidates the request, and the correct token then fails. | SEC-12 |
| `test_upload_magic.py` | HTML bytes declared as `image/png` or `application/pdf` get 415. A missing content type gets 400. | SEC-14 |
| `test_override_headers.py` | A business admin with `X-Override-Role: system` gets 400. A supervisor with executive access only in module A who sends `X-Override-Module: A` + `X-Override-Role: executive` keeps the role `supervisor` in module B. | SEC-15, SEC-16 |
| `test_module_claim_fresh.py` | A user whose membership was removed gets 403 on `require_module` routes while still holding the old token. | SEC-17 |
| `app/frontend` header check (CI script) | `vercel.json` has an enforced `Content-Security-Policy` with a report endpoint, has no `/cfg` rewrite, keeps `X-Frame-Options: DENY` on `/(.*)`, and has no `'unsafe-eval'` anywhere. | SEC-05, SEC-06, SEC-18 |

## 8. Go/no-go checklist

Every box must be ticked before an independent production deployment. Items marked † are configuration
checks with no code change.

- [ ] SEC-01: sessions can be revoked (`sessions_valid_after`); refresh is capped by `auth_time`; reset and logout revoke existing tokens.
- [ ] SEC-02: a per-account login throttle exists; the limiter store is shared (Redis), or there is exactly one worker and one instance.
- [ ] SEC-02 †: the start command uses `--proxy-headers --forwarded-allow-ips=<proxy CIDR>` (never `*`), and the logged `client.host` is the real client IP.
- [ ] SEC-03: `PLATFORM_ADMIN_JWT_SECRET` is set, ≥32 bytes, and different from `SUPABASE_JWT_SECRET`; no other service holds `SUPABASE_JWT_SECRET`.
- [ ] SEC-04: platform admins are individual allowlisted accounts; admin login is rate-limited; `/platform/*` is IP-restricted or behind MFA.
- [ ] SEC-05: an enforced `Content-Security-Policy` is live with a reporting endpoint; the ajv `new Function` dependency is removed from the SPA.
- [ ] SEC-06: no `/cfg` rewrite; `X-Frame-Options: DENY` on all paths; no `'unsafe-eval'`; the configurator iframe is disabled in prod or replaced by the native builder.
- [ ] † `ALLOW_INSECURE_DEFAULTS`, `ALLOW_ANON_DEMO_USER`, `ENABLE_DOCS` and `CORS_ALLOW_LOCALHOST` are unset; `PASSWORDLESS_DEMO_CODES` is empty (SEC-07).
- [ ] † `CORS_ORIGINS` lists exact prod origins only; `CORS_ORIGIN_REGEX` is scoped to this project's preview URLs, or empty (`config.py:45-68`).
- [ ] † The Supabase `site-files` bucket is private; downloads use signed URLs only (PRODUCTION-GAPS 4.2).
- [ ] † NocoBase is not deployed publicly; if it runs at all, it is private with sign-up off (PRODUCTION-GAPS §3.1; `THIRD_PARTY.md`: NocoBase licence §5.4 forbids public low-code SaaS use, so get a legal review first).
- [ ] † SEC-4.1 rollout from PRODUCTION-GAPS is done: every approved account without a password has a setup code issued.
- [ ] † The edge request-body limit is at least `MAX_UPLOAD_BYTES` (25 MB).
- [ ] The tests in §7 pass in CI, including the existing `tests/test_observer_readonly.py` and `tests/test_f5a_fixes.py`.

Improvements SEC-07 to SEC-21 (except SEC-07's config checklist items above) can follow the first release, but
SEC-14(b), the `kind is None` upload bypass, and SEC-16 are cheap and should go in the same change set.

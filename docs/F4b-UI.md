# F4b — the configurator journey in the app's UI (localhost)

What a person clicks, and what each screen calls. Backend contract: `docs/F4-API.md`. Every file
change: `app/SANDBOX-CHANGES.md` → "Phase 2 — F4b". Screens: `docs/reports/F4b-screens/`.

Start everything with `app-stack/start.sh` (db, storage stub, backend, NocoBase + configurator server,
frontend); `app-stack/status.sh` shows all six. App: <http://localhost:5173> (HashRouter).

## 1. Platform admin — design, publish, provision (`/#/admin` → **Workspaces**)

Sign in with the platform-admin credentials (`app/backend/.env`). The token (30 min) lives only in the
page's memory: a reload asks again; the configurator iframe never receives it.

**Design & publish** = the Workspace Configurator v5 (iframe of `/configurator/index.html`, same origin;
drafts persist to NocoBase through `/cfg`, exactly like the standalone configurator on :4300 — both edit the
same drafts) + the **App panel** on the right:

| App panel section | Shows | Calls |
|---|---|---|
| In the canvas | workspace open in the configurator: name, id (= the app's `configurator_ref`), configurator live/draft versions | — (from the iframe) |
| In the app | Not provisioned · or status, workspace code (copy), login-page link, seats, business admin claimed?, live release, release count | `GET /platform/workspaces/{ref}` |
| Activity | the last check/publish: progress, errors and warnings (`findings`), success with the release version and modules, Retry | below |
| **Check draft against the app** | would this draft publish? (writes nothing) | `POST …/{ref}/releases/validate` |

**Publish** is v5's own button (top right in the canvas → reason → "Publish vN"). With the portal around it:

1. the draft manifest is validated by the app — any **error** stops v5's publish (the canvas toasts why, the
   panel lists the findings); warnings don't;
2. if the app has no tenant for this workspace (404, or a failed earlier attempt): **Provision** dialog —
   company, business-admin name + email, seat limit, city → `POST /platform/workspaces` → the **workspace code
   and one-time setup code are shown once** (copy buttons, "share privately", login-page link, optional
   branding: company name + logo) → "I have shared the codes — continue";
3. v5 publishes (its live version goes up) → the portal stores v5's `manifest()` as an immutable app release:
   `POST /platform/workspaces/{ref}/releases {manifest, reason, source_ref: "configurator:<ref>@v<N>"}` →
   "live in the app: release vK" (+ a toast in the canvas). App release numbers are the app's own (1, 2, …);
   the configurator's vN is in `source_ref`. A refusal at this point (422 `manifest_invalid`) is shown with
   **Retry**; nothing is half-written.

A 401 anywhere (token expired) opens **Sign in again**; the call is retried after sign-in and the canvas keeps
its state. **Provisioned workspaces** lists every configurator-provisioned tenant (code, status, live
release, seats) with Details: release history (reason, publisher, source, sha), the live module registry
(off / custom / supervisor-only) and the business admin's claim state.

**Demo workspaces** (Blue Tokai, Starbucks, Burger King) publish exactly like custom ones: their id
(`bluetokai`, …) becomes the `configurator_ref`, the first publish provisions a tenant. Their v5 manifests
validate with 0 errors. Caveat: v5 keeps demo-workspace edits in memory only (a reload of the canvas resets
them; what was published stays in the app). Custom workspaces ("+ New workspace") persist to NocoBase.

The old approval queue is the **Requests** tab (unchanged), **Password resets** unchanged.

## 2. Login side — workspace-code authenticity (`/#/welcome` → Sign in)

* A **fake but well-formed code** is refused in the code dialog ("We couldn't find a workspace with that
  code…") — the user never reaches a sign-in form; a direct link `/#/login/<FAKE>` shows **Workspace not
  found**. A real code opens the branded page with the **company name** (and logo if branded). Source: the
  existing public `GET /tenancy/branding` (real → name, unknown → `name: null`; 30/min rate limit) — nothing
  is revealed beyond what that endpoint already answers.
* **Business admin first sign-in**: email → "Create a password" step now has **Setup code** — entering the code
  from the provisioning dialog claims the account with `POST /auth/password-reset/complete` (code checked and
  consumed). Left empty, the existing first-password path is used (SEC-1, see the report).

## 3. Business admin — onboarding into custom modules (`/#/business-admin`)

* **Departments**: one card per enabled module with teams, in release order — custom modules included (their
  label, generic icon), disabled built-ins gone. Rotate/Reveal the department code; **Awaiting approval** has a
  tab per module (custom ones too) → Approve puts the supervisor into that module.
* **Workspace Access**: the module list is the release's (custom modules → `/#/m/<key>`). A business admin
  acting on a custom module acts as *business admin* — every step outside its tier is recorded as an
  **override**.
* Supervisors of a custom module: **Team** → "My invite code for <module>" → executives join with it → approve.

## 4. Everyone — navigation from the published release

`GET /workspace/modules` (once per sign-in) drives: the custom module's sidebar (its configured navigation:
Overview / Queue / Checklist review / History → views of the generic page), a **Modules** section (other custom
modules the user belongs to + their home module), hidden **Payment** / **Launch** when `finance_ca` /
`launch_approval` are off, the observer and business-admin module switchers, the pending-approval tabs.
A user whose primary module is custom lands on `/#/m/<key>` after sign-in. Legacy tenants (never published)
look exactly as before.

## 5. Custom modules — `/#/m/<key>` and `/#/m/<key>/records/<id>`

* **Module page**: cases (All · My turn · Awaiting approval · Closed), and for supervisors / business admin
  **Open a case** per site → if the entry gate is closed: the **locked screen** (refusal message, every
  condition with met / reached-so-far, all/any) with "Check again".
* **Case page**: release the case is **pinned** to (and the live one if newer); stages of that release (tier
  chain, state, submitted values); **Next step** — whose turn; for a submit step the stage form (rjsf, from the
  backend's JSON Schema + uiSchema; client validation first, the backend re-validates and its errors appear
  under the fields); buttons only from `allowed_actions` (Approve · Send back with reason and optional earlier
  stage · Reject); every action carries `expected_seq` — if someone acted first: "This case changed since you
  opened it" + Refresh; the latest send-back reason is shown to whoever acts next; **Assign to an executive**
  (supervisor / business admin, when the module uses delegation); **Approvals** (override / delegate flags);
  **Audit trail** with provenance (policy, release version, actor role, override, event #) and a chain-verified
  badge.
* Field widgets: person → member picker (filtered by the field's tier hint); **file → "upload isn't available
  for configurator-built modules yet"** + a reference text field (no upload endpoint exists — gap).

## 6. Protocol between the configurator iframe and the portal

`public/configurator/host-bridge.js` ⇄ `src/modules/admin/workspaces/configuratorHost.js`, same-origin
`postMessage`, origin **and** source window checked on both sides, no credentials in any message:

| From → to | type | payload |
|---|---|---|
| frame → host | `context` | `{ref, name, slug, custom, liveV, draftV}` on mount and whenever workspace / versions change |
| frame → host | `pre-publish` | `{id, context, manifest (draft), reason}` — v5 waits |
| host → frame | `pre-publish-ack` / `pre-publish-result` | `{id}` / `{id, ok, message}` — no ack in 2.5 s ⇒ v5 publishes stand-alone |
| frame → host | `published` | `{context, version, reason, publisher, manifest}` (v5's `manifest()` after publishing) |
| host → frame | `request-manifest` → frame answers `manifest` | `{id}` → `{id, context, manifest}` |
| host → frame | `toast` | `{message}` |

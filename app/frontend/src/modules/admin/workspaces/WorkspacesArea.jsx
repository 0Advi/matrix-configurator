// The platform-admin portal's Workspaces area (/#/admin → Workspaces), F4b.
//
//   Design       the Workspace Configurator v5 (public/configurator/, same-origin iframe; drafts
//                persist to NocoBase through /cfg) + an "App" panel that turns a publish in the
//                canvas into a real workspace of this app:
//                  pre-publish  → POST …/releases/validate (errors stop v5's publish)
//                               → GET /platform/workspaces/{ref}; 404 → Provision dialog →
//                                 POST /platform/workspaces → codes shown once
//                  published    → POST /platform/workspaces/{ref}/releases {manifest, reason}
//   Provisioned  GET /platform/workspaces (+ detail: release history, module registry).
//
// Every call is made here with the admin token from the page's memory; the iframe never sees
// it. A 401 (the token lasts 30 minutes) opens a re-auth dialog and retries the call.
import React from 'react';
import { platformApi, adminTokenSecondsLeft, workspaceLoginUrl } from '../adminApi.js';
import { useAdminReauth } from '../useAdminReauth.jsx';
import CredentialsDialog from '../CredentialsDialog.jsx';
import { createConfiguratorHost, splitFindings } from './configuratorHost.js';
import { ProvisionDialog, FindingsList } from './dialogs.jsx';
import { C, Button, Pill, Eyebrow, Banner, Spinner, CopyButton, when } from './ui.jsx';
import WorkspacesList from './WorkspacesList.jsx';

export const CONFIGURATOR_SRC = '/configurator/index.html';

function sessionLabel(secs) {
  if (secs == null) return null;
  if (secs <= 0) return 'session expired';
  const m = Math.floor(secs / 60);
  return m >= 1 ? `session ${m} min left` : `session ${secs}s left`;
}

export default function WorkspacesArea({ keyValue, onKeyChange, onLogout, frameSrc = CONFIGURATOR_SRC }) {
  // F5a: the 401 → sign in again → retry-once flow lives in useAdminReauth (shared with the
  // portal's other tabs); behaviour unchanged.
  const { withAuth, keyRef, dialog: reauthDialog } = useAdminReauth({ keyValue, onKeyChange, onLogout });
  const [sub, setSub] = React.useState('design'); // design | provisioned
  const frameRef = React.useRef(null);
  const hostRef = React.useRef(null);
  const [frameReady, setFrameReady] = React.useState(false);
  const [context, setContext] = React.useState(null);
  const [app, setApp] = React.useState({ status: 'idle' }); // idle|loading|none|ready|error
  const [activity, setActivity] = React.useState(null);
  const [provision, setProvision] = React.useState(null);  // {context, previousError, busy, error, resolve}
  const [cred, setCred] = React.useState(null);             // {result, resolve}
  const [listTick, setListTick] = React.useState(0);
  const [secsLeft, setSecsLeft] = React.useState(() => adminTokenSecondsLeft(keyValue));

  React.useEffect(() => {
    const tick = () => setSecsLeft(adminTokenSecondsLeft(keyRef.current));
    tick();
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, [keyValue, keyRef]);

  // ── what the app knows about the workspace open in the canvas ───────────────
  const loadApp = React.useCallback(async (ref) => {
    if (!ref) { setApp({ status: 'idle' }); return null; }
    setApp((a) => (a.ref === ref && a.status === 'ready' ? { ...a, refreshing: true } : { status: 'loading', ref }));
    try {
      const ws = await withAuth((k) => platformApi.get(k, ref));
      setApp({ status: 'ready', ref, ws });
      return ws;
    } catch (e) {
      if (e?.status === 404) { setApp({ status: 'none', ref }); return null; }
      setApp({ status: 'error', ref, error: e.message });
      return null;
    }
  }, [withAuth]);
  const ctxRef = context?.ref || null;
  React.useEffect(() => { loadApp(ctxRef); }, [ctxRef, loadApp]);

  // ── provisioning (dialog → POST → codes once) ───────────────────────────────
  const askProvision = React.useCallback((ctx, previousError) => new Promise((resolve) => {
    setProvision({ context: ctx, previousError, busy: false, error: null, resolve });
  }), []);
  const submitProvision = async (body) => {
    const p = provision;
    setProvision({ ...p, busy: true, error: null });
    try {
      const res = await withAuth((k) => platformApi.provision(k, body));
      setProvision(null);
      // Codes are shown ONCE; the publish continues when the admin closes the dialog.
      setCred({ result: { ...res, company: body.company }, resolve: () => p.resolve(res) });
    } catch (e) {
      if (e?.status === 409 && e.code === 'already_provisioned') { setProvision(null); p.resolve({ already: true, ...e.body }); return; }
      setProvision({ ...p, busy: false, error: e.message || 'Provisioning failed.' });
    }
  };
  const cancelProvision = () => { const p = provision; setProvision(null); p?.resolve(null); };
  const closeCred = () => { const c = cred; setCred(null); c?.resolve?.(); };

  // ensure the workspace exists in the app; true when it does (or was just provisioned)
  const ensureProvisioned = React.useCallback(async (ctx) => {
    let ws = null;
    try { ws = await withAuth((k) => platformApi.get(k, ctx.ref)); }
    catch (e) { if (e?.status !== 404) throw e; }
    if (ws && ws.status === 'active') return { ws, provisioned: false };
    if (ws && ws.status === 'provisioning') throw new Error('Provisioning of this workspace is already in progress — try again in a moment.');
    const res = await askProvision(ctx, ws?.status === 'failed' ? (ws.last_error || 'unknown error') : null);
    if (!res) return null;
    return { ws: null, provisioned: true, result: res };
  }, [withAuth, askProvision]);

  // ── publish: gate (before v5 publishes) and release (after) ─────────────────
  const onPrePublish = async ({ id, context: ctx, manifest }) => {
    const host = hostRef.current;
    if (!ctx?.ref || !manifest) { host?.answerPrePublish(id, false, 'The configurator sent no manifest.'); return; }
    setSub('design');
    setActivity({ kind: 'working', ref: ctx.ref, title: `Checking ${ctx.name} v${ctx.draftV} with the app…` });
    try {
      const v = await withAuth((k) => platformApi.validate(k, ctx.ref, manifest));
      if (!v.ok || v.errors > 0) {
        setActivity({ kind: 'blocked', ref: ctx.ref, name: ctx.name, version: ctx.draftV, findings: v.findings });
        host?.answerPrePublish(id, false, `Publish blocked: the app found ${v.errors} error${v.errors === 1 ? '' : 's'} — see the App panel.`);
        return;
      }
      setActivity({ kind: 'working', ref: ctx.ref, title: 'Draft is valid. Checking the workspace in the app…', findings: v.findings });
      const ok = await ensureProvisioned(ctx);
      if (!ok) {
        setActivity({ kind: 'cancelled', ref: ctx.ref, name: ctx.name });
        host?.answerPrePublish(id, false, 'Publish cancelled — the workspace was not provisioned.');
        return;
      }
      setActivity({ kind: 'working', ref: ctx.ref, title: `Publishing ${ctx.name} v${ctx.draftV}…`, findings: v.findings });
      host?.answerPrePublish(id, true);
      if (ok.provisioned) { loadApp(ctx.ref); setListTick((t) => t + 1); }
    } catch (e) {
      setActivity({ kind: 'error', ref: ctx.ref, message: e.message || String(e) });
      host?.answerPrePublish(id, false, `Publish stopped: ${e.message || e}`);
    }
  };

  const runRelease = async (job) => {
    setActivity({ kind: 'working', ref: job.ref, title: `Storing ${job.name} v${job.cfgVersion} as a release of the app…` });
    try {
      const res = await withAuth((k) => platformApi.publish(k, job.ref, {
        manifest: job.manifest, reason: job.reason, sourceRef: `configurator:${job.ref}@v${job.cfgVersion}`,
      }));
      setActivity({ kind: 'live', ref: job.ref, name: job.name, cfgVersion: job.cfgVersion, release: res.release, findings: res.findings, modules: res.modules });
      hostRef.current?.toast(`Live in the Matrix app — release v${res.release?.version}.`);
      loadApp(job.ref);
      setListTick((t) => t + 1);
    } catch (e) {
      if (e?.status === 404) {
        // Published without the gate (e.g. the canvas was published before this page listened).
        const ok = await ensureProvisioned({ ref: job.ref, name: job.name }).catch(() => null);
        if (ok) return runRelease(job);
        setActivity({ kind: 'error', ref: job.ref, job, message: 'The workspace is not provisioned in the app, so this version was not stored.' });
        return;
      }
      if (e?.status === 422 && e.code === 'manifest_invalid') {
        setActivity({ kind: 'refused', ref: job.ref, name: job.name, cfgVersion: job.cfgVersion, findings: e.body?.findings, job });
        return;
      }
      setActivity({ kind: 'error', ref: job.ref, job, message: e.message || String(e) });
    }
  };

  const onPublished = (evt) => {
    const ctx = evt.context || {};
    if (!ctx.ref || !evt.manifest) return;
    runRelease({ ref: ctx.ref, name: ctx.name || ctx.ref, cfgVersion: evt.version, reason: evt.reason, manifest: evt.manifest });
  };

  const checkDraft = async () => {
    const host = hostRef.current;
    setActivity({ kind: 'working', ref: ctxRef, title: 'Checking the current draft against the app…' });
    try {
      const { context: ctx, manifest } = await host.requestManifest();
      const v = await withAuth((k) => platformApi.validate(k, ctx.ref, manifest));
      setActivity({ kind: 'check', ref: ctx.ref, name: ctx.name, version: ctx.draftV, ok: v.ok && !v.errors, errors: v.errors, warnings: v.warnings, findings: v.findings, modules: v.modules });
    } catch (e) {
      setActivity({ kind: 'error', ref: ctxRef, message: e.message || String(e) });
    }
  };

  // latest handlers for the long-lived message listener
  const handlers = React.useRef({});
  handlers.current = { onPrePublish, onPublished };
  React.useEffect(() => {
    const host = createConfiguratorHost({
      getFrameWindow: () => frameRef.current?.contentWindow || null,
      origin: window.location.origin,
      onContext: (ctx) => { setFrameReady(true); setContext(ctx); },
      onPrePublish: (req) => handlers.current.onPrePublish(req),
      onPublished: (evt) => handlers.current.onPublished(evt),
    });
    hostRef.current = host;
    return () => host.dispose();
  }, []);

  const tab = (v, label) => (
    <button key={v} type="button" role="tab" aria-selected={sub === v} onClick={() => setSub(v)} style={{ height: 28, padding: '0 12px', borderRadius: 999, border: 'none',
      background: sub === v ? 'rgba(255,255,255,0.14)' : 'transparent', color: sub === v ? '#fff' : C.muted, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{label}</button>
  );

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 20px', borderBottom: `1px solid ${C.line}`, flexShrink: 0 }}>
        <div role="tablist" aria-label="Workspaces views" style={{ display: 'inline-flex', gap: 2 }}>
          {tab('design', 'Design & publish')}
          {tab('provisioned', 'Provisioned workspaces')}
        </div>
        <span style={{ flex: 1 }}/>
        {sessionLabel(secsLeft) && <span style={{ fontSize: 11, color: secsLeft != null && secsLeft < 300 ? C.warn : C.faint, fontFamily: C.mono }}>{sessionLabel(secsLeft)}</span>}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: sub === 'design' ? 'flex' : 'none' }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative', background: C.page }}>
          <iframe ref={frameRef} title="Workspace configurator" src={frameSrc} data-testid="configurator-frame"
            style={{ width: '100%', height: '100%', border: 0, display: 'block', background: C.page }}/>
        </div>
        <AppPanel context={context} frameReady={frameReady} app={app} activity={activity}
          onCheck={checkDraft} onRefresh={() => loadApp(ctxRef)}
          onRetry={(job) => runRelease(job)} onDismiss={() => setActivity(null)}/>
      </div>

      {sub === 'provisioned' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 20px 40px' }}>
          <WorkspacesList withAuth={withAuth} tick={listTick}/>
        </div>
      )}

      {provision && <ProvisionDialog context={provision.context} previousError={provision.previousError} busy={provision.busy} error={provision.error}
        onCancel={cancelProvision} onSubmit={submitProvision}/>}
      {cred && <CredentialsDialog variant="configurator" result={cred.result} keyValue={keyRef.current} withAuth={withAuth} onClose={closeCred}/>}
      {reauthDialog}
    </div>
  );
}

function Section({ title, children, right }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px', borderBottom: `1px solid ${C.line}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Eyebrow>{title}</Eyebrow><span style={{ flex: 1 }}/>{right}</div>
      {children}
    </section>
  );
}

function KV({ k, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '104px 1fr', gap: 8, alignItems: 'baseline', fontSize: 12.5 }}>
      <span style={{ color: C.faint, fontSize: 11.5 }}>{k}</span>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

export function AppPanel({ context, frameReady, app, activity, onCheck, onRefresh, onRetry, onDismiss }) {
  const ws = app.status === 'ready' ? app.ws : null;
  return (
    <aside aria-label="App panel" style={{ width: 'clamp(280px, 30vw, 380px)', flexShrink: 0, borderLeft: `1px solid ${C.line}`, background: C.panel, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <Section title="In the canvas">
        {!frameReady && <span style={{ fontSize: 12.5, color: C.muted, display: 'inline-flex', gap: 8, alignItems: 'center' }}><Spinner/> Loading the configurator…</span>}
        {frameReady && !context && <span style={{ fontSize: 12.5, color: C.muted }}>Pick a workspace in the configurator.</span>}
        {context && (
          <>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{context.name || context.ref}</div>
            <KV k="Workspace id"><code style={{ fontFamily: C.mono, fontSize: 12 }}>{context.ref}</code>{context.custom ? '' : <span style={{ color: C.faint }}> · demo</span>}</KV>
            <KV k="Configurator">live v{context.liveV} · draft v{context.draftV}</KV>
          </>
        )}
      </Section>

      <Section title="In the app" right={context && <Button size="sm" onClick={onRefresh} disabled={app.status === 'loading'}>Refresh</Button>}>
        {(!context || app.status === 'idle') && <span style={{ fontSize: 12.5, color: C.faint }}>—</span>}
        {app.status === 'loading' && <span style={{ fontSize: 12.5, color: C.muted, display: 'inline-flex', gap: 8, alignItems: 'center' }}><Spinner/> Looking it up…</span>}
        {app.status === 'error' && <Banner>{app.error}</Banner>}
        {app.status === 'none' && (
          <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
            <Pill tone="muted">Not provisioned</Pill>
            <p style={{ margin: '8px 0 0' }}>The first <b>Publish</b> in the canvas provisions it: you enter the company and business admin, the app creates the tenant, and you get the workspace code and a one-time setup code.</p>
          </div>
        )}
        {ws && (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Pill tone={ws.status === 'active' ? 'ok' : ws.status === 'failed' ? 'bad' : 'warn'}>{ws.status}</Pill>
              {ws.live_release ? <Pill tone="info">release v{ws.live_release.version} live</Pill> : <Pill tone="warn">no release yet</Pill>}
            </div>
            <KV k="Company">{ws.company}</KV>
            <KV k="Workspace code">
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <code data-testid="app-workspace-code" style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700 }}>{ws.workspace_code}</code>
                {ws.workspace_code && <CopyButton value={ws.workspace_code}/>}
              </span>
            </KV>
            {ws.workspace_code && <KV k="Login page"><a href={workspaceLoginUrl(ws.workspace_code)} target="_blank" rel="noreferrer" style={{ color: C.info, fontSize: 12 }}>Open in a new tab ↗</a></KV>}
            <KV k="Seats">{ws.used_seats ?? '—'} / {ws.seat_limit}</KV>
            {ws.business_admin && <KV k="Business admin">{ws.business_admin.email} {ws.business_admin.has_password ? <Pill tone="ok">claimed</Pill> : <Pill tone="warn">not claimed yet</Pill>}</KV>}
            <KV k="Releases">{ws.release_count ?? (ws.releases || []).length}{ws.live_release?.activated_at ? ` · live since ${when(ws.live_release.activated_at)}` : ''}</KV>
            {ws.last_error && <Banner>{ws.last_error}</Banner>}
          </>
        )}
      </Section>

      <Section title="Activity" right={activity && activity.kind !== 'working' && <Button size="sm" onClick={onDismiss}>Clear</Button>}>
        <Activity activity={activity} onRetry={onRetry}/>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button size="sm" variant="primary" onClick={onCheck} disabled={!context || activity?.kind === 'working'}>Check draft against the app</Button>
        </div>
        <p style={{ margin: 0, fontSize: 11.5, color: C.faint, lineHeight: 1.5 }}>
          Publish from the canvas (top-right <b>Publish</b>). The app validates the draft first — errors stop the publish — provisions the workspace on its first publish, and stores each published version as an immutable release.
        </p>
      </Section>
    </aside>
  );
}

function Activity({ activity, onRetry }) {
  if (!activity) return <span style={{ fontSize: 12.5, color: C.faint }}>Nothing yet.</span>;
  const a = activity;
  const { errors, warnings } = splitFindings(a.findings);
  switch (a.kind) {
    case 'working':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span role="status" style={{ fontSize: 12.5, display: 'inline-flex', gap: 8, alignItems: 'center' }}><Spinner/> {a.title}</span>
          {warnings.length > 0 && <FindingsList findings={a.findings}/>}
        </div>
      );
    case 'blocked':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Banner>Publish of <b>{a.name}</b> v{a.version} was stopped: {errors.length} error{errors.length === 1 ? '' : 's'}. Fix them in the canvas and publish again.</Banner>
          <FindingsList findings={a.findings}/>
        </div>
      );
    case 'cancelled':
      return <Banner tone="warn">Publish of <b>{a.name}</b> cancelled — nothing was provisioned or published.</Banner>;
    case 'live':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Banner tone="ok"><b>{a.name}</b> is live in the app: release <b>v{a.release?.version}</b> (configurator v{a.cfgVersion}){a.release?.manifest_sha256 ? <> · <code style={{ fontFamily: C.mono }}>{a.release.manifest_sha256.slice(0, 10)}</code></> : null}.</Banner>
          {Array.isArray(a.modules) && a.modules.length > 0 && (
            <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.6 }}>
              Modules: {a.modules.map((m) => (
                <span key={m.key} style={{ marginRight: 8, color: m.enabled ? C.text : C.faint, textDecoration: m.enabled ? 'none' : 'line-through' }}>
                  {m.label || m.key}{m.kind === 'custom' ? ' ◆' : ''}
                </span>
              ))}
            </div>
          )}
          {warnings.length > 0 && <FindingsList findings={a.findings}/>}
        </div>
      );
    case 'refused':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Banner>The configurator marked <b>{a.name}</b> v{a.cfgVersion} live, but the app refused to store it ({errors.length} error{errors.length === 1 ? '' : 's'}). Fix the draft and publish again.</Banner>
          <FindingsList findings={a.findings}/>
          {a.job && <Button size="sm" onClick={() => onRetry(a.job)}>Retry storing v{a.cfgVersion}</Button>}
        </div>
      );
    case 'check':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Banner tone={a.ok ? 'ok' : 'bad'}>{a.ok ? <>Draft v{a.version} of <b>{a.name}</b> would publish cleanly{a.warnings ? ` (${a.warnings} warning${a.warnings === 1 ? '' : 's'})` : ''}.</> : <>Draft v{a.version} of <b>{a.name}</b> has {a.errors} error{a.errors === 1 ? '' : 's'} — a publish would be stopped.</>}</Banner>
          <FindingsList findings={a.findings}/>
        </div>
      );
    case 'error':
    default:
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Banner>{a.message}</Banner>
          {a.job && <Button size="sm" onClick={() => onRetry(a.job)}>Retry storing v{a.job.cfgVersion}</Button>}
        </div>
      );
  }
}

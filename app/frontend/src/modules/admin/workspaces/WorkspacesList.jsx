// Provisioned workspaces (GET /platform/workspaces) with a per-workspace detail
// (GET /platform/workspaces/{ref}: release history, module registry, business-admin claim).
import React from 'react';
import { platformApi, workspaceLoginUrl } from '../adminApi.js';
import { C, Button, Pill, Eyebrow, Banner, Spinner, CopyButton, when } from './ui.jsx';

const GRID = '1.5fr 1.6fr 0.8fr 0.9fr 0.7fr 1fr 90px';

export default function WorkspacesList({ withAuth, tick = 0 }) {
  const [state, setState] = React.useState({ status: 'loading', items: [] });
  const [open, setOpen] = React.useState(null);

  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, status: s.items.length ? 'refreshing' : 'loading', error: null }));
    try {
      const d = await withAuth((k) => platformApi.list(k));
      setState({ status: 'ready', items: d?.items || [] });
    } catch (e) {
      setState((s) => ({ ...s, status: 'error', error: e.message }));
    }
  }, [withAuth]);
  React.useEffect(() => { load(); }, [load, tick]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <p style={{ margin: 0, fontSize: 13, color: C.muted, lineHeight: 1.5, flex: 1 }}>
          Workspaces created from the configurator. Each publish is stored as an immutable release; the live one drives the workspace&#39;s modules, labels and order.
        </p>
        <Button size="sm" onClick={load} busy={state.status === 'refreshing'}>Refresh</Button>
      </div>
      {state.status === 'error' && <Banner>{state.error}</Banner>}
      {state.status === 'loading' && <span style={{ fontSize: 13, color: C.muted, display: 'inline-flex', gap: 8, alignItems: 'center' }}><Spinner/> Loading…</span>}
      {state.status !== 'loading' && state.items.length === 0 && !state.error && (
        <div style={{ padding: 40, textAlign: 'center', border: `1px dashed ${C.lineStrong}`, borderRadius: 14, color: C.faint, fontSize: 13 }}>
          No workspace has been published from the configurator yet.
        </div>
      )}
      {state.items.length > 0 && (
        <div role="table" aria-label="Provisioned workspaces" style={{ border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden' }}>
          <div role="row" style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '11px 16px', background: 'rgba(255,255,255,0.04)', fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.faint, fontWeight: 600 }}>
            <span>Workspace</span><span>Workspace code</span><span>Status</span><span>Live release</span><span>Seats</span><span>Provisioned</span><span/>
          </div>
          {state.items.map((w, i) => (
            <React.Fragment key={w.configurator_ref}>
              <div role="row" style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '12px 16px', borderTop: i === 0 ? 'none' : `1px solid ${C.line}`, alignItems: 'center', fontSize: 13 }}>
                <span style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 650 }}>{w.company || '—'}</div>
                  <code style={{ fontFamily: C.mono, fontSize: 11, color: C.faint }}>{w.configurator_ref}</code>
                </span>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                  <code style={{ fontFamily: C.mono, fontSize: 12, overflowWrap: 'anywhere' }}>{w.workspace_code || '—'}</code>
                  {w.workspace_code && <CopyButton value={w.workspace_code}/>}
                </span>
                <span><Pill tone={w.status === 'active' ? 'ok' : w.status === 'failed' ? 'bad' : 'warn'}>{w.status}</Pill></span>
                <span style={{ fontSize: 12.5 }}>{w.live_release ? <>v{w.live_release.version} <span style={{ color: C.faint }}>of {w.release_count}</span></> : <span style={{ color: C.faint }}>none</span>}</span>
                <span style={{ fontFamily: C.mono, fontSize: 12 }}>{w.used_seats ?? '—'}/{w.seat_limit ?? '—'}</span>
                <span style={{ fontSize: 11.5, color: C.muted }}>{when(w.provisioned_at || w.created_at)}</span>
                <span style={{ textAlign: 'right' }}>
                  <Button size="sm" aria-expanded={open === w.configurator_ref} onClick={() => setOpen(open === w.configurator_ref ? null : w.configurator_ref)}>{open === w.configurator_ref ? 'Hide' : 'Details'}</Button>
                </span>
              </div>
              {open === w.configurator_ref && <WorkspaceDetail refId={w.configurator_ref} withAuth={withAuth}/>}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceDetail({ refId, withAuth }) {
  const [d, setD] = React.useState({ status: 'loading' });
  React.useEffect(() => {
    let alive = true;
    withAuth((k) => platformApi.get(k, refId))
      .then((ws) => alive && setD({ status: 'ready', ws }))
      .catch((e) => alive && setD({ status: 'error', error: e.message }));
    return () => { alive = false; };
  }, [refId, withAuth]);
  if (d.status === 'loading') return <div style={{ padding: '10px 16px', borderTop: `1px solid ${C.line}` }}><Spinner/></div>;
  if (d.status === 'error') return <div style={{ padding: '10px 16px', borderTop: `1px solid ${C.line}` }}><Banner>{d.error}</Banner></div>;
  const ws = d.ws;
  return (
    <div style={{ padding: '14px 16px 18px', borderTop: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.02)', display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 22 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Eyebrow>Release history</Eyebrow>
        {(ws.releases || []).length === 0 && <span style={{ fontSize: 12.5, color: C.faint }}>Nothing published yet.</span>}
        {(ws.releases || []).map((r) => (
          <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '54px 1fr', gap: 10, padding: '8px 10px', borderRadius: 8, border: `1px solid ${C.line}`, background: r.is_live ? C.okBg : 'transparent' }}>
            <span style={{ fontFamily: C.mono, fontWeight: 700, fontSize: 12.5, color: r.is_live ? C.ok : C.text }}>v{r.version}</span>
            <span style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5 }}>{r.reason || <span style={{ color: C.faint }}>no reason given</span>} {r.is_live && <Pill tone="ok">live</Pill>}</div>
              <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>
                {when(r.created_at)} · {r.published_by || '—'}{r.source_ref ? ` · ${r.source_ref}` : ''} · <code style={{ fontFamily: C.mono }}>{String(r.manifest_sha256 || '').slice(0, 10)}</code>
              </div>
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Eyebrow>Business admin</Eyebrow>
        {ws.business_admin
          ? <div style={{ fontSize: 12.5 }}>{ws.business_admin.name ? `${ws.business_admin.name} · ` : ''}{ws.business_admin.email} {ws.business_admin.has_password ? <Pill tone="ok">claimed</Pill> : <Pill tone="warn">not claimed yet</Pill>}</div>
          : <span style={{ fontSize: 12.5, color: C.faint }}>—</span>}
        {ws.workspace_code && <a href={workspaceLoginUrl(ws.workspace_code)} target="_blank" rel="noreferrer" style={{ color: C.info, fontSize: 12 }}>Open the workspace login page ↗</a>}
        <Eyebrow style={{ marginTop: 8 }}>Modules (live registry)</Eyebrow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {(ws.modules || []).map((m) => (
            <div key={m.key} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, fontSize: 12, color: m.enabled ? C.text : C.faint }}>
              <span style={{ textDecoration: m.enabled ? 'none' : 'line-through' }}>
                {m.label || m.key} <code style={{ fontFamily: C.mono, fontSize: 10.5, color: C.faint }}>{m.key}</code>
              </span>
              <span style={{ display: 'inline-flex', gap: 4 }}>
                {m.kind === 'custom' && <Pill tone="info">custom</Pill>}
                {m.supervisor_only && <Pill>supervisor-only</Pill>}
                {!m.enabled && <Pill>off</Pill>}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// /m/:moduleKey — a configurator-defined module's home (F4b; backend docs/F4-API.md §3).
//
// Lists the module's cases (GET /m/{key}/records), filtered by the sidebar's views
// (?view=queue | review | history — the pages of the module's published navigation), and,
// for the roles that may open one (supervisor, business admin), the sites a case can be
// opened on. Opening runs the module's entry gate on the backend: 409 gate_closed renders the
// locked screen from its explanation.
//
// G3: role-scoped SAVED VIEWS (GET /m/{key}/views). The switcher shows the views whose audience
// has the caller's role; the selected one is applied SERVER-SIDE (GET /m/{key}/records?view=<id>,
// on top of the caller's scope) and decides the columns. `?view=` accepts a view id, a seed key
// (my_cases, awaiting_me, …) or the sidebar's page keys (queue / review / history). Business admins
// get "Manage views". When no views are available (older backend) F4b's fixed tabs are used.
import React from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import PageHeader, { HeaderTag } from '../shared/page-header/PageHeader.jsx';
import Icon from '../shared/primitives/Icon.jsx';
import { useSession } from '../../state/SessionContext.jsx';
import { useWorkspaceModules } from '../../state/useWorkspaceModules.js';
import { customModuleRecordRoute, customModuleViewsRoute } from '../../router/routes.js';
import { listRecords, listSitesForCases, listViews, listMembers, openRecord, problemOf, resolveView } from '../../services/api/moduleRuntimeApi.js';
import { COLUMNS, DEFAULT_COLUMNS, describeFilter } from './viewsKit.js';
import { Card, SectionTitle, CaseStatus, Button, Notice, Empty, when, tierLabel } from './kit.jsx';
import GateLocked from './GateLocked.jsx';

export const VIEWS = [
  { key: '', label: 'All cases' },
  { key: 'queue', label: 'My turn' },
  { key: 'review', label: 'Awaiting approval' },
  { key: 'history', label: 'Closed' },
];
const CLOSED = new Set(['completed', 'rejected']);

export function filterCases(items, view) {
  const list = Array.isArray(items) ? items : [];
  if (view === 'queue') return list.filter((r) => (r.allowed_actions || []).length > 0);
  if (view === 'review') return list.filter((r) => r.next_step?.kind === 'approve');
  if (view === 'history') return list.filter((r) => CLOSED.has(r.case_status));
  return list;
}

export default function GenericModulePage() {
  const { moduleKey } = useParams();
  const [params, setParams] = useSearchParams();
  const viewParam = params.get('view') || '';
  const navigate = useNavigate();
  const { isReadOnly } = useSession();
  const ws = useWorkspaceModules();
  const mod = ws.get(moduleKey);

  // Saved views for my role (G3). 'fallback' = no views API / none visible -> F4b's fixed tabs.
  const [views, setViews] = React.useState({ status: 'loading', items: [], defaultId: null, canManage: false });
  React.useEffect(() => {
    let alive = true;
    setViews({ status: 'loading', items: [], defaultId: null, canManage: false });
    Promise.resolve().then(() => listViews(moduleKey))
      .then((d) => alive && setViews(d && (d.items || []).length
        ? { status: 'ready', items: d.items, defaultId: d.default_view_id, canManage: Boolean(d.can_manage) }
        : { status: 'fallback', items: [], defaultId: null, canManage: Boolean(d?.can_manage) }))
      .catch(() => alive && setViews({ status: 'fallback', items: [], defaultId: null, canManage: false }));
    return () => { alive = false; };
  }, [moduleKey]);
  const saved = views.status === 'ready';
  const current = saved ? resolveView(views.items, viewParam, views.defaultId) : null;

  const [state, setState] = React.useState({ status: 'loading', data: null, byView: {}, problem: null });
  const load = React.useCallback(async () => {
    if (views.status === 'loading') return;
    setState((s) => ({ ...s, status: s.data ? 'refreshing' : 'loading' }));
    try {
      // the unfiltered scope (open-a-case needs every case) + each saved view, server-side
      const [data, ...perView] = await Promise.all([
        listRecords(moduleKey),
        ...(saved ? views.items.map((v) => listRecords(moduleKey, { viewId: v.id }).catch(() => null)) : []),
      ]);
      const byView = Object.fromEntries(views.items.map((v, i) => [v.id, perView[i]]).filter(([, d]) => d));
      setState({ status: 'ready', data, byView, problem: null });
    } catch (e) {
      setState({ status: 'error', data: null, byView: {}, problem: problemOf(e) });
    }
  }, [moduleKey, saved, views.status, views.items]);
  React.useEffect(() => { load(); }, [load]);

  const label = state.data?.module?.label || mod?.label || moduleKey;
  const role = state.data?.role || null;
  const items = state.data?.items || [];
  const visible = saved ? (state.byView[current?.id]?.items || []) : filterCases(items, viewParam);
  const columns = saved && Array.isArray(current?.columns) && current.columns.length ? current.columns : DEFAULT_COLUMNS;
  const canOpen = !isReadOnly && (role === 'supervisor' || role === 'business_admin');
  const sourceLabels = React.useMemo(() => Object.fromEntries((ws.modules || []).map((m) => [m.key, m.label])), [ws.modules]);
  const needsPeople = columns.includes('assigned_to') || columns.includes('opened_by');
  const people = useMemberNames(moduleKey, needsPeople && state.status === 'ready');
  const loading = state.status === 'loading' || views.status === 'loading';

  const tabs = saved
    ? views.items.map((v) => ({ key: v.seed_key || v.id, id: v.id, label: v.name, on: v.id === current?.id,
      n: state.byView[v.id]?.total ?? state.byView[v.id]?.items?.length }))
    : VIEWS.map((v) => ({ key: v.key, id: v.key || 'all', label: v.label, on: viewParam === v.key, n: filterCases(items, v.key).length }));

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <PageHeader
        title={label}
        lede={mod?.supervisor_only
          ? 'A workspace module designed in the configurator. Supervisors run every stage.'
          : 'A workspace module designed in the configurator. Each case runs the stages and approvals of the release its site is pinned to.'}
        right={(
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            {role && <HeaderTag icon="user" label={`You: ${tierLabel(role)}`}/>}
            {ws.release && <HeaderTag icon="layers" label={`Live release v${ws.release.version}`} tone="accent"/>}
            {views.canManage && <Button icon="settings" onClick={() => navigate(customModuleViewsRoute(moduleKey))}>Manage views</Button>}
            <Button icon="refresh" onClick={load} busy={state.status === 'refreshing'}>Refresh</Button>
          </span>
        )}
      />

      {state.status === 'error' && <ModuleProblem problem={state.problem} label={label} onRetry={load}/>}

      {state.status !== 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div role="tablist" aria-label={saved ? 'Saved views' : 'Case views'} style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, padding: 4, background: 'var(--zm-surface-2)', border: '1px solid var(--zm-line)', borderRadius: 999, alignSelf: 'flex-start' }}>
              {tabs.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={t.on}
                  onClick={() => setParams(t.key ? { view: t.key } : {})}
                  style={{ height: 30, padding: '0 13px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'var(--zm-font-body)',
                    fontSize: 12.5, fontWeight: 650, background: t.on ? 'var(--zm-fg)' : 'transparent', color: t.on ? 'var(--zm-bg)' : 'var(--zm-fg-2)' }}>
                  {t.label} <span style={{ marginLeft: 4, opacity: 0.7, fontFamily: 'var(--zm-font-mono)', fontSize: 11 }}>{loading ? '…' : (t.n ?? '–')}</span>
                </button>
              ))}
            </div>
            {saved && current && (
              <div style={{ fontSize: 12, color: 'var(--zm-fg-3)' }} data-testid="view-description">
                {current.name}: {describeFilter(current.filter)}{current.all_modules ? ' · every custom module' : ''}
              </div>
            )}
          </div>

          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {loading && <div style={{ padding: 24, color: 'var(--zm-fg-3)' }}>Loading cases…</div>}
            {!loading && visible.length === 0 && (
              <div style={{ padding: 18 }}>
                <Empty title={viewParam || saved ? 'Nothing here' : 'No cases yet'}>
                  {saved ? (items.length ? `No case matches “${current?.name}”.` : emptyText(canOpen, role))
                    : viewParam === 'queue' ? 'No case is waiting on you right now.'
                      : viewParam === 'review' ? 'No case is waiting for an approval.'
                        : viewParam === 'history' ? 'No case has finished yet.'
                          : emptyText(canOpen, role)}
                </Empty>
              </div>
            )}
            {!loading && visible.length > 0 && <CasesTable items={visible} columns={columns} people={people}
              onOpen={(r) => navigate(customModuleRecordRoute(moduleKey, r.id))}/>}
          </Card>

          {canOpen && <OpenCase moduleKey={moduleKey} label={label} existing={items} sourceLabels={sourceLabels}
            onOpened={(rec) => navigate(customModuleRecordRoute(moduleKey, rec.id))}/>}
        </div>
      )}
    </div>
  );
}

function emptyText(canOpen, role) {
  return canOpen ? 'Open a case for a site below.' : role === 'executive'
    ? 'Cases show up here once a supervisor opens one for a site and assigns it to you — or for a site you created, when a stage is reserved for the site’s creator.'
    : 'Cases show up here once a supervisor opens one for a site.';
}

// Member names for the assigned-to / opened-by columns (best effort; ids stay as a fallback).
function useMemberNames(moduleKey, enabled) {
  const [names, setNames] = React.useState({});
  React.useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    Promise.resolve().then(() => listMembers(moduleKey))
      .then((d) => alive && setNames(Object.fromEntries((d?.items || []).map((m) => [m.id, m.name || m.email]))))
      .catch(() => {});
    return () => { alive = false; };
  }, [moduleKey, enabled]);
  return names;
}

function ModuleProblem({ problem, label, onRetry }) {
  if (!problem) return null;
  const title = problem.status === 403 ? `You can’t open ${label}`
    : problem.status === 404 ? 'This module isn’t available in this workspace'
      : 'Couldn’t load this module';
  return (
    <Notice tone="danger" title={title} action={<Button onClick={onRetry} icon="refresh">Retry</Button>}>
      {problem.detail}
      {problem.status === 403 && <div style={{ marginTop: 4, color: 'var(--zm-fg-3)', fontSize: 12.5 }}>Only members of the module (its supervisors and executives), the business admin and observers can see it — or the module is switched off in the live release.</div>}
    </Notice>
  );
}

const COL_WIDTH = { site: 'minmax(0,1.6fr)', stage: 'minmax(0,1.1fr)', next_step: 'minmax(0,1.4fr)', status: '120px',
  assigned_to: 'minmax(0,1fr)', opened_by: 'minmax(0,1fr)', opened_at: '120px', closed_at: '120px', release: '80px' };
const COL_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));

function Cell({ col, r, people }) {
  const muted = { color: 'var(--zm-fg-3)' };
  switch (col) {
    case 'site':
      return (
        <span style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 650, color: 'var(--zm-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.site?.name || '—'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--zm-fg-3)', fontFamily: 'var(--zm-font-mono)' }}>{[r.site?.code, r.site?.city].filter(Boolean).join(' · ')}</div>
        </span>
      );
    case 'stage':
      return <span style={{ minWidth: 0, color: 'var(--zm-fg-2)' }}>{r.next_step ? `Stage ${r.next_step.stage} · ${r.next_step.name}` : r.current_stage ? `Stage ${r.current_stage}` : <span style={muted}>—</span>}</span>;
    case 'next_step':
      return (
        <span style={{ minWidth: 0, color: 'var(--zm-fg-2)' }}>
          {r.next_step
            ? <>Stage {r.next_step.stage} · {r.next_step.name}<div style={{ fontSize: 11.5, color: 'var(--zm-fg-3)' }}>{r.next_step.kind === 'approve' ? 'awaiting approval' : 'to submit'} · {tierLabel(r.next_step.role)}{r.next_step.restricted_to === 'site_creator' ? ' · site creator only' : ''}{(r.allowed_actions || []).length ? ' · your turn' : ''}</div></>
            : <span style={muted}>{r.exit_outcome ? `Finished · ${r.exit_outcome}` : '—'}</span>}
        </span>
      );
    case 'status': return <span><CaseStatus status={r.case_status}/></span>;
    case 'assigned_to': return <span style={{ minWidth: 0, fontSize: 12.5 }}>{r.assigned_to ? (people[r.assigned_to] || 'assigned') : <span style={muted}>—</span>}</span>;
    case 'opened_by': return <span style={{ minWidth: 0, fontSize: 12.5 }}>{r.opened_by ? (people[r.opened_by] || '—') : '—'}</span>;
    case 'opened_at': return <span style={{ fontSize: 12, color: 'var(--zm-fg-3)' }}>{when(r.opened_at)}</span>;
    case 'closed_at': return <span style={{ fontSize: 12, color: 'var(--zm-fg-3)' }}>{when(r.closed_at)}</span>;
    case 'release': return <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 12 }}>v{r.release_version ?? '—'}</span>;
    default: return <span/>;
  }
}

function CasesTable({ items, columns = DEFAULT_COLUMNS, people = {}, onOpen }) {
  const cols = columns.filter((c) => COL_WIDTH[c]);
  const grid = `${cols.map((c) => COL_WIDTH[c]).join(' ')} 24px`;
  return (
    <div role="table" aria-label="Cases">
      <div role="row" style={{ display: 'grid', gridTemplateColumns: grid, gap: 12, padding: '10px 18px', background: 'var(--zm-surface-2)',
        fontSize: 10.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--zm-fg-3)' }}>
        {cols.map((c) => <span key={c} role="columnheader">{COL_LABEL[c]}</span>)}<span/>
      </div>
      {items.map((r) => (
        <div key={r.id} role="row" tabIndex={0} className="zm-row" onClick={() => onOpen(r)}
          onKeyDown={(e) => { if (e.key === 'Enter') onOpen(r); }}
          style={{ display: 'grid', gridTemplateColumns: grid, gap: 12, padding: '12px 18px', borderTop: '1px solid var(--zm-line)', alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
          {cols.map((c) => <Cell key={c} col={c} r={r} people={people}/>)}
          <span className="zm-row-cta" style={{ color: 'var(--zm-fg-3)' }}><Icon name="arrow" size={14}/></span>
        </div>
      ))}
    </div>
  );
}

function OpenCase({ moduleKey, label, existing, sourceLabels, onOpened }) {
  const [sites, setSites] = React.useState({ status: 'loading', items: [] });
  const [busy, setBusy] = React.useState(null);
  const [locked, setLocked] = React.useState(null); // {site, gate}
  const [msg, setMsg] = React.useState(null);
  const loadSites = React.useCallback(async () => {
    try { setSites({ status: 'ready', items: await listSitesForCases() }); }
    catch (e) { setSites({ status: 'error', items: [], error: problemOf(e).detail }); }
  }, []);
  React.useEffect(() => { loadSites(); }, [loadSites]);

  const withCase = new Map((existing || []).map((r) => [r.site?.id, r]));
  const open = async (site) => {
    setBusy(site.id); setMsg(null);
    try {
      const rec = await openRecord(moduleKey, site.id);
      setLocked(null);
      onOpened(rec.record || rec);
    } catch (e) {
      const p = problemOf(e);
      if (p.code === 'gate_closed') setLocked({ site, gate: { ...(p.gate || {}), refusal: p.gate?.refusal || p.detail, sourceLabels } });
      else if (p.code === 'record_exists' && p.recordId) onOpened({ id: p.recordId });
      else setMsg({ tone: 'danger', text: p.detail });
    } finally { setBusy(null); }
  };

  return (
    <Card>
      <SectionTitle right={<Button icon="refresh" onClick={loadSites}>Reload sites</Button>}>Open a case</SectionTitle>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--zm-fg-2)' }}>
        A case runs <b>{label}</b> for one site, on the configuration release the site is pinned to. If the module’s entry gate is still closed for a site, you’ll see what it is waiting for.
      </p>
      {msg && <div style={{ marginBottom: 12 }}><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      {locked && <div style={{ marginBottom: 14 }}><GateLocked moduleLabel={label} site={locked.site} gate={locked.gate} busy={busy === locked.site.id}
        onRetry={() => open(locked.site)} onClose={() => setLocked(null)}/></div>}
      {sites.status === 'loading' && <div style={{ color: 'var(--zm-fg-3)', fontSize: 13 }}>Loading sites…</div>}
      {sites.status === 'error' && <Notice tone="danger">{sites.error}</Notice>}
      {sites.status === 'ready' && sites.items.length === 0 && <Empty icon="pin" title="No sites yet">Sites are created in BD (Pipeline). Once one exists you can open a case for it here.</Empty>}
      {sites.status === 'ready' && sites.items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sites.items.map((s) => {
            const rec = withCase.get(s.id);
            return (
              <div key={s.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 12, alignItems: 'center', padding: '9px 12px', border: '1px solid var(--zm-line)', borderRadius: 9 }}>
                <span style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 650 }}>{s.name}</span>
                  <span style={{ marginLeft: 8, fontSize: 11.5, color: 'var(--zm-fg-3)', fontFamily: 'var(--zm-font-mono)' }}>{[s.code, s.city, s.status].filter(Boolean).join(' · ')}</span>
                </span>
                {rec
                  ? <Button onClick={() => onOpened(rec)} icon="arrow">View case</Button>
                  : <Button variant="primary" busy={busy === s.id} onClick={() => open(s)} icon="plus">{busy === s.id ? 'Opening…' : 'Open case'}</Button>}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

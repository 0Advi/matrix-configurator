import React from 'react';
import { PRODUCT_NAME } from '../../router/routes.js';
import { apiFetch, adminLogin } from './adminApi.js';
import CredentialsDialog from './CredentialsDialog.jsx';
import WorkspacesArea from './workspaces/WorkspacesArea.jsx';
import { useAdminReauth } from './useAdminReauth.jsx';

// F4b: the platform-admin token lives ONLY in this page's memory (module scope, so moving
// between portal tabs/routes keeps it; a reload or a new tab asks to sign in again — it is a
// 30-minute token anyway). It used to be kept in sessionStorage; the portal now embeds the
// Workspace Configurator as a same-origin iframe, and same-origin pages share sessionStorage,
// so the key must not sit there. Any key left by an older build is scrubbed on load.
const LEGACY_SESSION_KEY = 'matrix.admin.platformKey';
let memoryKey = '';

function readKey() { return memoryKey; }

function writeKey(k) {
  memoryKey = k || '';
}

try { sessionStorage.removeItem(LEGACY_SESSION_KEY); } catch {/* storage unavailable */}

function GateScreen({ onUnlock }) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!email.trim() || !password) { setError('Enter your admin email and password.'); return; }
    setBusy(true); setError(null);
    try {
      const token = await adminLogin(email.trim(), password);
      writeKey(token);
      onUnlock(token);
    } catch (err) {
      setError(err.message || 'Auth failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0B0C10', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, overflowY: 'auto' }}>
      <form onSubmit={submit} style={{ width: 420, background: '#13141B', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 14, padding: 28, display: 'flex', flexDirection: 'column', gap: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.75)' }}>{PRODUCT_NAME} · Platform admin</div>
          <h1 style={{ margin: '6px 0 4px', fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', color: '#fff' }}>Platform admin</h1>
          <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.82)', lineHeight: 1.5 }}>This portal lets you design and publish workspaces, approve workspace requests and provision tenants. It is not part of any workspace — sign in with the platform admin credentials.</p>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'rgba(255,255,255,0.9)', fontWeight: 600 }}>
          Email
          <input type="email" autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@scale.bluetokai.com" style={{ height: 38, padding: '0 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.22)', background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 13, outline: 'none' }}/>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'rgba(255,255,255,0.9)', fontWeight: 600 }}>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" style={{ height: 38, padding: '0 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.22)', background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 13, outline: 'none' }}/>
        </label>
        {error && <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(220,38,38,0.22)', color: '#FCA5A5', fontSize: 12, border: '1px solid rgba(220,38,38,0.35)' }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ height: 38, borderRadius: 8, border: 'none', background: '#fff', color: '#0B0C10', fontWeight: 700, fontSize: 13, cursor: busy ? 'wait' : 'pointer' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

function ApproveDialog({ request, busy, onCancel, onConfirm }) {
  const [city, setCity] = React.useState('');
  const [adminName, setAdminName] = React.useState(request?.admin_email?.split('@')[0] || '');
  if (!request) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 480, background: '#13141B', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14, padding: 24, color: '#fff', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', opacity: 0.55 }}>Approve · {request.company}</div>
          <h2 style={{ margin: '4px 0 2px', fontSize: 19, fontWeight: 700 }}>Provision workspace</h2>
          <p style={{ margin: 0, fontSize: 12.5, opacity: 0.7, lineHeight: 1.5 }}>Creates the tenant, the supervisor user, and the workspace code. The supervisor sees every site across all cities. An email is queued in the outbox to {request.admin_email}.</p>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.85 }}>
          Primary city (optional)
          <input autoFocus value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Mumbai — used only as label metadata" style={{ height: 36, padding: '0 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(0,0,0,0.35)', color: '#fff', fontSize: 13, outline: 'none' }}/>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.85 }}>
          Admin display name (optional)
          <input value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Defaults to the email prefix" style={{ height: 36, padding: '0 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(0,0,0,0.35)', color: '#fff', fontSize: 13, outline: 'none' }}/>
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button onClick={onCancel} disabled={busy} style={{ height: 34, padding: '0 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.18)', background: 'transparent', color: '#fff', fontSize: 13, fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>Cancel</button>
          <button onClick={() => onConfirm({ city: city.trim() || null, admin_name: adminName.trim() || null })} disabled={busy} style={{ height: 34, padding: '0 16px', borderRadius: 8, border: 'none', background: '#fff', color: '#0B0C10', fontSize: 13, fontWeight: 700, cursor: busy ? 'wait' : 'pointer' }}>{busy ? 'Provisioning…' : 'Approve & provision'}</button>
        </div>
      </div>
    </div>
  );
}

function ResetQueue({ withAuth }) {
  const [items, setItems] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [confirmingId, setConfirmingId] = React.useState(null);
  const [issued, setIssued] = React.useState(null); // { email, token } from the last confirm

  const load = React.useCallback(async () => {
    setError(null);
    try {
      // F5a: a 401 asks to sign in again and retries (it used to log the admin out).
      const data = await withAuth((k) => apiFetch('/tenancy/password-reset-requests', { key: k }));
      setItems(data?.items || []);
    } catch (err) {
      setError(err.message || 'Failed to load');
    }
  }, [withAuth]);

  React.useEffect(() => { setItems(null); load(); }, [load]);

  async function confirm(id, email) {
    setConfirmingId(id); setError(null);
    try {
      const res = await withAuth((k) => apiFetch(`/tenancy/password-reset-requests/${id}/confirm`, { key: k, method: 'POST' }));
      // The reset code is shown ONCE — the user must present it to complete
      // the reset (#85). Relay it to them out-of-band.
      if (res?.reset_token) setIssued({ email, token: res.reset_token });
      await load();
    } catch (err) {
      setError(err.message || 'Confirm failed');
    } finally {
      setConfirmingId(null);
    }
  }

  return (
    <div>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>
        Users who failed sign-in and asked for a reset appear here. Confirm a request to let that user set a new password on their login page.
      </p>
      {error && <div style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(220,38,38,0.18)', color: '#FCA5A5', marginBottom: 20, fontSize: 13 }}>{error}</div>}
      {issued && (
        <div style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(250,204,21,0.10)', color: '#FDE68A', marginBottom: 20, fontSize: 12.5, lineHeight: 1.6 }}>
          Reset approved for <b>{issued.email}</b>. Share this one-time reset code with them privately — they enter it on their login page with their new password. It is shown only once.
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
            <code style={{ fontFamily: 'ui-monospace, monospace', padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.08)', fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{issued.token}</code>
            <button onClick={() => { try { navigator.clipboard?.writeText(issued.token); } catch {/* noop */} }}
              style={{ height: 28, padding: '0 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.18)', background: 'transparent', color: '#fff', fontSize: 11.5, cursor: 'pointer' }}>Copy</button>
            <button onClick={() => setIssued(null)}
              style={{ height: 28, padding: '0 10px', borderRadius: 6, border: 'none', background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: 11.5, cursor: 'pointer' }}>Dismiss</button>
          </div>
        </div>
      )}
      {items === null && !error && <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>}
      {items && items.length === 0 && (
        <div style={{ padding: 48, textAlign: 'center', border: '1px dashed rgba(255,255,255,0.15)', borderRadius: 14, color: 'rgba(255,255,255,0.55)' }}>No pending reset requests.</div>
      )}
      {items && items.length > 0 && (
        <div style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.2fr 1fr 1fr 130px', gap: 10, padding: '12px 18px', background: 'rgba(255,255,255,0.04)', fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', fontWeight: 600 }}>
            <span>Email</span><span>Company</span><span>Workspace</span><span>Requested</span><span style={{ textAlign: 'right', paddingRight: 16 }}>Action</span>
          </div>
          {items.map((r, i) => (
            <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.2fr 1fr 1fr 130px', gap: 10, padding: '14px 18px', borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.06)', alignItems: 'center', fontSize: 13 }}>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'rgba(255,255,255,0.9)', overflowWrap: 'anywhere' }}>{r.email}</span>
              <span style={{ fontSize: 12.5 }}>{r.tenant_name}</span>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>{r.workspace_code}</span>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: 'rgba(255,255,255,0.6)' }}>{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</span>
              <span style={{ textAlign: 'right' }}>
                <button onClick={() => confirm(r.id, r.email)} disabled={confirmingId === r.id}
                  style={{ height: 30, padding: '0 14px', borderRadius: 7, border: 'none', background: '#34D399', color: '#06251a', fontSize: 12, fontWeight: 800, cursor: confirmingId === r.id ? 'wait' : 'pointer', opacity: confirmingId === r.id ? 0.6 : 1 }}>
                  {confirmingId === r.id ? '…' : 'Confirm'}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function statusPill(s) {
  const palette = {
    pending:  { bg: 'rgba(217,119,6,0.18)',  fg: '#FCD34D' },
    approved: { bg: 'rgba(34,197,94,0.18)',  fg: '#86EFAC' },
    rejected: { bg: 'rgba(220,38,38,0.18)',  fg: '#FCA5A5' },
  }[s] || { bg: 'rgba(255,255,255,0.08)', fg: 'rgba(255,255,255,0.7)' };
  return (
    <span style={{ padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', ...palette, background: palette.bg, color: palette.fg }}>{s}</span>
  );
}

function PortalScreen({ keyValue, onLogout, onKeyChange }) {
  const [view, setView] = React.useState('requests'); // requests | resets | workspaces
  // F5a: every tab re-authenticates on a 401 (sign in again → the call is retried) instead of
  // logging out; the Workspaces area uses the same hook.
  const logout = React.useCallback(() => { writeKey(''); onLogout(); }, [onLogout]);
  const { withAuth, dialog: reauthDialog } = useAdminReauth({ keyValue, onKeyChange, onLogout: logout });
  // The configurator iframe is mounted on first visit and then kept (hidden) while other
  // tabs are open, so in-memory canvas state (v5 keeps demo-workspace edits in memory only)
  // and a publish in flight survive a look at the request queue.
  const [workspacesMounted, setWorkspacesMounted] = React.useState(false);
  React.useEffect(() => { if (view === 'workspaces') setWorkspacesMounted(true); }, [view]);
  const [statusFilter, setStatusFilter] = React.useState('pending');
  const [items, setItems] = React.useState(null); // null = loading
  const [error, setError] = React.useState(null);
  const [approving, setApproving] = React.useState(null);
  const [approveBusy, setApproveBusy] = React.useState(false);
  const [credResult, setCredResult] = React.useState(null);
  const [rejectingId, setRejectingId] = React.useState(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const data = await withAuth((k) => apiFetch(`/tenancy/requests?status_filter=${encodeURIComponent(statusFilter)}&limit=200`, { key: k }));
      setItems(data?.items || []);
    } catch (err) {
      setError(err.message || 'Failed to load');
    }
  }, [withAuth, statusFilter]);

  React.useEffect(() => { setItems(null); load(); }, [load]);

  async function onApprove({ city, admin_name }) {
    if (!approving) return;
    setApproveBusy(true);
    try {
      const result = await withAuth((k) => apiFetch(`/tenancy/requests/${approving.id}/approve`, {
        key: k, method: 'POST', body: { city, admin_name },
      }));
      setApproving(null);
      setCredResult({ ...result, company: approving.company });
      load();
    } catch (err) {
      setError(err.message || 'Approve failed');
    } finally {
      setApproveBusy(false);
    }
  }

  async function onReject(r) {
    if (typeof window !== 'undefined'
      && !window.confirm(`Reject the workspace request from "${r.company}"? No tenant is provisioned and this can't be undone.`)) {
      return;
    }
    setRejectingId(r.id);
    setError(null);
    try {
      await withAuth((k) => apiFetch(`/tenancy/requests/${r.id}/reject`, { key: k, method: 'POST' }));
      load();
    } catch (err) {
      setError(err.message || 'Reject failed');
    } finally {
      setRejectingId(null);
    }
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0B0C10', color: '#fff' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap', flexShrink: 0,
        padding: view === 'workspaces' ? '14px 20px 12px' : '32px 40px 0', marginBottom: view === 'workspaces' ? 0 : 28,
        borderBottom: view === 'workspaces' ? '1px solid rgba(255,255,255,0.1)' : 'none' }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.78)' }}>{PRODUCT_NAME} · Platform admin</div>
          <h1 style={{ margin: '4px 0 0', fontSize: view === 'workspaces' ? 20 : 26, fontWeight: 700, letterSpacing: '-0.02em', color: '#fff' }}>
            {view === 'resets' ? 'Password reset queue' : view === 'workspaces' ? 'Workspaces' : 'Workspace approval queue'}
          </h1>
        </div>
        <span style={{ flex: 1 }}/>
        <div role="tablist" aria-label="Platform admin areas" style={{ display: 'inline-flex', gap: 4, padding: 4, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 999 }}>
          {[['workspaces', 'Workspaces'], ['requests', 'Requests'], ['resets', 'Password resets']].map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} style={{ height: 30, padding: '0 14px', borderRadius: 999, border: 'none', background: view === v ? '#fff' : 'transparent', color: view === v ? '#0B0C10' : 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{label}</button>
          ))}
        </div>
        {view === 'requests' && (
          <div style={{ display: 'inline-flex', gap: 4, padding: 4, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 999 }}>
            {['pending', 'approved', 'all'].map(s => (
              <button key={s} onClick={() => setStatusFilter(s)} style={{ height: 30, padding: '0 14px', borderRadius: 999, border: 'none', background: statusFilter === s ? '#fff' : 'transparent', color: statusFilter === s ? '#0B0C10' : 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: 700, textTransform: 'capitalize', cursor: 'pointer' }}>{s}</button>
            ))}
          </div>
        )}
        {view !== 'workspaces' && (
          <button onClick={load} style={{ height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.18)', background: 'transparent', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Refresh</button>
        )}
        <button onClick={logout} style={{ height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.18)', background: 'transparent', color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Sign out</button>
      </header>

      {workspacesMounted && (
        <div style={{ flex: 1, minHeight: 0, display: view === 'workspaces' ? 'flex' : 'none' }}>
          <WorkspacesArea keyValue={keyValue} onKeyChange={onKeyChange} onLogout={logout}/>
        </div>
      )}

      {view !== 'workspaces' && (
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 40px 32px' }}>
      {view === 'resets' && (
        <ResetQueue withAuth={withAuth}/>
      )}

      {view === 'requests' && (<>
      {error && <div style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(220,38,38,0.18)', color: '#FCA5A5', marginBottom: 20, fontSize: 13 }}>{error}</div>}

      {items === null && !error && <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>}

      {items && items.length === 0 && (
        <div style={{ padding: 48, textAlign: 'center', border: '1px dashed rgba(255,255,255,0.15)', borderRadius: 14, color: 'rgba(255,255,255,0.55)' }}>
          No {statusFilter === 'all' ? '' : statusFilter} requests right now.
        </div>
      )}

      {items && items.length > 0 && (
        <div style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.6fr 0.9fr 0.6fr 110px 1fr 180px', gap: 10, padding: '12px 18px', background: 'rgba(255,255,255,0.04)', fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', fontWeight: 600 }}>
            <span>Company</span><span>Admin email</span><span>Team size</span><span>Seats</span><span>Status</span><span>Created</span><span style={{ textAlign: 'right', paddingRight: 16 }}>Action</span>
          </div>
          {items.map((r, i) => (
            <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.6fr 0.9fr 0.6fr 110px 1fr 180px', gap: 10, padding: '14px 18px', borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.06)', alignItems: 'center', fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>{r.company}</span>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: 'rgba(255,255,255,0.85)' }}>{r.admin_email}</span>
              <span style={{ opacity: 0.75, fontSize: 12 }}>{r.team_size || '—'}</span>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>{r.seat_limit}</span>
              <span>{statusPill(r.status)}</span>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, color: 'rgba(255,255,255,0.6)' }}>{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</span>
              <span style={{ textAlign: 'right' }}>
                {r.status === 'pending'
                  ? <span style={{ display: 'inline-flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button onClick={() => onReject(r)} disabled={rejectingId === r.id}
                        style={{ height: 30, padding: '0 12px', borderRadius: 7, border: '1px solid rgba(252,165,165,0.4)', background: 'transparent', color: '#FCA5A5', fontSize: 12, fontWeight: 700, cursor: rejectingId === r.id ? 'wait' : 'pointer', opacity: rejectingId === r.id ? 0.6 : 1 }}>
                        {rejectingId === r.id ? '…' : 'Reject'}
                      </button>
                      <button onClick={() => setApproving(r)}
                        style={{ height: 30, padding: '0 14px', borderRadius: 7, border: 'none', background: '#fff', color: '#0B0C10', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Approve</button>
                    </span>
                  : <span style={{ opacity: 0.45, fontSize: 11.5 }}>{r.decided_at ? new Date(r.decided_at).toLocaleDateString() : ''}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      </>)}
      </div>
      )}

      {approving && <ApproveDialog request={approving} busy={approveBusy} onCancel={() => setApproving(null)} onConfirm={onApprove}/>}
      {credResult && <CredentialsDialog result={credResult} keyValue={keyValue} withAuth={withAuth} onClose={() => setCredResult(null)}/>}
      {reauthDialog}
    </div>
  );
}

export default function AdminPortalPage() {
  const [keyValue, setKeyValue] = React.useState(() => readKey());
  const onKeyChange = React.useCallback((k) => { writeKey(k); setKeyValue(k || ''); }, []);
  if (!keyValue) return <GateScreen onUnlock={setKeyValue}/>;
  return <PortalScreen keyValue={keyValue} onLogout={() => setKeyValue('')} onKeyChange={onKeyChange}/>;
}

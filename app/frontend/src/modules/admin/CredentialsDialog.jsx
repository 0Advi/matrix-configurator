import React from 'react';
import { apiUpload, workspaceLoginUrl } from './adminApi.js';

// The one-time credentials dialog shown after a tenant is provisioned — by the approval queue
// ("Approve & provision") and by the configurator's first publish (Workspaces area).
// Moved out of AdminPortalPage.jsx unchanged except (F4b):
//   - the login-page link uses the HashRouter path (/#/login/<CODE>); the plain /login/<CODE>
//     never reached the branded login page,
//   - `variant="configurator"` swaps the intro copy (the configurator's tenant has a business
//     admin, not a supervisor) and the setup-code note names the exact place to enter it.
export default function CredentialsDialog({ result, keyValue, onClose, variant = 'request' }) {
  const [name, setName] = React.useState(result?.company || '');
  const [logoFile, setLogoFile] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [bErr, setBErr] = React.useState(null);
  const [copied, setCopied] = React.useState(null);
  if (!result) return null;
  const copy = (what, s) => {
    try { navigator.clipboard?.writeText(s); setCopied(what); setTimeout(() => setCopied(null), 1500); } catch {/* noop */}
  };
  const loginUrl = workspaceLoginUrl(result.workspace_code);
  const fld = { height: 38, padding: '0 11px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' };
  const isCfg = variant === 'configurator';

  async function saveBranding(e) {
    e.preventDefault();
    setBusy(true); setBErr(null);
    try {
      const fd = new FormData();
      if (name.trim()) fd.append('name', name.trim());
      if (logoFile) fd.append('logo', logoFile);
      await apiUpload(`/tenancy/tenants/${result.tenant_id}/branding`, { key: keyValue, formData: fd });
      setSaved(true);
    } catch (e2) { setBErr(e2.message || 'Could not save branding.'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div role="dialog" aria-modal="true" aria-label="Workspace created" style={{ width: 540, maxHeight: '92vh', overflowY: 'auto', background: '#13141B', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14, padding: 24, color: '#fff', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#86EFAC' }}>Provisioned ✓</div>
          <h2 style={{ margin: '4px 0 2px', fontSize: 19, fontWeight: 700 }}>Workspace created</h2>
          <p style={{ margin: 0, fontSize: 12.5, opacity: 0.7, lineHeight: 1.5 }}>
            {isCfg
              ? <>Share the workspace code and the setup code with the business admin{result.admin_email ? <> (<b>{result.admin_email}</b>)</> : null}, then brand the company&#39;s login page below.</>
              : <>Share the workspace code with the supervisor, then brand the company&#39;s login page below.</>}
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 70px', gap: 10, alignItems: 'center', fontSize: 13 }}>
          <span style={{ opacity: 0.6, fontSize: 12 }}>Workspace code</span>
          <code data-testid="cred-workspace-code" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.08)', fontSize: 13, fontWeight: 700, letterSpacing: '0.05em', overflowWrap: 'anywhere' }}>{result.workspace_code}</code>
          <button onClick={() => copy('code', result.workspace_code)} style={{ height: 28, borderRadius: 6, border: '1px solid rgba(255,255,255,0.18)', background: 'transparent', color: '#fff', fontSize: 11.5, cursor: 'pointer' }}>{copied === 'code' ? 'Copied' : 'Copy'}</button>
          {result.admin_setup_token && (
            <>
              <span style={{ opacity: 0.6, fontSize: 12 }}>Setup code</span>
              <code data-testid="cred-setup-code" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.08)', fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{result.admin_setup_token}</code>
              <button onClick={() => copy('setup', result.admin_setup_token)} style={{ height: 28, borderRadius: 6, border: '1px solid rgba(255,255,255,0.18)', background: 'transparent', color: '#fff', fontSize: 11.5, cursor: 'pointer' }}>{copied === 'setup' ? 'Copied' : 'Copy'}</button>
            </>
          )}
          <span style={{ opacity: 0.6, fontSize: 12 }}>Seat limit</span>
          <span style={{ fontSize: 13 }}>{result.seat_limit}</span>
          <span/>
          <span style={{ opacity: 0.6, fontSize: 12 }}>Login page</span>
          <a href={loginUrl} target="_blank" rel="noreferrer" style={{ color: '#93C5FD', fontSize: 12, overflowWrap: 'anywhere' }}>{loginUrl}</a>
          <button onClick={() => copy('url', loginUrl)} style={{ height: 28, borderRadius: 6, border: '1px solid rgba(255,255,255,0.18)', background: 'transparent', color: '#fff', fontSize: 11.5, cursor: 'pointer' }}>{copied === 'url' ? 'Copied' : 'Copy'}</button>
        </div>
        {result.admin_setup_token && (
          <p role="note" style={{ margin: 0, padding: '10px 12px', borderRadius: 8, background: 'rgba(250,204,21,0.10)', color: '#FDE68A', fontSize: 12, lineHeight: 1.5 }}>
            {isCfg
              ? <><b>Share privately — shown only once.</b> The business admin&#39;s account has no password yet. On the login page they enter their email, then the <b>setup code</b> with a new password, to activate sign-in. It expires in 30 days and cannot be shown again; if it is lost, confirm a password reset for them under “Password resets”.</>
              : <>The admin&#39;s account has no password yet. Share the <b>setup code</b> with them privately —
                on their login page they enter it (with a new password) to activate sign-in. It is shown only once and expires in 30 days.</>}
          </p>
        )}

        <div style={{ height: 1, background: 'rgba(255,255,255,0.1)' }}/>

        <form onSubmit={saveBranding} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)' }}>Brand the login page</div>
            <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.6, lineHeight: 1.5 }}>The company name and logo appear on their customized sign-in page.</p>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
            Company name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Blue Tokai Coffee" style={fld}/>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
            Logo image
            <input type="file" accept="image/*" onChange={(e) => setLogoFile(e.target.files?.[0] || null)} style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}/>
          </label>
          {bErr && <div style={{ fontSize: 12, color: '#FCA5A5' }}>{bErr}</div>}
          {saved ? (
            <div style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(34,197,94,0.12)', color: '#86EFAC', fontSize: 12.5, lineHeight: 1.5 }}>
              Login page is ready. Open it:{' '}
              <a href={loginUrl} target="_blank" rel="noreferrer" style={{ color: '#86EFAC', textDecoration: 'underline', overflowWrap: 'anywhere' }}>{loginUrl}</a>
            </div>
          ) : (
            <button type="submit" disabled={busy} style={{ height: 40, borderRadius: 8, border: 'none', background: '#34D399', color: '#06251a', fontSize: 13, fontWeight: 800, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1 }}>
              {busy ? 'Saving…' : 'Save branding & create login page'}
            </button>
          )}
        </form>

        {result.message && <p style={{ margin: 0, padding: '10px 12px', borderRadius: 8, background: 'rgba(34,197,94,0.10)', color: '#86EFAC', fontSize: 12, lineHeight: 1.5 }}>{result.message}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ height: 34, padding: '0 16px', borderRadius: 8, border: 'none', background: '#fff', color: '#0B0C10', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{isCfg ? 'I have shared the codes — continue' : 'Done'}</button>
        </div>
      </div>
    </div>
  );
}

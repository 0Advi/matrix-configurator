import React from 'react';
import { C, Button, Modal, Field, Banner, fieldStyle } from './ui.jsx';
import { splitFindings, findingWhere } from './configuratorHost.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// First publish of a workspace the app does not know yet → provision a tenant for it
// (POST /platform/workspaces). Runs the app's own approval path server-side.
export function ProvisionDialog({ context, previousError, busy, error, onCancel, onSubmit }) {
  const [company, setCompany] = React.useState(context?.name || '');
  const [adminName, setAdminName] = React.useState('');
  const [adminEmail, setAdminEmail] = React.useState('');
  const [seats, setSeats] = React.useState('25');
  const [city, setCity] = React.useState('');
  const [local, setLocal] = React.useState(null);

  const submit = (e) => {
    e.preventDefault();
    const n = Number(seats);
    if (!company.trim()) return setLocal('Enter the company name.');
    if (!EMAIL_RE.test(adminEmail.trim())) return setLocal('Enter the business admin’s email.');
    if (!Number.isInteger(n) || n < 1 || n > 10000) return setLocal('Seat limit must be a whole number from 1 to 10,000.');
    setLocal(null);
    onSubmit({
      configurator_ref: context.ref,
      company: company.trim(),
      admin_email: adminEmail.trim().toLowerCase(),
      admin_name: adminName.trim() || undefined,
      seat_limit: n,
      city: city.trim() || undefined,
    });
  };

  return (
    <Modal label="Provision workspace" eyebrow={`First publish · ${context?.name || context?.ref}`} title="Provision this workspace in the app"
      intro={<>The Matrix app doesn&#39;t have a tenant for <code style={{ fontFamily: C.mono }}>{context?.ref}</code> yet. Provisioning creates it through the app&#39;s normal approval path — tenant, workspace code, and a business admin who claims the account with a one-time setup code. The publish continues afterwards.</>}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {previousError && <Banner tone="warn">A previous provisioning attempt failed: {previousError}. Submitting retries it.</Banner>}
        <Field label="Company"><input aria-label="Company" value={company} onChange={(e) => setCompany(e.target.value)} style={fieldStyle} autoFocus/></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Business admin name"><input aria-label="Business admin name" value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Optional" style={fieldStyle}/></Field>
          <Field label="Business admin email"><input aria-label="Business admin email" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="owner@company.com" style={fieldStyle}/></Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Seat limit" hint="Users the workspace may have (1–10,000)"><input aria-label="Seat limit" inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} style={fieldStyle}/></Field>
          <Field label="City" hint="Label metadata only"><input aria-label="City" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Optional" style={fieldStyle}/></Field>
        </div>
        {(local || error) && <Banner>{local || error}</Banner>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <Button onClick={onCancel} disabled={busy}>Cancel publish</Button>
          <Button variant="primary" type="submit" busy={busy}>{busy ? 'Provisioning…' : 'Provision & continue'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// The 30-minute platform-admin token expired mid-task: sign in again without leaving the page
// (the configurator iframe and any publish in flight stay where they are), then retry.
export function ReauthDialog({ busy, error, onSubmit, onCancel, onSignOut }) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  return (
    <Modal label="Sign in again" z={90} eyebrow="Session expired" title="Sign in again to continue"
      intro="Your platform-admin session (30 minutes) has expired. Sign in again — what you were doing is retried right after, and the configurator keeps its state.">
      <form onSubmit={(e) => { e.preventDefault(); if (email.trim() && password) onSubmit(email.trim(), password); }} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Email"><input aria-label="Admin email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} style={fieldStyle} autoFocus/></Field>
        <Field label="Password"><input aria-label="Admin password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={fieldStyle}/></Field>
        {error && <Banner>{error}</Banner>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 4 }}>
          <Button onClick={onSignOut} disabled={busy}>Sign out</Button>
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <Button onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button variant="primary" type="submit" busy={busy}>{busy ? 'Signing in…' : 'Sign in & retry'}</Button>
          </span>
        </div>
      </form>
    </Modal>
  );
}

export function FindingsList({ findings, max = 50 }) {
  const { errors, warnings } = splitFindings(findings);
  if (!errors.length && !warnings.length) return null;
  const row = (f, i, tone) => (
    <li key={`${tone}-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', borderRadius: 8,
      background: tone === 'error' ? C.badBg : C.warnBg, border: `1px solid ${tone === 'error' ? 'rgba(252,165,165,0.25)' : 'rgba(253,230,138,0.2)'}` }}>
      <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: tone === 'error' ? C.bad : C.warn }}>{tone}</span>
        <code style={{ fontFamily: C.mono, fontSize: 10.5, color: C.faint }}>{f.code}</code>
        {findingWhere(f) && <span style={{ fontSize: 11, color: C.muted }}>{findingWhere(f)}</span>}
      </span>
      <span style={{ fontSize: 12.5, color: C.text, lineHeight: 1.45 }}>{f.message}</span>
    </li>
  );
  return (
    <ul aria-label="Validation findings" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {errors.slice(0, max).map((f, i) => row(f, i, 'error'))}
      {warnings.slice(0, max).map((f, i) => row(f, i, 'warning'))}
      {(errors.length > max || warnings.length > max) && <li style={{ fontSize: 11.5, color: C.faint }}>…and more</li>}
    </ul>
  );
}

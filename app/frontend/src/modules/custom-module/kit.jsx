// Presentational pieces for the generic (configurator-defined) module pages, built on the
// app's zm design tokens and existing class hooks (zm-btn / zm-btn-primary / zm-btn-danger
// hover effects live in index.html) so these pages look like the rest of the app.
import React from 'react';
import Icon from '../shared/primitives/Icon.jsx';
import { TONES } from '../shared/primitives/constants.js';

export function Card({ children, style, ...rest }) {
  return (
    <section {...rest} style={{
      background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 12,
      boxShadow: 'var(--zm-shadow-1)', padding: 18, ...style,
    }}>{children}</section>
  );
}

export function SectionTitle({ children, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      <h2 style={{ margin: 0, fontFamily: 'var(--zm-font-body)', fontSize: 11, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--zm-fg-3)' }}>{children}</h2>
      <span style={{ flex: 1 }}/>
      {right}
    </div>
  );
}

export function Tone({ tone = 'neutral', children, title }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <span title={title} className="zm-status-pill" style={{
      '--pill-mark': t.mark, display: 'inline-flex', alignItems: 'center', height: 22, borderRadius: 5,
      background: t.bg, color: t.fg, border: `1px solid ${t.edge}`, overflow: 'hidden',
      fontFamily: 'var(--zm-font-body)', fontWeight: 700, fontSize: 10, letterSpacing: '0.12em',
      textTransform: 'uppercase', whiteSpace: 'nowrap', lineHeight: 1,
    }}>
      <span style={{ width: 3, alignSelf: 'stretch', background: t.mark }}/>
      <span style={{ padding: '0 9px 0 8px' }}>{children}</span>
    </span>
  );
}

const CASE_TONE = { open: 'info', in_progress: 'plum', completed: 'success', rejected: 'danger', parked: 'copper' };
const CASE_LABEL = { open: 'Open', in_progress: 'In progress', completed: 'Completed', rejected: 'Rejected', parked: 'Parked' };
export function CaseStatus({ status }) {
  return <Tone tone={CASE_TONE[status] || 'neutral'}>{CASE_LABEL[status] || status || '—'}</Tone>;
}

const STAGE_TONE = {
  pending: 'neutral', locked: 'neutral', 'in progress': 'plum', submitted: 'info', approved: 'success',
  done: 'success', rejected: 'danger', 'sent back': 'copper', positive: 'success', negative: 'danger',
};
export function StageState({ state }) {
  return <Tone tone={STAGE_TONE[state] || 'neutral'}>{state || 'pending'}</Tone>;
}

export function Button({ variant = 'default', busy, disabled, icon, children, style, ...rest }) {
  const off = disabled || busy;
  const v = {
    primary: { className: 'zm-btn-primary', style: { border: 'none', background: off ? 'var(--zm-surface-sunken)' : 'var(--zm-accent)', color: off ? 'var(--zm-fg-4)' : 'var(--zm-accent-on)', boxShadow: off ? 'none' : 'var(--zm-shadow-1)' } },
    danger: { className: 'zm-btn-danger', style: { border: '1px solid var(--zm-line-strong)', background: 'var(--zm-surface)', color: 'var(--zm-danger)' } },
    default: { className: 'zm-btn', style: { border: '1px solid var(--zm-line-strong)', background: 'var(--zm-surface)', color: 'var(--zm-fg-2)' } },
  }[variant] || {};
  return (
    <button type="button" disabled={off} aria-busy={busy || undefined} className={v.className} {...rest} style={{
      height: 34, padding: '0 14px', borderRadius: 8, fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: 700,
      cursor: busy ? 'wait' : off ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
      whiteSpace: 'nowrap', opacity: off && variant !== 'primary' ? 0.6 : 1, ...v.style, ...style,
    }}>
      {icon && <Icon name={icon} size={13}/>}
      {children}
    </button>
  );
}

export function Notice({ tone = 'info', title, children, action }) {
  const t = TONES[tone] || TONES.info;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} style={{
      display: 'flex', gap: 12, alignItems: 'flex-start', padding: '11px 14px', borderRadius: 10,
      background: t.bg, border: `1px solid ${t.edge}`, color: 'var(--zm-fg)', fontSize: 13, lineHeight: 1.5,
    }}>
      <span style={{ color: t.fg, display: 'inline-flex', marginTop: 2 }}><Icon name={tone === 'danger' ? 'alert' : tone === 'success' ? 'check' : 'warning'} size={15}/></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div style={{ fontWeight: 700, marginBottom: 2 }}>{title}</div>}
        {children}
      </div>
      {action}
    </div>
  );
}

export function Empty({ icon = 'layers', title, children }) {
  return (
    <div style={{ padding: '36px 20px', textAlign: 'center', border: '1px dashed var(--zm-line-strong)', borderRadius: 12, color: 'var(--zm-fg-3)' }}>
      <div style={{ display: 'inline-flex', marginBottom: 8, color: 'var(--zm-fg-4)' }}><Icon name={icon} size={22}/></div>
      <div style={{ fontWeight: 700, color: 'var(--zm-fg-2)', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12.5 }}>{children}</div>
    </div>
  );
}

export function when(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return String(ts); }
}

export const TIER_LABEL = { executive: 'Executive', supervisor: 'Supervisor', business_admin: 'Business admin', observer: 'Observer' };
export const tierLabel = (t) => TIER_LABEL[t] || t || '—';

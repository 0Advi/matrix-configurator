// Small presentational kit for the platform-admin portal's Workspaces area. Same dark palette
// and shapes as the rest of AdminPortalPage.jsx (#0B0C10 page, #13141B panels, white primary
// buttons) and as the embedded configurator (#0B0C10 canvas), so the two read as one product.
import React from 'react';

export const C = {
  page: '#0B0C10',
  panel: '#13141B',
  panel2: '#181A22',
  line: 'rgba(255,255,255,0.10)',
  lineStrong: 'rgba(255,255,255,0.18)',
  text: '#FFFFFF',
  muted: 'rgba(255,255,255,0.68)',
  faint: 'rgba(255,255,255,0.48)',
  ok: '#86EFAC', okBg: 'rgba(34,197,94,0.12)',
  warn: '#FDE68A', warnBg: 'rgba(250,204,21,0.10)',
  bad: '#FCA5A5', badBg: 'rgba(220,38,38,0.16)',
  info: '#93C5FD', infoBg: 'rgba(59,130,246,0.14)',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

export const fieldStyle = {
  height: 36, padding: '0 11px', borderRadius: 8, border: `1px solid ${C.lineStrong}`,
  background: 'rgba(0,0,0,0.35)', color: C.text, fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box',
};

export function Button({ variant = 'ghost', size = 'md', busy, disabled, children, style, ...rest }) {
  const h = size === 'sm' ? 28 : 34;
  const v = {
    primary: { background: '#fff', color: C.page, border: 'none', fontWeight: 700 },
    success: { background: '#34D399', color: '#06251a', border: 'none', fontWeight: 800 },
    ghost: { background: 'transparent', color: C.text, border: `1px solid ${C.lineStrong}`, fontWeight: 600 },
    danger: { background: 'transparent', color: C.bad, border: '1px solid rgba(252,165,165,0.4)', fontWeight: 700 },
  }[variant];
  const off = disabled || busy;
  return (
    <button type="button" disabled={off} {...rest} style={{
      height: h, padding: size === 'sm' ? '0 10px' : '0 14px', borderRadius: 8, fontSize: size === 'sm' ? 11.5 : 12.5,
      cursor: busy ? 'wait' : off ? 'not-allowed' : 'pointer', opacity: off ? 0.6 : 1, whiteSpace: 'nowrap',
      display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit', ...v, ...style,
    }}>{children}</button>
  );
}

export function Pill({ tone = 'muted', children, title }) {
  const t = {
    ok: [C.okBg, C.ok], warn: [C.warnBg, C.warn], bad: [C.badBg, C.bad], info: [C.infoBg, C.info],
    muted: ['rgba(255,255,255,0.08)', C.muted],
  }[tone] || ['rgba(255,255,255,0.08)', C.muted];
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 999,
      fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', background: t[0], color: t[1], whiteSpace: 'nowrap' }}>{children}</span>
  );
}

export function Eyebrow({ children, style }) {
  return <div style={{ fontSize: 10.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: C.faint, fontWeight: 600, ...style }}>{children}</div>;
}

export function Modal({ label, eyebrow, title, intro, children, width = 480, z = 70 }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: z, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div role="dialog" aria-modal="true" aria-label={label || title} style={{ width, maxWidth: '100%', maxHeight: '92vh', overflowY: 'auto', background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 24, color: C.text, display: 'flex', flexDirection: 'column', gap: 14, boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
        <div>
          {eyebrow && <div style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', opacity: 0.6 }}>{eyebrow}</div>}
          <h2 style={{ margin: '4px 0 2px', fontSize: 19, fontWeight: 700 }}>{title}</h2>
          {intro && <p style={{ margin: 0, fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>{intro}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: C.muted, fontWeight: 600 }}>
      {label}
      {children}
      {hint && <span style={{ fontSize: 11, fontWeight: 400, color: C.faint }}>{hint}</span>}
    </label>
  );
}

export function Banner({ tone = 'bad', children }) {
  const t = { bad: [C.badBg, C.bad], warn: [C.warnBg, C.warn], ok: [C.okBg, C.ok], info: [C.infoBg, C.info] }[tone];
  return <div role={tone === 'bad' ? 'alert' : 'status'} style={{ padding: '9px 12px', borderRadius: 8, background: t[0], color: t[1], fontSize: 12.5, lineHeight: 1.5 }}>{children}</div>;
}

export function Spinner({ size = 12 }) {
  return <span aria-hidden="true" style={{ width: size, height: size, borderRadius: 999, border: '2px solid rgba(255,255,255,0.25)', borderTopColor: '#fff', display: 'inline-block', animation: 'zm-spin 0.8s linear infinite' }}/>;
}

export function CopyButton({ value, label = 'Copy' }) {
  const [done, setDone] = React.useState(false);
  return (
    <Button size="sm" onClick={() => { try { navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1400); } catch {/* noop */} }}>
      {done ? 'Copied' : label}
    </Button>
  );
}

export function when(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

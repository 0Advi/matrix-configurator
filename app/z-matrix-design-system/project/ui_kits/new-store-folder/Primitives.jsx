// Small primitives shared across the new-store-folder kit.
// Exported to window so other Babel scripts can use them.

const Icon = ({ name, size = 16, stroke = 1.5, style }) => {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    box: <><path d="M2 9l10-6 10 6-10 6z"/><path d="M2 9v6l10 6 10-6V9"/></>,
    list: <><path d="M3 6h18M3 12h18M3 18h12"/></>,
    pin: <><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 1118 0z"/><circle cx="12" cy="10" r="3"/></>,
    calendar: <><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></>,
    file: <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    check: <><path d="M20 6L9 17l-5-5"/></>,
    alert: <><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></>,
    arrow: <><path d="M3 12h18M13 5l7 7-7 7"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    card: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/></>,
    message: <><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></>,
    trend: <><path d="M3 3v18h18"/><path d="M7 14l3-3 4 4 5-7"/></>,
    shield: <><path d="M12 2l9 4v6c0 5-3.5 9.7-9 10-5.5-.3-9-5-9-10V6z"/></>,
    chat: <><path d="M21 11.5a8.5 8.5 0 01-15.4 5.1L3 21l4.4-2.6A8.5 8.5 0 1121 11.5z"/></>,
    user: <><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></>,
    chevron: <><path d="M9 6l6 6-6 6"/></>,
    chevronDown: <><path d="M6 9l6 6 6-6"/></>,
    chevronUp: <><path d="M6 15l6-6 6 6"/></>,
    x: <><path d="M18 6L6 18M6 6l12 12"/></>,
    filter: <><path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3z"/></>,
    upload: <><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></>,
    download: <><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></>,
    camera: <><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></>,
    rupee: <><path d="M6 3h12M6 8h12M6 13l5 8M13 3a5 5 0 010 10H6"/></>,
    activity: <><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></>,
    folder: <><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></>,
    home: <><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2h-4v-7H9v7H5a2 2 0 01-2-2z"/></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={style}>
      {paths[name] || null}
    </svg>
  );
};

// Z-Matrix new-store-folder is a three-stage module:
//   draft (pipeline) → shortlist (queue) → staging (LOI upload) → exits to Payments (separate module)
// Tones map to the design-system semantic palette — no raw saturated hex per stage.
const TONES = {
  neutral: { fg: 'var(--zm-fg-2)',    bg: 'var(--zm-surface-2)',    edge: 'var(--zm-line-strong)',  mark: 'var(--zm-fg-3)' },
  accent:  { fg: 'var(--zm-accent)',  bg: 'var(--zm-accent-soft)',  edge: 'var(--zm-accent-line)',  mark: 'var(--zm-accent)' },
  copper:  { fg: 'var(--zm-copper)',  bg: 'var(--zm-copper-soft)',  edge: 'var(--zm-copper-line)',  mark: 'var(--zm-copper)' },
  plum:    { fg: 'var(--zm-plum)',    bg: 'var(--zm-plum-soft)',    edge: 'color-mix(in srgb, var(--zm-plum) 38%, transparent)',    mark: 'var(--zm-plum)' },
  info:    { fg: 'var(--zm-info)',    bg: 'var(--zm-info-soft)',    edge: 'color-mix(in srgb, var(--zm-info) 38%, transparent)',    mark: 'var(--zm-info)' },
  success: { fg: 'var(--zm-success)', bg: 'var(--zm-success-soft)', edge: 'color-mix(in srgb, var(--zm-success) 38%, transparent)', mark: 'var(--zm-success)' },
  danger:  { fg: 'var(--zm-danger)',  bg: 'var(--zm-danger-soft)',  edge: 'color-mix(in srgb, var(--zm-danger) 38%, transparent)',  mark: 'var(--zm-danger)' },
};

const STAGES = {
  draft:        { name: 'Draft',           tone: 'neutral', color: '#6E6E78' },
  overdueDraft: { name: 'Draft · overdue', tone: 'danger',  color: '#9B2A2A' },
  shortlist:    { name: 'Shortlist',       tone: 'info',    color: '#2A4FA0' },
  inReview:     { name: 'In review',       tone: 'plum',    color: '#6B4789' },
  staging:      { name: 'Staging · LOI',   tone: 'copper',  color: '#B0712E' },
  overdue:      { name: 'LOI overdue',     tone: 'danger',  color: '#9B2A2A' },
  uploaded:     { name: 'LOI uploaded',    tone: 'accent',  color: '#0F5D5C' },
  completed:    { name: 'Pushed',          tone: 'success', color: '#2F7A4A' },
  rejected:     { name: 'Rejected',        tone: 'danger',  color: '#9B2A2A' },
  archived:     { name: 'Archived',        tone: 'neutral', color: '#6E6E78' },
};

const StageDot = ({ stage, size = 8 }) => (
  <span style={{ display: 'inline-block', width: size, height: size, borderRadius: 999, background: STAGES[stage]?.color || '#888', flex: '0 0 auto' }} />
);

const StatusPill = ({ stage }) => {
  const s = STAGES[stage] || STAGES.draft;
  const t = TONES[s.tone] || TONES.neutral;
  return (
    <span className="zm-status-pill" style={{
      '--pill-fg': t.fg, '--pill-bg': t.bg, '--pill-edge': t.edge, '--pill-mark': t.mark,
      display: 'inline-flex', alignItems: 'center', gap: 0,
      height: 22, padding: 0, borderRadius: 5,
      background: t.bg, color: t.fg,
      border: '1px solid ' + t.edge,
      fontFamily: 'var(--zm-font-body)', fontWeight: 700,
      fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
      whiteSpace: 'nowrap', lineHeight: 1, position: 'relative',
      overflow: 'hidden',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.45)',
    }}>
      {/* Editorial left rule — tonal mark */}
      <span style={{
        width: 3, alignSelf: 'stretch', background: t.mark, flex: '0 0 3px',
      }}/>
      <span style={{ padding: '0 10px 0 9px', fontFeatureSettings: "'ss01' 1" }}>{s.name}</span>
    </span>
  );
};

const Avatar = ({ name, size = 28 }) => {
  const initials = (name || '').split(' ').map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  return (
    <span style={{
      width: size, height: size, borderRadius: 999,
      background: 'var(--zm-accent-soft)', color: 'var(--zm-accent)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: size * 0.4,
      letterSpacing: 0.5, flex: '0 0 auto',
    }}>{initials || '–'}</span>
  );
};

Object.assign(window, { Icon, STAGES, StageDot, StatusPill, Avatar });

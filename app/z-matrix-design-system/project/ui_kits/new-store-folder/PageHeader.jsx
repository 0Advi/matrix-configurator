// Editorial page-header used across every view.
// Builds an "editorial field manual" feel: case-file number, eyebrow with
// rule, large serif title (italic), and a body lede.

const PageHeader = ({ file, eyebrow, title, lede, right, italic = true }) => (
  <header style={{
    display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24,
    marginBottom: 22, paddingBottom: 18,
    borderBottom: '1px solid var(--zm-line)',
    position: 'relative',
  }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
      {/* Eyebrow row: tiny mono file number + tracked label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {file && (
          <span style={{
            fontFamily: 'var(--zm-font-mono)', fontSize: 10, fontWeight: 600,
            letterSpacing: '0.18em', color: 'var(--zm-fg-4)',
            whiteSpace: 'nowrap', flex: '0 0 auto',
          }}>{file}</span>
        )}
        {file && <span style={{ width: 18, height: 1, background: 'var(--zm-line-strong)', flex: '0 0 auto' }}/>}
        <span style={{
          fontFamily: 'var(--zm-font-body)', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--zm-fg-3)',
          whiteSpace: 'nowrap',
        }}>{eyebrow}</span>
      </div>

      <h1 style={{
        margin: 0, color: 'var(--zm-fg)',
        fontFamily: 'var(--zm-font-serif)', fontWeight: 400,
        fontSize: 48, lineHeight: 1, letterSpacing: '-0.015em',
        fontStyle: italic ? 'italic' : 'normal',
      }}>{title}</h1>

      {lede && (
        <p style={{
          margin: '8px 0 0', maxWidth: 720,
          fontFamily: 'var(--zm-font-body)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--zm-fg-2)',
        }}>{lede}</p>
      )}
    </div>

    {right && <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'flex-end', gap: 10 }}>{right}</div>}
  </header>
);

// Inline pill used at the top of headers for tenant / role context.
const HeaderTag = ({ icon, label, tone = 'default' }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 6,
    height: 22, padding: '0 10px 0 9px', borderRadius: 4,
    border: '1px solid ' + (tone === 'accent' ? 'var(--zm-accent)' : 'var(--zm-line-strong)'),
    background: 'transparent',
    color: tone === 'accent' ? 'var(--zm-accent)' : 'var(--zm-fg-2)',
    fontFamily: 'var(--zm-font-body)', fontWeight: 700, fontSize: 10,
    letterSpacing: '0.16em', textTransform: 'uppercase',
    whiteSpace: 'nowrap', lineHeight: 1,
  }}>
    {icon && <Icon name={icon} size={11}/>}
    {label}
  </span>
);

Object.assign(window, { PageHeader, HeaderTag });

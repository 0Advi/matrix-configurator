// Command bar (NL query) + Ask Matrix reply tile.

const SUGGESTIONS = [
  'Staging sites overdue > 14 days in Mumbai',
  'Drafts older than 21 days by creator',
  'Generate shortlist digest PPTX for last week',
  'Compare pipeline velocity by city this quarter',
];

const CommandBar = ({ value, onChange, onSubmit, busy }) => (
  <div style={{
    background: '#171923', border: '1px solid #262A38', borderRadius: 14,
    padding: 4, display: 'flex', flexDirection: 'column', gap: 0,
    boxShadow: 'var(--zm-shadow-3)',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
      <span style={{ color: busy ? '#F59E0B' : '#00B4D8', display: 'inline-flex' }}>
        <Icon name="sparkle" size={18} stroke={1.6}/>
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) onSubmit(value); }}
        placeholder="Ask the workspace…  e.g. sites stuck at LOI > 14 days in Mumbai"
        style={{
          flex: 1, border: 'none', outline: 'none', background: 'transparent',
          fontFamily: 'var(--zm-font-body)', fontSize: 15, color: '#E2E8F0',
          letterSpacing: '-0.005em',
        }}
      />
      <kbd style={{
        fontFamily: 'var(--zm-font-mono)', fontSize: 10, color: '#7C8499',
        border: '1px solid #262A38', padding: '2px 6px', borderRadius: 4,
      }}>⌘ ↵</kbd>
      <button
        disabled={!value.trim() || busy}
        onClick={() => onSubmit(value)}
        style={{
          height: 30, padding: '0 12px', borderRadius: 8, border: 'none',
          background: value.trim() && !busy ? '#00B4D8' : '#262A38',
          color: value.trim() && !busy ? '#0B0C10' : '#525A6F',
          fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: 700,
          cursor: value.trim() && !busy ? 'pointer' : 'not-allowed',
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>
        {busy ? 'Thinking…' : <>Run <Icon name="arrow" size={12}/></>}
      </button>
    </div>
    <div style={{
      display: 'flex', gap: 6, padding: '10px 14px', borderTop: '1px solid #1B1E2A',
      overflowX: 'auto',
    }}>
      <span style={{
        fontFamily: 'var(--zm-font-body)', fontSize: 10.5, fontWeight: 600,
        letterSpacing: '0.14em', textTransform: 'uppercase', color: '#525A6F',
        alignSelf: 'center', marginRight: 6, whiteSpace: 'nowrap',
      }}>Try</span>
      {SUGGESTIONS.map((s, i) => (
        <button key={i} onClick={() => onSubmit(s)} style={{
          height: 26, padding: '0 10px', borderRadius: 999,
          border: '1px solid #262A38', background: '#1D2030',
          color: '#B4BBC9', fontFamily: 'var(--zm-font-body)', fontSize: 11.5,
          fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
        }}>{s}</button>
      ))}
    </div>
  </div>
);

const REPLY_TABLE = [
  { code: 'BT-MUM-0142', name: 'Powai · Lake Homes',     days: 16, value: '₹1.42L', who: 'Riya S.' },
  { code: 'BT-MUM-0118', name: 'Andheri W · Veera Desai',days: 19, value: '₹1.28L', who: 'Aman V.' },
  { code: 'BT-MUM-0110', name: 'Lower Parel · One BKC',  days: 22, value: '₹2.04L', who: 'Riya S.' },
  { code: 'BT-MUM-0098', name: 'Juhu Tara Rd',            days: 28, value: '₹1.18L', who: 'Nikhil I.' },
  { code: 'BT-MUM-0091', name: 'Khar Linking · 33',      days: 31, value: '₹1.56L', who: 'Aman V.' },
  { code: 'BT-MUM-0084', name: 'Worli Sea Face Lobby',   days: 38, value: '₹2.42L', who: 'Riya S.' },
];

const AskMatrixReply = ({ query }) => (
  <div style={{
    background: '#171923', border: '1px solid #262A38', borderRadius: 14,
    overflow: 'hidden', boxShadow: 'var(--zm-shadow-2)',
  }}>
    <div style={{
      padding: '14px 18px 12px', display: 'flex', alignItems: 'flex-start', gap: 12,
      borderBottom: '1px solid #1B1E2A',
    }}>
      <span style={{
        width: 28, height: 28, borderRadius: 8, flex: '0 0 28px',
        background: 'rgba(0,180,216,0.16)', color: '#00B4D8',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}><Icon name="sparkle" size={15}/></span>
      <div style={{ flex: 1 }}>
        <span style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 700, fontSize: 12, color: '#E2E8F0' }}>Ask Matrix</span>
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 11, color: '#7C8499', marginLeft: 8 }}>· claude-haiku-4-5 · 1.8s</span>
        <p style={{ margin: '4px 0 0', fontFamily: 'var(--zm-font-body)', fontSize: 14, color: '#B4BBC9', lineHeight: 1.55 }}>
          6 staging sites in Mumbai have been past their expected LOI date by &gt; 14 days. Combined expected{' '}
          <strong style={{ color: '#F59E0B', fontFamily: 'var(--zm-font-mono)', fontWeight: 600 }}>monthly op cost ₹9.90L</strong>. Oldest is Worli Sea Face Lobby at 38 days overdue.
        </p>
      </div>
      <button style={{
        background: 'transparent', border: '1px solid #262A38', borderRadius: 7,
        padding: '4px 10px', fontFamily: 'var(--zm-font-body)', fontSize: 11.5, fontWeight: 600,
        color: '#B4BBC9', cursor: 'pointer', whiteSpace: 'nowrap',
      }}>Export PPTX</button>
    </div>

    <div style={{
      display: 'grid', gridTemplateColumns: '90px 1fr 80px 80px 90px', alignItems: 'center', gap: 8,
      padding: '8px 18px', background: '#1B1E2A', borderBottom: '1px solid #1B1E2A',
      fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10, letterSpacing: '0.12em',
      textTransform: 'uppercase', color: '#7C8499',
    }}>
      <span>Code</span>
      <span>Site</span>
      <span style={{ textAlign: 'right' }}>Overdue</span>
      <span style={{ textAlign: 'right' }}>Op cost</span>
      <span>Owner</span>
    </div>
    {REPLY_TABLE.map((r, i) => (
      <div key={r.code} style={{
        display: 'grid', gridTemplateColumns: '90px 1fr 80px 80px 90px', alignItems: 'center', gap: 8,
        padding: '10px 18px', borderBottom: i < REPLY_TABLE.length - 1 ? '1px solid #1B1E2A' : 'none',
        fontFamily: 'var(--zm-font-body)', fontSize: 13, color: '#E2E8F0',
      }}>
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 11.5, color: '#7C8499' }}>{r.code}</span>
        <span style={{ fontWeight: 500 }}>{r.name}</span>
        <span style={{
          fontFamily: 'var(--zm-font-mono)', fontFeatureSettings: "'tnum' 1", textAlign: 'right',
          color: r.days > 21 ? '#F87171' : '#F59E0B', fontWeight: 600,
        }}>{r.days}d</span>
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontFeatureSettings: "'tnum' 1", textAlign: 'right' }}>{r.value}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#B4BBC9' }}>
          <Avatar name={r.who} size={20}/>
          <span style={{ fontSize: 12 }}>{r.who}</span>
        </span>
      </div>
    ))}

    <div style={{
      padding: '12px 18px', background: '#0F111A', borderTop: '1px solid #1B1E2A',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 10.5, color: '#7C8499' }}>
        via bd-mcp · staging_overdue(city="Mumbai", days_over=14)
      </span>
      <span style={{ flex: 1 }}/>
      <button style={{
        background: 'transparent', border: 'none', color: '#00B4D8',
        fontFamily: 'var(--zm-font-body)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}>Open in sites view <Icon name="arrow" size={12}/></button>
    </div>
  </div>
);

Object.assign(window, { CommandBar, AskMatrixReply, SUGGESTIONS });

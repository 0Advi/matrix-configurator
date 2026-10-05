// Main workspace app.

const App = () => {
  const [view, setView] = React.useState('dashboard');
  const [query, setQuery] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [reply, setReply] = React.useState(null);
  const [toast, setToast] = React.useState(null);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const runQuery = (q) => {
    setQuery(q);
    setBusy(true);
    setReply(null);
    setTimeout(() => {
      setBusy(false);
      setReply(q);
    }, 1200);
  };

  return (
    <div data-screen-label="01 Workspace" style={{
      width: '100%', height: '100vh', display: 'flex', flexDirection: 'column',
      background: '#0B0C10', overflow: 'hidden',
    }}>
      <Titlebar tenant="Blue Tokai · Mumbai tenant" model="claude-haiku-4-5"/>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Sidebar view={view} onView={setView}/>

        <main style={{
          flex: 1, overflowY: 'auto', padding: '24px 28px 56px',
          background: '#0B0C10',
          backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'><path d='M40 0 L0 0 0 40' fill='none' stroke='%23E2E8F0' stroke-width='0.5' opacity='0.04'/></svg>\")",
          backgroundSize: '40px 40px',
        }}>
          {(view === 'dashboard' || view === 'ask') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1140, margin: '0 auto' }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                <div>
                  <span style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#7C8499' }}>Z-Matrix workspace · dashboard</span>
                  <h1 style={{ margin: '4px 0 4px', fontFamily: 'var(--zm-font-display)', fontWeight: 700, fontSize: 30, letterSpacing: '-0.02em', color: '#E2E8F0' }}>Good evening, Riya</h1>
                  <p style={{ margin: 0, fontFamily: 'var(--zm-font-body)', fontSize: 13, color: '#7C8499' }}>
                    9 shortlists awaiting approval · 4 LOI overdue · synced 4s ago
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={{
                    height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid #262A38',
                    background: '#171923', color: '#B4BBC9',
                    fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                  }}><Icon name="book" size={13}/> Skills</button>
                  <button style={{
                    height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid rgba(0,180,216,0.32)',
                    background: 'rgba(0,180,216,0.12)', color: '#00B4D8',
                    fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                  }}><Icon name="plus" size={13}/> New report</button>
                </div>
              </div>

              <CommandBar value={query} onChange={setQuery} onSubmit={runQuery} busy={busy}/>

              {reply && <AskMatrixReply query={reply}/>}

              <HeroTiles/>

              <Approvals onAction={(verb, row) => setToast(`${verb === 'approved' ? 'Approved' : 'Rejected'} · ${row.site}`)}/>
            </div>
          )}

          {view === 'sites' && (
            <PlaceholderView title="Sites browser" body="Same data the new-store folder shows, scoped to your tenant via bd-mcp. Includes outbox: edits queue locally if the gateway is unreachable."/>
          )}
          {view === 'approvals' && (
            <div style={{ maxWidth: 1080, margin: '0 auto' }}>
              <h1 style={{ margin: '0 0 18px', fontFamily: 'var(--zm-font-display)', fontWeight: 700, fontSize: 28, letterSpacing: '-0.02em', color: '#E2E8F0' }}>Shortlist approvals</h1>
              <Approvals onAction={(verb, row) => setToast(`${verb === 'approved' ? 'Approved' : 'Rejected'} · ${row.site}`)}/>
            </div>
          )}
          {view === 'activity' && (
            <PlaceholderView title="Live activity" body="Cross-module event stream from Notification service. WebSocket push lands here even when modules are idle."/>
          )}
        </main>

        <TracePanel/>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)',
          background: '#171923', border: '1px solid #262A38', color: '#E2E8F0',
          padding: '10px 16px', borderRadius: 10,
          boxShadow: 'var(--zm-shadow-pop)',
          fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: 500,
          display: 'inline-flex', alignItems: 'center', gap: 10,
          animation: 'zm-rise 240ms var(--zm-ease-emp)',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: '#34D399', boxShadow: '0 0 8px rgba(52,211,153,0.7)' }}/>
          {toast}
        </div>
      )}
    </div>
  );
};

const PlaceholderView = ({ title, body }) => (
  <div style={{ maxWidth: 720, margin: '0 auto' }}>
    <h1 style={{ margin: 0, fontFamily: 'var(--zm-font-display)', fontWeight: 700, fontSize: 28, letterSpacing: '-0.02em', color: '#E2E8F0' }}>{title}</h1>
    <p style={{ margin: '8px 0 18px', fontFamily: 'var(--zm-font-body)', fontSize: 14, color: '#B4BBC9', lineHeight: 1.55 }}>{body}</p>
    <div style={{
      padding: 32, border: '1px dashed #262A38', borderRadius: 12,
      fontFamily: 'var(--zm-font-body)', fontSize: 13, color: '#7C8499',
      background: '#171923',
    }}>Surface mocked at kit level only.</div>
  </div>
);

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);

// Titlebar (Electron-style) + dark sidebar + workspace switcher.

const Titlebar = ({ tenant, model }) => (
  <header style={{
    height: 38, padding: '0 12px',
    display: 'flex', alignItems: 'center', gap: 12,
    background: '#0B0C10', borderBottom: '1px solid #171923',
    fontFamily: 'var(--zm-font-body)', WebkitAppRegion: 'drag',
    flex: '0 0 auto',
  }}>
    {/* traffic lights */}
    <div style={{ display: 'flex', gap: 7, WebkitAppRegion: 'no-drag' }}>
      <span style={{ width: 11, height: 11, borderRadius: 999, background: '#FF5F57' }}/>
      <span style={{ width: 11, height: 11, borderRadius: 999, background: '#FEBC2E' }}/>
      <span style={{ width: 11, height: 11, borderRadius: 999, background: '#28C840' }}/>
    </div>

    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
      <span style={{ fontSize: 11.5, color: '#7C8499', letterSpacing: '0.04em' }}>
        {tenant} · {model}
      </span>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: '#34D399', boxShadow: '0 0 8px rgba(52,211,153,0.6)' }}/>
    </div>

    <div style={{ width: 60 }}/>
  </header>
);

const SidebarItem = ({ icon, label, count, active, badge, onClick }) => (
  <div onClick={onClick} style={{
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 10px', borderRadius: 7, cursor: 'pointer',
    background: active ? 'rgba(0,180,216,0.12)' : 'transparent',
    color: active ? '#E2E8F0' : '#B4BBC9',
    fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: active ? 600 : 500,
    position: 'relative', transition: 'background 120ms var(--zm-ease)',
  }}
  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#20243A' }}
  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
  >
    {active && <span style={{ position: 'absolute', left: 0, top: 8, bottom: 8, width: 2, background: '#00B4D8', borderRadius: 2, boxShadow: '0 0 8px rgba(0,180,216,0.6)' }}/>}
    <span style={{ color: active ? '#00B4D8' : '#7C8499', display: 'inline-flex' }}>
      <Icon name={icon} size={16}/>
    </span>
    {label}
    {count != null && (
      <span style={{
        marginLeft: 'auto', fontFamily: 'var(--zm-font-mono)', fontSize: 11,
        color: active ? '#00B4D8' : '#7C8499', fontWeight: 500,
      }}>{count}</span>
    )}
    {badge && (
      <span style={{
        marginLeft: 'auto', padding: '1px 6px', borderRadius: 999,
        background: 'rgba(245,158,11,0.16)', color: '#F59E0B',
        fontFamily: 'var(--zm-font-mono)', fontSize: 10, fontWeight: 600,
      }}>{badge}</span>
    )}
  </div>
);

const Sidebar = ({ view, onView }) => (
  <aside style={{
    width: 238, flex: '0 0 238px', padding: '12px 10px',
    background: '#0F111A', borderRight: '1px solid #1B1E2A',
    display: 'flex', flexDirection: 'column', gap: 2,
    overflowY: 'auto',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 8px 14px', borderBottom: '1px solid #1B1E2A', marginBottom: 8 }}>
      <svg width="24" height="24" viewBox="0 0 64 64" fill="none">
        <g stroke="#00B4D8" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 14 L48 14"/><path d="M48 14.6 L19 47.4"/><path d="M16 50 L50 50"/>
          <path d="M14 14 L22 6 L56 6" opacity="0.7"/><path d="M56 6.4 L56 42" opacity="0.7"/><path d="M56 42.2 L50 50" opacity="0.7"/>
        </g>
      </svg>
      <span style={{ fontFamily: 'var(--zm-font-display)', fontWeight: 800, fontSize: 14, color: '#E2E8F0', letterSpacing: '0.04em' }}>
        Z<span style={{ fontWeight: 400, letterSpacing: '0.34em', fontSize: 11, marginLeft: 2, color: '#B4BBC9' }}>MATRIX</span>
      </span>
      <span style={{
        marginLeft: 'auto', fontFamily: 'var(--zm-font-mono)', fontSize: 9.5,
        color: '#525A6F', letterSpacing: '0.08em',
      }}>v3.3</span>
    </div>

    <SidebarItem icon="grid"     label="Dashboard"       active={view === 'dashboard'} onClick={() => onView('dashboard')}/>
    <SidebarItem icon="box"      label="Sites"           count={142} active={view === 'sites'}     onClick={() => onView('sites')}/>
    <SidebarItem icon="shield"   label="Approvals"       badge="9" active={view === 'approvals'}  onClick={() => onView('approvals')}/>
    <SidebarItem icon="activity" label="Live activity"   active={view === 'activity'}  onClick={() => onView('activity')}/>

    <div style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#525A6F', padding: '14px 10px 4px' }}>Agent</div>
    <SidebarItem icon="chat"     label="Ask Matrix"      active={view === 'ask'}      onClick={() => onView('ask')}/>
    <SidebarItem icon="terminal" label="MCP servers"     count={2}/>
    <SidebarItem icon="wand"     label="Skills"          count={5}/>

    <div style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#525A6F', padding: '14px 10px 4px' }}>Modules</div>
    <SidebarItem icon="shield"   label="Legal · DD"/>
    <SidebarItem icon="pin"      label="Recce + design"/>
    <SidebarItem icon="folder"   label="Project ex"/>

    <div style={{ flex: 1 }}/>
    <div style={{
      margin: '8px 4px', padding: 10, borderRadius: 10,
      background: '#171923', border: '1px solid #262A38',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <Avatar name="Riya Sharma" size={28}/>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 12, fontWeight: 600, color: '#E2E8F0' }}>Riya Sharma</span>
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 10, color: '#7C8499' }}>BD supervisor · MUM</span>
      </div>
      <Icon name="settings" size={14} style={{ marginLeft: 'auto', color: '#7C8499' }}/>
    </div>
  </aside>
);

Object.assign(window, { Titlebar, Sidebar });

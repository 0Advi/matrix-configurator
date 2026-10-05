// Top bar + Sidebar for the new-store-folder web SPA.

const TopBar = ({ user, role, dark, onToggleDark, onNewPipeline, onSearch }) => (
  <header style={{
    height: 64, padding: 0,
    display: 'flex', alignItems: 'stretch',
    background: 'var(--zm-surface)', borderBottom: '1px solid var(--zm-line)',
    flex: '0 0 auto',
  }}>
    {/* LEFT cluster — brand masthead, deep teal gradient w/ copper sheen */}
    <div className="zm-brand-plate" style={{
      width: 232, flex: '0 0 232px',
      display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px',
      color: '#F5F2EC',
      borderRight: '1px solid var(--zm-line)',
    }}>
      <svg className="zm-brand-cube" width="34" height="34" viewBox="0 0 64 64" fill="none" style={{ display: 'block', flex: '0 0 auto', position: 'relative', zIndex: 1 }}>
        <g stroke="#7AE7DA" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.55">
          <path d="M22 10 L58 10 L58 46 L22 46 Z"/>
          <path d="M6 22 L22 10"/><path d="M42 22 L58 10"/>
          <path d="M6 58 L22 46"/><path d="M42 58 L58 46"/>
          <path d="M6 22 L42 22 L42 58 L6 58 Z"/>
        </g>
        <g stroke="#E0A659" strokeWidth="3.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 22 L58 10"/><path d="M58 10 L6 58"/><path d="M6 58 L58 46"/>
        </g>
      </svg>
      <span className="zm-brand-word" style={{
        fontFamily: 'var(--zm-font-serif)', fontStyle: 'italic', fontWeight: 400,
        fontSize: 30, color: '#F5F2EC', letterSpacing: '-0.012em', lineHeight: 1,
        whiteSpace: 'nowrap', position: 'relative', zIndex: 1,
        textShadow: '0 1px 0 rgba(0,0,0,0.35), 0 0 24px rgba(122,231,218,0.15)',
      }}>z‑matrix</span>
      {/* tiny copper accent dot */}
      <span style={{
        position: 'absolute', top: 12, right: 12,
        width: 5, height: 5, borderRadius: 999,
        background: '#E0A659', boxShadow: '0 0 8px rgba(224,166,89,0.7)',
        zIndex: 1,
      }}/>
    </div>

    {/* RIGHT cluster — main pane chrome, starts at sidebar edge */}
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', gap: 12,
      padding: '0 20px', minWidth: 0,
    }}>
      <button className="zm-tb-btn" style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        height: 34, padding: '0 10px 0 12px', borderRadius: 8,
        border: '1px solid var(--zm-line)', background: 'var(--zm-surface)',
        fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: 600, color: 'var(--zm-fg)',
        cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: 1, flex: '0 0 auto',
      }}>
        <Icon name="folder" size={14} style={{ color: 'var(--zm-fg-3)' }}/>
        <span>New store opening</span>
        <Icon name="chevronDown" size={12} style={{ color: 'var(--zm-fg-3)', marginLeft: 2 }}/>
      </button>

      {/* Search */}
      <div style={{ flex: 1, position: 'relative', minWidth: 200, maxWidth: 480 }}>
        <Icon name="search" size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--zm-fg-3)', pointerEvents: 'none' }}/>
        <input
          className="zm-tb-search"
          placeholder="Search sites or SPOC…"
          onChange={(e) => onSearch?.(e.target.value)}
          style={{
            width: '100%', minWidth: 0, boxSizing: 'border-box',
            height: 34, padding: '0 56px 0 34px',
            background: 'var(--zm-bg)', border: '1px solid var(--zm-line)',
            borderRadius: 8, fontFamily: 'var(--zm-font-body)', fontSize: 13,
            color: 'var(--zm-fg)', outline: 'none', textOverflow: 'ellipsis',
          }}
        />
        <kbd style={{
          position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
          fontFamily: 'var(--zm-font-mono)', fontSize: 10.5, fontWeight: 500, color: 'var(--zm-fg-3)',
          background: 'var(--zm-surface)', border: '1px solid var(--zm-line)',
          padding: '2px 6px', borderRadius: 4, lineHeight: 1,
          display: 'inline-flex', alignItems: 'center', gap: 2, whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}>⌘K</kbd>
      </div>

      <span style={{ flex: 1 }}/>

      {/* Theme toggle */}
      <button onClick={onToggleDark} title={dark ? 'Switch to light' : 'Switch to dark'} className="zm-tb-btn" style={{
        width: 34, height: 34, padding: 0, borderRadius: 8,
        border: '1px solid var(--zm-line)', background: 'var(--zm-surface)',
        color: 'var(--zm-fg-2)', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flex: '0 0 auto',
      }}>
        {dark ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v1M12 20v1M3 12h1M20 12h1M5.6 5.6l.7.7M17.7 17.7l.7.7M5.6 18.4l.7-.7M17.7 6.3l.7-.7"/></svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>
        )}
      </button>

      <button onClick={onNewPipeline} className="zm-tb-cta" style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        height: 34, padding: '0 14px', borderRadius: 8,
        background: 'var(--zm-accent)', color: '#fff', border: 'none',
        fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: 600,
        cursor: 'pointer', boxShadow: 'var(--zm-shadow-1)',
        whiteSpace: 'nowrap', lineHeight: 1, flex: '0 0 auto',
      }}>
        <Icon name="plus" size={13}/>
        <span>New pipeline</span>
      </button>

      <span style={{ width: 1, height: 24, background: 'var(--zm-line)', marginLeft: 2, flex: '0 0 auto' }}/>

      <button title="Account" style={{
        display: 'inline-flex', alignItems: 'center', gap: 10,
        height: 40, padding: '0 10px 0 4px', borderRadius: 999,
        background: 'transparent', border: '1px solid transparent',
        cursor: 'pointer', flex: '0 0 auto',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--zm-surface-hover)'; e.currentTarget.style.borderColor = 'var(--zm-line)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; }}
      >
        <Avatar name={user.name} size={30}/>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15, whiteSpace: 'nowrap', alignItems: 'flex-start' }}>
          <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: 600, color: 'var(--zm-fg)' }}>{user.name}</span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontFamily: 'var(--zm-font-body)', fontSize: 10.5, fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: role === 'supervisor' ? 'var(--zm-accent)' : 'var(--zm-fg-3)',
            marginTop: 2,
          }}>
            <span style={{
              width: 5, height: 5, borderRadius: 999,
              background: role === 'supervisor' ? 'var(--zm-accent)' : 'var(--zm-fg-3)',
            }}/>
            {role === 'supervisor' ? 'Supervisor' : 'BD Exec'}
          </span>
        </div>
        <Icon name="chevronDown" size={12} style={{ color: 'var(--zm-fg-3)' }}/>
      </button>
    </div>
  </header>
);

const SidebarItem = ({ icon, label, count, active, onClick }) => (
  <div onClick={onClick} className="zm-sb-item" style={{
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '7px 10px', borderRadius: 7, cursor: 'pointer',
    background: active ? 'var(--zm-accent-soft)' : 'transparent',
    color: active ? 'var(--zm-fg)' : 'var(--zm-fg-2)',
    fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: active ? 600 : 500,
    position: 'relative',
  }}
  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--zm-surface-hover)' }}
  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
  >
    {active && <span style={{ position: 'absolute', left: 0, top: 8, bottom: 8, width: 2, background: 'var(--zm-accent)', borderRadius: 2 }}/>}
    <span style={{ color: active ? 'var(--zm-accent)' : 'var(--zm-fg-3)', display: 'inline-flex' }}>
      <Icon name={icon} size={16}/>
    </span>
    {label}
    {count != null && (
      <span style={{
        marginLeft: 'auto', fontFamily: 'var(--zm-font-mono)', fontSize: 11,
        color: active ? 'var(--zm-accent)' : 'var(--zm-fg-3)', fontWeight: 500,
      }}>{count}</span>
    )}
  </div>
);

const Sidebar = ({ view, onView, counts, role, onRole }) => (
  <aside style={{
    width: 232, flex: '0 0 232px', padding: '14px 12px',
    background: 'var(--zm-surface)', borderRight: '1px solid var(--zm-line)',
    display: 'flex', flexDirection: 'column', gap: 2,
    overflowY: 'auto',
  }}>
    <div style={{
      fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10,
      letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--zm-fg-4)',
      padding: '4px 10px 6px',
    }}>Overview</div>
    <SidebarItem icon="trend"    label="Sites in motion" active={view === 'overview'}  onClick={() => onView('overview')}/>

    <div style={{
      fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10,
      letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--zm-fg-4)',
      padding: '14px 10px 6px',
    }}>Workflow</div>
    <SidebarItem icon="file"     label="Pipeline"        count={counts.pipeline}  active={view === 'pipeline'}  onClick={() => onView('pipeline')}/>
    <SidebarItem icon="shield"   label="Shortlist queue" count={counts.shortlist} active={view === 'shortlist'} onClick={() => onView('shortlist')}/>
    <SidebarItem icon="box"      label="Staging"         count={counts.staging}   active={view === 'staging'}   onClick={() => onView('staging')}/>
    {role === 'supervisor' && (
      <SidebarItem icon="folder"   label="Archive"         count={counts.archive}   active={view === 'archive'}   onClick={() => onView('archive')}/>
    )}

    <div style={{ flex: 1 }}/>

    {/* Role switcher — for the mock; in production this comes from identity service */}
    <div style={{
      padding: 10, margin: '0 4px 8px',
      border: '1px solid var(--zm-line)', borderRadius: 10,
      background: 'var(--zm-surface-2)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <span style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 700, fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--zm-fg-3)' }}>View as</span>
      <div style={{ display: 'flex', gap: 4, background: 'var(--zm-bg-2)', borderRadius: 7, padding: 3 }}>
        {['supervisor', 'exec'].map(r => (
          <button key={r} onClick={() => onRole(r)} className="zm-tb-btn" style={{
            flex: 1, height: 24, border: 'none', borderRadius: 5,
            background: role === r ? 'var(--zm-surface)' : 'transparent',
            color: role === r ? 'var(--zm-fg)' : 'var(--zm-fg-3)',
            fontFamily: 'var(--zm-font-body)', fontSize: 11, fontWeight: 600,
            cursor: 'pointer', boxShadow: role === r ? 'var(--zm-shadow-1)' : 'none',
            textTransform: 'capitalize',
          }}>{r === 'supervisor' ? 'Supervisor' : 'BD exec'}</button>
        ))}
      </div>
    </div>

    <div style={{
      padding: 12, margin: '0 4px',
      border: '1px solid var(--zm-line)', borderRadius: 10,
      background: 'var(--zm-surface-2)',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--zm-accent)' }}>
        <Icon name="chat" size={14}/>
        <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Ask Matrix</span>
      </div>
      <p style={{ margin: 0, fontFamily: 'var(--zm-font-body)', fontSize: 11.5, color: 'var(--zm-fg-2)', lineHeight: 1.45 }}>
        "Staging sites overdue &gt; 14 days" — answer in the desktop workspace.
      </p>
    </div>
  </aside>
);

Object.assign(window, { TopBar, Sidebar, SidebarItem });

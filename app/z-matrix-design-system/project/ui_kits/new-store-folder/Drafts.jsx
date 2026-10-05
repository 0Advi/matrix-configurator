// Pipeline view = DRAFTS ONLY.
// - Supervisor: sees every BD exec's draft; Yes / No / View / Archive.
//               Drafts ≥ 7 days unactioned are highlighted in red.
// - BD exec: sees only their own drafts; View only.
// Filters: name/creator · city · visit month · days.
// "No" opens a reject-reason dialog with 7 reason chips + Other comment.

const MONTHS = ['All', 'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const REJECT_REASONS = [
  'High rent', 'High cannibalisation', 'Affluence problem',
  'High traffic problem', 'No visibility', 'Sales problem', 'Other',
];

const RejectReasonDialog = ({ draft, onCancel, onSubmit }) => {
  const [picked, setPicked] = React.useState([]);
  const [comment, setComment] = React.useState('');
  const toggle = (r) => setPicked(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r]);

  const otherSelected = picked.includes('Other');
  const ready = picked.length > 0 && (!otherSelected || comment.trim().length > 0);

  if (!draft) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(11,12,16,0.46)', backdropFilter: 'blur(6px)',
      zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'zm-fade 200ms var(--zm-ease)',
    }}>
      <div style={{
        background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 14,
        width: 540, padding: 26, boxShadow: 'var(--zm-shadow-pop)',
        display: 'flex', flexDirection: 'column', gap: 18,
        animation: 'zm-rise 240ms var(--zm-ease-emp)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <span style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#B91C1C' }}>
              Rejecting · {draft.code}
            </span>
            <h2 style={{ margin: '4px 0 6px', fontFamily: 'var(--zm-font-display)', fontWeight: 700, fontSize: 20, letterSpacing: '-0.02em', color: 'var(--zm-fg)' }}>
              Why is this draft a No?
            </h2>
            <p style={{ margin: 0, fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg-3)' }}>
              Pick all that apply. The BD exec sees the reason; the draft is archived for future reference.
            </p>
          </div>
          <button onClick={onCancel} className="zm-icon-btn" style={{
            background: 'var(--zm-surface-2)', border: '1px solid var(--zm-line)', borderRadius: 8,
            width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--zm-fg-2)', cursor: 'pointer',
          }}><Icon name="x" size={14}/></button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {REJECT_REASONS.map(r => {
            const on = picked.includes(r);
            return (
              <button key={r} onClick={() => toggle(r)} className="zm-pill" style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                height: 32, padding: '0 12px', borderRadius: 999,
                border: '1px solid ' + (on ? '#B91C1C' : 'var(--zm-line)'),
                background: on ? '#FBE0E0' : 'var(--zm-surface)',
                color: on ? '#B91C1C' : 'var(--zm-fg-2)',
                fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
              }}>
                {on && <Icon name="check" size={12}/>}
                {r}
              </button>
            );
          })}
        </div>

        {otherSelected && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 12, color: 'var(--zm-fg)' }}>
              Other reason · comment <span style={{ color: '#B91C1C', fontWeight: 700 }}>*</span>
            </label>
            <textarea
              value={comment} onChange={(e) => setComment(e.target.value)}
              placeholder="Tell the BD exec what to look out for next time…"
              style={{
                width: '100%', minHeight: 80, padding: 10, resize: 'vertical',
                border: '1px solid var(--zm-line)', borderRadius: 8,
                fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)',
                outline: 'none', background: 'var(--zm-bg)',
              }}
            />
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} className="zm-btn" style={{
            height: 36, padding: '0 14px', borderRadius: 8, border: '1px solid var(--zm-line)',
            background: 'var(--zm-surface)', color: 'var(--zm-fg)',
            fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Cancel</button>
          <button disabled={!ready} onClick={() => onSubmit(draft, picked, comment)} className="zm-btn-primary" style={{
            height: 36, padding: '0 16px', borderRadius: 8, border: '1px solid #F2B6B6',
            background: ready ? '#fff' : 'var(--zm-surface)',
            color: ready ? '#B91C1C' : 'var(--zm-fg-4)',
            fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: 700,
            cursor: ready ? 'pointer' : 'not-allowed',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>Confirm reject</button>
        </div>
      </div>
    </div>
  );
};

const DraftsFilterBar = ({ filters, onFilters, drafts }) => {
  const cities = ['All', ...Array.from(new Set(drafts.map(d => d.city)))];
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: 10,
      padding: 14, background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 12,
      boxShadow: 'var(--zm-shadow-1)',
    }}>
      <div style={{ position: 'relative', minWidth: 0 }}>
        <Icon name="search" size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--zm-fg-3)', pointerEvents: 'none' }}/>
        <input
          placeholder="Search name or creator…"
          value={filters.q}
          onChange={(e) => onFilters({ ...filters, q: e.target.value })}
          style={{
            width: '100%', minWidth: 0, boxSizing: 'border-box',
            height: 36, padding: '0 10px 0 32px',
            background: 'var(--zm-bg)', border: '1px solid var(--zm-line)', borderRadius: 6,
            fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)', outline: 'none',
          }}
        />
      </div>
      <select value={filters.city} onChange={(e) => onFilters({ ...filters, city: e.target.value })} style={{
        height: 36, padding: '0 10px', background: 'var(--zm-bg)',
        border: '1px solid var(--zm-line)', borderRadius: 6,
        fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)', outline: 'none',
      }}>
        {cities.map(c => <option key={c} value={c}>City · {c}</option>)}
      </select>
      <select value={filters.month} onChange={(e) => onFilters({ ...filters, month: e.target.value })} style={{
        height: 36, padding: '0 10px', background: 'var(--zm-bg)',
        border: '1px solid var(--zm-line)', borderRadius: 6,
        fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)', outline: 'none',
      }}>
        {MONTHS.map(m => <option key={m} value={m}>Visit · {m}</option>)}
      </select>
      <select value={filters.days} onChange={(e) => onFilters({ ...filters, days: e.target.value })} style={{
        height: 36, padding: '0 10px', background: 'var(--zm-bg)',
        border: '1px solid var(--zm-line)', borderRadius: 6,
        fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)', outline: 'none',
      }}>
        <option value="all">Days · all</option>
        <option value="0-3">Days · 0–3</option>
        <option value="4-7">Days · 4–7</option>
        <option value="7+">Days · &gt; 7 (overdue)</option>
        <option value="14+">Days · 14+</option>
      </select>
    </div>
  );
};

const applyDraftFilters = (drafts, f) => drafts.filter(d => {
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!d.name.toLowerCase().includes(q) && !d.createdBy.toLowerCase().includes(q)) return false;
  }
  if (f.city !== 'All' && d.city !== f.city) return false;
  if (f.month !== 'All') {
    const m = new Date(d.visitDate).toLocaleString('en', { month: 'short' });
    if (m !== f.month) return false;
  }
  if (f.days !== 'all') {
    const bands = { '0-3': [0,3], '4-7': [4,7], '7+': [8, 9999], '14+': [14, 9999] };
    const [lo, hi] = bands[f.days];
    if (d.days < lo || d.days > hi) return false;
  }
  return true;
});

const EyeIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
);

const DraftRow = ({ draft, role, onApprove, onReject, onArchive, onOpen }) => {
  const overdue = role === 'supervisor' && draft.days > 7;
  return (
    <div className="zm-row" style={{
      display: 'grid',
      gridTemplateColumns: '0.9fr 1.6fr 1fr 1fr 0.8fr 0.7fr ' + (role === 'supervisor' ? '230px' : '90px'),
      alignItems: 'center', gap: 10, padding: '12px 16px',
      borderBottom: '1px solid var(--zm-line-faint)',
      background: overdue ? 'rgba(185,28,28,0.05)' : 'transparent',
      position: 'relative',
    }}>
      {overdue && <span style={{ position: 'absolute', left: 0, top: 12, bottom: 12, width: 2, background: '#B91C1C', borderRadius: 2 }}/>}
      <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 11.5, color: 'var(--zm-fg-3)' }}>{draft.code}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 13.5, fontWeight: 600, color: 'var(--zm-fg)' }}>{draft.name}</span>
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 10.5, color: 'var(--zm-fg-3)' }}>{draft.id}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Avatar name={draft.createdBy} size={22}/>
        <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 12.5, color: 'var(--zm-fg-2)' }}>{draft.createdBy}</span>
      </div>
      <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)' }}>{draft.city}</span>
      <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 12.5, color: 'var(--zm-fg-2)' }}>{draft.visitDate}</span>
      <span style={{
        fontFamily: 'var(--zm-font-mono)', fontSize: 13, fontWeight: 600,
        color: overdue ? '#B91C1C' : 'var(--zm-fg)',
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}>
        {overdue && <Icon name="alert" size={12}/>}
        {String(draft.days).padStart(2, '0')}d
      </span>
      {role === 'supervisor' ? (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={() => onOpen(draft)} title="View" className="zm-icon-btn" style={{
            width: 32, height: 32, padding: 0, border: '1px solid var(--zm-line)', borderRadius: 7,
            background: 'var(--zm-surface)', color: 'var(--zm-fg-2)',
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}><EyeIcon/></button>
          <button onClick={() => onArchive(draft)} title="Archive" className="zm-icon-btn" style={{
            width: 32, height: 32, padding: 0, border: '1px solid var(--zm-line)', borderRadius: 7,
            background: 'var(--zm-surface)', color: 'var(--zm-fg-2)',
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}><Icon name="folder" size={14}/></button>
          <button onClick={() => onReject(draft)} className="zm-btn-danger" style={{
            height: 32, padding: '0 10px', border: '1px solid #F2B6B6', borderRadius: 7,
            background: '#fff', color: '#B91C1C',
            fontFamily: 'var(--zm-font-body)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>No</button>
          <button onClick={() => onApprove(draft)} className="zm-btn-primary" style={{
            height: 32, padding: '0 14px', border: 'none', borderRadius: 7,
            background: 'var(--zm-accent)', color: '#fff',
            fontFamily: 'var(--zm-font-body)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            boxShadow: 'var(--zm-shadow-1)', display: 'inline-flex', alignItems: 'center', gap: 4,
          }}><Icon name="check" size={12}/> Yes</button>
        </div>
      ) : (
        <button onClick={() => onOpen(draft)} className="zm-btn" style={{
          height: 32, padding: '0 12px', border: '1px solid var(--zm-line)', borderRadius: 7,
          background: 'var(--zm-surface)', color: 'var(--zm-fg-2)', justifySelf: 'end',
          fontFamily: 'var(--zm-font-body)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}><EyeIcon/> View</button>
      )}
    </div>
  );
};

const DraftsView = ({ drafts, role, onApprove, onReject, onArchive, onOpen }) => {
  const [filters, setFilters] = React.useState({ q: '', city: 'All', month: 'All', days: 'all' });
  const filtered = applyDraftFilters(drafts, filters);
  const overdueCount = role === 'supervisor' ? drafts.filter(d => d.days > 7).length : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader
        file="№ 02"
        eyebrow="Workflow · Pipeline"
        title={role === 'supervisor' ? <>Drafts <em>awaiting</em> shortlist</> : <>Your drafts <em>in flight</em></>}
        lede={role === 'supervisor'
          ? `${drafts.length} draft${drafts.length === 1 ? '' : 's'} from all your BD execs. Supervisor SLA: 7 days. Tap Yes, No, or Archive.`
          : `${drafts.length} of your own draft${drafts.length === 1 ? '' : 's'} awaiting supervisor decision — you only see what you created.`
        }
        right={overdueCount > 0 ? <HeaderTag icon="alert" label={`${overdueCount} PAST SLA`} tone="accent"/> : <HeaderTag icon="check" label="SLA CLEAR"/>}
      />

      <DraftsFilterBar filters={filters} onFilters={setFilters} drafts={drafts}/>

      <div style={{ background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 12, overflow: 'hidden', boxShadow: 'var(--zm-shadow-1)' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '0.9fr 1.6fr 1fr 1fr 0.8fr 0.7fr ' + (role === 'supervisor' ? '230px' : '90px'),
          gap: 10, padding: '11px 16px', background: 'var(--zm-surface-2)',
          borderBottom: '1px solid var(--zm-line)',
          fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10.5,
          letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--zm-fg-3)',
        }}>
          <span>Code</span>
          <span>Pipeline name</span>
          <span>Created by</span>
          <span>City</span>
          <span>Visit date</span>
          <span>Days</span>
          <span style={{ textAlign: 'right' }}>{role === 'supervisor' ? 'Decision' : 'Action'}</span>
        </div>
        {filtered.map(d => <DraftRow key={d.id} draft={d} role={role} onApprove={onApprove} onReject={onReject} onArchive={onArchive} onOpen={onOpen}/>)}
        {filtered.length === 0 && (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--zm-fg-3)', fontFamily: 'var(--zm-font-body)', fontSize: 13 }}>
            No drafts match these filters.
          </div>
        )}
      </div>
    </div>
  );
};

Object.assign(window, { DraftsView, RejectReasonDialog, applyDraftFilters, EyeIcon });

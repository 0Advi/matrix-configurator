// Staging view — two-step flow:
//   BD exec  : sees their own approved sites (any state). Has Upload LOI.
//   Supervisor: ONLY sees sites where the exec has already uploaded the LOI.
//               In place of Upload LOI: View LOI + Push site.
//               Each row has a draft→LOI timeline tracker with day-count, draft date, LOI date.
//
// Overdue (current days > expected timeline) is highlighted in copper for BD exec view.

const StagingFilterBar = ({ filters, onFilters, sites, role }) => {
  const cities = ['All', ...Array.from(new Set(sites.map((s) => s.city)))];
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: 10,
      padding: 14, background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 12,
      boxShadow: 'var(--zm-shadow-1)'
    }}>
      <div style={{ position: 'relative', minWidth: 0 }}>
        <Icon name="search" size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--zm-fg-3)', pointerEvents: 'none' }} />
        <input
          placeholder="Search site or SPOC…"
          value={filters.q}
          onChange={(e) => onFilters({ ...filters, q: e.target.value })}
          style={{
            width: '100%', minWidth: 0, boxSizing: 'border-box',
            height: 36, padding: '0 10px 0 32px',
            background: 'var(--zm-bg)', border: '1px solid var(--zm-line)', borderRadius: 6,
            fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)', outline: 'none'
          }} />
        
      </div>
      <select value={filters.city} onChange={(e) => onFilters({ ...filters, city: e.target.value })} style={{
        height: 36, padding: '0 10px', background: 'var(--zm-bg)',
        border: '1px solid var(--zm-line)', borderRadius: 6,
        fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)', outline: 'none'
      }}>
        {cities.map((c) => <option key={c} value={c}>City · {c}</option>)}
      </select>
      <select value={filters.status} onChange={(e) => onFilters({ ...filters, status: e.target.value })} style={{
        height: 36, padding: '0 10px', background: 'var(--zm-bg)',
        border: '1px solid var(--zm-line)', borderRadius: 6,
        fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)', outline: 'none'
      }}>
        {role === 'supervisor' ?
        <>
            <option value="all">Status · all uploaded</option>
            <option value="overdue">Status · uploaded late</option>
            <option value="ontime">Status · uploaded on time</option>
          </> :

        <>
            <option value="all">Status · all</option>
            <option value="ontime">Status · on time</option>
            <option value="overdue">Status · overdue</option>
            <option value="uploaded">Status · uploaded</option>
          </>
        }
      </select>
      <select value={filters.month} onChange={(e) => onFilters({ ...filters, month: e.target.value })} style={{
        height: 36, padding: '0 10px', background: 'var(--zm-bg)',
        border: '1px solid var(--zm-line)', borderRadius: 6,
        fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)', outline: 'none'
      }}>
        {['All', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m) => <option key={m} value={m}>Approved · {m}</option>)}
      </select>
    </div>);

};

// Compact draft→LOI timeline visualization for supervisor view.
const TimelineTracker = ({ site }) => {
  const target = site.expectedLoiDays;
  const actual = site.daysToLOI ?? site.daysSinceApproval; // days from approval to LOI upload
  const late = actual > target;
  const pct = Math.max(0, Math.min(100, actual / Math.max(target, actual) * 100));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4,
        fontFamily: 'var(--zm-font-mono)', fontSize: 10.5, whiteSpace: 'nowrap'
      }}>
        <span style={{ color: 'var(--zm-fg-3)' }}>{site.draftDate || site.approvedDate}</span>
        <span style={{ color: late ? '#B91C1C' : '#005F60', fontWeight: 600 }}>{actual}d / {target}d</span>
        <span style={{ color: 'var(--zm-fg-3)' }}>{site.loiUploadedAt || '—'}</span>
      </div>
      <div style={{
        height: 6, borderRadius: 999, background: 'var(--zm-surface-sunken)',
        position: 'relative', overflow: 'hidden'
      }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${pct}%`, background: late ? '#B91C1C' : '#005F60', borderRadius: 999,
          transition: 'width 360ms var(--zm-ease-emp)'
        }} />
        <span style={{
          position: 'absolute', left: `${Math.min(100, target / Math.max(target, actual) * 100)}%`, top: -3, bottom: -3, width: 2,
          background: 'var(--zm-fg-3)', opacity: 0.4
        }} />
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        fontFamily: 'var(--zm-font-body)', fontSize: 10.5, fontWeight: 600,
        color: late ? '#B91C1C' : '#047857', whiteSpace: 'nowrap'
      }}>
        {late ?
        <><Icon name="alert" size={10} /> Uploaded {actual - target}d late</> :
        <><Icon name="check" size={10} /> Uploaded {target - actual}d early</>
        }
      </div>
    </div>);

};

const ExecRow = ({ site, onUpload, onOpen }) => {
  const remaining = site.expectedLoiDays - site.daysSinceApproval;
  const overdue = remaining < 0;
  const uploaded = site.loiUploaded;
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '0.9fr 1.6fr 1fr 1fr 1fr 1.4fr 170px',
      alignItems: 'center', gap: 10, padding: '14px 16px',
      borderBottom: '1px solid var(--zm-line-faint)',
      background: overdue && !uploaded ? 'rgba(217,119,6,0.06)' : 'transparent',
      position: 'relative'
    }}>
      {overdue && !uploaded &&
      <span style={{ position: 'absolute', left: 0, top: 12, bottom: 12, width: 2, background: '#D97706', borderRadius: 2 }} />
      }
      <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 11.5, color: 'var(--zm-fg-3)' }}>{site.code}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 13.5, fontWeight: 600, color: 'var(--zm-fg)' }}>{site.name}</span>
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 10.5, color: 'var(--zm-fg-3)' }}>SPOC · {site.spocName}</span>
      </div>
      <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)' }}>{site.city}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 12.5, color: 'var(--zm-fg)' }}>{site.approvedDate}</span>
        <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 11, color: 'var(--zm-fg-3)' }}>by {site.approvedBy}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--zm-fg)' }}>
          {String(site.daysSinceApproval).padStart(2, '0')} / {site.expectedLoiDays} d
        </span>
        <span style={{
          fontFamily: 'var(--zm-font-body)', fontSize: 11, fontWeight: 500,
          color: uploaded ? '#005F60' : overdue ? '#B45309' : 'var(--zm-fg-3)'
        }}>
          {uploaded ? 'LOI uploaded' : overdue ? `${Math.abs(remaining)}d overdue` : `${remaining}d remaining`}
        </span>
      </div>
      <div>
        {uploaded ? <StatusPill stage="uploaded" /> :
        overdue ? <StatusPill stage="overdue" /> :
        <StatusPill stage="staging" />}
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button onClick={() => onOpen(site)} title="View" style={{
          width: 32, height: 32, padding: 0, border: '1px solid var(--zm-line)', borderRadius: 7,
          background: 'var(--zm-surface)', color: 'var(--zm-fg-2)',
          cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center'
        }}><EyeIcon /></button>
        {uploaded ?
        <button disabled style={{
          height: 32, padding: '0 12px', border: '1px solid var(--zm-line)', borderRadius: 7,
          background: 'var(--zm-surface)', color: 'var(--zm-fg-3)',
          fontFamily: 'var(--zm-font-body)', fontSize: 12, fontWeight: 600, cursor: 'not-allowed',
          display: 'inline-flex', alignItems: 'center', gap: 6
        }}><Icon name="check" size={12} /> Uploaded</button> :

        <button onClick={() => onUpload(site)} style={{
          height: 32, padding: '0 12px', border: 'none', borderRadius: 7,
          background: overdue ? '#D97706' : 'var(--zm-accent)', color: '#fff',
          fontFamily: 'var(--zm-font-body)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 6,
          boxShadow: 'var(--zm-shadow-1)'
        }}><Icon name="upload" size={12} /> Upload LOI</button>
        }
      </div>
    </div>);

};

const SupervisorRow = ({ site, onPush, onViewLOI, onOpen }) => {
  const pushed = site.pushed;
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '70px minmax(130px, 0.9fr) 70px 124px minmax(170px, 1.3fr) 170px',
      alignItems: 'center', gap: 10, padding: '14px 12px',
      borderBottom: '1px solid var(--zm-line-faint)',
      background: pushed ? 'rgba(4,120,87,0.04)' : 'transparent',
      opacity: pushed ? 0.85 : 1
    }}>
      <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 11.5, color: 'var(--zm-fg-3)' }}>{site.code}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 13.5, fontWeight: 600, color: 'var(--zm-fg)' }}>{site.name}</span>
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 10.5, color: 'var(--zm-fg-3)' }}>by {site.createdBy}</span>
      </div>
      <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)' }}>{site.city}</span>
      <div>{pushed ? <StatusPill stage="completed" /> : <StatusPill stage="uploaded" />}</div>
      <div style={{ minWidth: 0, overflow: 'hidden' }}>
        <TimelineTracker site={site} />
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', minWidth: 0 }}>
        <button onClick={() => onOpen(site)} title="View site" style={{
          width: 32, height: 32, padding: 0, border: '1px solid var(--zm-line)', borderRadius: 7,
          background: 'transparent', color: 'var(--zm-fg)',
          cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          flex: '0 0 32px'
        }}><EyeIcon size={14} /></button>
        <button onClick={() => onViewLOI(site)} title="View LOI" style={{
          width: 32, height: 32, padding: 0, border: '1px solid var(--zm-line)', borderRadius: 7,
          background: 'transparent', color: 'var(--zm-fg)',
          cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          flex: '0 0 32px'
        }}><Icon name="file" size={14} /></button>
        {pushed ?
        <button disabled style={{
          height: 32, padding: '0 12px', border: '1px solid var(--zm-line)', borderRadius: 7,
          background: 'var(--zm-surface)', color: 'var(--zm-fg-3)',
          fontFamily: 'var(--zm-font-body)', fontSize: 12, fontWeight: 600, cursor: 'not-allowed',
          display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', lineHeight: 1,
          flex: '0 0 auto'
        }}><Icon name="check" size={12} /> Pushed</button> :

        <button onClick={() => onPush(site)} style={{
          flex: '1 1 auto', minWidth: 100, height: 32, padding: '0 12px', border: 'none', borderRadius: 7,
          background: 'var(--zm-accent)', color: '#fff',
          fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          whiteSpace: 'nowrap', lineHeight: 1, boxShadow: 'var(--zm-shadow-1)'
        }}>Push site <Icon name="arrow" size={12} /></button>
        }
      </div>
    </div>);

};

const applyStagingFilters = (sites, f) => sites.filter((s) => {
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!s.name.toLowerCase().includes(q) && !(s.spocName || '').toLowerCase().includes(q)) return false;
  }
  if (f.city !== 'All' && s.city !== f.city) return false;
  if (f.month !== 'All') {
    const m = new Date(s.approvedDate).toLocaleString('en', { month: 'short' });
    if (m !== f.month) return false;
  }
  const overdue = s.daysSinceApproval > s.expectedLoiDays && !s.loiUploaded;
  if (f.status === 'overdue' && !overdue) return false;
  if (f.status === 'ontime' && (overdue || s.loiUploaded)) return false;
  if (f.status === 'uploaded' && !s.loiUploaded) return false;
  return true;
});

const StagingView = ({ sites, role, onUpload, onOpen, onPush, onViewLOI }) => {
  const [filters, setFilters] = React.useState({ q: '', city: 'All', month: 'All', status: 'all' });
  const filtered = applyStagingFilters(sites, filters);
  const overdueCount = sites.filter((s) => s.daysSinceApproval > s.expectedLoiDays && !s.loiUploaded).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader
        file="№ 04"
        eyebrow="Workflow · Staging"
        title={role === 'supervisor' ? <>LOIs <em>awaiting</em> push</> : <>Sites <em>awaiting</em> LOI</>}
        lede={role === 'supervisor' ?
        `${sites.length} site${sites.length === 1 ? '' : 's'} with uploaded LOI — review the draft → LOI timeline and push to the next module.` :
        `${sites.length} of your own approved site${sites.length === 1 ? '' : 's'} — ${overdueCount} overdue against expected timeline.`
        }
        right={role !== 'supervisor' && overdueCount > 0 ?
        <HeaderTag icon="alert" label={`${overdueCount} OVERDUE`} tone="accent" /> :
        <HeaderTag icon="check" label="ON TRACK" />} />
      

      <StagingFilterBar filters={filters} onFilters={setFilters} sites={sites} role={role} />

      <div className="zm-glass" style={{ borderRadius: 16, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
        {role === 'supervisor' ?
          <div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '70px minmax(130px, 0.9fr) 70px 124px minmax(170px, 1.3fr) 170px',
              gap: 10, padding: '11px 12px',
              background: 'var(--zm-surface-2)',
              borderBottom: '1px solid var(--zm-line)',
              fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10.5,
              letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--zm-fg-3)'
            }}>
              <span>Code</span>
              <span>Site</span>
              <span>City</span>
              <span>Status</span>
              <span>Draft → LOI timeline</span>
              <span style={{ textAlign: "center" }}>Action</span>
            </div>
            {filtered.map((s) => <SupervisorRow key={s.id} site={s} onPush={onPush} onViewLOI={onViewLOI} onOpen={onOpen} />)}
          </div> :

          <div style={{ minWidth: 1080 }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '0.9fr 1.6fr 1fr 1fr 1fr 1.4fr 170px',
              gap: 10, padding: '11px 16px',
              background: 'var(--zm-surface-2)',
              borderBottom: '1px solid var(--zm-line)',
              fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10.5,
              letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--zm-fg-3)'
            }}>
              <span>Code</span>
              <span>Site</span>
              <span>City</span>
              <span>Approved</span>
              <span>LOI timeline</span>
              <span>Status</span>
              <span style={{ textAlign: 'right' }}>Action</span>
            </div>
            {filtered.map((s) => <ExecRow key={s.id} site={s} onUpload={onUpload} onOpen={onOpen} />)}
          </div>
          }
        {filtered.length === 0 &&
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--zm-fg-3)', fontFamily: 'var(--zm-font-body)', fontSize: 13 }}>
            {role === 'supervisor' ? 'No LOIs uploaded yet.' : 'No sites match these filters.'}
          </div>
          }
        </div>
      </div>
    </div>);

};

Object.assign(window, { StagingView });
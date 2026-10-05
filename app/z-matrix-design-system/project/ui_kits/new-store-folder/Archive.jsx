// Archive view — supervisor only. Stores rejected/archived sites for future reference.

const ArchiveView = ({ archives, onOpen }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
    <PageHeader
      file="№ 05"
      eyebrow="Reference · Archive"
      title={<>Archived <em>sites</em></>}
      lede={`${archives.length} site${archives.length === 1 ? '' : 's'} archived for future reference — rejected drafts and paused inquiries, with their reasons preserved.`}
      right={<HeaderTag icon="folder" label="READ ONLY"/>}
    />

    <div style={{ background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 12, overflow: 'hidden', boxShadow: 'var(--zm-shadow-1)' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '0.9fr 1.6fr 1fr 1fr 1fr 1.4fr 90px',
        gap: 10, padding: '11px 16px', background: 'var(--zm-surface-2)',
        borderBottom: '1px solid var(--zm-line)',
        fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10.5,
        letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--zm-fg-3)',
      }}>
        <span>Code</span><span>Site</span><span>City</span><span>Created by</span>
        <span>Archived on</span><span>Reason</span><span/>
      </div>
      {archives.map(a => (
        <div key={a.id} className="zm-row" style={{
          display: 'grid', gridTemplateColumns: '0.9fr 1.6fr 1fr 1fr 1fr 1.4fr 90px',
          gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--zm-line-faint)',
        }}>
          <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 11.5, color: 'var(--zm-fg-3)' }}>{a.code}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: 600, color: 'var(--zm-fg)' }}>{a.name}</span>
            <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 10.5, color: 'var(--zm-fg-3)' }}>{a.id}</span>
          </div>
          <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)' }}>{a.city}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Avatar name={a.createdBy} size={20}/>
            <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 12.5, color: 'var(--zm-fg-2)' }}>{a.createdBy}</span>
          </div>
          <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 12, color: 'var(--zm-fg)' }}>{a.archivedAt}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'flex-start' }}>
            {(a.reasons || []).map(r => (
              <span key={r} style={{
                padding: '2px 8px', borderRadius: 999, background: '#F1F3F6', color: '#374151',
                fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10.5,
                whiteSpace: 'nowrap',
              }}>{r}</span>
            ))}
            {(!a.reasons || a.reasons.length === 0) && (
              <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 12, color: 'var(--zm-fg-3)' }}>—</span>
            )}
          </div>
          <button onClick={() => onOpen(a)} className="zm-btn zm-row-cta" style={{
            height: 28, padding: '0 10px', border: '1px solid var(--zm-line)', borderRadius: 7,
            background: 'var(--zm-surface)', color: 'var(--zm-fg-2)', justifySelf: 'end',
            fontFamily: 'var(--zm-font-body)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}><EyeIcon size={12}/> View</button>
        </div>
      ))}
      {archives.length === 0 && (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--zm-fg-3)', fontFamily: 'var(--zm-font-body)', fontSize: 13 }}>
          Archive is empty. Rejected and archived drafts will appear here for future reference.
        </div>
      )}
    </div>
  </div>
);

Object.assign(window, { ArchiveView });

// Hero tiles: 4-up metric grid with sparklines + Approvals queue + Trace panel.

const HeroTile = ({ eyebrow, value, accent = '#00B4D8', delta, deltaTone = 'pos', spark, sparkColor }) => (
  <div style={{
    background: '#171923', border: '1px solid #262A38', borderRadius: 12,
    padding: '18px 18px 4px', display: 'flex', flexDirection: 'column', gap: 8,
    position: 'relative', overflow: 'hidden',
  }}>
    <span style={{
      fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10,
      letterSpacing: '0.14em', textTransform: 'uppercase', color: '#7C8499',
    }}>{eyebrow}</span>
    <span style={{
      fontFamily: 'var(--zm-font-mono)', fontFeatureSettings: "'tnum' 1",
      fontWeight: 600, fontSize: 34, letterSpacing: '-0.02em', color: '#E2E8F0', lineHeight: 1,
    }}>{value}</span>
    <span style={{ width: 32, height: 2, background: accent, boxShadow: `0 0 6px ${accent}55` }}/>
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
      <span style={{
        fontFamily: 'var(--zm-font-mono)', fontSize: 11.5,
        color: deltaTone === 'pos' ? '#34D399' : deltaTone === 'neg' ? '#F87171' : '#7C8499',
      }}>{delta}</span>
      <div style={{ width: '55%', opacity: 0.92 }}>
        {spark && <Spark data={spark} color={sparkColor || accent} height={30}/>}
      </div>
    </div>
  </div>
);

const HeroTiles = () => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
    <HeroTile eyebrow="Sites in motion"   value="142"  accent="#00B4D8" delta="▲ 12 · 7d" spark={[110,118,121,124,128,132,136,138,142]}/>
    <HeroTile eyebrow="Drafts · pending"  value="9"    accent="#A78BFA" delta="▲ 2 · 7d"  spark={[5,6,7,8,7,8,9,8,9]} sparkColor="#A78BFA"/>
    <HeroTile eyebrow="LOI overdue"       value="4"    accent="#F59E0B" delta="▲ 1 · 7d"  deltaTone="neg" spark={[2,2,3,3,3,4,4,3,4]} sparkColor="#F59E0B"/>
    <HeroTile eyebrow="Cycle · median d"  value="61"   accent="#34D399" delta="▼ 5 · vs Q1" spark={[71,69,68,66,64,63,62,61,61]} sparkColor="#34D399"/>
  </div>
);

const APPROVALS = [
  { id: 'sl_88f1', site: 'Bandra Linking Rd',      city: 'Mumbai',    code: 'BT-MUM-0143', by: 'Riya Sharma',   ago: '14 min', detailed: true,  score: 78 },
  { id: 'sl_88e3', site: 'Connaught Place · F-21', city: 'New Delhi', code: 'BT-DEL-0090', by: 'Nikhil Iyer',   ago: '2 hr',   detailed: true,  score: 82 },
  { id: 'sl_88d2', site: 'BKC One · East Wing',    city: 'Mumbai',    code: 'BT-MUM-0144', by: 'Riya Sharma',   ago: '5 hr',   detailed: false, score: 74 },
  { id: 'sl_88c1', site: 'Koramangala 6th Block',  city: 'Bengaluru', code: 'BT-BLR-0209', by: 'Aman Verma',    ago: '1 day',  detailed: false, score: 71 },
];

const ApprovalCard = ({ row, onApprove, onReject }) => (
  <div style={{
    padding: '14px 16px', borderBottom: '1px solid #1B1E2A',
    display: 'grid', gridTemplateColumns: '1.6fr 1fr 0.7fr 1.1fr auto', alignItems: 'center', gap: 14,
  }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: 600, color: '#E2E8F0' }}>{row.site}</span>
      <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 10.5, color: '#7C8499' }}>{row.code} · {row.city}</span>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 12.5, color: '#E2E8F0' }}>by {row.by}</span>
      <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 11, color: '#7C8499' }}>{row.ago} ago</span>
    </div>
    <span style={{
      fontFamily: 'var(--zm-font-mono)', fontFeatureSettings: "'tnum' 1",
      fontSize: 18, fontWeight: 600, color: row.score >= 75 ? '#34D399' : '#E2E8F0', textAlign: 'right',
    }}>{row.score}</span>
    <div>
      {row.detailed ? (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '3px 10px', borderRadius: 999, background: 'rgba(52,211,153,0.14)', color: '#34D399',
          fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10.5,
          letterSpacing: '0.12em', textTransform: 'uppercase',
        }}><Icon name="check" size={11}/> Details added</span>
      ) : (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '3px 10px', borderRadius: 999, background: 'rgba(245,158,11,0.14)', color: '#F59E0B',
          fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10.5,
          letterSpacing: '0.12em', textTransform: 'uppercase',
        }}><Icon name="alert" size={11}/> Awaiting detail</span>
      )}
    </div>
    <div style={{ display: 'flex', gap: 6 }}>
      <button onClick={() => onReject(row)} style={{
        background: 'transparent', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 7,
        padding: '6px 10px', fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 12, color: '#F87171',
        cursor: 'pointer',
      }}>Reject</button>
      <button disabled={!row.detailed} onClick={() => onApprove(row)} style={{
        background: row.detailed ? '#00B4D8' : '#262A38',
        color: row.detailed ? '#0B0C10' : '#525A6F',
        border: 'none', borderRadius: 7, padding: '6px 12px',
        fontFamily: 'var(--zm-font-body)', fontWeight: 700, fontSize: 12,
        cursor: row.detailed ? 'pointer' : 'not-allowed',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}>
        <Icon name="check" size={12}/> Approve
      </button>
    </div>
  </div>
);

const Approvals = ({ onAction }) => (
  <div style={{
    background: '#171923', border: '1px solid #262A38', borderRadius: 12, overflow: 'hidden',
  }}>
    <div style={{
      padding: '14px 16px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      borderBottom: '1px solid #1B1E2A',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h3 style={{ margin: 0, fontFamily: 'var(--zm-font-display)', fontWeight: 600, fontSize: 16, color: '#E2E8F0' }}>Shortlist approvals</h3>
        <span style={{
          padding: '2px 8px', borderRadius: 999, background: 'rgba(245,158,11,0.14)', color: '#F59E0B',
          fontFamily: 'var(--zm-font-body)', fontWeight: 700, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>{APPROVALS.length} pending</span>
      </div>
      <div style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 11, color: '#7C8499' }}>via bd-mcp · 4s lag</div>
    </div>
    {APPROVALS.map(r => (
      <ApprovalCard key={r.id} row={r} onApprove={() => onAction('approved', r)} onReject={() => onAction('rejected', r)}/>
    ))}
  </div>
);

const TRACE = [
  { kind: 'user',   t: '14:32:08', text: 'staging sites overdue > 14 days in mumbai' },
  { kind: 'think',  t: '14:32:08', text: 'Resolving "Mumbai" → tenant.cities[name=Mumbai]. Building filter: stage == staging AND city == Mumbai AND (days_since_approval − expected_loi_days) > 14.' },
  { kind: 'tool',   t: '14:32:09', text: 'bd-mcp · staging_overdue', meta: 'city=Mumbai · days_over=14' },
  { kind: 'result', t: '14:32:10', text: '6 rows · cache hit · 142ms' },
  { kind: 'think',  t: '14:32:10', text: 'Computing expected op cost = sum(total_op_cost) = ₹9,90,000. Sorting by overdue days desc.' },
  { kind: 'tool',   t: '14:32:11', text: 'render · table_card', meta: 'cols=5 · sort=overdue desc' },
  { kind: 'msg',    t: '14:32:11', text: '6 sites returned. Want me to draft the supervisor digest as PPTX?' },
];

const TracePanel = () => (
  <aside style={{
    width: 320, flex: '0 0 320px', background: '#0F111A', borderLeft: '1px solid #1B1E2A',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  }}>
    <div style={{ padding: '14px 16px', borderBottom: '1px solid #1B1E2A', display: 'flex', alignItems: 'center', gap: 8 }}>
      <Icon name="activity" size={14} style={{ color: '#00B4D8' }}/>
      <span style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#B4BBC9' }}>Trace</span>
      <span style={{ marginLeft: 'auto', fontFamily: 'var(--zm-font-mono)', fontSize: 10.5, color: '#525A6F' }}>last run · 14:32:11</span>
    </div>
    <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
      {TRACE.map((e, i) => {
        const colors = {
          user:   { c: '#E2E8F0', l: 'You',     bg: 'rgba(0,180,216,0.12)' },
          think:  { c: '#A78BFA', l: 'Think',   bg: 'rgba(167,139,250,0.10)' },
          tool:   { c: '#00B4D8', l: 'Tool',    bg: 'rgba(0,180,216,0.10)' },
          result: { c: '#34D399', l: 'Result',  bg: 'rgba(52,211,153,0.10)' },
          msg:    { c: '#F59E0B', l: 'Reply',   bg: 'rgba(245,158,11,0.10)' },
        }[e.kind];
        return (
          <div key={i} style={{ padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                padding: '1px 7px', borderRadius: 4, background: colors.bg, color: colors.c,
                fontFamily: 'var(--zm-font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
              }}>{colors.l}</span>
              <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 10, color: '#525A6F' }}>{e.t}</span>
            </div>
            <span style={{
              fontFamily: e.kind === 'tool' ? 'var(--zm-font-mono)' : 'var(--zm-font-body)',
              fontSize: e.kind === 'tool' ? 12 : 12.5, color: e.kind === 'tool' ? '#B4BBC9' : '#D1D6E2', lineHeight: 1.5,
            }}>{e.text}</span>
            {e.meta && (
              <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 10.5, color: '#7C8499', paddingLeft: 8, borderLeft: '1px solid #262A38' }}>{e.meta}</span>
            )}
          </div>
        );
      })}
    </div>
    <div style={{ padding: '10px 14px', borderTop: '1px solid #1B1E2A', display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 10.5, color: '#525A6F' }}>2 MCP servers · 5 skills</span>
      <span style={{ flex: 1 }}/>
      <button style={{ background: 'transparent', border: 'none', color: '#7C8499', cursor: 'pointer', display: 'inline-flex' }}>
        <Icon name="refresh" size={13}/>
      </button>
    </div>
  </aside>
);

Object.assign(window, { HeroTile, HeroTiles, ApprovalCard, Approvals, TracePanel, APPROVALS });

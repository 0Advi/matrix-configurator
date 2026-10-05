// Pipeline overview: metric strip + filter bar + sites table.

const MetricCard = ({ eyebrow, value, rule = 'var(--zm-copper)', delta, deltaTone = 'pos', sub, no }) => (
  <div className="zm-glass" style={{
    borderRadius: 16,
    padding: '24px 26px 26px',
    display: 'flex', flexDirection: 'column', gap: 12,
    position: 'relative', overflow: 'hidden',
    transition: 'transform 200ms cubic-bezier(0.22,1,0.36,1), box-shadow 200ms cubic-bezier(0.22,1,0.36,1)',
  }}
  onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--zm-shadow-3)'; }}
  onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'var(--zm-glass)'; }}
  >
    {/* Gradient accent edge at top */}
    <span aria-hidden="true" style={{
      position: 'absolute', inset: '0 0 auto 0', height: 1,
      background: 'linear-gradient(90deg, transparent, ' + rule + ', transparent)', opacity: 0.6,
    }}/>
    <CornerTicks/>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      {no && (
        <span style={{
          fontFamily: 'var(--zm-font-mono)', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.16em', color: 'var(--zm-fg-4)', flex: '0 0 auto',
        }}>{no}</span>
      )}
      <span style={{
        fontFamily: 'var(--zm-font-body)', fontWeight: 700, fontSize: 9.5,
        letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--zm-fg-3)',
        lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1,
      }}>{eyebrow}</span>
    </div>
    <span style={{
      fontFamily: 'var(--zm-font-serif)', fontWeight: 400, fontStyle: 'italic',
      fontSize: 68, letterSpacing: '-0.025em', color: 'var(--zm-fg)', lineHeight: 0.95,
      fontFeatureSettings: "'tnum' 1",
    }}>{value}</span>
    <span style={{ width: 36, height: 1, background: rule, opacity: 0.7 }}/>
    {delta && (
      <span style={{
        fontFamily: 'var(--zm-font-mono)', fontSize: 11.5, letterSpacing: 0,
        color: deltaTone === 'pos' ? 'var(--zm-success)' : deltaTone === 'neg' ? 'var(--zm-danger)' : 'var(--zm-fg-3)',
      }}>{delta}</span>
    )}
    {sub && <span style={{ fontFamily: 'var(--zm-font-serif)', fontStyle: 'italic', fontSize: 13, color: 'var(--zm-fg-3)' }}>{sub}</span>}
  </div>
);

const CornerTicks = () => (
  <>
    {[
      { top: 0, left: 0, rot: 0 },
      { top: 0, right: 0, rot: 90 },
      { bottom: 0, right: 0, rot: 180 },
      { bottom: 0, left: 0, rot: -90 },
    ].map((p, i) => (
      <span key={i} style={{
        position: 'absolute', width: 8, height: 8, ...p,
        borderTop: '1px solid var(--zm-fg-3)', borderLeft: '1px solid var(--zm-fg-3)',
        opacity: 0.35,
        transform: `rotate(${p.rot}deg)`,
        margin: 6,
      }}/>
    ))}
  </>
);

const MetricStrip = ({ metrics }) => {
  // Falls back to placeholder values if no metrics provided — keeps the
  // component renderable in isolation for design-system previews.
  const m = metrics || {
    inMotion: { value: 0, sub: 'no data' },
    drafts:   { value: 0, sub: 'no data' },
    shortlist:{ value: 0, sub: 'no data' },
    loi:      { value: 0, sub: 'no data' },
  };
  return (
    <div className="zm-stagger" style={{
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14,
    }}>
      <MetricCard no="Ⅰ" eyebrow="Sites in motion" value={m.inMotion.value} rule="var(--zm-accent)" delta={m.inMotion.delta} sub={m.inMotion.sub}/>
      <MetricCard no="Ⅱ" eyebrow="New drafts"      value={m.drafts.value}   rule="var(--zm-fg-3)"   delta={m.drafts.delta}   sub={m.drafts.sub}/>
      <MetricCard no="Ⅲ" eyebrow="Shortlist"       value={m.shortlist.value} rule="var(--zm-info)"  delta={m.shortlist.delta} sub={m.shortlist.sub}/>
      <MetricCard no="Ⅳ" eyebrow="LOI due / overdue" value={m.loi.value}    rule="var(--zm-copper)" delta={m.loi.delta} deltaTone={m.loi.deltaTone || 'neutral'} sub={m.loi.sub}/>
    </div>
  );
};

const FilterChip = ({ active, label, count, color, onClick }) => (
  <button onClick={onClick} className="zm-pill" style={{
    display: 'inline-flex', alignItems: 'center', gap: 8,
    height: 30, padding: '0 12px', borderRadius: 999,
    border: '1px solid ' + (active ? 'var(--zm-fg)' : 'var(--zm-line)'),
    background: active ? 'var(--zm-fg)' : 'var(--zm-surface)',
    color: active ? '#fff' : 'var(--zm-fg-2)',
    fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: 600,
    cursor: 'pointer', transition: 'all 120ms var(--zm-ease)',
  }}>
    {color && <span style={{ width: 6, height: 6, borderRadius: 999, background: color }}/>}
    {label}
    {count != null && (
      <span style={{
        fontFamily: 'var(--zm-font-mono)', fontWeight: 500, fontSize: 11,
        color: active ? 'rgba(255,255,255,0.7)' : 'var(--zm-fg-3)',
      }}>{count}</span>
    )}
  </button>
);

// =================================================================
// More-filters popover: month chips, quick presets, calendar range.
// =================================================================

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const PRESETS = [
  { id: 'today',     label: 'Today',        days: 0 },
  { id: 'week',      label: 'Last 7 days',  days: 7 },
  { id: 'month',     label: 'Last 30 days', days: 30 },
  { id: 'thisMo',    label: 'This month',   kind: 'thisMonth' },
  { id: 'lastMo',    label: 'Last month',   kind: 'lastMonth' },
  { id: 'q',         label: 'This quarter', kind: 'thisQuarter' },
  { id: 'ytd',       label: 'YTD',          kind: 'ytd' },
];

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtISO = (d) => {
  // Local-date ISO — avoids the UTC off-by-one when the user is east of GMT.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const fmtNice = (iso) => iso ? new Date(iso + 'T00:00').toLocaleDateString('en', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const presetRange = (p) => {
  const now = new Date();
  if (p.days != null) {
    const end = now;
    const start = p.days === 0 ? now : addDays(now, -p.days);
    return { from: fmtISO(start), to: fmtISO(end) };
  }
  if (p.kind === 'thisMonth') {
    return { from: fmtISO(new Date(now.getFullYear(), now.getMonth(), 1)), to: fmtISO(new Date(now.getFullYear(), now.getMonth()+1, 0)) };
  }
  if (p.kind === 'lastMonth') {
    return { from: fmtISO(new Date(now.getFullYear(), now.getMonth()-1, 1)), to: fmtISO(new Date(now.getFullYear(), now.getMonth(), 0)) };
  }
  if (p.kind === 'thisQuarter') {
    const q = Math.floor(now.getMonth() / 3);
    return { from: fmtISO(new Date(now.getFullYear(), q*3, 1)), to: fmtISO(new Date(now.getFullYear(), q*3+3, 0)) };
  }
  if (p.kind === 'ytd') {
    return { from: fmtISO(new Date(now.getFullYear(), 0, 1)), to: fmtISO(now) };
  }
  return { from: '', to: '' };
};

// Tiny month-grid calendar with click-to-pick range.
const RangeCalendar = ({ from, to, onChange }) => {
  const [view, setView] = React.useState(() => {
    const seed = from ? new Date(from + 'T00:00') : new Date();
    return { y: seed.getFullYear(), m: seed.getMonth() };
  });

  // Keep the visible month in sync when `from` is set externally (e.g. via a preset).
  React.useEffect(() => {
    if (!from) return;
    const d = new Date(from + 'T00:00');
    setView(v => (v.y === d.getFullYear() && v.m === d.getMonth()) ? v : { y: d.getFullYear(), m: d.getMonth() });
  }, [from]);

  const monthStart = new Date(view.y, view.m, 1);
  const monthEnd   = new Date(view.y, view.m + 1, 0);
  const startDow   = monthStart.getDay();   // 0..6 (Sun)
  const daysInMonth = monthEnd.getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(view.y, view.m, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const fromD = from ? new Date(from + 'T00:00') : null;
  const toD   = to   ? new Date(to   + 'T00:00') : null;
  const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const inRange = (d) => fromD && toD && d > fromD && d < toD;
  const isEnd   = (d, t) => sameDay(d, t);

  const pick = (d) => {
    if (!d) return;
    const iso = fmtISO(d);
    // No range yet, OR a full range already exists → start over with a new "from".
    if (!from || (from && to)) return onChange({ from: iso, to: '' });
    // "From" picked, choosing the second endpoint.
    if (iso === from) return onChange({ from: iso, to: iso });   // single-day range
    if (iso < from)   return onChange({ from: iso, to: from });  // swap if user picked earlier
    return onChange({ from, to: iso });
  };

  const shift = (delta) => setView(v => {
    let y = v.y, m = v.m + delta;
    while (m < 0) { m += 12; y--; }
    while (m > 11) { m -= 12; y++; }
    return { y, m };
  });

  return (
    <div style={{
      background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 10,
      padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 248,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button onClick={() => shift(-1)} className="zm-icon-btn" style={{
          width: 24, height: 24, padding: 0, border: '1px solid var(--zm-line)', borderRadius: 6,
          background: 'var(--zm-surface)', color: 'var(--zm-fg-2)', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <span style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 12.5, color: 'var(--zm-fg)' }}>
          {MONTH_NAMES[view.m]} {view.y}
        </span>
        <button onClick={() => shift(1)} className="zm-icon-btn" style={{
          width: 24, height: 24, padding: 0, border: '1px solid var(--zm-line)', borderRadius: 6,
          background: 'var(--zm-surface)', color: 'var(--zm-fg-2)', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {['S','M','T','W','T','F','S'].map((d, i) => (
          <span key={i} style={{
            fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 9.5,
            letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--zm-fg-4)',
            textAlign: 'center', padding: '4px 0',
          }}>{d}</span>
        ))}
        {cells.map((d, i) => {
          if (!d) return <span key={i} style={{ height: 28 }}/>;
          const startSel = isEnd(d, fromD);
          const endSel   = isEnd(d, toD);
          const within   = inRange(d) && !startSel && !endSel;
          return (
            <button key={i} onClick={() => pick(d)} className="zm-cal-day" data-state={startSel ? 'start' : endSel ? 'end' : within ? 'within' : 'idle'} style={{
              height: 28, padding: 0, border: 'none',
              borderRadius: startSel ? '999px 0 0 999px' : endSel ? '0 999px 999px 0' : within ? 0 : 6,
              background: (startSel || endSel) ? 'var(--zm-accent)' : within ? 'var(--zm-accent-soft)' : 'transparent',
              color: (startSel || endSel) ? '#fff' : within ? 'var(--zm-accent)' : 'var(--zm-fg)',
              fontFamily: 'var(--zm-font-mono)', fontFeatureSettings: "'tnum' 1",
              fontSize: 12, fontWeight: (startSel || endSel) ? 700 : 500,
              cursor: 'pointer',
            }}>{d.getDate()}</button>
          );
        })}
      </div>
    </div>
  );
};

const MoreFilters = ({ value, onChange, onClose }) => {
  // Build last 12 months as pickable chips (advanced.month is a YYYY-MM string).
  const months = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`, label: `${MONTH_NAMES[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}` });
  }

  const setMonth = (k) => {
    if (value.month === k) return onChange({ ...value, month: '' });
    onChange({ ...value, month: k, from: '', to: '', preset: '' });
  };
  const setPreset = (p) => {
    const r = presetRange(p);
    onChange({ ...value, preset: p.id, month: '', ...r });
  };
  const setRange = (r) => onChange({ ...value, ...r, preset: '', month: '' });
  const clear = () => onChange({ month: '', preset: '', from: '', to: '' });

  return (
    <div style={{
      position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 30,
      background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 12,
      boxShadow: 'var(--zm-shadow-pop)',
      width: 560, padding: 16, display: 'flex', flexDirection: 'column', gap: 16,
      animation: 'zm-rise 200ms var(--zm-ease-emp)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div>
          <h4 style={{ margin: 0, fontFamily: 'var(--zm-font-display)', fontWeight: 600, fontSize: 14, color: 'var(--zm-fg)' }}>More filters</h4>
          <p style={{ margin: '2px 0 0', fontFamily: 'var(--zm-font-body)', fontSize: 11.5, color: 'var(--zm-fg-3)' }}>
            Narrow by visit-date month, preset window, or custom range.
          </p>
        </div>
        <button onClick={clear} className="zm-link-btn" style={{
          background: 'transparent', border: 'none', color: 'var(--zm-fg-3)',
          fontFamily: 'var(--zm-font-body)', fontSize: 11.5, fontWeight: 600,
          cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2,
        }}>Clear all</button>
      </div>

      {/* Month chips */}
      <section>
        <span style={{ display: 'block', fontFamily: 'var(--zm-font-body)', fontWeight: 700, fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--zm-fg-3)', marginBottom: 8 }}>By month · visit date</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
          {months.map(m => {
            const on = value.month === m.key;
            return (
              <button key={m.key} onClick={() => setMonth(m.key)} className="zm-pill" style={{
                height: 30, padding: '0 8px', borderRadius: 7,
                border: '1px solid ' + (on ? 'var(--zm-accent)' : 'var(--zm-line)'),
                background: on ? 'var(--zm-accent-soft)' : 'var(--zm-surface)',
                color: on ? 'var(--zm-accent)' : 'var(--zm-fg-2)',
                fontFamily: 'var(--zm-font-mono)', fontSize: 11, fontWeight: on ? 700 : 600,
                cursor: 'pointer',
              }}>{m.label}</button>
            );
          })}
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 16 }}>
        {/* Presets column */}
        <section>
          <span style={{ display: 'block', fontFamily: 'var(--zm-font-body)', fontWeight: 700, fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--zm-fg-3)', marginBottom: 8 }}>Preset window</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {PRESETS.map(p => {
              const on = value.preset === p.id;
              return (
                <button key={p.id} onClick={() => setPreset(p)} style={{
                  textAlign: 'left', height: 30, padding: '0 10px', borderRadius: 7,
                  border: '1px solid ' + (on ? 'var(--zm-accent)' : 'transparent'),
                  background: on ? 'var(--zm-accent-soft)' : 'transparent',
                  color: on ? 'var(--zm-accent)' : 'var(--zm-fg-2)',
                  fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: on ? 600 : 500,
                  cursor: 'pointer',
                }}>{p.label}</button>
              );
            })}
          </div>
        </section>

        {/* Calendar column */}
        <section>
          <span style={{ display: 'block', fontFamily: 'var(--zm-font-body)', fontWeight: 700, fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--zm-fg-3)', marginBottom: 8 }}>Custom range</span>
          <RangeCalendar from={value.from} to={value.to} onChange={setRange}/>
        </section>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 12px', borderRadius: 8, background: 'var(--zm-bg-2)',
      }}>
        <Icon name="calendar" size={13} style={{ color: 'var(--zm-fg-3)' }}/>
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 11.5, color: 'var(--zm-fg-2)' }}>
          {value.month
            ? <>Month: <strong style={{ color: 'var(--zm-fg)' }}>{months.find(m => m.key === value.month)?.label}</strong></>
            : (value.from || value.to)
              ? <>Range: <strong style={{ color: 'var(--zm-fg)' }}>{fmtNice(value.from)}</strong> → <strong style={{ color: 'var(--zm-fg)' }}>{fmtNice(value.to)}</strong></>
              : <>No date filter applied · showing all sites</>
          }
        </span>
        <span style={{ flex: 1 }}/>
        <button onClick={onClose} style={{
          height: 30, padding: '0 14px', borderRadius: 7, border: 'none',
          background: 'var(--zm-accent)', color: '#fff',
          fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        }}>Apply</button>
      </div>
    </div>
  );
};

const PipelineFilter = ({ stage, onStage, counts, advanced, onAdvanced }) => {
  const [open, setOpen] = React.useState(false);
  const adv = advanced || { month: '', preset: '', from: '', to: '' };
  const active = !!(adv.month || adv.preset || adv.from || adv.to);
  const popRef = React.useRef(null);

  // Close on outside click + Escape.
  // The popover and the calendar live inside `popRef`, so we only close when
  // the click target is outside that subtree. Attaching on a deferred tick
  // ensures the opening click doesn't immediately re-close the popover.
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (popRef.current && !popRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDoc, true);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const summary = adv.month
    ? `Month · ${adv.month.slice(5)}/${adv.month.slice(2,4)}`
    : adv.preset
      ? PRESETS.find(p => p.id === adv.preset)?.label
      : (adv.from && adv.to) ? `${adv.from} → ${adv.to}`
      : adv.from ? `from ${adv.from}` : '';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', position: 'relative' }}>
      <FilterChip label="All"        count={counts.all}       active={stage === 'all'}       onClick={() => onStage('all')}/>
      <FilterChip label="Draft"      count={counts.draft}     active={stage === 'draft'}     onClick={() => onStage('draft')}     color={STAGES.draft.color}/>
      <FilterChip label="Shortlist"  count={counts.shortlist} active={stage === 'shortlist'} onClick={() => onStage('shortlist')} color={STAGES.shortlist.color}/>
      <FilterChip label="Staging"    count={counts.staging}   active={stage === 'staging'}   onClick={() => onStage('staging')}   color={STAGES.staging.color}/>
      <span style={{ flex: 1 }}/>

      {active && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 30, padding: '0 10px', borderRadius: 999,
          background: 'var(--zm-accent-soft)', color: 'var(--zm-accent)',
          fontFamily: 'var(--zm-font-mono)', fontSize: 11, fontWeight: 600,
        }}>
          <Icon name="calendar" size={11}/> {summary}
          <button onClick={() => onAdvanced({ month: '', preset: '', from: '', to: '' })} style={{
            background: 'transparent', border: 'none', color: 'inherit', padding: 0,
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', marginLeft: 4, opacity: 0.7,
          }}><Icon name="x" size={11}/></button>
        </span>
      )}

      <div ref={popRef} style={{ position: 'relative' }}>
        <button onClick={() => setOpen(o => !o)} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 30, padding: '0 12px', borderRadius: 999,
          border: '1px solid ' + (active || open ? 'var(--zm-accent)' : 'var(--zm-line)'),
          background: active || open ? 'var(--zm-accent-soft)' : 'var(--zm-surface)',
          color: active || open ? 'var(--zm-accent)' : 'var(--zm-fg-2)',
          fontFamily: 'var(--zm-font-body)', fontSize: 12, fontWeight: 600,
          cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: 1,
        }}>
          <Icon name="filter" size={13}/> More filters
          {active && <span style={{
            background: 'var(--zm-accent)', color: '#fff',
            width: 16, height: 16, borderRadius: 999,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--zm-font-mono)', fontSize: 9.5, fontWeight: 700,
            marginLeft: 2,
          }}>•</span>}
        </button>

        {open && (
          <MoreFilters
            value={adv}
            onChange={(v) => onAdvanced(v)}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    </div>
  );
};

const SiteRow = ({ site, onClick, hovered, onHover }) => {
  const cell = { padding: '12px 8px', fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg)' };
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => onHover?.(site.id)}
      onMouseLeave={() => onHover?.(null)}
      className="zm-row"
      style={{
        display: 'grid', gridTemplateColumns: '32px 1.5fr 0.9fr 0.95fr 0.7fr 0.6fr 1.1fr 24px',
        alignItems: 'center', gap: 8, padding: '0 16px',
        borderBottom: '1px solid var(--zm-line-faint)', cursor: 'pointer',
      }}>
      <span style={{ ...cell, fontFamily: 'var(--zm-font-mono)', color: 'var(--zm-fg-3)', fontSize: 11 }}>{site.code}</span>
      <div style={{ padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 13, color: 'var(--zm-fg)' }}>{site.name}</span>
        <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 10.5, color: 'var(--zm-fg-3)' }}>{site.id}</span>
      </div>
      <span style={cell}>{site.city}</span>
      <span style={{ ...cell, fontFamily: 'var(--zm-font-mono)', fontFeatureSettings: "'tnum' 1", textAlign: 'right' }}>₹{site.opCost.toLocaleString('en-IN')}</span>
      <span style={{ ...cell, fontFamily: 'var(--zm-font-mono)', fontFeatureSettings: "'tnum' 1", textAlign: 'right' }}>{site.carpet}</span>
      <span style={{ ...cell, fontFamily: 'var(--zm-font-mono)', fontFeatureSettings: "'tnum' 1", textAlign: 'right', color: site.days > 14 ? '#B45309' : 'var(--zm-fg)' }}>{String(site.days).padStart(2, '0')}d</span>
      <span style={cell}><StatusPill stage={site.stage}/></span>
      <span style={{ ...cell, color: 'var(--zm-fg-4)' }} className="zm-row-cta"><Icon name="chevron" size={14}/></span>
    </div>
  );
};

const SitesTable = ({ sites, onOpen }) => {
  const [hovered, setHovered] = React.useState(null);
  return (
    <div style={{
      background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 12,
      overflow: 'hidden', boxShadow: 'var(--zm-shadow-1)',
    }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '32px 1.5fr 0.9fr 0.95fr 0.7fr 0.6fr 1.1fr 24px',
        gap: 8, padding: '11px 16px', background: 'var(--zm-surface-2)',
        borderBottom: '1px solid var(--zm-line)',
        fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10.5,
        letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--zm-fg-3)',
      }}>
        <span>#</span>
        <span>Site</span>
        <span>City</span>
        <span style={{ textAlign: 'right' }}>Op cost</span>
        <span style={{ textAlign: 'right' }}>Carpet</span>
        <span style={{ textAlign: 'right' }}>Days</span>
        <span>Stage</span>
        <span/>
      </div>
      {sites.map(site => (
        <SiteRow key={site.id} site={site} onClick={() => onOpen(site)} hovered={hovered === site.id} onHover={setHovered}/>
      ))}
      {sites.length === 0 && (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--zm-fg-3)', fontFamily: 'var(--zm-font-body)', fontSize: 13 }}>
          No sites match this filter. Adjust above or submit a new pipeline.
        </div>
      )}
    </div>
  );
};

Object.assign(window, { MetricCard, MetricStrip, FilterChip, PipelineFilter, SiteRow, SitesTable, CornerTicks });

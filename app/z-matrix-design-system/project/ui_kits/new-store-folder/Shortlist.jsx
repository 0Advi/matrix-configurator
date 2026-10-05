// Shortlist queue.
// - BD exec: sees their own shortlisted sites; can View / Add details / Edit details. Cannot Approve.
// - Supervisor: sees all shortlisted sites. Approve only available once exec has marked "In review"
//               (i.e. completed the 17-field form and hit Send for review).
// Approve opens the LOI-timeline modal, then advances the site to Staging.

const ShortlistCard = ({ item, role, onView, onAddDetails, onApprove }) => {
  const supervisor = role === 'supervisor';
  const reviewable = item.inReview === true;
  const hasDraft   = !!item.details && !reviewable;

  return (
    <div style={{
      background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 12,
      padding: 20, display: 'flex', flexDirection: 'column', gap: 14,
      boxShadow: 'var(--zm-shadow-1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div style={{
          width: 64, height: 64, borderRadius: 10, flex: '0 0 64px',
          background: `linear-gradient(135deg, hsl(${item.hue} 30% 80%), hsl(${item.hue+30} 30% 60%))`,
        }}/>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 11, color: 'var(--zm-fg-3)' }}>{item.code}</span>
            {reviewable
              ? <StatusPill stage="inReview"/>
              : <StatusPill stage="shortlist"/>
            }
          </span>
          <h3 style={{ margin: 0, fontFamily: 'var(--zm-font-display)', fontWeight: 600, fontSize: 17, color: 'var(--zm-fg)' }}>{item.name}</h3>
          <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg-3)' }}>
            {item.city} · visit {item.visitDate} · created by {item.createdBy}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          <span style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--zm-fg-3)' }}>Score</span>
          <span style={{ fontFamily: 'var(--zm-font-mono)', fontWeight: 600, fontSize: 22, color: item.score >= 75 ? '#047857' : 'var(--zm-fg)' }}>{item.score || '—'}</span>
        </div>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0,
        padding: '10px 0', borderTop: '1px solid var(--zm-line-faint)', borderBottom: '1px solid var(--zm-line-faint)',
      }}>
        {[
          ['Est. sales',  item.estSales ? `₹${item.estSales}L` : '—'],
          ['Carpet',      item.carpet ? `${item.carpet} sqft` : '—'],
          ['Total op',    item.totalOpCost ? `₹${Math.round(item.totalOpCost/1000)}k/mo` : '—'],
          ['Rent type',   item.rentType === 'fixed' ? 'Fixed + esc.' : item.rentType === 'revshare' ? 'Rev share' : '—'],
        ].map(([k, v]) => (
          <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--zm-fg-3)' }}>{k}</span>
            <span style={{ fontFamily: 'var(--zm-font-mono)', fontFeatureSettings: "'tnum' 1", fontSize: 14, fontWeight: 600, color: 'var(--zm-fg)' }}>{v}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => onView(item)} title="View" className="zm-icon-btn" style={{
          width: 34, height: 34, border: '1px solid var(--zm-line)', borderRadius: 7,
          background: 'var(--zm-surface)', color: 'var(--zm-fg-2)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}><EyeIcon size={16}/></button>

        {/* Only the original BD exec can fill the form */}
        {!supervisor && (
          <button onClick={() => onAddDetails(item)} className="zm-btn" style={{
            height: 34, padding: '0 14px', borderRadius: 7,
            border: '1px solid ' + (hasDraft ? 'var(--zm-accent-line)' : 'var(--zm-line)'),
            background: hasDraft ? 'var(--zm-accent-soft)' : 'var(--zm-surface)',
            color: hasDraft ? 'var(--zm-accent)' : 'var(--zm-fg)',
            fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            <Icon name={hasDraft ? 'folder' : 'plus'} size={13}/>
            {reviewable ? 'Edit details' : hasDraft ? 'Continue draft' : 'Add details'}
          </button>
        )}
        {hasDraft && !supervisor && (
          <span style={{
            padding: '4px 8px', borderRadius: 999,
            background: 'var(--zm-surface-2)', border: '1px solid var(--zm-line)',
            fontFamily: 'var(--zm-font-mono)', fontSize: 10.5, color: 'var(--zm-fg-3)', fontWeight: 600,
            letterSpacing: '0.08em', textTransform: 'uppercase',
          }}>Draft saved</span>
        )}

        <span style={{ flex: 1 }}/>

        {supervisor ? (
          <button
            onClick={() => onApprove(item)}
            disabled={!reviewable}
            className="zm-btn-primary"
            title={!reviewable ? 'BD exec must Send for review before approving' : 'Approve and advance to staging'}
            style={{
              height: 34, padding: '0 14px', border: 'none', borderRadius: 7,
              background: reviewable ? 'var(--zm-accent)' : 'var(--zm-surface-sunken)',
              color: reviewable ? '#fff' : 'var(--zm-fg-4)',
              fontFamily: 'var(--zm-font-body)', fontSize: 12.5, fontWeight: 700,
              cursor: reviewable ? 'pointer' : 'not-allowed',
              boxShadow: reviewable ? 'var(--zm-shadow-1)' : 'none',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              whiteSpace: 'nowrap', lineHeight: 1,
            }}><Icon name="check" size={13}/> Approve shortlist</button>
        ) : reviewable ? (
          <span style={{
            padding: '6px 10px', borderRadius: 7,
            background: 'var(--zm-accent-soft)', border: '1px solid var(--zm-accent-line)',
            fontFamily: 'var(--zm-font-body)', fontSize: 11.5, color: 'var(--zm-accent)', fontWeight: 600,
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}><Icon name="clock" size={12}/> Awaiting supervisor approval</span>
        ) : (
          <span style={{
            padding: '6px 10px', borderRadius: 7,
            background: 'var(--zm-surface-2)', border: '1px solid var(--zm-line)',
            fontFamily: 'var(--zm-font-body)', fontSize: 11.5, color: 'var(--zm-fg-3)',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}><Icon name="alert" size={12}/> Add 17 fields then Send for review</span>
        )}
      </div>
    </div>
  );
};

const ShortlistQueue = ({ items, role, onView, onAddDetails, onApprove }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 920 }}>
    <PageHeader
      file="№ 03"
      eyebrow="Workflow · Shortlist"
      title={<>Shortlist <em>queue</em></>}
      lede={role === 'supervisor'
        ? `${items.length} site${items.length === 1 ? '' : 's'} cleared from pipeline — approve once the exec marks them as in review.`
        : `${items.length} of your own shortlisted site${items.length === 1 ? '' : 's'} — add the 17 essential fields, then send for review.`
      }
      right={<HeaderTag icon="clock" label="OLDEST FIRST"/>}
    />
    {items.map(item => (
      <ShortlistCard key={item.code} item={item} role={role}
        onView={onView} onAddDetails={onAddDetails} onApprove={onApprove}/>
    ))}
    {items.length === 0 && (
      <div style={{
        padding: 48, textAlign: 'center', background: 'var(--zm-surface)',
        border: '1px dashed var(--zm-line)', borderRadius: 12,
      }}>
        <span style={{ display: 'inline-flex', color: 'var(--zm-fg-3)', marginBottom: 12 }}><Icon name="check" size={32}/></span>
        <p style={{ margin: 0, fontFamily: 'var(--zm-font-body)', fontSize: 14, color: 'var(--zm-fg-2)' }}>Queue empty.</p>
      </div>
    )}
  </div>
);

// Modal that pops after Approve shortlist — supervisor sets expected LOI timeline.
const LOITimelineModal = ({ site, onCancel, onSubmit }) => {
  const [days, setDays] = React.useState(14);
  if (!site) return null;
  const presets = [7, 14, 21, 30];
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(11,12,16,0.46)', backdropFilter: 'blur(6px)',
      zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'zm-fade 200ms var(--zm-ease)',
    }}>
      <div style={{
        background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 14,
        width: 480, padding: 28, boxShadow: 'var(--zm-shadow-pop)',
        display: 'flex', flexDirection: 'column', gap: 16,
        animation: 'zm-rise 240ms var(--zm-ease-emp)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <span style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--zm-accent)' }}>
              Approving · {site.code}
            </span>
            <h2 style={{ margin: '4px 0 6px', fontFamily: 'var(--zm-font-display)', fontWeight: 700, fontSize: 20, letterSpacing: '-0.02em', color: 'var(--zm-fg)' }}>
              Expected LOI timeline
            </h2>
            <p style={{ margin: 0, fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg-3)' }}>
              By when should the BD exec have the signed LOI uploaded? Sites that miss this date highlight in staging.
            </p>
          </div>
          <button onClick={onCancel} className="zm-icon-btn" style={{
            background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 8,
            width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--zm-fg-2)', cursor: 'pointer', flex: '0 0 30px',
          }}><Icon name="x" size={14}/></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 12, color: 'var(--zm-fg)' }}>
            Days from today
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="number" min="1" max="120" value={days}
              onChange={(e) => setDays(Math.max(1, Math.min(120, Number(e.target.value) || 0)))}
              style={{
                width: 110, height: 56, padding: '0 14px',
                background: 'var(--zm-bg)', border: '1px solid var(--zm-line)', borderRadius: 8,
                fontFamily: 'var(--zm-font-mono)', fontSize: 28, fontWeight: 600, color: 'var(--zm-fg)',
                outline: 'none', textAlign: 'center',
              }}
            />
            <span style={{ fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg-2)' }}>
              days · target date{' '}
              <strong style={{ color: 'var(--zm-fg)', fontFamily: 'var(--zm-font-mono)' }}>
                {new Date(Date.now() + days * 86400000).toISOString().slice(0,10)}
              </strong>
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            {presets.map(p => (
              <button key={p} onClick={() => setDays(p)} className="zm-pill" style={{
                height: 28, padding: '0 12px', borderRadius: 999,
                border: '1px solid ' + (days === p ? 'var(--zm-accent)' : 'var(--zm-line)'),
                background: days === p ? 'var(--zm-accent-soft)' : 'var(--zm-surface)',
                color: days === p ? 'var(--zm-accent)' : 'var(--zm-fg-2)',
                fontFamily: 'var(--zm-font-body)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}>{p}d</button>
            ))}
          </div>
        </div>

        <div style={{
          padding: 12, background: 'var(--zm-accent-soft)', borderRadius: 8,
          fontFamily: 'var(--zm-font-body)', fontSize: 12, color: 'var(--zm-fg-2)',
          display: 'flex', alignItems: 'flex-start', gap: 8,
        }}>
          <span style={{ color: 'var(--zm-accent)', display: 'inline-flex', marginTop: 1 }}><Icon name="alert" size={14}/></span>
          On approval, this site moves to Staging. The BD exec is notified and the timer starts.
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} className="zm-btn" style={{
            height: 36, padding: '0 16px', borderRadius: 8, border: '1px solid var(--zm-line)',
            background: 'var(--zm-surface)', color: 'var(--zm-fg)',
            fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={() => onSubmit(site, days)} className="zm-btn-primary" style={{
            height: 36, padding: '0 16px', borderRadius: 8, border: 'none',
            background: 'var(--zm-accent)', color: '#fff',
            fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: 700, cursor: 'pointer',
            boxShadow: 'var(--zm-shadow-1)',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}><Icon name="check" size={13}/> Approve & set timeline</button>
        </div>
      </div>
    </div>
  );
};

const NewPipelineModal = ({ onClose, onSubmit }) => {
  const [form, setForm] = React.useState({ name: '', visitDate: '', city: '' });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const ready = form.name && form.visitDate && form.city;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(11,12,16,0.46)', backdropFilter: 'blur(6px)',
      zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'zm-fade 200ms var(--zm-ease)',
    }}>
      <div style={{
        background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 14,
        width: 480, padding: 28, boxShadow: 'var(--zm-shadow-pop)',
        display: 'flex', flexDirection: 'column', gap: 18,
        animation: 'zm-rise 240ms var(--zm-ease-emp)',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <span style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--zm-accent)' }}>Pipeline · step 1 of 1</span>
            <h2 style={{ margin: '4px 0 6px', fontFamily: 'var(--zm-font-display)', fontWeight: 700, fontSize: 22, letterSpacing: '-0.02em', color: 'var(--zm-fg)' }}>New pipeline draft</h2>
            <p style={{ margin: 0, fontFamily: 'var(--zm-font-body)', fontSize: 13, color: 'var(--zm-fg-3)' }}>
              Three fields to start. Add the 17-field site detail after supervisor shortlist.
            </p>
          </div>
          <button onClick={onClose} className="zm-icon-btn" style={{
            background: 'var(--zm-surface)', border: '1px solid var(--zm-line)', borderRadius: 8,
            width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--zm-fg-2)', cursor: 'pointer', flex: '0 0 30px',
          }}><Icon name="x" size={14}/></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 12, color: 'var(--zm-fg)' }}>Site / pipeline name</label>
            <input value={form.name} onChange={set('name')} placeholder="e.g. Powai · Lake Homes" style={{
              height: 40, padding: '0 12px', border: '1px solid var(--zm-line)', borderRadius: 6,
              background: 'var(--zm-bg)', fontFamily: 'var(--zm-font-body)', fontSize: 14, color: 'var(--zm-fg)', outline: 'none',
            }}/>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 12, color: 'var(--zm-fg)' }}>Visit date</label>
              <input type="date" value={form.visitDate} onChange={set('visitDate')} style={{
                height: 40, padding: '0 12px', border: '1px solid var(--zm-line)', borderRadius: 6,
                background: 'var(--zm-bg)', fontFamily: 'var(--zm-font-mono)', fontSize: 13, color: 'var(--zm-fg)', outline: 'none',
              }}/>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontFamily: 'var(--zm-font-body)', fontWeight: 600, fontSize: 12, color: 'var(--zm-fg)' }}>City</label>
              <select value={form.city} onChange={set('city')} style={{
                height: 40, padding: '0 12px', border: '1px solid var(--zm-line)', borderRadius: 6,
                background: 'var(--zm-bg)', fontFamily: 'var(--zm-font-body)', fontSize: 14, color: 'var(--zm-fg)', outline: 'none',
              }}>
                <option value="">Select city…</option>
                <option>Mumbai</option><option>Bengaluru</option><option>New Delhi</option>
                <option>Hyderabad</option><option>Pune</option><option>Chennai</option><option>Ahmedabad</option>
              </select>
            </div>
          </div>
        </div>

        <div style={{
          padding: 12, background: 'var(--zm-accent-soft)', borderRadius: 8,
          fontFamily: 'var(--zm-font-body)', fontSize: 12, color: 'var(--zm-fg-2)',
          display: 'flex', alignItems: 'flex-start', gap: 8,
        }}>
          <span style={{ color: 'var(--zm-accent)', display: 'inline-flex', marginTop: 1 }}><Icon name="alert" size={14}/></span>
          Once submitted, your supervisor reviews the shortlist (Yes / No). You can edit the draft until then.
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="zm-btn" style={{
            height: 36, padding: '0 16px', borderRadius: 8, border: '1px solid var(--zm-line)',
            background: 'var(--zm-surface)', color: 'var(--zm-fg)',
            fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Cancel</button>
          <button disabled={!ready} onClick={() => onSubmit(form)} className="zm-btn-primary" style={{
            height: 36, padding: '0 16px', borderRadius: 8, border: 'none',
            background: ready ? 'var(--zm-accent)' : 'var(--zm-surface-sunken)',
            color: ready ? '#fff' : 'var(--zm-fg-4)',
            fontFamily: 'var(--zm-font-body)', fontSize: 13, fontWeight: 600,
            cursor: ready ? 'pointer' : 'not-allowed', boxShadow: ready ? 'var(--zm-shadow-1)' : 'none',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>Submit for shortlist <Icon name="arrow" size={14}/></button>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { ShortlistCard, ShortlistQueue, LOITimelineModal, NewPipelineModal });

// /m/:moduleKey/views — business admin: the module's saved views (G3 #4; docs/G3-API.md §3).
//
// Lists every view of the module (GET /m/{key}/views?manage=true), with its audience (who sees it
// in their switcher — not who may see the data: the server always applies the caller's scope
// first), filter, columns, position and default flag. Create / edit / delete, and "Reset to
// defaults" (drops this module's views and re-seeds My cases / Awaiting my approval / Team queue /
// Admin sign-off / All cases / Closed). The backend refuses everyone but a business admin.
import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import PageHeader from '../shared/page-header/PageHeader.jsx';
import { createView, deleteView, listViews, problemOf, resetViews, updateView } from '../../services/api/moduleRuntimeApi.js';
import { AUDIENCE, CASE_STATUSES, COLUMNS, DEFAULT_COLUMNS, FLAGS, TIERS, describeFilter, filterFromForm, formFromFilter } from './viewsKit.js';
import { Button, Card, Empty, Notice, SectionTitle, Tone } from './kit.jsx';

const input = { height: 34, padding: '0 10px', borderRadius: 8, border: '1px solid var(--zm-line-strong)', background: 'var(--zm-surface)',
  color: 'var(--zm-fg)', fontSize: 13, fontFamily: 'var(--zm-font-body)', boxSizing: 'border-box' };
const lab = { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 650, color: 'var(--zm-fg-2)' };

const blank = () => ({ name: '', audience: ['executive', 'supervisor'], columns: [...DEFAULT_COLUMNS], position: 100,
  is_default: false, all_modules: false, ...formFromFilter({}) });

export default function ManageViewsPage() {
  const { moduleKey } = useParams();
  const navigate = useNavigate();
  const [st, setSt] = React.useState({ status: 'loading', data: null, problem: null });
  const [editing, setEditing] = React.useState(null);   // {id|null, form}
  const [busy, setBusy] = React.useState(null);
  const [msg, setMsg] = React.useState(null);
  const [confirmReset, setConfirmReset] = React.useState(false);

  const load = React.useCallback(async () => {
    try { setSt({ status: 'ready', data: await listViews(moduleKey, { manage: true }), problem: null }); }
    catch (e) { setSt({ status: 'error', data: null, problem: problemOf(e) }); }
  }, [moduleKey]);
  React.useEffect(() => { load(); }, [load]);

  const label = st.data?.module?.label || moduleKey;
  const views = st.data?.items || [];
  const back = () => navigate(`/m/${encodeURIComponent(moduleKey)}`);

  const save = async () => {
    const f = editing.form;
    const body = { name: f.name.trim(), filter: filterFromForm(f), columns: f.columns, audience: f.audience,
      position: Number(f.position) || 0, is_default: Boolean(f.is_default) };
    setBusy('save'); setMsg(null);
    try {
      if (editing.id) await updateView(moduleKey, editing.id, body);
      else await createView(moduleKey, { ...body, all_modules: Boolean(f.all_modules) });
      setMsg({ tone: 'success', text: `Saved “${body.name}”.` });
      setEditing(null);
      await load();
    } catch (e) { setMsg({ tone: 'danger', text: problemOf(e).detail }); }
    finally { setBusy(null); }
  };
  const remove = async (v) => {
    setBusy(v.id); setMsg(null);
    try { await deleteView(moduleKey, v.id); setMsg({ tone: 'success', text: `Removed “${v.name}”.` }); await load(); }
    catch (e) { setMsg({ tone: 'danger', text: problemOf(e).detail }); }
    finally { setBusy(null); }
  };
  const reset = async () => {
    setBusy('reset'); setMsg(null);
    try {
      const d = await resetViews(moduleKey);
      setSt({ status: 'ready', data: d, problem: null });
      setMsg({ tone: 'success', text: `Default views restored (${d?.reset?.seeded ?? 0} views).` });
      setConfirmReset(false); setEditing(null);
    } catch (e) { setMsg({ tone: 'danger', text: problemOf(e).detail }); }
    finally { setBusy(null); }
  };

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <PageHeader title={`Views · ${label}`}
        lede="Saved list views for this module. The audience decides who sees a view in their switcher; what they see inside it is always limited by their own access."
        right={<span style={{ display: 'inline-flex', gap: 8 }}>
          <Button icon="arrow" onClick={back}>Back to {label}</Button>
          {st.status === 'ready' && <Button variant="primary" icon="plus" onClick={() => setEditing({ id: null, form: blank() })}>New view</Button>}
        </span>}/>
      {st.status === 'loading' && <div style={{ color: 'var(--zm-fg-3)' }}>Loading views…</div>}
      {st.status === 'error' && (
        <Notice tone="danger" title={st.problem?.status === 403 ? 'Only a business admin can manage views' : 'Couldn’t load the views'}>{st.problem?.detail}</Notice>
      )}
      {st.status === 'ready' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          {editing && <ViewEditor editing={editing} setEditing={setEditing} busy={busy === 'save'} onSave={save}/>}
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {views.length === 0 && <div style={{ padding: 18 }}><Empty title="No views">Reset to defaults to get the standard set back.</Empty></div>}
            {views.length > 0 && (
              <div role="table" aria-label="Saved views">
                <div role="row" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.2fr 1.8fr 60px 170px', gap: 12, padding: '10px 18px', background: 'var(--zm-surface-2)',
                  fontSize: 10.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--zm-fg-3)' }}>
                  <span>View</span><span>Audience</span><span>Shows</span><span>Order</span><span/>
                </div>
                {views.map((v) => (
                  <div key={v.id} role="row" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.2fr 1.8fr 60px 170px', gap: 12, padding: '11px 18px', borderTop: '1px solid var(--zm-line)', alignItems: 'center', fontSize: 13 }}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 700 }}>{v.name}</span>
                      <span style={{ display: 'inline-flex', gap: 4, marginLeft: 6 }}>
                        {v.is_default && <Tone tone="success">default</Tone>}
                        {v.all_modules && <Tone tone="info">all modules</Tone>}
                        {v.seed_key && <Tone>standard</Tone>}
                      </span>
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--zm-fg-2)' }}>{v.audience.map((a) => AUDIENCE.find((x) => x.key === a)?.label || a).join(', ')}</span>
                    <span style={{ fontSize: 12, color: 'var(--zm-fg-2)' }}>
                      {describeFilter(v.filter)}
                      <div style={{ color: 'var(--zm-fg-3)', fontSize: 11.5 }}>columns: {(v.columns || []).map((c) => COLUMNS.find((x) => x.key === c)?.label || c).join(', ') || '—'}</div>
                    </span>
                    <span style={{ fontFamily: 'var(--zm-font-mono)', fontSize: 12 }}>{v.position}</span>
                    <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                      <Button onClick={() => setEditing({ id: v.id, form: { name: v.name, audience: v.audience, columns: v.columns || [], position: v.position,
                        is_default: v.is_default, all_modules: v.all_modules, ...formFromFilter(v.filter) } })}>Edit</Button>
                      <Button variant="danger" busy={busy === v.id} onClick={() => remove(v)} aria-label={`Remove ${v.name}`}>Remove</Button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card>
            <SectionTitle>Defaults</SectionTitle>
            <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--zm-fg-2)' }}>
              Restores the standard views for {label} — Awaiting my approval, My cases, Team queue, Admin sign-off, All cases and Closed — and removes views made only for this module. Views shared by every module stay.
            </p>
            {!confirmReset && <Button onClick={() => setConfirmReset(true)}>Reset to defaults</Button>}
            {confirmReset && (
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 13 }}>Replace this module’s views with the defaults?</span>
                <Button variant="primary" busy={busy === 'reset'} onClick={reset}>Yes, reset</Button>
                <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
              </span>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function ViewEditor({ editing, setEditing, busy, onSave }) {
  const f = editing.form;
  const set = (patch) => setEditing({ ...editing, form: { ...f, ...patch } });
  const toggle = (key, value) => set({ [key]: f[key].includes(value) ? f[key].filter((x) => x !== value) : [...f[key], value] });
  const valid = f.name.trim().length > 0 && f.audience.length > 0;
  return (
    <Card aria-label={editing.id ? 'Edit view' : 'New view'} style={{ borderColor: 'var(--zm-accent-line)' }}>
      <SectionTitle>{editing.id ? 'Edit view' : 'New view'}</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
        <label style={lab}>Name<input aria-label="View name" style={input} value={f.name} maxLength={80} onChange={(e) => set({ name: e.target.value })}/></label>
        <label style={lab}>Order<input aria-label="Order" type="number" min={0} max={10000} style={input} value={f.position} onChange={(e) => set({ position: e.target.value })}/></label>
        <label style={lab}>Next step on
          <select aria-label="Next step on" style={input} value={f.awaiting} onChange={(e) => set({ awaiting: e.target.value })}>
            <option value="">any tier</option>
            {TIERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label style={lab}>Next step kind
          <select aria-label="Next step kind" style={input} value={f.kind} onChange={(e) => set({ kind: e.target.value })}>
            <option value="">any</option><option value="submit">to submit</option><option value="approve">awaiting approval</option>
          </select>
        </label>
        {FLAGS.map((flag) => (
          <label key={flag.key} style={lab}>{flag.label}
            <select aria-label={flag.label} style={input} value={f[flag.key]} onChange={(e) => set({ [flag.key]: e.target.value })}>
              <option value="">any</option><option value="yes">yes</option><option value="no">no</option>
            </select>
          </label>
        ))}
        <label style={lab}>Stages (orders)<input aria-label="Stages" style={input} placeholder="e.g. 1, 2" value={f.stage} onChange={(e) => set({ stage: e.target.value })}/></label>
        <label style={lab}>Sites (ids)<input aria-label="Sites" style={input} placeholder="optional" value={f.site_ids} onChange={(e) => set({ site_ids: e.target.value })}/></label>
      </div>
      <fieldset style={{ border: 'none', padding: 0, margin: '14px 0 0' }}>
        <legend style={{ ...lab, marginBottom: 6 }}>Case status</legend>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
          {CASE_STATUSES.map((s) => <label key={s}><input type="checkbox" checked={f.status.includes(s)} onChange={() => toggle('status', s)}/> {s.replace('_', ' ')}</label>)}
        </div>
      </fieldset>
      <fieldset style={{ border: 'none', padding: 0, margin: '14px 0 0' }}>
        <legend style={{ ...lab, marginBottom: 6 }}>Shown to (audience)</legend>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
          {AUDIENCE.map((a) => <label key={a.key}><input type="checkbox" checked={f.audience.includes(a.key)} onChange={() => toggle('audience', a.key)}/> {a.label}</label>)}
        </div>
      </fieldset>
      <fieldset style={{ border: 'none', padding: 0, margin: '14px 0 0' }}>
        <legend style={{ ...lab, marginBottom: 6 }}>Columns</legend>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13 }}>
          {COLUMNS.map((c) => <label key={c.key}><input type="checkbox" checked={f.columns.includes(c.key)} onChange={() => toggle('columns', c.key)}/> {c.label}</label>)}
        </div>
      </fieldset>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, marginTop: 14 }}>
        <label><input type="checkbox" checked={Boolean(f.is_default)} onChange={(e) => set({ is_default: e.target.checked })}/> Opens first for its audience (default)</label>
        {!editing.id && <label><input type="checkbox" checked={Boolean(f.all_modules)} onChange={(e) => set({ all_modules: e.target.checked })}/> Every custom module of the workspace</label>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--zm-fg-3)', margin: '12px 0' }}>Shows: {describeFilter(filterFromForm(f))}</div>
      <span style={{ display: 'inline-flex', gap: 8 }}>
        <Button variant="primary" busy={busy} disabled={!valid} onClick={onSave}>Save view</Button>
        <Button onClick={() => setEditing(null)}>Cancel</Button>
      </span>
    </Card>
  );
}

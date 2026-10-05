// /m/:moduleKey/records/:recordId — one case of a configurator-defined module (F4b).
//
// Everything on this page comes from GET /m/{key}/records/{id} (docs/F4-API.md §3.4):
//   - the release the case is pinned to (and the live one),
//   - the stages of THAT release with their tier chains and states,
//   - next_step: whose turn it is, and for a submit step the stage form as JSON Schema +
//     uiSchema, rendered with react-jsonschema-form,
//   - allowed_actions: what THIS user may do now (buttons), sent with expected_seq,
//   - approvals + audit (with provenance: release version, actor role, override flag).
// Backend refusals are shown as they come: 422 invalid_form → rjsf extraErrors, 409 stale →
// "someone acted first" with a refresh, 403 wrong_tier / no_delegation / separation_of_duties
// → their message.
import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import PageHeader, { HeaderTag } from '../shared/page-header/PageHeader.jsx';
import Icon from '../shared/primitives/Icon.jsx';
import { useSession } from '../../state/SessionContext.jsx';
import { useWorkspaceModules } from '../../state/useWorkspaceModules.js';
import { customModuleRoute } from '../shared/workspaceModules.js';
import {
  getRecord, actOnRecord, assignRecord, listMembers, problemOf, toExtraErrors,
} from '../../services/api/moduleRuntimeApi.js';
import { Card, SectionTitle, CaseStatus, StageState, Button, Notice, when, tierLabel } from './kit.jsx';
import { MembersContext, WIDGETS } from './widgets.jsx';
import GateLocked from './GateLocked.jsx';
import './generic-module.css';

const CONFLICT_CODES = new Set(['stale', 'wrong_action', 'closed', 'release_mismatch']);

// rjsf/ajv messages are written for developers ("must match pattern \"^[0-9]{2}…\""); say what
// the user needs instead. The backend re-validates every submission regardless.
export function transformErrors(errors) {
  return (errors || []).map((e) => {
    if (e.name === 'pattern') return { ...e, message: 'Doesn’t match the expected format.' };
    if (e.name === 'required') return { ...e, message: 'Required.' };
    if (e.name === 'minimum') return { ...e, message: `Must be at least ${e.params?.limit}.` };
    if (e.name === 'maximum') return { ...e, message: `Must be at most ${e.params?.limit}.` };
    return e;
  });
}

function stripTitle(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const { title: _title, ...rest } = schema;
  return rest;
}

export default function GenericRecordPage() {
  const { moduleKey, recordId } = useParams();
  const navigate = useNavigate();
  const { isReadOnly } = useSession();
  const ws = useWorkspaceModules();
  const [detail, setDetail] = React.useState(null);
  const [loadProblem, setLoadProblem] = React.useState(null);
  const [members, setMembers] = React.useState({ status: 'idle', members: [] });
  const [formData, setFormData] = React.useState({});
  const [extraErrors, setExtraErrors] = React.useState({});
  const [busy, setBusy] = React.useState(null);
  const [problem, setProblem] = React.useState(null);
  const [conflict, setConflict] = React.useState(null);
  const [flash, setFlash] = React.useState(null);
  const [dialog, setDialog] = React.useState(null); // 'send_back' | 'reject'

  const load = React.useCallback(async () => {
    try {
      const d = await getRecord(moduleKey, recordId);
      setDetail(d);
      setLoadProblem(null);
      return d;
    } catch (e) {
      setLoadProblem(problemOf(e));
      return null;
    }
  }, [moduleKey, recordId]);
  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => {
    let alive = true;
    setMembers({ status: 'loading', members: [] });
    listMembers(moduleKey)
      .then((d) => alive && setMembers({ status: 'ready', members: d?.items || [] }))
      .catch(() => alive && setMembers({ status: 'error', members: [] }));
    return () => { alive = false; };
  }, [moduleKey]);

  // A new step means a new (empty) form.
  const stepKey = detail ? `${detail.record?.seq}-${detail.next_step?.stage}-${detail.next_step?.kind}` : '';
  React.useEffect(() => { setFormData({}); setExtraErrors({}); }, [stepKey]);

  const refresh = async () => { setConflict(null); setProblem(null); await load(); };

  const act = async (action, extra = {}) => {
    if (!detail) return;
    setBusy(action); setProblem(null); setFlash(null);
    try {
      const d = await actOnRecord(moduleKey, recordId, { action, expected_seq: detail.record.seq, ...extra });
      setDetail(d);
      setDialog(null);
      setFlash({ submit: 'Stage submitted.', approve: 'Approved.', send_back: 'Sent back.', reject: 'Rejected.' }[action] || 'Done.');
    } catch (e) {
      const p = problemOf(e);
      if (p.code === 'invalid_form') {
        setExtraErrors(toExtraErrors(p.errors, detail.next_step?.form?.schema));
        setProblem({ ...p, detail: 'Some fields need attention — see the messages under them.' });
      } else if (p.status === 409 && CONFLICT_CODES.has(p.code)) {
        setConflict(p);
      } else {
        setProblem(p);
      }
    } finally {
      setBusy(null);
    }
  };

  const assign = async (executiveId) => {
    setBusy('assign'); setProblem(null); setFlash(null);
    try {
      const d = await assignRecord(moduleKey, recordId, executiveId);
      setDetail(d);
      setFlash('Assigned. The executive can now act on this case.');
    } catch (e) { setProblem(problemOf(e)); }
    finally { setBusy(null); }
  };

  const moduleLabel = detail?.module?.label || ws.get(moduleKey)?.label || moduleKey;
  const back = () => navigate(customModuleRoute(moduleKey));

  if (loadProblem && !detail) {
    return (
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <PageHeader title={moduleLabel} onBack={back}/>
        <Notice tone="danger" title={loadProblem.status === 404 ? 'Case not found' : 'Couldn’t load this case'}
          action={<Button icon="refresh" onClick={refresh}>Retry</Button>}>
          {loadProblem.detail}
          {loadProblem.status === 404 && <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--zm-fg-3)' }}>Executives see a case once it is assigned to them.</div>}
        </Notice>
      </div>
    );
  }
  if (!detail) return <div style={{ padding: '4rem', textAlign: 'center', opacity: 0.6 }}>Loading case…</div>;

  const { record, release, module: mod, stages = [], next_step: next, me, allowed_actions: allowed = [], approvals = [], audit = [] } = detail;
  const can = (a) => !isReadOnly && allowed.includes(a);
  const memberName = (id) => members.members.find((m) => m.id === id)?.name || members.members.find((m) => m.id === id)?.email || null;
  const executives = members.members.filter((m) => m.role_in_module === 'executive');
  const canAssign = !isReadOnly && !!mod?.tiers?.delegation && (me?.role === 'supervisor' || me?.role === 'business_admin')
    && !['completed', 'rejected'].includes(record.case_status);
  const outdated = release?.live_version != null && release.live_version !== release.version;
  const sourceLabels = Object.fromEntries((ws.modules || []).map((m) => [m.key, m.label]));

  return (
    <MembersContext.Provider value={members}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <PageHeader
          onBack={back}
          title={record.site?.name || 'Case'}
          lede={<>{moduleLabel} · {[record.site?.code, record.site?.city].filter(Boolean).join(' · ')}</>}
          right={(
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <CaseStatus status={record.case_status}/>
              <HeaderTag icon="layers" tone="accent" label={`Release v${release?.version} · pinned`}/>
              {outdated && <HeaderTag icon="clock" label={`Live is v${release.live_version}`}/>}
              <Button icon="refresh" onClick={refresh}>Refresh</Button>
            </span>
          )}
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.55fr) minmax(300px, 1fr)', gap: 18, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
            {conflict && (
              <Notice tone="copper" title="This case changed since you opened it"
                action={<Button variant="primary" icon="refresh" onClick={refresh}>Refresh</Button>}>
                {conflict.detail || 'Someone else acted on it first.'} Refresh to see the latest state before acting again.
              </Notice>
            )}
            {problem && <Notice tone="danger" title={problemTitle(problem)}>{problem.detail}</Notice>}
            {flash && !problem && !conflict && <Notice tone="success">{flash}</Notice>}

            <NextStep next={next} record={record} me={me} allowed={allowed} isReadOnly={isReadOnly} mod={mod} approvals={approvals}>
              {next?.kind === 'submit' && next.form && can('submit') && (
                <div className="gm-form" data-testid="stage-form">
                  <Form
                    schema={stripTitle(next.form.schema)}
                    uiSchema={next.form.uiSchema || {}}
                    validator={validator}
                    widgets={WIDGETS}
                    formData={formData}
                    onChange={({ formData: fd }) => setFormData(fd)}
                    onSubmit={({ formData: fd }) => act('submit', { values: fd || {} })}
                    extraErrors={extraErrors}
                    transformErrors={transformErrors}
                    showErrorList={false}
                    noHtml5Validate
                    disabled={!!busy}
                  >
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                      <Button variant="primary" type="submit" busy={busy === 'submit'} icon="check">Submit stage {next.stage}</Button>
                      {can('send_back') && <Button onClick={() => setDialog('send_back')}>Send back…</Button>}
                      {can('reject') && <Button variant="danger" onClick={() => setDialog('reject')}>Reject…</Button>}
                    </div>
                  </Form>
                </div>
              )}
              {next?.kind === 'submit' && !next.form && can('submit') && (
                <Button variant="primary" busy={busy === 'submit'} icon="check" onClick={() => act('submit', { values: {} })}>Submit stage {next.stage}</Button>
              )}
              {next?.kind === 'approve' && (can('approve') || can('send_back') || can('reject')) && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {can('approve') && <Button variant="primary" busy={busy === 'approve'} icon="check" onClick={() => act('approve')}>Approve stage {next.stage}</Button>}
                  {can('send_back') && <Button onClick={() => setDialog('send_back')}>Send back…</Button>}
                  {can('reject') && <Button variant="danger" onClick={() => setDialog('reject')}>Reject…</Button>}
                </div>
              )}
              {dialog && <ReasonForm kind={dialog} stages={stages} currentStage={next?.stage} busy={busy === dialog}
                onCancel={() => setDialog(null)}
                onSubmit={({ reason, toStage }) => act(dialog, dialog === 'send_back'
                  ? { reason, ...(toStage ? { to_stage: toStage } : {}) }
                  : { reason })}/>}
            </NextStep>

            <Card>
              <SectionTitle>Stages · release v{release?.version}</SectionTitle>
              <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {stages.map((s) => <StageRow key={s.order} s={s} current={next?.stage === s.order} memberName={memberName}/>)}
              </ol>
            </Card>

            {next === null && detail.gate && detail.gate.open === false && record.case_status !== 'completed' && (
              <GateLocked moduleLabel={moduleLabel} site={record.site} gate={{ ...detail.gate, sourceLabels }}/>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
            <Card>
              <SectionTitle>Case</SectionTitle>
              <Facts rows={[
                ['Opened', when(record.opened_at)],
                ['Assigned to', record.assigned_to ? (memberName(record.assigned_to) || 'an executive') : 'nobody yet'],
                ['Your role here', tierLabel(me?.role)],
                ['Outcome', record.exit_outcome || (record.case_status === 'completed' ? 'done' : '—')],
                ['Reached', (record.reached || []).join(', ') || '—'],
                ['Closed', record.closed_at ? when(record.closed_at) : '—'],
              ]}/>
              {canAssign && <AssignForm executives={executives} current={record.assigned_to} busy={busy === 'assign'} onAssign={assign}
                hint={mod?.tiers?.executive !== false ? 'Executives can act on a case only after it is assigned to them.' : null}/>}
            </Card>

            <Card>
              <SectionTitle right={detail.audit_chain_valid === true ? <span title="Every event's hash links to the previous one" style={{ fontSize: 11, color: 'var(--zm-success)', fontWeight: 700 }}>✓ chain verified</span>
                : detail.audit_chain_valid === false ? <span style={{ fontSize: 11, color: 'var(--zm-danger)', fontWeight: 700 }}>chain broken</span> : null}>
                Approvals
              </SectionTitle>
              {approvals.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--zm-fg-3)' }}>No decisions yet.</div>}
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {approvals.map((a, i) => (
                  <li key={i} style={{ fontSize: 12.5, lineHeight: 1.45, paddingBottom: 8, borderBottom: '1px solid var(--zm-line)' }}>
                    <b>Stage {a.stage_order}</b> · {String(a.verdict || '').replace(/_/g, ' ')} by {a.actor_name || 'someone'} <span style={{ color: 'var(--zm-fg-3)' }}>({tierLabel(a.actor_role)} acting as {tierLabel(a.tier)})</span>
                    {a.is_override && <span style={{ marginLeft: 6, color: 'var(--zm-copper)', fontWeight: 700 }}>override</span>}
                    {a.acting_as_delegate && <span style={{ marginLeft: 6, color: 'var(--zm-info)', fontWeight: 700 }}>delegate</span>}
                    {a.comment && <div style={{ color: 'var(--zm-fg-2)' }}>“{a.comment}”</div>}
                    <div style={{ fontSize: 11.5, color: 'var(--zm-fg-3)' }}>{when(a.decided_at)}</div>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <SectionTitle>Audit trail</SectionTitle>
              <ol aria-label="Audit trail" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {audit.map((a, i) => {
                  const pv = a.provenance || {};
                  const ev = pv.event || {};
                  return (
                    <li key={i} style={{ display: 'grid', gridTemplateColumns: '18px 1fr', gap: 8, fontSize: 12.5 }}>
                      <span style={{ color: 'var(--zm-fg-4)', marginTop: 2 }}><Icon name="activity" size={12}/></span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ fontWeight: 650 }}>{humanAction(a.action, ev.type)}</span>
                        <span style={{ color: 'var(--zm-fg-3)' }}> · {a.actor_name || (ev.actor === 'system' ? 'system' : '—')}{ev.actor_role && ev.actor_role !== 'system' ? ` (${tierLabel(ev.actor_role)})` : ''}</span>
                        {(pv.override || ev.override) && <span style={{ marginLeft: 6, color: 'var(--zm-copper)', fontWeight: 700 }}>override</span>}
                        <div style={{ fontSize: 11.5, color: 'var(--zm-fg-3)' }}>
                          {when(a.at)} · release v{pv.release_version ?? '—'} · {pv.policy || 'runtime'}{ev.seq != null ? ` · #${ev.seq}` : ''}
                        </div>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </Card>
          </div>
        </div>
      </div>
    </MembersContext.Provider>
  );
}

function problemTitle(p) {
  switch (p.code) {
    case 'wrong_tier': return 'Not your step';
    case 'no_delegation': return 'This case isn’t assigned to you';
    case 'separation_of_duties': return 'Someone else must take this step';
    case 'observer_read_only': return 'Read-only access';
    case 'reason_required': return 'A reason is required';
    case 'stage_gate_closed': return 'This stage is locked';
    case 'invalid_form': return 'Check the form';
    default: return p.status === 403 ? 'Not allowed' : 'That didn’t work';
  }
}

function humanAction(action, type) {
  const t = type || String(action || '').replace(/^module_/, '');
  return ({
    case_created: 'Case opened', gate_opened: 'Entry gate opened', submitted: 'Stage submitted', approved: 'Approved',
    auto_approved: 'Auto-approved', rejected: 'Rejected', rejected_forward: 'Rejected (forward)', sent_back: 'Sent back',
    stage_completed: 'Stage completed', module_completed: 'Case completed', parked: 'Parked', assigned: 'Assigned',
    record_assigned: 'Assigned to an executive',
  })[t] || String(t).replace(/_/g, ' ');
}

function NextStep({ next, record, me, allowed, isReadOnly, mod, approvals = [], children }) {
  const closed = ['completed', 'rejected'].includes(record.case_status);
  // The latest decision on the current stage, when it sent the work back: whoever acts next
  // needs the reason in front of them, not only in the approvals list.
  const last = [...approvals].reverse().find((a) => a.stage_order === next?.stage);
  const sentBack = last && /sent.?back/.test(String(last.verdict || '')) ? last : null;
  return (
    <Card style={{ borderColor: !closed && allowed.length ? 'var(--zm-accent-line)' : 'var(--zm-line)' }}>
      <SectionTitle>{closed ? 'Result' : 'Next step'}</SectionTitle>
      {closed && (
        <div style={{ fontSize: 14 }}>
          {record.case_status === 'completed'
            ? <>This case is <b>complete</b>{record.exit_outcome ? <> — outcome <b>{record.exit_outcome}</b></> : null}. Downstream modules waiting on <b>{mod?.label}</b> can now open for this site.</>
            : <>This case was <b>rejected</b>.</>}
        </div>
      )}
      {!closed && !next && <div style={{ fontSize: 13.5, color: 'var(--zm-fg-2)' }}>Nothing to do right now{record.case_status === 'parked' ? ' — the case is parked (its roll-up could not be decided).' : '.'}</div>}
      {!closed && next && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <span style={{ fontSize: 17, fontWeight: 750, color: 'var(--zm-fg)' }}>Stage {next.stage} · {next.name}</span>
            <span style={{ fontSize: 12.5, color: 'var(--zm-fg-3)' }}>
              {next.kind === 'approve' ? 'awaiting approval by' : 'to be filled in by'} <b>{tierLabel(next.role)}</b>
            </span>
          </div>
          {allowed.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--zm-fg-2)', padding: '10px 12px', borderRadius: 9, background: 'var(--zm-surface-2)', border: '1px solid var(--zm-line)' }}>
              {isReadOnly ? 'You have read-only access.'
                : me?.role === 'executive' && next.role === 'executive' && !record.assigned_to
                  ? 'It’s an executive’s turn, but this case hasn’t been assigned yet — a supervisor assigns it first.'
                  : `It’s the ${tierLabel(next.role).toLowerCase()}’s turn. You’ll be able to act when it reaches your tier.`}
            </div>
          )}
          {sentBack && !closed && (
            <div role="note" style={{ fontSize: 12.5, marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--zm-copper-soft)', border: '1px solid var(--zm-copper-line)', color: 'var(--zm-fg)' }}>
              Sent back by {sentBack.actor_name || 'a reviewer'}{sentBack.comment ? <>: “{sentBack.comment}”</> : '.'}
            </div>
          )}
          {me?.role && me.role !== next.role && me.role !== 'business_admin' && allowed.includes('submit') && (
            <div style={{ fontSize: 12, color: 'var(--zm-fg-3)', marginBottom: 10 }}>
              This step belongs to the {tierLabel(next.role).toLowerCase()} tier; as a {tierLabel(me.role).toLowerCase()} of this stage you may fill it yourself — someone else then has to approve it (separation of duties).
            </div>
          )}
          {me?.role === 'business_admin' && allowed.length > 0 && next.role !== 'business_admin' && (
            <div style={{ fontSize: 12, color: 'var(--zm-copper)', marginBottom: 10 }}>
              You are the business admin: acting on a {tierLabel(next.role).toLowerCase()} step is recorded as an <b>override</b>.
            </div>
          )}
          {children}
        </>
      )}
    </Card>
  );
}

function StageRow({ s, current, memberName }) {
  const values = s.field_values || {};
  const fields = Array.isArray(s.fields) ? s.fields : [];
  const shown = fields.filter((f) => values[f.key] !== undefined && values[f.key] !== null && values[f.key] !== '');
  const fmt = (f, v) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : f.kind === 'person' ? (memberName(v) || v) : String(v));
  return (
    <li style={{ display: 'grid', gridTemplateColumns: '30px 1fr', gap: 10, padding: '10px 12px', borderRadius: 10,
      border: `1px solid ${current ? 'var(--zm-accent-line)' : 'var(--zm-line)'}`, background: current ? 'var(--zm-accent-soft)' : 'transparent' }}>
      <span style={{ width: 26, height: 26, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--zm-surface-2)', border: '1px solid var(--zm-line-strong)', fontFamily: 'var(--zm-font-mono)', fontSize: 12, fontWeight: 700 }}>{s.order}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 13.5 }}>{s.name}</span>
          <StageState state={s.state}/>
          {s.terminal && <span style={{ fontSize: 11, color: 'var(--zm-fg-3)' }}>last stage</span>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--zm-fg-3)', marginTop: 3 }}>
          {(s.chain || []).map(tierLabel).join(' → ') || '—'} · completes as “{s.outcome}”
          {s.submitted_at ? ` · submitted ${when(s.submitted_at)}` : ''}{s.decided_at ? ` · decided ${when(s.decided_at)}` : ''}
        </div>
        {shown.length > 0 && (
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '3px 12px', margin: '8px 0 0', fontSize: 12.5 }}>
            {shown.map((f) => (
              <React.Fragment key={f.key}>
                <dt style={{ color: 'var(--zm-fg-3)' }}>{f.label || f.key}</dt>
                <dd style={{ margin: 0, color: 'var(--zm-fg)', overflowWrap: 'anywhere' }}>{fmt(f, values[f.key])}</dd>
              </React.Fragment>
            ))}
          </dl>
        )}
      </div>
    </li>
  );
}

function Facts({ rows }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 14px', margin: 0, fontSize: 12.5 }}>
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt style={{ color: 'var(--zm-fg-3)' }}>{k}</dt>
          <dd style={{ margin: 0, color: 'var(--zm-fg)', overflowWrap: 'anywhere' }}>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function AssignForm({ executives, current, busy, onAssign, hint }) {
  const [pick, setPick] = React.useState(current || '');
  React.useEffect(() => { setPick(current || ''); }, [current]);
  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--zm-line)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label htmlFor="gm-assign" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--zm-fg-3)' }}>Assign to an executive</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <select id="gm-assign" value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 1, minWidth: 0, height: 34, borderRadius: 8, border: '1px solid var(--zm-line-strong)', background: 'var(--zm-surface)', color: 'var(--zm-fg)', fontSize: 13, padding: '0 8px' }}>
          <option value="">{executives.length ? 'Choose an executive…' : 'No executives in this module yet'}</option>
          {executives.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
        </select>
        <Button variant="primary" busy={busy} disabled={!pick || pick === current} onClick={() => onAssign(pick)}>Assign</Button>
      </div>
      {hint && <div style={{ fontSize: 11.5, color: 'var(--zm-fg-3)' }}>{hint}</div>}
    </div>
  );
}

function ReasonForm({ kind, stages, currentStage, busy, onCancel, onSubmit }) {
  const [reason, setReason] = React.useState('');
  const [toStage, setToStage] = React.useState('');
  const earlier = (stages || []).filter((s) => currentStage && s.order < currentStage);
  const isBack = kind === 'send_back';
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (reason.trim()) onSubmit({ reason: reason.trim(), toStage: toStage ? Number(toStage) : null }); }}
      style={{ marginTop: 14, padding: 14, borderRadius: 10, border: '1px solid var(--zm-line-strong)', background: 'var(--zm-surface-2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label htmlFor="gm-reason" style={{ fontSize: 12.5, fontWeight: 700 }}>{isBack ? 'Why are you sending it back?' : 'Why are you rejecting it?'}</label>
      <textarea id="gm-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} required
        style={{ borderRadius: 8, border: '1px solid var(--zm-line-strong)', background: 'var(--zm-surface)', color: 'var(--zm-fg)', fontFamily: 'var(--zm-font-body)', fontSize: 13, padding: 8, resize: 'vertical' }}/>
      {isBack && earlier.length > 0 && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
          Back to
          <select value={toStage} onChange={(e) => setToStage(e.target.value)} style={{ height: 30, borderRadius: 7, border: '1px solid var(--zm-line-strong)', background: 'var(--zm-surface)', color: 'var(--zm-fg)' }}>
            <option value="">the previous step (default)</option>
            {earlier.map((s) => <option key={s.order} value={s.order}>Stage {s.order} · {s.name}</option>)}
          </select>
        </label>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant={isBack ? 'primary' : 'danger'} type="submit" busy={busy} disabled={!reason.trim()}>{isBack ? 'Send back' : 'Reject case'}</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

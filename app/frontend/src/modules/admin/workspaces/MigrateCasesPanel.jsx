// "Migrate running cases" (G3 #2) — /#/admin → Workspaces → a workspace's Details.
//
// Moves in-flight custom-module cases from the release they are pinned to (vN, or every older
// release) onto another release (default: live) — the hot-fix path next to version pinning.
// Always a DRY RUN first (POST /platform/workspaces/{ref}/migrations {dry_run: true}): a table of
// every affected case — compatible?, stage before → after and how it was mapped, fields kept /
// dropped, approvals carried, blocking reasons and warnings. Executing needs a reason and a
// confirmation; the backend re-checks every site under its row locks, moves a site's pin and all
// its running cases together or skips the site, and writes an audited journal (docs/G3-API.md §1).
// F5a: optional "also re-pin sites with no running case" (include_idle_sites) with its own list in the
// dry run / result, and the history shows a migration's status (done / failed / stale "running").
import React from 'react';
import { platformApi } from '../adminApi.js';
import { C, Button, Pill, Eyebrow, Banner, Spinner, fieldStyle, when } from './ui.jsx';

const OUTCOME_TONE = { would_migrate: 'ok', migrated: 'ok', blocked: 'bad', skipped: 'warn', failed: 'bad', not_in_flight: 'muted' };
const OUTCOME_LABEL = { would_migrate: 'compatible', migrated: 'migrated', blocked: 'blocked', skipped: 'skipped', failed: 'failed', not_in_flight: 'finished — stays' };

export function describeStage(s) {
  if (!s) return '—';
  return `${s.order} · ${s.name}${s.role ? ` (${String(s.role).replace('_', ' ')})` : ''}`;
}

export default function MigrateCasesPanel({ refId, ws, withAuth }) {
  const releases = React.useMemo(() => [...(ws?.releases || [])].sort((a, b) => b.version - a.version), [ws]);
  const live = releases.find((r) => r.is_live) || releases[0];
  const customModules = (ws?.modules || []).filter((m) => m.kind === 'custom');
  const [to, setTo] = React.useState(live?.version ?? '');
  const [from, setFrom] = React.useState('all_older');
  const [mods, setMods] = React.useState([]);
  const [restart, setRestart] = React.useState(false);
  const [idle, setIdle] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [dry, setDry] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [confirm, setConfirm] = React.useState(false);
  const [history, setHistory] = React.useState([]);

  const loadHistory = React.useCallback(async () => {
    try { setHistory((await withAuth((k) => platformApi.migrations(k, refId)))?.items || []); } catch { /* optional */ }
  }, [withAuth, refId]);
  React.useEffect(() => { loadHistory(); }, [loadHistory]);

  if (releases.length < 2) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} aria-label="Migrate running cases">
        <Eyebrow>Migrate running cases</Eyebrow>
        <span style={{ fontSize: 12.5, color: C.faint }}>Needs at least two releases: publish a fix first, then move running cases onto it.</span>
      </div>
    );
  }

  const body = (dryRun) => ({
    from_release_version: from === 'all_older' ? 'all_older' : Number(from),
    to_release_version: Number(to),
    scope: mods.length ? { module_keys: mods } : {},
    restart_stage_on_chain_change: restart,
    ...(idle ? { include_idle_sites: true } : {}),
    dry_run: dryRun,
    ...(dryRun ? {} : { reason: reason.trim() }),
  });
  const run = async (dryRun) => {
    setBusy(dryRun ? 'dry' : 'exec'); setError(null);
    try {
      const d = await withAuth((k) => platformApi.migrate(k, refId, body(dryRun)));
      if (dryRun) { setDry(d); setResult(null); } else { setResult(d); setDry(null); setConfirm(false); setReason(''); loadHistory(); }
    } catch (e) {
      setError(e.message);
    } finally { setBusy(null); }
  };
  const changed = () => { setDry(null); setResult(null); setConfirm(false); };
  const movable = (dry?.items || []).filter((i) => i.outcome === 'would_migrate');
  const idleMovable = (dry?.idle_sites || []).filter((i) => i.outcome === 'would_repin');
  const canExecute = movable.length > 0 || idleMovable.length > 0;
  const shown = result || dry;

  return (
    <section aria-label="Migrate running cases" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px', borderRadius: 12, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.02)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <Eyebrow>Migrate running cases</Eyebrow>
        <span style={{ fontSize: 11.5, color: C.faint }}>Cases normally finish on the release they started on. Use this to move running custom-module cases onto a fixed release.</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, alignItems: 'end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11.5, color: C.muted, fontWeight: 600 }}>
          Move cases from
          <select aria-label="Move cases from" style={fieldStyle} value={from} onChange={(e) => { setFrom(e.target.value); changed(); }}>
            <option value="all_older">every older release</option>
            {releases.filter((r) => r.version !== Number(to)).map((r) => <option key={r.id} value={r.version}>v{r.version}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11.5, color: C.muted, fontWeight: 600 }}>
          Onto release
          <select aria-label="Onto release" style={fieldStyle} value={to} onChange={(e) => { setTo(Number(e.target.value)); changed(); }}>
            {releases.map((r) => <option key={r.id} value={r.version}>v{r.version}{r.is_live ? ' (live)' : ''}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11.5, color: C.muted, fontWeight: 600 }}>
          Modules
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontWeight: 400, fontSize: 12, color: C.text }}>
            {customModules.length === 0 && <span style={{ color: C.faint }}>no custom modules</span>}
            {customModules.map((m) => (
              <label key={m.key}><input type="checkbox" checked={mods.includes(m.key)}
                onChange={() => { setMods(mods.includes(m.key) ? mods.filter((x) => x !== m.key) : [...mods, m.key]); changed(); }}/> {m.label || m.key}</label>
            ))}
            {customModules.length > 0 && <span style={{ color: C.faint }}>{mods.length ? '' : '(all)'}</span>}
          </div>
        </div>
        <label style={{ fontSize: 12, color: C.muted, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={restart} onChange={(e) => { setRestart(e.target.checked); changed(); }}/>
          Restart a stage whose approval chain changed mid-way
        </label>
        <label style={{ fontSize: 12, color: C.muted, display: 'flex', gap: 6, alignItems: 'center' }} title="A site keeps the release it was pinned to; a case opened on it later starts on that release. Tick to move such sites too (their finished cases stay where they finished).">
          <input type="checkbox" checked={idle} onChange={(e) => { setIdle(e.target.checked); changed(); }}/>
          Also re-pin sites with no running case
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button size="sm" variant="primary" busy={busy === 'dry'} onClick={() => run(true)}>Dry run</Button>
        <span style={{ fontSize: 11.5, color: C.faint }}>Checks every running case; changes nothing.</span>
      </div>
      {error && <Banner>{error}</Banner>}
      {busy && <span style={{ fontSize: 12, color: C.muted, display: 'inline-flex', gap: 6, alignItems: 'center' }}><Spinner/> {busy === 'dry' ? 'Checking…' : 'Migrating…'}</span>}

      {shown && <MigrationTable data={shown}/>}
      {shown && Array.isArray(shown.idle_sites) && <IdleSites data={shown}/>}

      {dry && canExecute && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6, borderTop: `1px solid ${C.line}` }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11.5, color: C.muted, fontWeight: 600 }}>
            Reason (required — recorded on every moved case)
            <textarea aria-label="Migration reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)}
              style={{ ...fieldStyle, height: 'auto', padding: 8, resize: 'vertical' }} placeholder="e.g. Hot-fix: sign-off stage removed"/>
          </label>
          {!confirm && <span><Button size="sm" variant="success" disabled={reason.trim().length < 3} onClick={() => setConfirm(true)}>
            Migrate {movable.length} case{movable.length === 1 ? '' : 's'}{idleMovable.length ? ` + re-pin ${idleMovable.length} idle site${idleMovable.length === 1 ? '' : 's'}` : ''}…</Button></span>}
          {confirm && (
            <span role="alert" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
              Move {movable.length} running case{movable.length === 1 ? '' : 's'} on {new Set(movable.map((i) => i.site.id)).size} site(s){idleMovable.length ? ` and re-pin ${idleMovable.length} site(s) with no running case` : ''} onto v{dry.to?.version}? Blocked ones are skipped.
              <Button size="sm" variant="success" busy={busy === 'exec'} onClick={() => run(false)}>Confirm migration</Button>
              <Button size="sm" onClick={() => setConfirm(false)}>Cancel</Button>
            </span>
          )}
        </div>
      )}
      {dry && !canExecute && (dry.items || []).length > 0 && <Banner tone="warn">Nothing can move: every running case is blocked (see the reasons).</Banner>}
      {dry && (dry.items || []).length === 0 && <Banner tone="info">No running custom-module case is on the selected release(s).</Banner>}
      {result && <Banner tone="ok">Migration {String(result.migration_id).slice(0, 8)} done: {result.summary?.by_outcome?.migrated || 0} migrated, {result.summary?.by_outcome?.skipped || 0} skipped{result.summary?.by_outcome?.failed ? `, ${result.summary.by_outcome.failed} failed` : ''}{result.summary?.idle_sites ? `, ${result.summary.idle_sites.by_outcome?.repinned || 0} idle site(s) re-pinned` : ''}.</Banner>}

      {history.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Eyebrow style={{ marginTop: 4 }}>Earlier migrations</Eyebrow>
          {history.slice(0, 5).map((m) => (
            <div key={m.id} style={{ fontSize: 11.5, color: C.muted, display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <HistoryStatus m={m}/>
              <span>{when(m.created_at)} · {m.from} → v{m.to_version} · {m.summary?.by_outcome?.migrated || 0} migrated · {m.actor} · “{m.reason}”</span>
              {m.summary?.failure && <span style={{ color: C.faint }}>— {m.summary.failure}</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function MigrationTable({ data }) {
  const items = data.items || [];
  const s = data.summary || {};
  const grid = '1.2fr 0.8fr 60px 1.5fr 1.2fr 64px 110px 1.6fr';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 12, color: C.muted }}>
        {data.dry_run ? 'Dry run' : 'Result'} · {data.from?.spec === 'all_older' ? 'every older release' : data.from?.spec} → v{data.to?.version} ·
        {' '}{s.records || 0} case(s) on {s.sites || 0} site(s) · {s.compatible || 0} compatible · {s.blocked || 0} blocked
      </div>
      {items.length > 0 && (
        <div role="table" aria-label={data.dry_run ? 'Migration dry run' : 'Migration result'} style={{ border: `1px solid ${C.line}`, borderRadius: 10, overflow: 'hidden', fontSize: 12 }}>
          <div role="row" style={{ display: 'grid', gridTemplateColumns: grid, gap: 8, padding: '8px 10px', background: 'rgba(255,255,255,0.04)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.faint, fontWeight: 600 }}>
            <span>Site</span><span>Module</span><span>From</span><span>Stage before → after</span><span>Fields</span><span>Approvals</span><span>Outcome</span><span>Why</span>
          </div>
          {items.map((i) => (
            <div key={i.record_id} role="row" style={{ display: 'grid', gridTemplateColumns: grid, gap: 8, padding: '8px 10px', borderTop: `1px solid ${C.line}`, alignItems: 'start' }}>
              <span style={{ minWidth: 0 }}>{i.site?.name || '—'}<div style={{ fontFamily: C.mono, fontSize: 10.5, color: C.faint }}>{i.site?.code}</div></span>
              <span style={{ minWidth: 0, fontFamily: C.mono, fontSize: 11 }}>{i.module_key}{i.co_migrated ? <div style={{ color: C.faint, fontFamily: 'inherit' }}>same site</div> : null}</span>
              <span style={{ fontFamily: C.mono }}>v{i.from_version}</span>
              <span style={{ minWidth: 0 }}>
                {i.in_flight ? <>{describeStage(i.stage?.before)} → {i.stage?.after ? describeStage(i.stage.after) : <span style={{ color: C.bad }}>no counterpart</span>}</> : <span style={{ color: C.faint }}>{i.case_status}</span>}
                {(i.stage_mapping || []).some((m) => m.how !== 'same') && (
                  <div style={{ color: C.faint, fontSize: 11 }}>
                    {(i.stage_mapping || []).filter((m) => m.how !== 'same').map((m) => `${m.from.order}→${m.to ? m.to.order : '∅'} (${m.how.replace('_', ' ')})`).join(', ')}
                  </div>
                )}
              </span>
              <span style={{ minWidth: 0, color: C.muted }}>
                {(i.fields?.kept || []).length} kept · {(i.fields?.dropped || []).length} dropped
                {(i.fields?.dropped || []).length > 0 && <div style={{ color: C.warn, fontSize: 11 }}>{i.fields.dropped.map((f) => f.field).join(', ')}</div>}
              </span>
              <span style={{ fontFamily: C.mono }}>{i.approvals_carried ?? 0}</span>
              <span><Pill tone={OUTCOME_TONE[i.outcome] || 'muted'}>{OUTCOME_LABEL[i.outcome] || i.outcome}</Pill></span>
              <span style={{ minWidth: 0, fontSize: 11.5 }}>
                {(i.blocking || []).filter((b) => b.code !== 'not_in_flight').map((b) => <div key={b.code} style={{ color: C.bad }}>{b.message}</div>)}
                {(i.warnings || []).map((w, k) => <div key={`${w.code}-${k}`} style={{ color: C.warn }}>{w.message}</div>)}
                {i.message && <div style={{ color: C.faint }}>{i.message}</div>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// F5a: a migration whose process died is shown as such (it is marked failed on the next run / restart).
function HistoryStatus({ m }) {
  if (m.status === 'running' && m.stale) return <Pill tone="bad" title="No progress for 10 minutes: the run stopped. It is marked failed on the next migration or app restart.">stalled</Pill>;
  if (m.status === 'running') return <Pill tone="warn">running</Pill>;
  if (m.status === 'failed') return <Pill tone="bad">{m.summary?.recovered ? 'failed · recovered' : 'failed'}</Pill>;
  return <Pill tone="ok">done</Pill>;
}

// F5a: sites pinned to a source release with NO running case (include_idle_sites).
function IdleSites({ data }) {
  const rows = data.idle_sites || [];
  const tone = { would_repin: 'ok', repinned: 'ok', skipped: 'warn', failed: 'bad' };
  const label = { would_repin: 'would re-pin', repinned: 're-pinned', skipped: 'skipped', failed: 'failed' };
  return (
    <div aria-label="Sites with no running case" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 12, color: C.muted }}>
        Sites with no running case: {rows.length === 0 ? 'none on the selected release(s).' : `${rows.length} — their pin moves to v${data.to?.version}; finished cases stay on the release they finished on.`}
      </div>
      {rows.map((i) => (
        <div key={i.site.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
          <Pill tone={tone[i.outcome] || 'muted'}>{label[i.outcome] || i.outcome}</Pill>
          <span>{i.site.name}</span>
          <span style={{ fontFamily: C.mono, color: C.faint }}>v{i.from_version} → v{i.to_version}</span>
          {i.finished_cases ? <span style={{ color: C.faint }}>{i.finished_cases} finished case(s) stay</span> : null}
          {i.message && <span style={{ color: C.faint }}>{i.message}</span>}
        </div>
      ))}
    </div>
  );
}

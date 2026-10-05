// G3: role-scoped saved views — shared vocabulary for the module page's view switcher and the
// business admin's "Manage views" screen. The backend owns the semantics (docs/G3-API.md §3):
// a view's filter only narrows what the caller may already see; audience = who sees it in the menu.

export const AUDIENCE = [
  { key: 'executive', label: 'Executives' },
  { key: 'supervisor', label: 'Supervisors' },
  { key: 'business_admin', label: 'Business admin' },
  { key: 'observer', label: 'Observers' },
];

export const COLUMNS = [
  { key: 'site', label: 'Site' },
  { key: 'stage', label: 'Stage' },
  { key: 'next_step', label: 'Now' },
  { key: 'status', label: 'Status' },
  { key: 'assigned_to', label: 'Assigned to' },
  { key: 'opened_by', label: 'Opened by' },
  { key: 'opened_at', label: 'Opened' },
  { key: 'closed_at', label: 'Closed' },
  { key: 'release', label: 'Release' },
];
export const DEFAULT_COLUMNS = ['site', 'next_step', 'status', 'release', 'opened_at'];

export const CASE_STATUSES = ['open', 'in_progress', 'completed', 'rejected', 'parked'];
export const TIERS = [
  { key: 'my_tier', label: 'my tier' },
  { key: 'executive', label: 'executive' },
  { key: 'supervisor', label: 'supervisor' },
  { key: 'business_admin', label: 'business admin' },
];

// Yes / no / any filters (true = must hold, false = must not, absent = ignore).
export const FLAGS = [
  { key: 'actionable', label: 'I can act now', yes: 'I can act now', no: 'I can’t act now' },
  { key: 'mine', label: 'Mine (assigned, created or delegated)', yes: 'mine', no: 'not mine' },
  { key: 'assigned_to_me', label: 'Assigned to me', yes: 'assigned to me', no: 'not assigned to me' },
  { key: 'created_by_me', label: 'Created by me (case or site)', yes: 'created by me', no: 'not created by me' },
  { key: 'assigned', label: 'Has an assignee', yes: 'assigned', no: 'unassigned' },
  { key: 'closed', label: 'Finished', yes: 'finished', no: 'still running' },
];

/** One short sentence describing a view filter (shown under the switcher and in Manage views). */
export function describeFilter(filter) {
  const f = filter || {};
  const parts = [];
  if (f.awaiting) parts.push(`next step on ${f.awaiting === 'my_tier' ? 'my tier' : (TIERS.find((t) => t.key === f.awaiting)?.label || f.awaiting)}`);
  for (const flag of FLAGS) {
    if (f[flag.key] === true) parts.push(flag.yes);
    if (f[flag.key] === false) parts.push(flag.no);
  }
  if (Array.isArray(f.status) && f.status.length) parts.push(`status ${f.status.map((s) => s.replace('_', ' ')).join(' / ')}`);
  if (Array.isArray(f.stage) && f.stage.length) parts.push(`stage ${f.stage.join(', ')}`);
  if (f.kind) parts.push(f.kind === 'approve' ? 'awaiting approval' : 'to submit');
  if (Array.isArray(f.site_ids) && f.site_ids.length) parts.push(`${f.site_ids.length} site${f.site_ids.length === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'every case you can see';
}

/** Editor state (strings / tri-states) → the API filter object. */
export function filterFromForm(form) {
  const out = {};
  if (form.awaiting) out.awaiting = form.awaiting;
  for (const flag of FLAGS) {
    if (form[flag.key] === 'yes') out[flag.key] = true;
    if (form[flag.key] === 'no') out[flag.key] = false;
  }
  if (form.status?.length) out.status = form.status;
  const stages = String(form.stage || '').split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (stages.length) out.stage = stages;
  if (form.kind) out.kind = form.kind;
  const sites = String(form.site_ids || '').split(/[\s,]+/).filter(Boolean);
  if (sites.length) out.site_ids = sites;
  return out;
}

/** API filter → editor state. */
export function formFromFilter(filter) {
  const f = filter || {};
  const form = { awaiting: f.awaiting || '', status: f.status || [], stage: (f.stage || []).join(', '),
    kind: f.kind || '', site_ids: (f.site_ids || []).join(', ') };
  for (const flag of FLAGS) form[flag.key] = f[flag.key] === true ? 'yes' : f[flag.key] === false ? 'no' : '';
  return form;
}

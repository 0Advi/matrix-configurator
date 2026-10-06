// G3: role-scoped saved views on /m/:moduleKey (+ the business admin's Manage views screen) and the
// creator-scoped rule / release-migration entries on the case page. Responses are shaped like
// app-stack/smoke-g3.mjs's (docs/G3-API.md).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listRecords: vi.fn(), listSitesForCases: vi.fn(), openRecord: vi.fn(), getRecord: vi.fn(), actOnRecord: vi.fn(),
  assignRecord: vi.fn(), listMembers: vi.fn(), listViews: vi.fn(), createView: vi.fn(), updateView: vi.fn(),
  deleteView: vi.fn(), resetViews: vi.fn(),
}));
vi.mock('../../../services/api/moduleRuntimeApi.js', async () => {
  const real = await vi.importActual('../../../services/api/moduleRuntimeApi.js');
  return { ...real, ...api };
});
vi.mock('../../../services/api/axiosClient.js', () => ({ createApiClient: () => ({ get: vi.fn(), post: vi.fn() }) }));
vi.mock('../../../state/SessionContext.jsx', () => ({ useSession: () => ({ isReadOnly: false }) }));
vi.mock('../../../state/useWorkspaceModules.js', () => ({
  useWorkspaceModules: () => ({ status: 'ready', release: { version: 2 }, modules: [{ key: 'g3_vendor', label: 'G3 Vendor', kind: 'custom' }],
    get: (k) => (k === 'g3_vendor' ? { key: 'g3_vendor', label: 'G3 Vendor', kind: 'custom' } : null) }),
}));

import GenericModulePage from '../GenericModulePage.jsx';
import GenericRecordPage from '../GenericRecordPage.jsx';
import ManageViewsPage from '../ManageViewsPage.jsx';
import { resolveView } from '../../../services/api/moduleRuntimeApi.js';
import { describeFilter, filterFromForm, formFromFilter } from '../viewsKit.js';

const MOD = 'g3_vendor';
const err = (status, data) => Object.assign(new Error(data?.detail || 'x'), { status, cause: { response: { status, data } } });
function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/m/:moduleKey" element={<GenericModulePage/>}/>
        <Route path="/m/:moduleKey/views" element={<ManageViewsPage/>}/>
        <Route path="/m/:moduleKey/records/:recordId" element={<GenericRecordPage/>}/>
      </Routes>
    </MemoryRouter>,
  );
}
const view = (id, seed, name, over = {}) => ({ id, seed_key: seed, name, module_key: MOD, all_modules: false, filter: {}, columns: ['site', 'next_step', 'status'],
  audience: ['executive', 'supervisor'], position: 10, is_default: false, ...over });
const VIEWS = [
  view('v-await', 'awaiting_me', 'Awaiting my approval', { filter: { awaiting: 'my_tier', actionable: true }, is_default: true }),
  view('v-mine', 'my_cases', 'My cases', { filter: { mine: true, closed: false }, columns: ['site', 'stage', 'assigned_to', 'release'] }),
  view('v-all', 'all', 'All cases', { audience: ['executive', 'supervisor', 'business_admin', 'observer'], is_default: true }),
];
const SITE = { id: 's1', name: 'Pune Camp', code: 'G3-PNQ-1', city: 'Pune' };
const row = (id, over = {}) => ({ id, site: { ...SITE, id: `s-${id}`, name: `Site ${id}` }, case_status: 'in_progress', current_stage: 1, release_version: 1,
  next_step: { stage: 1, name: 'Vendor capture', role: 'executive', kind: 'submit', restricted_to: 'site_creator' }, allowed_actions: ['submit'],
  assigned_to: 'ex2', opened_by: 'sup1', opened_at: '2026-10-05T08:00:00Z', ...over });

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.listSitesForCases.mockResolvedValue([]);
  api.listMembers.mockResolvedValue({ items: [{ id: 'ex2', name: 'Esha Two', role_in_module: 'executive' }, { id: 'sup1', name: 'Sam Sup', role_in_module: 'supervisor' }] });
});

describe('saved views — helpers', () => {
  it('resolves a view from an id, a seed key, a sidebar page key, else the default', () => {
    expect(resolveView(VIEWS, 'v-mine', 'v-await').id).toBe('v-mine');
    expect(resolveView(VIEWS, 'my_cases', 'v-await').id).toBe('v-mine');
    expect(resolveView(VIEWS, 'review', 'v-all').id).toBe('v-await');     // sidebar "Checklist review"
    expect(resolveView(VIEWS, 'queue', 'v-all').id).toBe('v-await');      // no team queue for this role
    expect(resolveView(VIEWS, '', 'v-all').id).toBe('v-all');
    expect(resolveView([], 'x', null)).toBeNull();
  });

  it('describes and edits filters without inventing keys', () => {
    expect(describeFilter({ awaiting: 'my_tier', actionable: true })).toBe('next step on my tier · I can act now');
    expect(describeFilter({})).toBe('every case you can see');
    const f = { awaiting: 'business_admin', mine: false, status: ['open'], stage: [1, 3], kind: 'approve' };
    expect(filterFromForm(formFromFilter(f))).toEqual(f);
    expect(filterFromForm({ ...formFromFilter({}), stage: '2, x, -1', site_ids: ' a , b ' })).toEqual({ stage: [2], site_ids: ['a', 'b'] });
  });
});

describe('GenericModulePage — saved views', () => {
  it('shows the role’s views, applies the selected one server-side and uses its columns', async () => {
    api.listViews.mockResolvedValue({ module: { key: MOD, label: 'G3 Vendor' }, role: 'executive', can_manage: false, default_view_id: 'v-await', items: VIEWS });
    api.listRecords.mockImplementation(async (key, opts = {}) => {
      const items = { 'v-await': [row('a')], 'v-mine': [row('a'), row('b', { next_step: null, case_status: 'in_progress' })], 'v-all': [row('a'), row('b'), row('c')] }[opts.viewId] || [row('a'), row('b'), row('c')];
      return { module: { key: MOD, label: 'G3 Vendor' }, role: 'executive', items, total: items.length };
    });
    renderAt(`/m/${MOD}`);
    const tabs = await screen.findByRole('tablist', { name: 'Saved views' });
    await waitFor(() => expect(within(tabs).getByRole('tab', { name: /Awaiting my approval 1/ })).toHaveAttribute('aria-selected', 'true'));
    expect(within(tabs).getByRole('tab', { name: /My cases 2/ })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: /All cases 3/ })).toBeInTheDocument();
    expect(api.listRecords).toHaveBeenCalledWith(MOD, { viewId: 'v-await' });
    expect(screen.getByTestId('view-description')).toHaveTextContent('next step on my tier · I can act now');
    expect(within(screen.getByRole('table', { name: 'Cases' })).getByText(/site creator only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /manage views/i })).toBeNull();

    await userEvent.click(within(tabs).getByRole('tab', { name: /My cases/ }));
    const table = screen.getByRole('table', { name: 'Cases' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Site', 'Stage', 'Assigned to', 'Release']);
    await waitFor(() => expect(within(table).getAllByText('Esha Two').length).toBe(2));
  });

  it('business admins get "Manage views"; without views (older backend) the F4b tabs stay', async () => {
    api.listViews.mockResolvedValueOnce({ role: 'business_admin', can_manage: true, default_view_id: 'v-all', items: [VIEWS[2]] });
    api.listRecords.mockResolvedValue({ module: { key: MOD, label: 'G3 Vendor' }, role: 'business_admin', items: [], total: 0 });
    const { unmount } = renderAt(`/m/${MOD}`);
    expect(await screen.findByRole('button', { name: /manage views/i })).toBeInTheDocument();
    unmount();
    api.listViews.mockRejectedValueOnce(err(404, { detail: 'Not Found' }));
    renderAt(`/m/${MOD}`);
    expect(await screen.findByRole('tablist', { name: 'Case views' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /closed/i })).toBeInTheDocument();
  });
});

describe('ManageViewsPage', () => {
  const MANAGE = { module: { key: MOD, label: 'G3 Vendor' }, role: 'business_admin', can_manage: true, default_view_id: 'v-all', items: VIEWS };

  it('creates, edits, removes and resets views', async () => {
    api.listViews.mockResolvedValue(MANAGE);
    api.createView.mockResolvedValue({ id: 'v-new' });
    api.updateView.mockResolvedValue({ id: 'v-mine' });
    api.deleteView.mockResolvedValue(null);
    api.resetViews.mockResolvedValue({ ...MANAGE, reset: { removed: 4, seeded: 6 } });
    renderAt(`/m/${MOD}/views`);
    const table = await screen.findByRole('table', { name: 'Saved views' });
    expect(within(table).getByText('Awaiting my approval')).toBeInTheDocument();
    expect(within(table).getByText(/next step on my tier · I can act now/)).toBeInTheDocument();
    expect(api.listViews).toHaveBeenCalledWith(MOD, { manage: true });

    await userEvent.click(screen.getByRole('button', { name: 'New view' }));
    await userEvent.type(screen.getByLabelText('View name'), 'Stuck at stage 2');
    await userEvent.type(screen.getByLabelText('Stages'), '2');
    await userEvent.selectOptions(screen.getByLabelText('Has an assignee'), 'no');
    await userEvent.click(screen.getByLabelText('Business admin'));
    await userEvent.click(screen.getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(api.createView).toHaveBeenCalled());
    expect(api.createView.mock.calls[0][1]).toMatchObject({ name: 'Stuck at stage 2', filter: { stage: [2], assigned: false },
      audience: ['executive', 'supervisor', 'business_admin'], all_modules: false });

    await userEvent.click(within(screen.getByRole('table', { name: 'Saved views' })).getAllByRole('button', { name: 'Edit' })[1]);
    await userEvent.selectOptions(screen.getByLabelText('Next step on'), 'supervisor');
    await userEvent.click(screen.getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(api.updateView).toHaveBeenCalled());
    expect(api.updateView.mock.calls[0][1]).toBe('v-mine');
    expect(api.updateView.mock.calls[0][2].filter).toEqual({ awaiting: 'supervisor', mine: true, closed: false });

    await userEvent.click(screen.getByRole('button', { name: 'Remove All cases' }));
    await waitFor(() => expect(api.deleteView).toHaveBeenCalledWith(MOD, 'v-all'));

    await userEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(api.resetViews).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Yes, reset' }));
    await waitFor(() => expect(api.resetViews).toHaveBeenCalledWith(MOD));
    expect(await screen.findByText(/Default views restored \(6 views\)/)).toBeInTheDocument();
  });

  it('non-admins see the backend refusal', async () => {
    api.listViews.mockRejectedValue(err(403, { detail: 'Only a business admin can manage views.' }));
    renderAt(`/m/${MOD}/views`);
    expect(await screen.findByText('Only a business admin can manage views', { selector: 'div' })).toBeInTheDocument();
  });
});

const detail = (over = {}) => ({
  record: { id: 'r1', module_key: MOD, status: 'in progress', case_status: 'in_progress', current_stage: 1, reached: [], seq: 4,
    site: SITE, opened_by: 'sup1', assigned_to: 'ex2', opened_at: '2026-10-05T08:00:00Z', closed_at: null },
  release: { id: 'rel2', version: 2, pinned: true, live_version: 2 },
  module: { key: MOD, label: 'G3 Vendor', tiers: { supervisor: true, executive: true, business_admin_signoff: true, delegation: true }, exit_signal: 'approved' },
  stages: [{ order: 1, name: 'Vendor capture', outcome: 'submitted', terminal: false, chain: ['executive', 'supervisor'], restricted_to: 'site_creator', state: 'in progress', field_values: {}, fields: [] }],
  next_step: { stage: 1, name: 'Vendor capture', role: 'executive', kind: 'approve', restricted_to: 'site_creator', form: null },
  me: { id: 'ex2', role: 'executive', owns_site: false },
  allowed_actions: [],
  gate: { open: true, conditions: [] }, approvals: [],
  audit: [{ action: 'module_release_migrated', actor_name: 'platform-admin@example.com',
    provenance: { policy: 'release_migration', release_version: 2, from_release: { version: 1 }, to_release: { version: 2 }, reason: 'Hot-fix: sign-off removed',
      before_stage: { order: 2, name: 'Compliance check' }, after_stage: { order: 2, name: 'Compliance check' }, event: { seq: 4, type: 'release_migrated', actor_role: 'platform_admin' } },
    at: '2026-10-05T09:00:00Z' }],
  audit_chain_valid: true,
  ...over,
});

describe('GenericRecordPage — creator rule + release migration', () => {
  it('tells a non-creator the step waits for the site’s creator and shows the migration in the audit trail', async () => {
    api.getRecord.mockResolvedValue(detail());
    renderAt(`/m/${MOD}/records/r1`);
    expect(await screen.findByTestId('creator-rule')).toHaveTextContent('Only the site’s creator can do this step');
    expect(screen.getByText(/You didn’t create this site/)).toBeInTheDocument();
    expect(screen.getByText('site creator only')).toBeInTheDocument();
    const trail = screen.getByRole('list', { name: 'Audit trail' });
    expect(within(trail).getByText('Moved to another release')).toBeInTheDocument();
    expect(within(trail).getByTestId('migration-entry')).toHaveTextContent('Moved v1 → v2 · stage 2 “Compliance check” → 2 “Compliance check” · “Hot-fix: sign-off removed”');
  });

  it('a business admin is told that acting on the creator step is an override', async () => {
    api.getRecord.mockResolvedValue(detail({ me: { id: 'ba', role: 'business_admin', owns_site: false }, allowed_actions: ['approve', 'reject'] }));
    renderAt(`/m/${MOD}/records/r1`);
    expect(await screen.findByText(/a step reserved for the site’s creator/)).toBeInTheDocument();
  });

  it('the creator sees that the step is theirs', async () => {
    api.getRecord.mockResolvedValue(detail({ me: { id: 'ex1', role: 'executive', owns_site: true }, allowed_actions: ['approve', 'reject'] }));
    renderAt(`/m/${MOD}/records/r1`);
    expect(await screen.findByTestId('creator-rule')).toHaveTextContent('That’s you.');
  });
});

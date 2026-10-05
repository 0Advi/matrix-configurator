// F4b: the generic module pages (/m/:moduleKey, /m/:moduleKey/records/:id) against the
// backend contract of docs/F4-API.md §3 (responses shaped like smoke-configurator's).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listRecords: vi.fn(), listSitesForCases: vi.fn(), openRecord: vi.fn(), getRecord: vi.fn(),
  actOnRecord: vi.fn(), assignRecord: vi.fn(), listMembers: vi.fn(),
}));
vi.mock('../../../services/api/moduleRuntimeApi.js', async () => {
  const real = await vi.importActual('../../../services/api/moduleRuntimeApi.js');
  return { ...real, ...api };
});
vi.mock('../../../services/api/axiosClient.js', () => ({ createApiClient: () => ({ get: vi.fn(), post: vi.fn() }) }));
vi.mock('../../../state/SessionContext.jsx', () => ({ useSession: () => ({ isReadOnly: false }) }));
vi.mock('../../../state/useWorkspaceModules.js', () => ({
  useWorkspaceModules: () => ({
    status: 'ready', release: { version: 1 },
    modules: [{ key: 'bd', label: 'BD' }, { key: 'vendor_onboarding', label: 'Vendor Onboarding', kind: 'custom' }],
    get: (k) => ({ bd: { key: 'bd', label: 'BD' }, vendor_onboarding: { key: 'vendor_onboarding', label: 'Vendor Onboarding', kind: 'custom' } })[k] || null,
  }),
}));

import GenericModulePage from '../GenericModulePage.jsx';
import GenericRecordPage, { transformErrors } from '../GenericRecordPage.jsx';

const err = (status, data) => Object.assign(new Error(data?.detail || 'x'), { status, cause: { response: { status, data } } });
const MOD = 'vendor_onboarding';

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/m/:moduleKey" element={<GenericModulePage/>}/>
        <Route path="/m/:moduleKey/records/:recordId" element={<GenericRecordPage/>}/>
      </Routes>
    </MemoryRouter>,
  );
}

const SITE = { id: 's1', name: 'Andheri West', code: 'BT-MUM-1', city: 'Mumbai' };
const caseRow = (over = {}) => ({ id: 'r1', site: SITE, status: 'in progress', case_status: 'in_progress', current_stage: 1,
  release_version: 1, next_step: { stage: 1, name: 'Vendor capture', role: 'executive', kind: 'submit' }, allowed_actions: [], opened_at: '2026-10-04T08:00:00Z', ...over });

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.listMembers.mockResolvedValue({ items: [
    { id: 'sup1', name: 'Sam Supervisor', email: 's@x', role_in_module: 'supervisor' },
    { id: 'ex1', name: 'Esha Exec', email: 'e@x', role_in_module: 'executive' },
  ] });
});

describe('GenericModulePage', () => {
  it('lists cases and filters by the sidebar views', async () => {
    api.listRecords.mockResolvedValue({ module: { key: MOD, label: 'Vendor Onboarding' }, role: 'supervisor', total: 2, items: [
      caseRow(), caseRow({ id: 'r2', site: { ...SITE, id: 's2', name: 'Bandra' }, case_status: 'completed', next_step: null, exit_outcome: 'approved' }),
    ] });
    api.listSitesForCases.mockResolvedValue([]);
    renderAt(`/m/${MOD}`);
    expect(await screen.findByRole('heading', { name: 'Vendor Onboarding' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Cases' });
    expect(within(table).getByText('Andheri West')).toBeInTheDocument();
    expect(within(table).getByText('Bandra')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /closed/i }));
    expect(within(screen.getByRole('table', { name: 'Cases' })).queryByText('Andheri West')).toBeNull();
  });

  it('opening a case while the entry gate is closed shows the locked screen from gate.conditions', async () => {
    api.listRecords.mockResolvedValue({ module: { key: MOD, label: 'Vendor Onboarding' }, role: 'supervisor', total: 0, items: [] });
    api.listSitesForCases.mockResolvedValue([SITE]);
    api.openRecord.mockRejectedValue(err(409, { detail: 'Vendor Onboarding is locked: waiting for BD in progress.', code: 'gate_closed',
      gate: { open: false, refusal: 'Vendor Onboarding is locked: waiting for BD in progress.', match: 'all',
        conditions: [{ source: 'bd', outcome: 'in progress', met: false, reached: ['submitted'] }] } }));
    renderAt(`/m/${MOD}`);
    await userEvent.click(await screen.findByRole('button', { name: /open case/i }));
    const locked = await screen.findByRole('region', { name: /is locked/i });
    expect(within(locked).getByRole('heading', { name: /waiting for BD in progress/i })).toBeInTheDocument();
    const cond = within(locked).getByRole('list', { name: /gate conditions/i });
    expect(cond).toHaveTextContent('BD has reached “in progress”');
    expect(cond).toHaveTextContent('Reached so far: submitted');
    expect(within(cond).getByLabelText('not met')).toBeInTheDocument();
  });

  it('a non-member sees the backend refusal', async () => {
    api.listRecords.mockRejectedValue(err(403, { detail: 'You are not a member of Vendor Onboarding.' }));
    renderAt(`/m/${MOD}`);
    expect(await screen.findByText('You are not a member of Vendor Onboarding.')).toBeInTheDocument();
  });
});

const detail = (over = {}) => ({
  record: { id: 'r1', module_key: MOD, status: 'in progress', case_status: 'in_progress', current_stage: 1, exit_outcome: null, reached: [], seq: 5,
    site: SITE, opened_by: 'sup1', assigned_to: 'ex1', opened_at: '2026-10-04T08:00:00Z', closed_at: null },
  release: { id: 'rel1', version: 1, pinned: true, live_version: 2 },
  module: { key: MOD, label: 'Vendor Onboarding', tiers: { supervisor: true, executive: true, business_admin_signoff: false, delegation: true }, exit_signal: 'approved' },
  stages: [
    { order: 1, name: 'Vendor capture', outcome: 'submitted', terminal: false, chain: ['executive', 'supervisor'], state: 'pending', field_values: {}, fields: [] },
    { order: 2, name: 'Final check', outcome: 'approved', terminal: true, chain: ['supervisor'], state: 'pending', field_values: {}, fields: [] },
  ],
  next_step: { stage: 1, name: 'Vendor capture', role: 'executive', kind: 'submit', form: {
    schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', title: 'Vendor capture', additionalProperties: false, required: ['vendor_name', 'gst_number'],
      properties: { vendor_name: { title: 'Vendor name', type: 'string' }, gst_number: { title: 'GST number', type: 'string' }, msme_certificate: { title: 'MSME certificate', type: 'string' } } },
    uiSchema: { 'ui:order': ['vendor_name', 'gst_number', 'msme_certificate'], msme_certificate: { 'ui:widget': 'MatrixFileWidget', 'ui:options': { accept: '.pdf' } } },
    unparsed: [] } },
  me: { id: 'ex1', role: 'executive' },
  allowed_actions: ['submit'],
  gate: { open: true, conditions: [] },
  approvals: [],
  audit: [{ action: 'module_case_created', actor_name: 'Sam Supervisor', provenance: { policy: 'runtime', release_version: 1, event: { seq: 1, type: 'case_created', actor_role: 'supervisor', override: false } }, at: '2026-10-04T08:00:00Z' }],
  audit_chain_valid: true,
  ...over,
});

describe('GenericRecordPage', () => {
  it('renders the pinned release, stages, the rjsf form and the file-field notice', async () => {
    api.getRecord.mockResolvedValue(detail());
    renderAt(`/m/${MOD}/records/r1`);
    expect(await screen.findByRole('heading', { name: 'Andheri West' })).toBeInTheDocument();
    expect(screen.getByText(/release v1 · pinned/i)).toBeInTheDocument();
    expect(screen.getByText(/live is v2/i)).toBeInTheDocument();
    expect(screen.getByText(/Executive → Supervisor/)).toBeInTheDocument();
    expect(screen.getByLabelText(/vendor name/i)).toBeInTheDocument();
    expect(screen.getByTestId('file-unsupported')).toHaveTextContent(/isn’t available/);
    expect(screen.getByText('✓ chain verified')).toBeInTheDocument();
    expect(screen.getByText(/release v1 · runtime · #1/)).toBeInTheDocument();
  });

  it('submits with expected_seq and maps invalid_form errors under the fields', async () => {
    const user = userEvent.setup();
    api.getRecord.mockResolvedValue(detail());
    api.actOnRecord.mockRejectedValueOnce(err(422, { detail: 'Form invalid', code: 'invalid_form', errors: ["gst_number: 'bad' does not match '^[0-9]{2}'"] }));
    renderAt(`/m/${MOD}/records/r1`);
    await user.type(await screen.findByLabelText(/vendor name/i), 'Acme Supplies');
    await user.type(screen.getByLabelText(/gst number/i), 'bad');
    await user.click(screen.getByRole('button', { name: /submit stage 1/i }));
    await waitFor(() => expect(api.actOnRecord).toHaveBeenCalledTimes(1));
    expect(api.actOnRecord).toHaveBeenCalledWith(MOD, 'r1', { action: 'submit', expected_seq: 5, values: { vendor_name: 'Acme Supplies', gst_number: 'bad' } });
    expect(await screen.findByText("'bad' does not match '^[0-9]{2}'")).toBeInTheDocument();
  });

  it('a stale action (409) asks to refresh', async () => {
    const user = userEvent.setup();
    api.getRecord.mockResolvedValue(detail({ next_step: { stage: 1, name: 'Vendor capture', role: 'supervisor', kind: 'approve', form: null },
      me: { id: 'sup1', role: 'supervisor' }, allowed_actions: ['approve', 'send_back', 'reject'] }));
    api.actOnRecord.mockRejectedValue(err(409, { detail: 'Someone acted first.', code: 'stale' }));
    renderAt(`/m/${MOD}/records/r1`);
    await user.click(await screen.findByRole('button', { name: /approve stage 1/i }));
    expect(await screen.findByText(/this case changed since you opened it/i)).toBeInTheDocument();
    api.getRecord.mockClear();
    await user.click(screen.getAllByRole('button', { name: /refresh/i })[0]);
    await waitFor(() => expect(api.getRecord).toHaveBeenCalled());
  });

  it('send back requires a reason and can target an earlier stage', async () => {
    const user = userEvent.setup();
    api.getRecord.mockResolvedValue(detail({ next_step: { stage: 2, name: 'Final check', role: 'supervisor', kind: 'approve', form: null },
      me: { id: 'sup1', role: 'supervisor' }, allowed_actions: ['approve', 'send_back', 'reject'] }));
    api.actOnRecord.mockResolvedValue(detail({ next_step: null, allowed_actions: [] }));
    renderAt(`/m/${MOD}/records/r1`);
    await user.click(await screen.findByRole('button', { name: /send back…/i }));
    await user.type(screen.getByLabelText(/why are you sending it back/i), 'GST name differs');
    await user.selectOptions(screen.getByRole('combobox', { name: /back to/i }), '1');
    await user.click(screen.getByRole('button', { name: /^send back$/i }));
    await waitFor(() => expect(api.actOnRecord).toHaveBeenCalledWith(MOD, 'r1', { action: 'send_back', expected_seq: 5, reason: 'GST name differs', to_stage: 1 }));
  });

  it('a supervisor assigns the case to an executive of the module', async () => {
    const user = userEvent.setup();
    api.getRecord.mockResolvedValue(detail({ record: { ...detail().record, assigned_to: null }, me: { id: 'sup1', role: 'supervisor' }, allowed_actions: [] }));
    api.assignRecord.mockResolvedValue(detail());
    renderAt(`/m/${MOD}/records/r1`);
    const select = await screen.findByLabelText(/assign to an executive/i);
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Esha Exec' })).toBeInTheDocument());
    await user.selectOptions(select, 'ex1');
    await user.click(screen.getByRole('button', { name: /^assign$/i }));
    await waitFor(() => expect(api.assignRecord).toHaveBeenCalledWith(MOD, 'r1', 'ex1'));
  });

  it('an executive waiting on another tier sees whose turn it is, no buttons', async () => {
    api.getRecord.mockResolvedValue(detail({ next_step: { stage: 1, name: 'Vendor capture', role: 'supervisor', kind: 'approve', form: null }, allowed_actions: [] }));
    renderAt(`/m/${MOD}/records/r1`);
    expect(await screen.findByText(/It’s the supervisor’s turn/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });
});

describe('record page wording', () => {
  it('turns ajv messages into user language', () => {
    const out = transformErrors([
      { name: 'pattern', message: 'must match pattern "^[0-9]{2}"' },
      { name: 'maximum', params: { limit: 120 }, message: 'must be <= 120' },
      { name: 'type', message: 'must be number' },
    ]);
    expect(out.map((e) => e.message)).toEqual(['Doesn’t match the expected format.', 'Must be at most 120.', 'must be number']);
  });

  it('shows the send-back reason to whoever acts next', async () => {
    api.getRecord.mockResolvedValue(detail({ approvals: [
      { stage_order: 1, tier: 'executive', actor_name: 'Esha Exec', actor_role: 'executive', verdict: 'submitted' },
      { stage_order: 1, tier: 'supervisor', actor_name: 'Sam Supervisor', actor_role: 'supervisor', verdict: 'sent_back', comment: 'GST name differs' },
    ] }));
    renderAt(`/m/${MOD}/records/r1`);
    const notes = await screen.findAllByRole('note');
    expect(notes.some((n) => n.textContent === 'Sent back by Sam Supervisor: “GST name differs”')).toBe(true);
    expect(screen.getAllByText(/sent back/i).length).toBeGreaterThan(1);   // verdict text in the approvals list too
  });
});

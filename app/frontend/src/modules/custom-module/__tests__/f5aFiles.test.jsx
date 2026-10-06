// F5a: file fields of configurator-built modules upload for real (POST /m/{key}/records/{id}/files);
// the form submits the returned file id; submitted files open through a signed URL. The widget
// mirrors the backend's type/size checks from the field's hint before sending anything.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const api = vi.hoisted(() => ({
  getRecord: vi.fn(), actOnRecord: vi.fn(), assignRecord: vi.fn(), listMembers: vi.fn(),
  uploadRecordFile: vi.fn(), getRecordFile: vi.fn(),
}));
vi.mock('../../../services/api/moduleRuntimeApi.js', async () => {
  const real = await vi.importActual('../../../services/api/moduleRuntimeApi.js');
  return { ...real, ...api };
});
vi.mock('../../../services/api/axiosClient.js', () => ({ createApiClient: () => ({ get: vi.fn(), post: vi.fn() }) }));
vi.mock('../../../state/SessionContext.jsx', () => ({ useSession: () => ({ isReadOnly: false }) }));
vi.mock('../../../state/useWorkspaceModules.js', () => ({
  useWorkspaceModules: () => ({ status: 'ready', release: { version: 1 }, modules: [], get: () => null }),
}));

import GenericRecordPage from '../GenericRecordPage.jsx';
import { checkFile, parseMaxSize } from '../widgets.jsx';

const MOD = 'vendor_onboarding';
const FILE_ID = '11111111-2222-3333-4444-555555555555';
const SITE = { id: 's1', name: 'Andheri West', code: 'BT-MUM-1', city: 'Mumbai' };
const FIELDS = [{ key: 'vendor_name', label: 'Vendor name', kind: 'text' }, { key: 'msme_certificate', label: 'MSME certificate', kind: 'file' }];
const detail = (over = {}) => ({
  record: { id: 'r1', module_key: MOD, status: 'in progress', case_status: 'in_progress', current_stage: 1, reached: [], seq: 5,
    site: SITE, opened_by: 'sup1', assigned_to: 'ex1', opened_at: '2026-10-04T08:00:00Z', closed_at: null },
  release: { id: 'rel1', version: 1, pinned: true, live_version: 1 },
  module: { key: MOD, label: 'Vendor Onboarding', tiers: { supervisor: true, executive: true, delegation: true }, exit_signal: 'approved' },
  stages: [{ order: 1, name: 'Vendor capture', outcome: 'submitted', terminal: true, chain: ['executive', 'supervisor'], state: 'pending', field_values: {}, fields: FIELDS }],
  next_step: { stage: 1, name: 'Vendor capture', role: 'executive', kind: 'submit', form: {
    schema: { type: 'object', required: ['vendor_name'], properties: { vendor_name: { title: 'Vendor name', type: 'string' }, msme_certificate: { title: 'MSME certificate', type: 'string' } } },
    uiSchema: { 'ui:order': ['vendor_name', 'msme_certificate'], msme_certificate: { 'ui:widget': 'MatrixFileWidget', 'ui:options': { accept: '.pdf', maxSize: '2MB' } } },
    unparsed: [] } },
  me: { id: 'ex1', role: 'executive' }, allowed_actions: ['submit'], gate: { open: true, conditions: [] },
  approvals: [], audit: [], audit_chain_valid: null, files: {},
  ...over,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/m/${MOD}/records/r1`]}>
      <Routes><Route path="/m/:moduleKey/records/:recordId" element={<GenericRecordPage/>}/></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.listMembers.mockResolvedValue({ items: [] });
});

describe('file fields (F5a)', () => {
  it('uploads the chosen file for this case + field and submits its id', async () => {
    const user = userEvent.setup();
    api.getRecord.mockResolvedValue(detail());
    api.uploadRecordFile.mockResolvedValue({ id: FILE_ID, file_name: 'msme.pdf', content_type: 'application/pdf', size: 2048 });
    api.actOnRecord.mockResolvedValue(detail());
    renderPage();
    await user.type(await screen.findByLabelText(/vendor name/i), 'Acme Supplies');
    const pdf = new File(['%PDF-1.4 test'], 'msme.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Upload file'), pdf);
    await waitFor(() => expect(api.uploadRecordFile).toHaveBeenCalledWith(MOD, 'r1', 'msme_certificate', pdf));
    expect(await screen.findByRole('button', { name: 'msme.pdf' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /submit stage 1/i }));
    await waitFor(() => expect(api.actOnRecord).toHaveBeenCalledWith(MOD, 'r1',
      { action: 'submit', expected_seq: 5, values: { vendor_name: 'Acme Supplies', msme_certificate: FILE_ID } }));
  });

  it('refuses a wrong type before uploading anything', async () => {
    const user = userEvent.setup({ applyAccept: false });
    api.getRecord.mockResolvedValue(detail());
    renderPage();
    await screen.findByLabelText(/vendor name/i);
    await user.upload(screen.getByLabelText('Upload file'), new File(['x'], 'photo.png', { type: 'image/png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('accepts .pdf files only');
    expect(api.uploadRecordFile).not.toHaveBeenCalled();
  });

  it('a submitted file shows by name in the stage summary and opens through a signed URL', async () => {
    const user = userEvent.setup();
    api.getRecord.mockResolvedValue(detail({
      stages: [{ ...detail().stages[0], state: 'submitted', field_values: { vendor_name: 'Acme', msme_certificate: FILE_ID } }],
      next_step: null, allowed_actions: [],
      files: { [FILE_ID]: { file_name: 'msme.pdf', content_type: 'application/pdf', size: 2048, stage: 1, field: 'msme_certificate' } },
      audit: [{ action: 'module_file_uploaded', actor_name: 'Esha Exec', provenance: { policy: 'files', release_version: 1, stage: 1, field: 'msme_certificate', file_name: 'msme.pdf', size: 2048 }, at: '2026-10-04T08:00:00Z' }],
    }));
    api.getRecordFile.mockResolvedValue({ url: 'http://127.0.0.1:54331/storage/v1/object/sign/x?token=t' });
    const fake = { opener: 'x', location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(fake);
    renderPage();
    await user.click(await screen.findByRole('button', { name: /msme\.pdf/ }));
    await waitFor(() => expect(api.getRecordFile).toHaveBeenCalledWith(MOD, FILE_ID));
    expect(fake.location.href).toMatch(/object\/sign/);
    expect(fake.opener).toBeNull();
    expect(screen.getByTestId('file-entry')).toHaveTextContent('Stage 1 · msme_certificate: msme.pdf (2 KB)');
    expect(screen.getByText('File uploaded')).toBeInTheDocument();
  });

  it('checkFile / parseMaxSize mirror the backend hint rules', () => {
    expect(parseMaxSize('2MB')).toBe(2 * 1024 * 1024);
    expect(parseMaxSize('500 kb')).toBe(500 * 1024);
    expect(parseMaxSize('lots')).toBeNull();
    const opts = { accept: '.pdf,.jpeg', maxSize: '1MB' };
    expect(checkFile({ name: 'a.pdf', size: 10 }, opts)).toBeNull();
    expect(checkFile({ name: 'a.JPG', size: 10 }, opts)).toBeNull();
    expect(checkFile({ name: 'a.png', size: 10 }, opts)).toMatch(/accepts/);
    expect(checkFile({ name: 'a.pdf', size: 2 * 1024 * 1024 }, opts)).toMatch(/larger than 1MB/);
    expect(checkFile({ name: 'noext', size: 1 }, opts)).toMatch(/accepts/);
  });
});

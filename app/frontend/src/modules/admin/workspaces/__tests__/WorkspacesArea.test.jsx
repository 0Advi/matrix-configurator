// F4b: the portal side of "publish in the configurator → provision → release", driven by the
// same postMessages the embedded configurator sends (public/configurator/host-bridge.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { platformApi, adminLogin } = vi.hoisted(() => ({
  platformApi: { list: vi.fn(), get: vi.fn(), provision: vi.fn(), validate: vi.fn(), publish: vi.fn(), release: vi.fn() },
  adminLogin: vi.fn(),
}));
vi.mock('../../adminApi.js', () => ({
  platformApi,
  adminLogin: (...a) => adminLogin(...a),
  adminTokenSecondsLeft: () => 1500,
  workspaceLoginUrl: (code) => `http://localhost:5173/#/login/${code}`,
  apiUpload: vi.fn(),
}));

import WorkspacesArea from '../WorkspacesArea.jsx';

const err = (status, body = {}) => Object.assign(new Error(body.detail || `HTTP ${status}`), { status, code: body.code, body });
const CTX = { ref: 'ws_acme', name: 'Acme Retail', slug: 'acme', custom: true, liveV: 0, draftV: 1 };
const MANIFEST = { workspace: { id: 'ws_acme' }, modules: [] };

let frameWin;
function renderArea(props = {}) {
  const onKeyChange = vi.fn();
  render(<WorkspacesArea keyValue="admin-token-1" onKeyChange={onKeyChange} onLogout={vi.fn()} frameSrc="about:blank" {...props}/>);
  frameWin = screen.getByTestId('configurator-frame').contentWindow;
  vi.spyOn(frameWin, 'postMessage');
  return { onKeyChange };
}
function fromFrame(data) {
  act(() => {
    window.dispatchEvent(new window.MessageEvent('message', { data: { source: 'matrix-cfg', ...data }, origin: window.location.origin, source: frameWin }));
  });
}
const toFrame = (type) => frameWin.postMessage.mock.calls.map((c) => c[0]).filter((m) => m.type === type);

beforeEach(() => {
  for (const f of Object.values(platformApi)) f.mockReset();
  adminLogin.mockReset();
  platformApi.list.mockResolvedValue({ items: [], total: 0 });
});

describe('WorkspacesArea', () => {
  it('shows what the app knows about the workspace open in the canvas', async () => {
    platformApi.get.mockResolvedValue({ status: 'active', company: 'Acme Retail', workspace_code: 'ACMERE-ABC', seat_limit: 25, used_seats: 1,
      live_release: { version: 2 }, release_count: 2, business_admin: { email: 'o@acme.example', has_password: false } });
    renderArea();
    fromFrame({ type: 'context', context: CTX });
    expect(await screen.findByTestId('app-workspace-code')).toHaveTextContent('ACMERE-ABC');
    expect(screen.getByText(/release v2 live/i)).toBeInTheDocument();
    expect(screen.getByText(/not claimed yet/i)).toBeInTheDocument();
    expect(platformApi.get).toHaveBeenCalledWith('admin-token-1', 'ws_acme');
  });

  it('stops the publish and lists the findings when the app finds errors', async () => {
    platformApi.get.mockRejectedValue(err(404, { detail: 'not linked' }));
    platformApi.validate.mockResolvedValue({ ok: false, errors: 1, warnings: 1, findings: [
      { severity: 'error', code: 'gate_unknown_source', message: "entry_gate: unknown source 'nope'", module: 'vendor_onboarding' },
      { severity: 'warning', code: 'unparsed_hint', message: 'hint not understood', module: 'vendor_onboarding', stage: 2 },
    ] });
    renderArea();
    fromFrame({ type: 'context', context: CTX });
    fromFrame({ type: 'pre-publish', id: 'pp-1', context: CTX, manifest: MANIFEST, reason: 'go' });
    expect(toFrame('pre-publish-ack')).toEqual([{ source: 'matrix-host', type: 'pre-publish-ack', id: 'pp-1' }]);
    await waitFor(() => expect(toFrame('pre-publish-result')).toHaveLength(1));
    expect(toFrame('pre-publish-result')[0]).toMatchObject({ id: 'pp-1', ok: false });
    expect(screen.getByText(/entry_gate: unknown source 'nope'/)).toBeInTheDocument();
    expect(platformApi.provision).not.toHaveBeenCalled();
  });

  it('first publish: validate → provision dialog → codes once → go ahead → release stored', async () => {
    const user = userEvent.setup();
    platformApi.get.mockRejectedValue(err(404, { detail: 'not linked' }));
    platformApi.validate.mockResolvedValue({ ok: true, errors: 0, warnings: 0, findings: [] });
    platformApi.provision.mockResolvedValue({ configurator_ref: 'ws_acme', tenant_id: 't1', workspace_code: 'ACMERE-C7C3', seat_limit: 25,
      admin_email: 'owner@acme.example', admin_setup_token: 'SETUP-ONCE-123', message: 'Provisioned Acme Retail.' });
    platformApi.publish.mockResolvedValue({ release: { version: 1, manifest_sha256: 'abcdef0123456789' }, findings: [],
      modules: [{ key: 'bd', label: 'BD', enabled: true, kind: 'builtin' }, { key: 'vendor_onboarding', label: 'Vendor Onboarding', enabled: true, kind: 'custom' }] });
    renderArea();
    fromFrame({ type: 'context', context: CTX });
    fromFrame({ type: 'pre-publish', id: 'pp-2', context: CTX, manifest: MANIFEST, reason: 'first' });

    const dlg = await screen.findByRole('dialog', { name: /provision workspace/i });
    expect(within(dlg).getByLabelText('Company')).toHaveValue('Acme Retail');
    await user.type(within(dlg).getByLabelText('Business admin email'), 'owner@acme.example');
    await user.click(within(dlg).getByRole('button', { name: /provision & continue/i }));

    expect(platformApi.provision).toHaveBeenCalledWith('admin-token-1', expect.objectContaining({
      configurator_ref: 'ws_acme', company: 'Acme Retail', admin_email: 'owner@acme.example', seat_limit: 25,
    }));
    const creds = await screen.findByRole('dialog', { name: /workspace created/i });
    expect(within(creds).getByTestId('cred-workspace-code')).toHaveTextContent('ACMERE-C7C3');
    expect(within(creds).getByTestId('cred-setup-code')).toHaveTextContent('SETUP-ONCE-123');
    expect(within(creds).getByText(/shown only once/i)).toBeInTheDocument();
    expect(toFrame('pre-publish-result')).toHaveLength(0);       // waits for the admin to close the codes
    await user.click(within(creds).getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(toFrame('pre-publish-result')).toHaveLength(1));
    expect(toFrame('pre-publish-result')[0]).toMatchObject({ id: 'pp-2', ok: true });
    expect(screen.queryByText('SETUP-ONCE-123')).toBeNull();    // never shown again

    fromFrame({ type: 'published', context: { ...CTX, liveV: 1, draftV: 2 }, version: 1, reason: 'first', manifest: MANIFEST });
    await screen.findByText(/is live in the app/i);
    expect(platformApi.publish).toHaveBeenCalledWith('admin-token-1', 'ws_acme', { manifest: MANIFEST, reason: 'first', sourceRef: 'configurator:ws_acme@v1' });
    expect(toFrame('toast')[0].message).toMatch(/release v1/);
  });

  it('an app refusal after v5 published is shown with a retry', async () => {
    const user = userEvent.setup();
    platformApi.get.mockResolvedValue({ status: 'active', company: 'Acme', workspace_code: 'C', live_release: null });
    platformApi.publish
      .mockRejectedValueOnce(err(422, { detail: 'Manifest refused', code: 'manifest_invalid', findings: [{ severity: 'error', code: 'no_stages', message: 'module has no stages' }] }))
      .mockResolvedValueOnce({ release: { version: 1 }, findings: [], modules: [] });
    renderArea();
    fromFrame({ type: 'published', context: CTX, version: 3, reason: 'r', manifest: MANIFEST });
    expect(await screen.findByText(/module has no stages/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry storing v3/i }));
    await screen.findByText(/is live in the app/i);
  });

  it('an expired admin session asks to sign in again, then retries the call', async () => {
    const user = userEvent.setup();
    platformApi.get.mockResolvedValue({ status: 'active', company: 'Acme', workspace_code: 'C', live_release: null });
    platformApi.validate
      .mockRejectedValueOnce(err(401, { detail: 'expired' }))
      .mockResolvedValueOnce({ ok: true, errors: 0, warnings: 0, findings: [] });
    adminLogin.mockResolvedValue('admin-token-2');
    const { onKeyChange } = renderArea();
    fromFrame({ type: 'pre-publish', id: 'pp-3', context: CTX, manifest: MANIFEST, reason: 'r' });
    const dlg = await screen.findByRole('dialog', { name: /sign in again/i });
    await user.type(within(dlg).getByLabelText('Admin email'), 'platform-admin@example.com');
    await user.type(within(dlg).getByLabelText('Admin password'), 'not-the-real-one');
    await user.click(within(dlg).getByRole('button', { name: /sign in & retry/i }));
    await waitFor(() => expect(toFrame('pre-publish-result')).toHaveLength(1));
    expect(toFrame('pre-publish-result')[0]).toMatchObject({ ok: true });
    expect(onKeyChange).toHaveBeenCalledWith('admin-token-2');
    expect(platformApi.validate).toHaveBeenLastCalledWith('admin-token-2', 'ws_acme', MANIFEST);
  });

  it('Check validates the current draft without publishing', async () => {
    const user = userEvent.setup();
    platformApi.get.mockRejectedValue(err(404, {}));
    platformApi.validate.mockResolvedValue({ ok: true, errors: 0, warnings: 1, findings: [{ severity: 'warning', code: 'unparsed_hint', message: 'free-text hint' }] });
    renderArea();
    fromFrame({ type: 'context', context: CTX });
    await user.click(await screen.findByRole('button', { name: /check draft against the app/i }));
    const [req] = toFrame('request-manifest');
    fromFrame({ type: 'manifest', id: req.id, context: CTX, manifest: MANIFEST });
    expect(await screen.findByText(/would publish cleanly/i)).toBeInTheDocument();
    expect(screen.getByText('free-text hint')).toBeInTheDocument();
    expect(platformApi.publish).not.toHaveBeenCalled();
  });

  it('never posts the admin token to the configurator frame', async () => {
    platformApi.get.mockRejectedValue(err(404, {}));
    platformApi.validate.mockResolvedValue({ ok: false, errors: 1, findings: [{ severity: 'error', code: 'schema', message: 'bad' }] });
    renderArea();
    fromFrame({ type: 'pre-publish', id: 'pp-9', context: CTX, manifest: MANIFEST, reason: 'r' });
    await waitFor(() => expect(toFrame('pre-publish-result')).toHaveLength(1));
    const all = JSON.stringify(frameWin.postMessage.mock.calls);
    expect(all).not.toContain('admin-token-1');
  });
});

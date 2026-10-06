// F5a: the platform-admin portal's Requests and Password-resets tabs re-authenticate on a 401
// (sign in again → the call is retried with the new token) exactly like the Workspaces area —
// they used to log the admin out and lose their place (F4b caveat 6).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiFetch, adminLogin } = vi.hoisted(() => ({ apiFetch: vi.fn(), adminLogin: vi.fn() }));
vi.mock('../adminApi.js', () => ({
  apiFetch, adminLogin, apiUpload: vi.fn(), platformApi: {}, adminTokenSecondsLeft: () => 1800,
  workspaceLoginUrl: (c) => `/#/login/${c}`,
}));
vi.mock('../workspaces/WorkspacesArea.jsx', () => ({ default: () => null }));

// The portal keeps the admin token in module memory: load a fresh copy per test.
let AdminPortalPage;

const expired = () => Object.assign(new Error('Invalid or expired admin token — please log in again.'), { status: 401 });
const REQ = { id: 'q1', company: 'Acme Retail', admin_email: 'owner@acme.example', team_size: '11-50', seat_limit: 50, status: 'pending', created_at: null };

async function signIn(user) {
  await user.type(screen.getByPlaceholderText('admin@scale.bluetokai.com'), 'pa@example.com');
  await user.type(screen.getByPlaceholderText('••••••••'), 'pw');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(async () => {
  apiFetch.mockReset(); adminLogin.mockReset();
  vi.resetModules();
  ({ default: AdminPortalPage } = await import('../AdminPortalPage.jsx'));
});

describe('platform-admin portal re-auth (F5a)', () => {
  it('Requests: a 401 asks to sign in again and retries — no logout', async () => {
    const user = userEvent.setup();
    adminLogin.mockResolvedValueOnce('token-1').mockResolvedValueOnce('token-2');
    apiFetch.mockImplementation(async (path, { key }) => {
      if (key === 'token-1') throw expired();
      return { items: [REQ], total: 1 };
    });
    render(<AdminPortalPage/>);
    await signIn(user);
    const dialog = await screen.findByRole('dialog', { name: /sign in again/i });
    await user.type(screen.getByLabelText('Admin email'), 'pa@example.com');
    await user.type(screen.getByLabelText('Admin password'), 'pw');
    await user.click(screen.getByRole('button', { name: /sign in & retry/i }));
    expect(await screen.findByText('Acme Retail')).toBeInTheDocument();
    expect(dialog).not.toBeInTheDocument();
    expect(apiFetch.mock.calls.map((c) => c[1].key)).toEqual(['token-1', 'token-2']);
    expect(screen.getByRole('tab', { name: 'Requests' })).toBeInTheDocument(); // still in the portal
  });

  it('Password resets: the confirm call is retried after re-auth too', async () => {
    const user = userEvent.setup();
    adminLogin.mockResolvedValueOnce('token-1').mockResolvedValueOnce('token-2');
    apiFetch.mockImplementation(async (path, { key, method }) => {
      if (path.startsWith('/tenancy/requests')) return { items: [], total: 0 };
      if (path === '/tenancy/password-reset-requests') return { items: [{ id: 'r1', email: 'sup@acme.example', tenant_name: 'Acme', workspace_code: 'ACME-1', created_at: null }] };
      if (method === 'POST' && key === 'token-1') throw expired();
      return { id: 'r1', status: 'approved', reset_token: 'ONE-TIME-RESET-CODE' };
    });
    render(<AdminPortalPage/>);
    await signIn(user);
    await user.click(await screen.findByRole('tab', { name: 'Password resets' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));
    await screen.findByRole('dialog', { name: /sign in again/i });
    await user.type(screen.getByLabelText('Admin email'), 'pa@example.com');
    await user.type(screen.getByLabelText('Admin password'), 'pw');
    await user.click(screen.getByRole('button', { name: /sign in & retry/i }));
    expect(await screen.findByText('ONE-TIME-RESET-CODE')).toBeInTheDocument();
  });

  it('cancelling the re-auth keeps the portal open and shows the error', async () => {
    const user = userEvent.setup();
    adminLogin.mockResolvedValueOnce('token-1');
    apiFetch.mockRejectedValue(expired());
    render(<AdminPortalPage/>);
    await signIn(user);
    await screen.findByRole('dialog', { name: /sign in again/i });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(/sign-in cancelled/i)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Requests' })).toBeInTheDocument();
  });
});

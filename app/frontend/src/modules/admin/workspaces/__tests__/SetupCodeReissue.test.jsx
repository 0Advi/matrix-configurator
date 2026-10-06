// F5a (SEC-1): /#/admin → Workspaces → Details. A business admin who has not claimed the account
// can only do so with a one-time setup code; the platform admin can issue a new one (earlier
// codes stop working). Claimed admins get no button; a backend refusal is shown, not swallowed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { platformApi } = vi.hoisted(() => ({
  platformApi: { reissueSetupCode: vi.fn(), get: vi.fn(), list: vi.fn(), migrations: vi.fn() },
}));
vi.mock('../../adminApi.js', () => ({ platformApi, workspaceLoginUrl: (c) => `/#/login/${c}` }));

import { SetupCodeReissue } from '../WorkspacesList.jsx';

const withAuth = (fn) => fn('admin-token');

beforeEach(() => { platformApi.reissueSetupCode.mockReset(); });

describe('SetupCodeReissue', () => {
  it('issues a new code once and shows it with the share-privately note', async () => {
    platformApi.reissueSetupCode.mockResolvedValue({
      admin_email: 'owner@acme.example', admin_setup_token: 'NEW-ONE-TIME-CODE', expires_at: '2026-11-05T00:00:00Z',
    });
    render(<SetupCodeReissue refId="ws_acme" withAuth={withAuth}/>);
    await userEvent.click(screen.getByRole('button', { name: /issue a new setup code/i }));
    expect(platformApi.reissueSetupCode).toHaveBeenCalledWith('admin-token', 'ws_acme');
    expect(await screen.findByTestId('reissued-setup-code')).toHaveTextContent('NEW-ONE-TIME-CODE');
    expect(screen.getByRole('note', { name: /new setup code/i })).toHaveTextContent(/shown only once/i);
    expect(screen.getByRole('note', { name: /new setup code/i })).toHaveTextContent(/earlier codes no longer work/i);
    expect(screen.queryByRole('button', { name: /issue a new setup code/i })).toBeNull();
  });

  it('shows the backend refusal (e.g. the admin claimed the account meanwhile)', async () => {
    platformApi.reissueSetupCode.mockRejectedValue(new Error('The business admin has already claimed the account'));
    render(<SetupCodeReissue refId="ws_acme" withAuth={withAuth}/>);
    await userEvent.click(screen.getByRole('button', { name: /issue a new setup code/i }));
    expect(await screen.findByText(/already claimed/i)).toBeInTheDocument();
    expect(screen.queryByTestId('reissued-setup-code')).toBeNull();
  });
});

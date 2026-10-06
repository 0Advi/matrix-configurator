// F5a: the logo upload in the "Workspace created" dialog (exercised live on localhost: upload →
// GET /tenancy/branding → signed URL → the branded login page renders it). Here: the multipart body
// and the re-auth path (a 401 is retried through the portal's withAuth instead of failing).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiUpload } = vi.hoisted(() => ({ apiUpload: vi.fn() }));
vi.mock('../adminApi.js', () => ({ apiUpload, workspaceLoginUrl: (c) => `http://localhost:5173/#/login/${c}` }));

import CredentialsDialog from '../CredentialsDialog.jsx';

const RESULT = { tenant_id: 't-1', workspace_code: 'ACME-1234', company: 'Acme', seat_limit: 25, admin_setup_token: 'SETUP-CODE-1' };

beforeEach(() => apiUpload.mockReset());

describe('CredentialsDialog — branding (F5a)', () => {
  it('sends name + logo as multipart through withAuth', async () => {
    const user = userEvent.setup();
    apiUpload.mockResolvedValue({ id: 't-1', name: 'Acme Retail', has_logo: true });
    const withAuth = vi.fn((fn) => fn('fresh-token'));
    const { container } = render(<CredentialsDialog result={RESULT} keyValue="old-token" withAuth={withAuth} variant="configurator" onClose={() => {}}/>);
    const name = screen.getByPlaceholderText('Blue Tokai Coffee');
    await user.clear(name);
    await user.type(name, 'Acme Retail');
    const logo = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' });
    await user.upload(container.querySelector('input[type=file]'), logo);
    await user.click(screen.getByRole('button', { name: /save branding/i }));
    expect(await screen.findByText(/login page is ready/i)).toBeInTheDocument();
    expect(withAuth).toHaveBeenCalledTimes(1);
    const [path, { key, formData }] = apiUpload.mock.calls[0];
    expect(path).toBe('/tenancy/tenants/t-1/branding');
    expect(key).toBe('fresh-token');
    expect(formData.get('name')).toBe('Acme Retail');
    expect(formData.get('logo').name).toBe('logo.png');
  });

  it('without withAuth (older callers) it still uploads with the given key', async () => {
    const user = userEvent.setup();
    apiUpload.mockResolvedValue({ has_logo: false });
    render(<CredentialsDialog result={RESULT} keyValue="the-key" onClose={() => {}}/>);
    await user.click(screen.getByRole('button', { name: /save branding/i }));
    expect(apiUpload.mock.calls[0][1].key).toBe('the-key');
  });
});

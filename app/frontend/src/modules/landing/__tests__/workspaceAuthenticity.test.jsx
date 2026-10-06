// F4b — workspace-code authenticity on the login side.
//
// /tenancy/branding answers a real code with the company name and an unknown one with an
// explicit `name: null`. The dialog must stop a fake code BEFORE the user reaches a sign-in
// form; the branded login page must say "Workspace not found" for it; a real code shows the
// company. A response without a `name` key (older uniform backend) keeps the old flow.
// Also: a provisioned business admin claims the account with the one-time setup code.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const getWorkspaceBranding = vi.fn();
const checkAccountState = vi.fn();
const setupPassword = vi.fn();
const completePasswordReset = vi.fn();
const signInWithWorkspaceCode = vi.fn();

vi.mock('../../../services/api/supabaseAuth.js', () => ({
  getWorkspaceBranding: (...a) => getWorkspaceBranding(...a),
  checkAccountState: (...a) => checkAccountState(...a),
  setupPassword: (...a) => setupPassword(...a),
  completePasswordReset: (...a) => completePasswordReset(...a),
  signInWithWorkspaceCode: (...a) => signInWithWorkspaceCode(...a),
  requestPasswordReset: vi.fn(),
  signupAsSupervisor: vi.fn(), signupAsExecutive: vi.fn(), signupAsObserver: vi.fn(),
  PendingApprovalError: class extends Error {}, InvalidCredentialsError: class extends Error {},
}));
vi.mock('../LottiePanel.jsx', () => ({ default: () => null }));
vi.mock('../../../assets/lottie/workspace-community.json', () => ({ default: {} }));

import WorkspaceCodeDialog from '../WorkspaceCodeDialog.jsx';
import BrandedLoginPage from '../BrandedLoginPage.jsx';
import { isUnknownWorkspace } from '../workspaceLookup.js';

class MemoryStorage {
  #map = new Map();
  getItem(k) { return this.#map.has(k) ? this.#map.get(k) : null; }
  setItem(k, v) { this.#map.set(k, String(v)); }
  removeItem(k) { this.#map.delete(k); }
  clear() { this.#map.clear(); }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  for (const f of [getWorkspaceBranding, checkAccountState, setupPassword, completePasswordReset, signInWithWorkspaceCode]) f.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('isUnknownWorkspace', () => {
  it('is true only for an explicit null/empty name', () => {
    expect(isUnknownWorkspace({ name: null, logo_url: null })).toBe(true);
    expect(isUnknownWorkspace({ name: '' })).toBe(true);
    expect(isUnknownWorkspace({ name: 'Acme Retail' })).toBe(false);
    expect(isUnknownWorkspace({})).toBe(false);   // older uniform backend: cannot tell
    expect(isUnknownWorkspace(null)).toBe(false);
  });
});

function renderDialog() {
  return render(
    <MemoryRouter initialEntries={['/welcome']}>
      <Routes>
        <Route path="/welcome" element={<WorkspaceCodeDialog open onClose={vi.fn()}/>}/>
        <Route path="/login/:code" element={<div>LOGIN PAGE</div>}/>
      </Routes>
    </MemoryRouter>,
  );
}

describe('WorkspaceCodeDialog', () => {
  it('rejects a well-formed but fake code before any sign-in form', async () => {
    getWorkspaceBranding.mockResolvedValue({ name: null, logo_url: null });
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByRole('combobox'), 'FAKEWS-0000000000000000');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t find a workspace/i);
    expect(screen.queryByText('LOGIN PAGE')).toBeNull();
    expect(localStorage.getItem('zm_workspace_codes')).toBeNull();
  });

  it('continues to the branded login page for a real code', async () => {
    getWorkspaceBranding.mockResolvedValue({ name: 'Acme Retail', logo_url: null });
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByRole('combobox'), 'acmere-c7c3eccf78ab3d2b');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
    expect(getWorkspaceBranding).toHaveBeenCalledWith('ACMERE-C7C3ECCF78AB3D2B');
    expect(JSON.parse(localStorage.getItem('zm_workspace_codes'))).toEqual(['ACMERE-C7C3ECCF78AB3D2B']);
  });
});

function renderLogin(code) {
  return render(
    <MemoryRouter initialEntries={[`/login/${code}`]}>
      <Routes>
        <Route path="/login/:code" element={<BrandedLoginPage/>}/>
        <Route path="/business-admin" element={<div>BA PORTAL</div>}/>
        <Route path="/m/:key" element={<div>CUSTOM MODULE PAGE</div>}/>
      </Routes>
    </MemoryRouter>,
  );
}

describe('BrandedLoginPage', () => {
  it('shows "Workspace not found" (no email form) for an unknown code', async () => {
    getWorkspaceBranding.mockResolvedValue({ name: null, logo_url: null });
    renderLogin('FAKEWS-0000');
    expect(await screen.findByRole('heading', { name: /workspace not found/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/work email/i)).toBeNull();
  });

  it('shows the company name for a real code', async () => {
    getWorkspaceBranding.mockResolvedValue({ name: 'Acme Retail', logo_url: null });
    renderLogin('ACMERE-1234');
    expect(await screen.findByRole('heading', { name: 'Acme Retail' })).toBeInTheDocument();
    expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
  });

  it('a business admin claims the account with the setup code (password-reset/complete)', async () => {
    getWorkspaceBranding.mockResolvedValue({ name: 'Acme Retail', logo_url: null });
    checkAccountState.mockResolvedValue('needs_password');
    completePasswordReset.mockResolvedValue({ ok: true });
    // A BA token (role business_admin) → the page routes to /business-admin.
    const payload = btoa(JSON.stringify({ app_metadata: { role: 'business_admin' } }));
    signInWithWorkspaceCode.mockResolvedValue({ access_token: `x.${payload}.y` });
    const user = userEvent.setup();
    renderLogin('ACMERE-1234');
    await user.type(await screen.findByLabelText(/work email/i), 'owner@acme.example');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(await screen.findByLabelText(/setup code/i), 'ONE-TIME-CODE-123');
    await user.type(screen.getByLabelText(/^new password/i), 'Sandbox#pass1');
    await user.type(screen.getByLabelText(/confirm password/i), 'Sandbox#pass1');
    await user.click(screen.getByRole('button', { name: /create password/i }));
    expect(await screen.findByText('BA PORTAL')).toBeInTheDocument();
    expect(completePasswordReset).toHaveBeenCalledWith('owner@acme.example', 'ACMERE-1234', 'Sandbox#pass1', 'ONE-TIME-CODE-123');
    expect(setupPassword).not.toHaveBeenCalled();
  });

  // F5a / SEC-1: the code-less first-password path is gone. Without the one-time setup
  // code nobody — not the owner, not someone who merely knows the email and workspace
  // code — can set the first password of an approved account.
  it('without a setup code the account cannot be claimed', async () => {
    getWorkspaceBranding.mockResolvedValue({ name: 'Acme Retail', logo_url: null });
    checkAccountState.mockResolvedValue('needs_password');
    const user = userEvent.setup();
    renderLogin('ACMERE-1234');
    await user.type(await screen.findByLabelText(/work email/i), 'exec@acme.example');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/setup code from your platform admin/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^new password/i), 'Sandbox#pass1');
    await user.type(screen.getByLabelText(/confirm password/i), 'Sandbox#pass1');
    await user.click(screen.getByRole('button', { name: /create password/i }));
    expect(await screen.findByText(/enter the one-time setup code/i)).toBeInTheDocument();
    expect(setupPassword).not.toHaveBeenCalled();
    expect(completePasswordReset).not.toHaveBeenCalled();
    expect(signInWithWorkspaceCode).not.toHaveBeenCalled();
    // …and it offers the supported way to get one (the platform admin's reset queue).
    expect(screen.getByRole('button', { name: /no setup code\? request one/i })).toBeInTheDocument();
  });

  it('a staff member who chose a password at signup signs straight in (custom module page)', async () => {
    getWorkspaceBranding.mockResolvedValue({ name: 'Acme Retail', logo_url: null });
    checkAccountState.mockResolvedValue('active');
    const payload = btoa(JSON.stringify({ app_metadata: { role: 'executive', module: 'vendor_onboarding' } }));
    signInWithWorkspaceCode.mockResolvedValue({ access_token: `x.${payload}.y` });
    const user = userEvent.setup();
    renderLogin('ACMERE-1234');
    await user.type(await screen.findByLabelText(/work email/i), 'exec@acme.example');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(await screen.findByLabelText(/^password/i), 'Chosen#pw1');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    // A custom-module claim lands on its generic module page.
    expect(await screen.findByText('CUSTOM MODULE PAGE')).toBeInTheDocument();
    expect(signInWithWorkspaceCode).toHaveBeenCalledWith('exec@acme.example', 'ACMERE-1234', 'Chosen#pw1');
  });
});

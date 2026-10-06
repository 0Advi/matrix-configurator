// F5a: the API now refuses (403) every route of a built-in module the tenant's published
// configuration switched off. The business-admin portal must therefore not even ask for such a
// module's queue — whenModuleEnabled() answers an empty list instead, from the shared
// GET /workspace/modules store (one fetch per token). It errs on "enabled" when it cannot tell.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { get, token } = vi.hoisted(() => ({ get: vi.fn(), token: { value: 'tok-1' } }));
vi.mock('../../services/api/axiosClient.js', () => ({ createApiClient: () => ({ get }) }));
vi.mock('../../services/api/authToken.js', () => ({
  getAuthToken: () => token.value,
  subscribeAuthToken: () => () => {},
}));

const { whenModuleEnabled, isModuleEnabled, __resetWorkspaceModules } = await import('../useWorkspaceModules.js');

const MODULES = { release: { version: 2 }, modules: [{ key: 'bd' }, { key: 'legal' }, { key: 'vendor_onboarding' }] };

beforeEach(() => {
  __resetWorkspaceModules();
  get.mockReset();
  token.value = 'tok-1';
});

describe('whenModuleEnabled', () => {
  it('skips the request for a module the release switched off, calls it for an enabled one', async () => {
    get.mockResolvedValue({ data: MODULES });
    const launchQueue = vi.fn().mockResolvedValue({ items: [{ id: 1 }], total: 1 });
    const bdQueue = vi.fn().mockResolvedValue({ items: [{ id: 2 }], total: 1 });
    expect(await whenModuleEnabled('launch_approval', launchQueue)()).toEqual({ items: [], total: 0 });
    expect(launchQueue).not.toHaveBeenCalled();
    expect(await whenModuleEnabled('bd', bdQueue)()).toEqual({ items: [{ id: 2 }], total: 1 });
    // one /workspace/modules call shared by both
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/workspace/modules');
  });

  it('a custom empty value can be supplied (the finance queue is a bare list)', async () => {
    get.mockResolvedValue({ data: MODULES });
    expect(await whenModuleEnabled('finance_ca', vi.fn(), () => [])()).toEqual([]);
  });

  it('errs on "enabled" when signed out or when the modules call fails', async () => {
    token.value = null;
    expect(await isModuleEnabled('launch_approval')).toBe(true);
    token.value = 'tok-2';
    get.mockRejectedValue(new Error('network down'));
    expect(await isModuleEnabled('launch_approval')).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

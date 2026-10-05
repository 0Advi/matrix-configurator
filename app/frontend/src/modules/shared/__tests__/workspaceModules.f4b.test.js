// F4b: data-driven module lists. The static WORKSPACE_MODULES stays the fallback; the tenant's
// published release (GET /workspace/modules) decides what switchers offer.
import { describe, it, expect } from 'vitest';
import {
  WORKSPACE_MODULES, isCustomModuleKey, customModuleRoute, switcherModules,
  workspaceModuleRoute, workspaceModuleLabel,
} from '../workspaceModules.js';

const api = [
  { key: 'bd', label: 'BP – Site identification', kind: 'builtin', position: 10, has_membership: true, supervisor_only: false, route: '/' },
  { key: 'legal', label: 'Legal clearance', kind: 'builtin', position: 20, has_membership: true, supervisor_only: false, route: '/legal' },
  { key: 'finance_ca', label: 'Finance', kind: 'builtin', position: 30, has_membership: false, route: null },
  { key: 'nso', label: 'NSO', kind: 'builtin', position: 60, has_membership: true, supervisor_only: true, route: '/nso' },
  { key: 'vendor_onboarding', label: 'Vendor Onboarding', kind: 'custom', position: 120, has_membership: true, supervisor_only: false, route: '/m/vendor_onboarding' },
];

describe('isCustomModuleKey', () => {
  it('is true for a valid key that is not a built-in or reserved word', () => {
    expect(isCustomModuleKey('vendor_onboarding')).toBe(true);
    expect(isCustomModuleKey('qa2')).toBe(true);
  });
  it('is false for built-ins, reserved words, bad shapes and non-strings', () => {
    for (const k of ['bd', 'legal', 'project_excellence', 'finance_ca', 'launch_approval', 'financial_closure', 'nso', 'design', 'project']) {
      expect(isCustomModuleKey(k)).toBe(false);
    }
    for (const k of ['admin', 'sites', 'modules', 'Vendor', '1abc', 'a', '', null, undefined, 42]) {
      expect(isCustomModuleKey(k)).toBe(false);
    }
  });
});

describe('switcherModules', () => {
  it('falls back to the static list without an API answer', () => {
    expect(switcherModules(undefined)).toBe(WORKSPACE_MODULES);
    expect(switcherModules([])).toBe(WORKSPACE_MODULES);
  });

  it('keeps release order, drops team-less modules, and routes custom modules to /m/<key>', () => {
    const out = switcherModules(api);
    expect(out.map((m) => m.value)).toEqual(['bd', 'legal', 'nso', 'vendor_onboarding']);
    expect(out.find((m) => m.value === 'vendor_onboarding')).toMatchObject({
      label: 'Vendor Onboarding', route: '/m/vendor_onboarding', kind: 'custom',
    });
  });

  it('keeps the familiar short labels and bespoke routes for built-ins', () => {
    const out = switcherModules(api);
    expect(out.find((m) => m.value === 'bd')).toMatchObject({ label: 'BD', route: '/', kind: 'builtin' });
    expect(out.find((m) => m.value === 'nso')).toMatchObject({ label: 'NSO', supervisorOnly: true });
  });

  it('a disabled module is simply absent (the API lists enabled modules only)', () => {
    const out = switcherModules(api.filter((m) => m.key !== 'legal'));
    expect(out.some((m) => m.value === 'legal')).toBe(false);
  });
});

describe('workspaceModuleRoute / workspaceModuleLabel', () => {
  it('routes an unknown custom key to its generic page, anything else unknown to /', () => {
    expect(workspaceModuleRoute('vendor_onboarding')).toBe('/m/vendor_onboarding');
    expect(workspaceModuleRoute('admin')).toBe('/');
    expect(customModuleRoute('qa_audit')).toBe('/m/qa_audit');
  });
  it('labels only modules it knows (never a raw slug)', () => {
    expect(workspaceModuleLabel('something_new')).toBeNull();
    expect(workspaceModuleLabel('vendor_onboarding', switcherModules(api))).toBe('Vendor Onboarding');
  });
});

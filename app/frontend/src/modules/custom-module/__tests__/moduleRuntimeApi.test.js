// F4b: mapping backend refusals for the generic module pages.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../services/api/axiosClient.js', () => ({ createApiClient: () => ({ get: vi.fn(), post: vi.fn() }) }));

import { problemOf, toExtraErrors } from '../../../services/api/moduleRuntimeApi.js';
import { filterCases } from '../GenericModulePage.jsx';
import { customNavItems } from '../../shared/chrome/Sidebar.jsx';
import { tierFilter } from '../widgets.jsx';

const schema = { type: 'object', properties: { gst_number: { type: 'string' }, credit_days: { type: 'number' } } };

describe('toExtraErrors', () => {
  it('puts "field: message" errors under the field', () => {
    expect(toExtraErrors(["gst_number: 'x' does not match '^[0-9]{2}'", 'credit_days: 500 is greater than the maximum of 120'], schema)).toEqual({
      gst_number: { __errors: ["'x' does not match '^[0-9]{2}'"] },
      credit_days: { __errors: ['500 is greater than the maximum of 120'] },
    });
  });
  it('sends unaddressed or unknown-field errors to the form root', () => {
    expect(toExtraErrors(['something odd', 'nope: missing'], schema)).toEqual({
      __errors: ['something odd', 'nope: missing'],
    });
  });
  it('uses the first segment of a nested path', () => {
    expect(toExtraErrors(['gst_number.0: bad'], schema)).toEqual({ gst_number: { __errors: ['bad'] } });
  });
});

describe('problemOf', () => {
  it('recovers code, gate and errors from an ApiError-wrapped axios error', () => {
    const err = Object.assign(new Error('locked'), {
      status: 409,
      cause: { response: { status: 409, data: { detail: 'Vendor onboarding is locked', code: 'gate_closed', gate: { open: false, conditions: [] } } } },
    });
    expect(problemOf(err)).toMatchObject({ status: 409, code: 'gate_closed', detail: 'Vendor onboarding is locked', gate: { open: false } });
  });
  it('flattens FastAPI list-shaped details', () => {
    const err = { status: 422, cause: { response: { data: { detail: [{ msg: 'field required' }, { msg: 'bad uuid' }] } } } };
    expect(problemOf(err).detail).toBe('field required; bad uuid');
  });
  it('keeps record_id for record_exists', () => {
    const err = { status: 409, cause: { response: { data: { detail: 'exists', code: 'record_exists', record_id: 'r1' } } } };
    expect(problemOf(err).recordId).toBe('r1');
  });
});

describe('filterCases (sidebar views)', () => {
  const items = [
    { id: 1, allowed_actions: ['submit'], next_step: { kind: 'submit' }, case_status: 'in_progress' },
    { id: 2, allowed_actions: [], next_step: { kind: 'approve' }, case_status: 'in_progress' },
    { id: 3, allowed_actions: [], next_step: null, case_status: 'completed' },
    { id: 4, allowed_actions: [], next_step: null, case_status: 'rejected' },
  ];
  it('splits the list into my turn / awaiting approval / closed', () => {
    expect(filterCases(items, '').map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(filterCases(items, 'queue').map((r) => r.id)).toEqual([1]);
    expect(filterCases(items, 'review').map((r) => r.id)).toEqual([2]);
    expect(filterCases(items, 'history').map((r) => r.id)).toEqual([3, 4]);
  });
});

describe('customNavItems (sidebar from the published navigation)', () => {
  const mod = { key: 'vendor_onboarding', label: 'Vendor Onboarding', navigation: [{ section: 'Vendor Onboarding', items: [
    { label: 'Overview', page: 'overview', roles: ['supervisor', 'executive'] },
    { label: 'Queue', page: 'queue', roles: ['supervisor', 'executive'] },
    { label: 'Checklist review', page: 'review', roles: ['supervisor'] },
    { label: 'History', page: 'history', roles: ['supervisor', 'executive'] },
  ] }] };
  it('maps configurator pages onto the generic page views', () => {
    const [sec] = customNavItems(mod, 'supervisor');
    expect(sec.section).toBe('Vendor Onboarding');
    expect(sec.items.map((i) => [i.label, i.view])).toEqual([['Overview', ''], ['Queue', 'queue'], ['Checklist review', 'review'], ['History', 'history']]);
  });
  it('hides items whose roles exclude the user (exec alias included)', () => {
    const [sec] = customNavItems(mod, 'exec');
    expect(sec.items.map((i) => i.label)).toEqual(['Overview', 'Queue', 'History']);
  });
  it('falls back to default views when the release has no navigation', () => {
    const [sec] = customNavItems({ key: 'x_mod', navigation: [] }, 'supervisor');
    expect(sec.items.map((i) => i.view)).toEqual(['', 'queue', 'review', 'history']);
  });
});

describe('MatrixPersonWidget tier filter', () => {
  const members = [{ id: 'a', role_in_module: 'supervisor' }, { id: 'b', role_in_module: 'executive' }];
  it('filters by the tier named in the hint', () => {
    expect(tierFilter(members, 'executive').map((m) => m.id)).toEqual(['b']);
    expect(tierFilter(members, 'Supervisor tier').map((m) => m.id)).toEqual(['a']);
    expect(tierFilter(members, '').map((m) => m.id)).toEqual(['a', 'b']);
  });
});

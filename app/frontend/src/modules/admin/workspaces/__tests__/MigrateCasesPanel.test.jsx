// G3 #2: "Migrate running cases" in /#/admin → Workspaces → Details — dry run first, a reason and a
// confirmation before anything moves (responses shaped like app-stack/smoke-g3.mjs's).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { platformApi } = vi.hoisted(() => ({ platformApi: { migrate: vi.fn(), migrations: vi.fn() } }));
vi.mock('../../adminApi.js', () => ({ platformApi }));

import MigrateCasesPanel from '../MigrateCasesPanel.jsx';

const WS = {
  releases: [{ id: 'r2', version: 2, is_live: true }, { id: 'r1', version: 1, is_live: false }],
  modules: [{ key: 'g3_vendor', label: 'G3 Vendor', kind: 'custom' }, { key: 'bd', label: 'BD', kind: 'builtin' }],
};
const withAuth = (fn) => fn('admin-token');
const item = (id, outcome, over = {}) => ({
  record_id: id, module_key: 'g3_vendor', site: { id: `s-${id}`, name: `Site ${id}`, code: 'G3-1' }, from_version: 1, to_version: 2,
  case_status: 'in_progress', in_flight: true, compatible: outcome === 'would_migrate' || outcome === 'migrated', co_migrated: false, outcome,
  blocking: [], warnings: [], stage: { before: { order: 2, name: 'Compliance check', role: 'supervisor' }, after: { order: 2, name: 'Compliance check', role: 'supervisor' } },
  stage_mapping: [{ from: { order: 1 }, to: { order: 1 }, how: 'same' }, { from: { order: 3 }, to: null, how: 'unmapped' }],
  fields: { kept: [{ stage: 1, field: 'vendor_name' }], dropped: [] }, approvals_carried: 2, ...over,
});
const DRY = { dry_run: true, migration_id: null, from: { spec: 'all_older' }, to: { version: 2 }, summary: { records: 2, sites: 2, compatible: 1, blocked: 1 },
  items: [item('A', 'would_migrate'), item('B', 'blocked', { stage: { before: { order: 3, name: 'Sign-off' }, after: null },
    blocking: [{ code: 'stage_missing', message: 'Current stage 3 “Sign-off” has no counterpart in v2.' }] })] };

beforeEach(() => {
  platformApi.migrate.mockReset();
  platformApi.migrations.mockReset().mockResolvedValue({ items: [] });
});

describe('MigrateCasesPanel', () => {
  it('dry run -> compatibility table -> reason + confirm -> execute', async () => {
    platformApi.migrate.mockResolvedValueOnce(DRY).mockResolvedValueOnce({
      ...DRY, dry_run: false, migration_id: 'abcdef12-0000', summary: { records: 2, sites: 2, compatible: 1, blocked: 1, by_outcome: { migrated: 1, skipped: 1 } },
      items: [item('A', 'migrated'), { ...DRY.items[1], outcome: 'skipped' }] });
    render(<MigrateCasesPanel refId="ws_g3" ws={WS} withAuth={withAuth}/>);
    await userEvent.click(screen.getByLabelText('G3 Vendor'));
    await userEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    const table = await screen.findByRole('table', { name: 'Migration dry run' });
    expect(platformApi.migrate.mock.calls[0]).toEqual(['admin-token', 'ws_g3', { from_release_version: 'all_older', to_release_version: 2,
      scope: { module_keys: ['g3_vendor'] }, restart_stage_on_chain_change: false, dry_run: true }]);
    expect(within(table).getByText('compatible')).toBeInTheDocument();
    expect(within(table).getByText('blocked')).toBeInTheDocument();
    expect(within(table).getByText(/no counterpart in v2/)).toBeInTheDocument();
    expect(within(table).getAllByText(/3→∅ \(unmapped\)/)).toHaveLength(2);

    const go = screen.getByRole('button', { name: /Migrate 1 case/ });
    expect(go).toBeDisabled();                                   // a reason is mandatory
    await userEvent.type(screen.getByLabelText('Migration reason'), 'Hot-fix: sign-off removed');
    await userEvent.click(go);
    expect(platformApi.migrate).toHaveBeenCalledTimes(1);        // still only the dry run: confirm first
    await userEvent.click(screen.getByRole('button', { name: 'Confirm migration' }));
    await waitFor(() => expect(platformApi.migrate).toHaveBeenCalledTimes(2));
    expect(platformApi.migrate.mock.calls[1][2]).toMatchObject({ dry_run: false, reason: 'Hot-fix: sign-off removed', to_release_version: 2 });
    const result = await screen.findByRole('table', { name: 'Migration result' });
    expect(within(result).getByText('migrated')).toBeInTheDocument();
    expect(within(result).getByText('skipped')).toBeInTheDocument();
    expect(screen.getByText(/1 migrated, 1 skipped/)).toBeInTheDocument();
    expect(platformApi.migrations).toHaveBeenCalledTimes(2);    // history refreshed after executing
  });

  it('needs two releases', () => {
    render(<MigrateCasesPanel refId="ws_g3" ws={{ releases: [WS.releases[0]], modules: [] }} withAuth={withAuth}/>);
    expect(screen.getByText(/Needs at least two releases/)).toBeInTheDocument();
  });

  it('shows the backend refusal', async () => {
    platformApi.migrate.mockRejectedValue(new Error('Release v9 does not exist.'));
    render(<MigrateCasesPanel refId="ws_g3" ws={WS} withAuth={withAuth}/>);
    await userEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Release v9 does not exist.');
  });
});

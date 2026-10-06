// F5a: "Migrate running cases" — optional re-pin of sites with NO running case (include_idle_sites),
// executable even when no running case moves, and the history shows a stalled / recovered run.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { platformApi } = vi.hoisted(() => ({ platformApi: { migrate: vi.fn(), migrations: vi.fn() } }));
vi.mock('../../adminApi.js', () => ({ platformApi }));

import MigrateCasesPanel from '../MigrateCasesPanel.jsx';

const WS = {
  releases: [{ id: 'r3', version: 3, is_live: true }, { id: 'r2', version: 2 }, { id: 'r1', version: 1 }],
  modules: [{ key: 'g3_vendor', label: 'G3 Vendor', kind: 'custom' }],
};
const withAuth = (fn) => fn('admin-token');
const idleSite = (outcome) => ({ site: { id: 's1', name: 'G3 S1', code: 'G3-1' }, from_version: 2, to_version: 3, finished_cases: 1, outcome });
const DRY = { dry_run: true, migration_id: null, from: { spec: 'all_older' }, to: { version: 3 },
  summary: { records: 0, sites: 0, compatible: 0, blocked: 0, idle_sites: { total: 1, by_outcome: { would_repin: 1 } } },
  items: [], idle_sites: [idleSite('would_repin')] };

beforeEach(() => {
  platformApi.migrate.mockReset();
  platformApi.migrations.mockReset().mockResolvedValue({ items: [] });
});

describe('MigrateCasesPanel — F5a', () => {
  it('sends include_idle_sites, lists idle sites, and can execute a re-pin-only migration', async () => {
    platformApi.migrate.mockResolvedValueOnce(DRY).mockResolvedValueOnce({
      ...DRY, dry_run: false, migration_id: 'abcdef12-0000',
      summary: { ...DRY.summary, by_outcome: {}, idle_sites: { total: 1, by_outcome: { repinned: 1 } } },
      idle_sites: [idleSite('repinned')] });
    render(<MigrateCasesPanel refId="ws_g3" ws={WS} withAuth={withAuth}/>);
    await userEvent.click(screen.getByLabelText(/also re-pin sites with no running case/i));
    await userEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(platformApi.migrate.mock.calls[0][2]).toMatchObject({ include_idle_sites: true, dry_run: true });
    expect(await screen.findByLabelText('Sites with no running case')).toHaveTextContent(/G3 S1.*v2 → v3.*1 finished case\(s\) stay/);
    await userEvent.type(screen.getByLabelText('Migration reason'), 'Move idle sites onto v3');
    await userEvent.click(screen.getByRole('button', { name: /re-pin 1 idle site/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm migration' }));
    expect(platformApi.migrate.mock.calls[1][2]).toMatchObject({ include_idle_sites: true, dry_run: false, reason: 'Move idle sites onto v3' });
    expect(await screen.findByText(/1 idle site\(s\) re-pinned/)).toBeInTheDocument();
  });

  it('without the option nothing extra is sent (G3 behaviour)', async () => {
    platformApi.migrate.mockResolvedValueOnce({ ...DRY, idle_sites: undefined });
    render(<MigrateCasesPanel refId="ws_g3" ws={WS} withAuth={withAuth}/>);
    await userEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(platformApi.migrate.mock.calls[0][2]).not.toHaveProperty('include_idle_sites');
  });

  it('history: a stalled run and a recovered one are labelled', async () => {
    platformApi.migrations.mockResolvedValue({ items: [
      { id: 'm1', status: 'running', stale: true, from: 'v1', to_version: 2, actor: 'pa', reason: 'x', created_at: null, summary: null },
      { id: 'm2', status: 'failed', stale: false, from: 'v1', to_version: 2, actor: 'pa', reason: 'y', created_at: null,
        summary: { recovered: true, failure: 'The process running this migration stopped before it finished.' } },
    ] });
    render(<MigrateCasesPanel refId="ws_g3" ws={WS} withAuth={withAuth}/>);
    expect(await screen.findByText('stalled')).toBeInTheDocument();
    expect(screen.getByText('failed · recovered')).toBeInTheDocument();
    expect(screen.getByText(/stopped before it finished/)).toBeInTheDocument();
  });
});

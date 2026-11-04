import { describe, it, expect } from 'vitest';
import { handleAdminInteraction, type AdminDeps, type Block, type StoredRun } from './admin-page';
import type { SyncReport } from '../sync/types';

const report: SyncReport = {
  created: [{ entryId: 'e1', shopifyId: '101', handle: 'blue-mug', title: 'Blue Mug', slug: 'blue-mug' }],
  flagged: [{ entryId: 'e2', shopifyId: '102', slug: 'red-mug', title: 'Red Mug' }],
  unchanged: 7,
  warnings: ['The shop-data cache could not be purged (boom).'],
};

function setup(options: { stored?: StoredRun | null; outcome?: StoredRun } = {}) {
  let stored = options.stored ?? null;
  let syncs = 0;
  const deps: AdminDeps = {
    async sync() {
      syncs += 1;
      return options.outcome ?? { at: '2026-11-04T12:00:00.000Z', report };
    },
    async lastRun() {
      return stored;
    },
    async saveRun(run) {
      stored = run;
    },
  };
  return { deps, syncs: () => syncs, stored: () => stored };
}

const ofType = (blocks: Block[], type: string) => blocks.filter((block) => block.type === type);
const syncButton = (blocks: Block[]) =>
  (ofType(blocks, 'actions')[0]?.elements as { action_id: string; label: string }[]).find((el) => el.action_id === 'sync');

describe('the admin page', () => {
  it('opens with a Sync button and no results before any run', async () => {
    const { deps } = setup();
    const response = await handleAdminInteraction({ type: 'page_load', page: '/sync' }, deps);

    expect(response.blocks[0]).toMatchObject({ type: 'header', text: 'Shopify sync' });
    expect(syncButton(response.blocks)).toMatchObject({ label: 'Sync now' });
    expect(ofType(response.blocks, 'stats')).toEqual([]);
    expect(response.toast).toBeUndefined();
  });

  it('shows the last run on open: created, flagged and unchanged counts, warnings and the tables', async () => {
    const { deps } = setup({ stored: { at: '2026-11-04T12:00:00.000Z', report } });
    const response = await handleAdminInteraction({ type: 'page_load', page: '/sync' }, deps);

    const stats = ofType(response.blocks, 'stats')[0];
    expect(stats?.items).toEqual([
      { label: 'Created', value: 1 },
      { label: 'Flagged', value: 1 },
      { label: 'Unchanged', value: 7 },
    ]);
    expect(JSON.stringify(response.blocks)).toContain('The shop-data cache could not be purged (boom).');
    const tables = ofType(response.blocks, 'table');
    expect(tables).toHaveLength(2);
    expect(tables[0]?.rows).toEqual([{ handle: 'blue-mug', title: 'Blue Mug', slug: 'blue-mug' }]);
    expect(tables[1]?.rows).toEqual([{ title: 'Red Mug', shopifyId: '102', slug: 'red-mug' }]);
    expect(JSON.stringify(response.blocks)).toContain('2026-11-04');
  });

  it('runs a sync when Sync now is pressed, saves the run, and shows it with a success toast', async () => {
    const { deps, syncs, stored } = setup();
    const response = await handleAdminInteraction({ type: 'block_action', action_id: 'sync', page: '/sync' }, deps);

    expect(syncs()).toBe(1);
    expect(stored()?.report).toEqual(report);
    expect(ofType(response.blocks, 'stats')[0]?.items).toMatchObject([{ value: 1 }, { value: 1 }, { value: 7 }]);
    expect(response.toast).toEqual({ message: 'Sync finished: 1 created, 1 flagged, 7 unchanged.', type: 'success' });
  });

  it('shows a refused or failed run as an error banner with no counts, and an error toast', async () => {
    const { deps } = setup({ outcome: { at: '2026-11-04T12:00:00.000Z', error: 'The Storefront token is not set.' } });
    const response = await handleAdminInteraction({ type: 'block_action', action_id: 'sync', page: '/sync' }, deps);

    expect(ofType(response.blocks, 'stats')).toEqual([]);
    expect(ofType(response.blocks, 'banner')[0]).toMatchObject({ variant: 'error', description: 'The Storefront token is not set.' });
    expect(response.toast).toEqual({ message: 'The sync did not run.', type: 'error' });
  });

  it('does not run a sync for a table page action or anything it does not know', async () => {
    const { deps, syncs } = setup();
    await handleAdminInteraction({ type: 'block_action', action_id: 'created_page', page: '/sync' }, deps);
    await handleAdminInteraction({ type: 'form_submit', action_id: 'sync', page: '/sync' }, deps);
    await handleAdminInteraction('nonsense', deps);
    await handleAdminInteraction(null, deps);
    expect(syncs()).toBe(0);
  });

  it('caps the created table and says how many more there were', async () => {
    const many: SyncReport = {
      ...report,
      created: Array.from({ length: 150 }, (_, n) => ({
        entryId: `e${n}`,
        shopifyId: String(n),
        handle: `h-${n}`,
        title: `T ${n}`,
        slug: `h-${n}`,
      })),
    };
    const { deps } = setup({ stored: { at: '2026-11-04T12:00:00.000Z', report: many } });
    const response = await handleAdminInteraction({ type: 'page_load', page: '/sync' }, deps);
    expect(ofType(response.blocks, 'table')[0]?.rows).toHaveLength(100);
    expect(JSON.stringify(response.blocks)).toContain('50 more');
  });
});

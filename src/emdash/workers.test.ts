import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSync } from '../sync/run-sync';
import { purgeWorkerCache } from './workers';

// The Workers runtime provides this module; stand in a cache whose purge answers as it does.
const purge = vi.fn();
vi.mock('cloudflare:workers', () => ({ env: {}, cache: { purge: (options: unknown) => purge(options) } }));

beforeEach(() => purge.mockReset());

describe('purgeWorkerCache', () => {
  it('purges the tags and resolves when the cache reports success', async () => {
    purge.mockResolvedValue({ success: true, errors: [] });
    await expect(purgeWorkerCache(['shop-data'])).resolves.toBeUndefined();
    expect(purge).toHaveBeenCalledWith({ tags: ['shop-data'] });
  });

  it('rejects, naming the errors, when the cache reports success: false', async () => {
    purge.mockResolvedValue({ success: false, errors: [{ code: 1001, message: 'rate limited' }] });
    await expect(purgeWorkerCache(['shop-data'])).rejects.toThrow('rate limited');
  });

  it('rejects with a plain message when success is false and no error is given', async () => {
    purge.mockResolvedValue({ success: false, errors: [] });
    await expect(purgeWorkerCache(['shop-data'])).rejects.toThrow(/purge/i);
  });

  it('becomes a warning in the Sync report when the purge reports failure', async () => {
    purge.mockResolvedValue({ success: false, errors: [{ code: 1, message: 'nope' }] });
    const report = await runSync({
      shopify: { listChannelProducts: async () => [] },
      store: { listLinked: async () => [], createDraft: async () => ({ entryId: 'x', slug: null }) },
      purge: purgeWorkerCache,
    });
    expect(report.warnings).toEqual([expect.stringContaining('could not be purged')]);
    expect(report.warnings[0]).toContain('nope');
  });
});

import { describe, it, expect } from 'vitest';
import { handlePurge, purgeFailure } from './purge';
import { SHOP_DATA_CACHE_TAG } from './cache-tag';

describe('handlePurge', () => {
  it('invalidates the shop-data cache tag, and only that, and answers 200', async () => {
    const calls: string[][] = [];
    const response = await handlePurge(async (tags) => {
      calls.push(tags);
    });

    expect(calls).toEqual([[SHOP_DATA_CACHE_TAG]]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ purged: true, tags: [SHOP_DATA_CACHE_TAG] });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('answers 502 when the cache resolves success: false instead of throwing, as cache.purge does', async () => {
    const response = await handlePurge(async () => ({ success: false, errors: [{ code: 1, message: 'internal detail' }] }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ purged: false, error: 'The shop-data cache could not be purged.' });
  });

  it('answers 200 for a cache result of success: true', async () => {
    const response = await handlePurge(async () => ({ success: true, errors: [] }));
    expect(response.status).toBe(200);
  });

  it('answers 502 with a plain message, not the error text, when the purge fails', async () => {
    const response = await handlePurge(async () => {
      throw new Error('secret internal detail');
    });

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({ purged: false, error: 'The shop-data cache could not be purged.' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('purgeFailure', () => {
  it('reads a failed cache.purge() result, and nothing else, as a failure', () => {
    expect(purgeFailure({ success: false, errors: [{ message: 'a' }, { message: 'b' }] })).toBe('a; b');
    expect(purgeFailure({ success: false, errors: [] })).toMatch(/purge/);
    for (const fine of [undefined, null, {}, { success: true, errors: [] }]) expect(purgeFailure(fine)).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { handlePurge } from './purge';
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

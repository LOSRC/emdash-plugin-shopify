import { describe, it, expect } from 'vitest';
import { createFakeCartClient } from '../core/testing';
import { SHOP_DATA_CACHE_TAG } from '../core/cache-tag';
import { runSync } from './run-sync';
import { createMemoryContentStore } from './memory-store';
import type { MemoryContentStore } from './memory-store';
import type { LinkedEntry } from './types';

function setup() {
  const shopify = createFakeCartClient();
  const store = createMemoryContentStore();
  const purges: string[][] = [];
  const purge = async (tags: string[]) => {
    purges.push(tags);
  };
  return { shopify, store, purges, purge };
}

describe('runSync: new products', () => {
  it('makes one draft per unlinked channel product, then purges the shop-data tag once', async () => {
    const { shopify, store, purges, purge } = setup();
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });
    shopify.seedProduct({ id: '102', handle: 'red-mug', title: 'Red Mug' });

    const report = await runSync({ shopify, store, purge });

    expect(store.entries()).toEqual([
      { entryId: 'entry-1', shopifyId: '101', slug: 'blue-mug', title: 'Blue Mug' },
      { entryId: 'entry-2', shopifyId: '102', slug: 'red-mug', title: 'Red Mug' },
    ]);
    expect(report).toEqual({
      created: [
        { entryId: 'entry-1', shopifyId: '101', handle: 'blue-mug', title: 'Blue Mug', slug: 'blue-mug' },
        { entryId: 'entry-2', shopifyId: '102', handle: 'red-mug', title: 'Red Mug', slug: 'red-mug' },
      ],
      flagged: [],
      unchanged: 0,
      warnings: [],
    });
    expect(purges).toEqual([[SHOP_DATA_CACHE_TAG]]);
  });
});

/**
 * A store over `store` that, on its `nth` listing, lets `entry` appear straight after the list is
 * taken: another run (or an editor) got there first, in the gap before the next write.
 */
function entryAppearsAfterListing(store: MemoryContentStore, nth: number, entry: LinkedEntry): MemoryContentStore {
  let listings = 0;
  return {
    ...store,
    async listLinked() {
      const rows = await store.listLinked();
      listings += 1;
      if (listings === nth) store.seed(entry);
      return rows;
    },
    createDraft: (draft) => store.createDraft(draft),
  };
}

describe('runSync: another run got there first', () => {
  it('makes no second draft for a product whose entry appeared after the run listed the store', async () => {
    const { shopify, store, purge } = setup();
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });
    const racing = entryAppearsAfterListing(store, 1, { entryId: 'theirs', shopifyId: '101', slug: 'blue-mug', title: 'Blue Mug' });

    const report = await runSync({ shopify, store: racing, purge });

    expect(store.createCalls).toBe(0);
    expect(store.entries()).toHaveLength(1);
    expect(report.created).toEqual([]);
    expect(report.unchanged).toBe(1);
    expect(report.warnings).toEqual([
      'An entry for Shopify product 101 ("blue-mug") appeared while the sync was running, so no draft was made. Was another sync running?',
    ]);
  });

  it('checks again before every draft, not only the first', async () => {
    const { shopify, store, purge } = setup();
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });
    shopify.seedProduct({ id: '102', handle: 'red-mug', title: 'Red Mug' });
    // Listing 1 is the run's own; listing 2 is the check before the first draft; the entry for 102 appears after that.
    const racing = entryAppearsAfterListing(store, 2, { entryId: 'theirs', shopifyId: '102', slug: 'red-mug', title: 'Red Mug' });

    const report = await runSync({ shopify, store: racing, purge });

    expect(report.created.map((entry) => entry.shopifyId)).toEqual(['101']);
    expect(store.entries().map((entry) => entry.shopifyId).sort()).toEqual(['101', '102']);
  });

  it('matches the appeared entry by product id however it is stored (a GID counts)', async () => {
    const { shopify, store, purge } = setup();
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });
    const racing = entryAppearsAfterListing(store, 1, { entryId: 'theirs', shopifyId: 'gid://shopify/Product/101', slug: 'blue-mug', title: 'Blue Mug' });

    await runSync({ shopify, store: racing, purge });

    expect(store.createCalls).toBe(0);
  });
});

describe('runSync: a second run', () => {
  it('changes nothing when Shopify has not changed', async () => {
    const { shopify, store, purge } = setup();
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });
    shopify.seedProduct({ id: '102', handle: 'red-mug', title: 'Red Mug' });
    await runSync({ shopify, store, purge });
    const before = store.entries();

    const report = await runSync({ shopify, store, purge });

    expect(store.entries()).toEqual(before);
    expect(store.createCalls).toBe(2);
    expect(report).toEqual({ created: [], flagged: [], unchanged: 2, warnings: [] });
  });

  it('purges the shop-data tag every run, so a button press always refreshes the pages', async () => {
    const { shopify, store, purges, purge } = setup();
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });
    await runSync({ shopify, store, purge });
    await runSync({ shopify, store, purge });
    expect(purges).toEqual([[SHOP_DATA_CACHE_TAG], [SHOP_DATA_CACHE_TAG]]);
  });

  it('never overwrites an editor: a linked entry keeps its title and slug even if Shopify renamed the product', async () => {
    const { shopify, store, purge } = setup();
    store.seed({ entryId: 'e1', shopifyId: '101', slug: 'my-mug', title: 'My own title' });
    shopify.seedProduct({ id: '101', handle: 'blue-mug-renamed', title: 'Renamed in Shopify' });

    const report = await runSync({ shopify, store, purge });

    expect(store.entries()).toEqual([{ entryId: 'e1', shopifyId: '101', slug: 'my-mug', title: 'My own title' }]);
    expect(report.created).toEqual([]);
    expect(report.unchanged).toBe(1);
  });
});

describe('runSync: entries Shopify no longer returns', () => {
  it('flags an entry whose product was unpublished or removed, and changes nothing about it', async () => {
    const { shopify, store, purge } = setup();
    store.seed({ entryId: 'e1', shopifyId: '101', slug: 'blue-mug', title: 'Blue Mug' });
    store.seed({ entryId: 'e2', shopifyId: '102', slug: 'red-mug', title: 'Red Mug' });
    store.seed({ entryId: 'e3', shopifyId: '103', slug: 'green-mug', title: 'Green Mug' });
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });
    shopify.seedProduct({ id: '102', handle: 'red-mug', title: 'Red Mug', published: false });
    const before = store.entries();

    const report = await runSync({ shopify, store, purge });

    expect(report.flagged).toEqual([
      { entryId: 'e2', shopifyId: '102', slug: 'red-mug', title: 'Red Mug' },
      { entryId: 'e3', shopifyId: '103', slug: 'green-mug', title: 'Green Mug' },
    ]);
    expect(report.unchanged).toBe(1);
    expect(report.created).toEqual([]);
    expect(store.entries()).toEqual(before);
  });

  it('flags the same entries again on a second run, still without writing', async () => {
    const { shopify, store, purge } = setup();
    store.seed({ entryId: 'e1', shopifyId: '101', slug: 'blue-mug', title: 'Blue Mug' });
    shopify.seedProduct({ id: '102', handle: 'red-mug', title: 'Red Mug' });
    const first = await runSync({ shopify, store, purge });
    const second = await runSync({ shopify, store, purge });
    expect(second.flagged).toEqual(first.flagged);
    expect(second.created).toEqual([]);
  });

  it('matches an entry that stores a gid against the numeric channel id', async () => {
    const { shopify, store, purge } = setup();
    store.seed({ entryId: 'e1', shopifyId: 'gid://shopify/Product/101', slug: 'blue-mug', title: 'Blue Mug' });
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });

    const report = await runSync({ shopify, store, purge });

    expect(report).toEqual({ created: [], flagged: [], unchanged: 1, warnings: [] });
    expect(store.createCalls).toBe(0);
  });
});

describe('runSync: refusing to act on a bad answer', () => {
  it('stops with an error, flagging nothing, when the channel is empty but entries are linked', async () => {
    const { shopify, store, purges, purge } = setup();
    store.seed({ entryId: 'e1', shopifyId: '101', slug: 'blue-mug', title: 'Blue Mug' });

    await expect(runSync({ shopify, store, purge })).rejects.toThrow(/no products/i);
    expect(purges).toEqual([]);
    expect(store.createCalls).toBe(0);
  });

  it('is fine with an empty channel when nothing is linked yet', async () => {
    const { shopify, store, purge } = setup();
    const report = await runSync({ shopify, store, purge });
    expect(report).toEqual({ created: [], flagged: [], unchanged: 0, warnings: [] });
  });

  it('aborts before any write or purge when Shopify fails', async () => {
    const { shopify, store, purges, purge } = setup();
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });
    shopify.failNextWith(new Error('Shopify is down'));

    await expect(runSync({ shopify, store, purge })).rejects.toThrow('Shopify is down');
    expect(store.createCalls).toBe(0);
    expect(store.entries()).toEqual([]);
    expect(purges).toEqual([]);
  });

  it('aborts before any write or purge when the content store cannot be listed', async () => {
    const { shopify, store, purges, purge } = setup();
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });
    store.failListWith(new Error('No products collection'));

    await expect(runSync({ shopify, store, purge })).rejects.toThrow('No products collection');
    expect(store.createCalls).toBe(0);
    expect(purges).toEqual([]);
  });
});

describe('runSync: warnings', () => {
  it('reports a created slug that is not the handle', async () => {
    const { shopify, store, purge } = setup();
    store.seed({ entryId: 'e1', shopifyId: '900', slug: 'blue-mug', title: 'An editor entry' });
    shopify.seedProduct({ id: '900', handle: 'other', title: 'Other' });
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });

    const report = await runSync({ shopify, store, purge });

    expect(report.created).toHaveLength(1);
    expect(report.created[0]?.slug).toBe('blue-mug-2');
    expect(report.warnings).toEqual([
      'The draft for "blue-mug" got the slug "blue-mug-2", not the handle. Product links on the site use the slug.',
    ]);
  });

  it('does not create a third entry for a product that already has two, and says so', async () => {
    const { shopify, store, purge } = setup();
    store.seed({ entryId: 'e1', shopifyId: '101', slug: 'blue-mug', title: 'Blue Mug' });
    store.seed({ entryId: 'e2', shopifyId: '101', slug: 'blue-mug-2', title: 'Blue Mug copy' });
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });

    const report = await runSync({ shopify, store, purge });

    expect(store.createCalls).toBe(0);
    expect(report.unchanged).toBe(2);
    expect(report.warnings).toEqual(['More than one entry carries Shopify product 101: "blue-mug", "blue-mug-2".']);
  });

  it('carries on past a draft that could not be made, reports it, and still purges', async () => {
    const { shopify, store, purges, purge } = setup();
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });
    shopify.seedProduct({ id: '102', handle: 'red-mug', title: 'Red Mug' });
    store.failCreateFor('101', new Error('Validation failed'));

    const report = await runSync({ shopify, store, purge });

    expect(report.created.map((c) => c.handle)).toEqual(['red-mug']);
    expect(report.warnings).toEqual(['Could not make a draft for "blue-mug": Validation failed']);
    expect(purges).toEqual([[SHOP_DATA_CACHE_TAG]]);
  });

  it('reports a failed purge as a warning, not a crash', async () => {
    const { shopify, store } = setup();
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });
    const purge = async () => {
      throw new Error('cache.purge is not a function');
    };

    const report = await runSync({ shopify, store, purge });

    expect(report.created).toHaveLength(1);
    expect(report.warnings).toEqual([
      'The shop-data cache could not be purged (cache.purge is not a function). Pages show the old data until their cache expires.',
    ]);
  });

  it('reports a purge that resolves success: false as a warning too', async () => {
    const { shopify, store } = setup();
    const purge = async () => ({ success: false, errors: [{ code: 1, message: 'rate limited' }] });

    const report = await runSync({ shopify, store, purge });

    expect(report.warnings).toEqual([
      'The shop-data cache could not be purged (rate limited). Pages show the old data until their cache expires.',
    ]);
  });
});

describe('runSync: the product picker', () => {
  it('hands every product slug, existing and new, to refreshProductOptions, before the purge', async () => {
    const { shopify, store, purge } = setup();
    const calls: string[] = [];
    store.seed({ entryId: 'e1', shopifyId: '101', slug: 'blue-mug', title: 'Blue Mug' });
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });
    shopify.seedProduct({ id: '102', handle: 'red-mug', title: 'Red Mug' });

    await runSync({
      shopify,
      store,
      purge: async () => {
        calls.push('purge');
      },
      refreshProductOptions: async (slugs) => {
        calls.push(`options:${slugs.join(',')}`);
      },
    });

    expect(calls).toEqual(['options:blue-mug,red-mug', 'purge']);
  });

  it('refreshes the options on a run that created nothing, too', async () => {
    const { shopify, store, purge } = setup();
    store.seed({ entryId: 'e1', shopifyId: '101', slug: 'blue-mug', title: 'Blue Mug' });
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });
    let seen: string[] = [];
    await runSync({ shopify, store, purge, refreshProductOptions: async (slugs) => void (seen = slugs) });
    expect(seen).toEqual(['blue-mug']);
  });

  it('reports a failed refresh as a warning, and still purges', async () => {
    const { shopify, store, purges, purge } = setup();
    shopify.seedProduct({ id: '101', handle: 'blue-mug', title: 'Blue Mug' });

    const report = await runSync({
      shopify,
      store,
      purge,
      refreshProductOptions: async () => {
        throw new Error('Block type "product-grid" not found');
      },
    });

    expect(report.warnings).toEqual([
      'The product picker could not be refreshed (Block type "product-grid" not found). New products are not pickable until the next sync.',
    ]);
    expect(purges).toHaveLength(1);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SHOP_DATA_CACHE_TAG } from './core/cache-tag';
import { buildPluginDefinition, PLUGIN_ID, PLUGIN_VERSION, type PluginContextLike } from './plugin';
import type { ContentApiItem } from './emdash/content-store';

const SHOP = 'example-shop.myshopify.com';

/** A stub plugin context: an in-memory `ctx.content`, a recording `ctx.http.fetch` answering as Shopify, a Map for `ctx.kv`. */
function stubContext(options: { channel?: { id: string; handle: string; title: string }[]; content?: boolean; http?: boolean } = {}) {
  const channel = options.channel ?? [{ id: '101', handle: 'blue-mug', title: 'Blue Mug' }];
  const items: ContentApiItem[] = [];
  const urls: string[] = [];
  const kv = new Map<string, unknown>();
  const logged: string[] = [];
  const ctx: PluginContextLike = {
    content:
      options.content === false
        ? { async list() { return { items: [...items], hasMore: false }; } }
        : {
            async list() {
              return { items: [...items], hasMore: false };
            },
            async create(_collection, data) {
              const item = { id: `e${items.length + 1}`, slug: String(data.title), data };
              items.push(item);
              return item;
            },
          },
    ...(options.http === false
      ? {}
      : {
          http: {
            async fetch(url: string) {
              urls.push(url);
              const body = {
                data: {
                  products: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: channel.map((p) => ({ id: `gid://shopify/Product/${p.id}`, handle: p.handle, title: p.title })),
                  },
                },
              };
              return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
            },
          },
        }),
    kv: {
      async get<T>(key: string) {
        return (kv.get(key) as T | undefined) ?? null;
      },
      async set(key: string, value: unknown) {
        kv.set(key, value);
      },
    },
    log: { info: (m) => void logged.push(m), warn: (m) => void logged.push(m), error: (m) => void logged.push(m) },
  };
  return { ctx, items, urls, kv, logged };
}

function build(hooks: Parameters<typeof buildPluginDefinition>[1] = {}, options: Partial<Parameters<typeof buildPluginDefinition>[0]> = {}) {
  const purges: string[][] = [];
  const definition = buildPluginDefinition(
    { shop: SHOP, ...options },
    {
      readEnv: async () => ({ SHOPIFY_STOREFRONT_TOKEN: 'tok-123' }),
      purge: async (tags) => void purges.push(tags),
      ...hooks,
    },
  );
  return { definition, purges };
}

const loadPage = { type: 'page_load', page: '/sync' };
const pressSync = { type: 'block_action', action_id: 'sync', page: '/sync' };

describe('the plugin definition', () => {
  it('declares a native plugin with an admin page, content write, network access limited to the shop, and private routes', () => {
    const { definition } = build();

    expect(definition.id).toBe(PLUGIN_ID);
    expect(definition.capabilities).toEqual(['content:write', 'network:request']);
    expect(definition.allowedHosts).toEqual([SHOP]);
    expect(definition.admin.pages).toEqual([{ path: '/sync', label: 'Shopify sync' }]);
    expect(Object.keys(definition.routes).sort()).toEqual(['admin', 'sync']);
    for (const route of Object.values(definition.routes)) {
      expect(route.permission).toBe('content:create');
      expect((route as { public?: boolean }).public).toBeUndefined();
    }
  });

  it('carries the same version as package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(PLUGIN_VERSION).toBe(pkg.version);
    expect(build().definition.version).toBe(pkg.version);
  });
});

describe('the admin route', () => {
  it('opens on page_load with the Sync button, without calling Shopify', async () => {
    const { definition } = build();
    const { ctx, urls } = stubContext();

    const response = (await definition.routes.admin.handler({ ...ctx, input: loadPage })) as { blocks: { type: string }[] };

    expect(response.blocks.map((b) => b.type)).toContain('actions');
    expect(urls).toEqual([]);
  });

  it('runs a sync on the Sync button: a draft per product, the shop host only, one purge, shown on the page', async () => {
    const { definition, purges } = build();
    const { ctx, items, urls } = stubContext();

    const response = (await definition.routes.admin.handler({ ...ctx, input: pressSync })) as {
      blocks: { type: string; items?: unknown[] }[];
      toast?: { type: string };
    };

    expect(items.map((i) => i.data)).toEqual([{ title: 'blue-mug', shopify_title: 'Blue Mug', shopify_product_id: '101' }]);
    expect(urls.every((url) => new URL(url).host === SHOP)).toBe(true);
    expect(urls.length).toBeGreaterThan(0);
    expect(purges).toEqual([[SHOP_DATA_CACHE_TAG]]);
    expect(response.blocks.find((b) => b.type === 'stats')?.items).toMatchObject([{ value: 1 }, { value: 0 }, { value: 0 }]);
    expect(response.toast?.type).toBe('success');
  });

  it('shows the last run when the page is opened again', async () => {
    const { definition } = build();
    const { ctx } = stubContext();
    await definition.routes.admin.handler({ ...ctx, input: pressSync });

    const response = (await definition.routes.admin.handler({ ...ctx, input: loadPage })) as { blocks: { type: string }[] };

    expect(response.blocks.map((b) => b.type)).toContain('stats');
  });

  it('a second press changes nothing', async () => {
    const { definition } = build();
    const { ctx, items } = stubContext();
    await definition.routes.admin.handler({ ...ctx, input: pressSync });
    await definition.routes.admin.handler({ ...ctx, input: pressSync });
    expect(items).toHaveLength(1);
  });

  it('shows a banner, and does not call Shopify, when the token is not set', async () => {
    const { definition } = build({ readEnv: async () => ({}) });
    const { ctx, urls } = stubContext();

    const response = (await definition.routes.admin.handler({ ...ctx, input: pressSync })) as {
      blocks: { type: string; description?: string; variant?: string }[];
      toast?: { type: string };
    };

    const banner = response.blocks.find((b) => b.type === 'banner');
    expect(banner?.variant).toBe('error');
    expect(banner?.description).toContain('SHOPIFY_STOREFRONT_TOKEN');
    expect(urls).toEqual([]);
    expect(response.toast?.type).toBe('error');
  });

  it('reads the token from the configured environment variable name', async () => {
    const { definition } = build({ readEnv: async () => ({ MY_TOKEN: 'x' }) }, { tokenEnv: 'MY_TOKEN' });
    const { ctx, items } = stubContext();
    await definition.routes.admin.handler({ ...ctx, input: pressSync });
    expect(items).toHaveLength(1);
  });

  it('explains when the plugin cannot write content or reach the network, rather than throwing', async () => {
    const { definition } = build();
    for (const stub of [stubContext({ content: false }), stubContext({ http: false })]) {
      const response = (await definition.routes.admin.handler({ ...stub.ctx, input: pressSync })) as { blocks: { type: string }[] };
      expect(response.blocks.some((b) => b.type === 'banner')).toBe(true);
    }
  });

  it('never puts the token in a response, a log line or the kv record', async () => {
    const { definition } = build({ readEnv: async () => ({ SHOPIFY_STOREFRONT_TOKEN: 'tok-secret-999' }) });
    const { ctx, kv, logged } = stubContext();
    const response = await definition.routes.admin.handler({ ...ctx, input: pressSync });
    expect(JSON.stringify([response, [...kv.values()], logged])).not.toContain('tok-secret-999');
  });

  it('refreshes the product picker through the injected hook, and a failing purge is a warning on the page', async () => {
    const seen: string[][] = [];
    const { definition } = build({
      refreshProductOptions: async (slugs) => void seen.push(slugs),
      purge: async () => {
        throw new Error('cache.purge is not a function');
      },
    });
    const { ctx } = stubContext();

    const response = await definition.routes.admin.handler({ ...ctx, input: pressSync });

    expect(seen).toEqual([['blue-mug']]);
    expect(JSON.stringify(response)).toContain('could not be purged');
  });
});

describe('the sync route', () => {
  it('runs a sync and answers with the report as JSON', async () => {
    const { definition } = build();
    const { ctx, items } = stubContext();

    const result = await definition.routes.sync.handler({ ...ctx, input: {} });

    expect(items).toHaveLength(1);
    expect(result).toMatchObject({ created: [{ handle: 'blue-mug', slug: 'blue-mug' }], flagged: [], unchanged: 0, warnings: [] });
  });

  it('throws a plain error when the run is refused, so the caller sees a failure status', async () => {
    const { definition } = build({ readEnv: async () => ({}) });
    const { ctx } = stubContext();
    await expect(definition.routes.sync.handler({ ...ctx, input: {} })).rejects.toThrow('SHOPIFY_STOREFRONT_TOKEN');
  });
});

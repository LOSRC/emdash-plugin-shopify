import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SHOP_DATA_CACHE_TAG } from './core/cache-tag';
import { PluginRouteError } from 'emdash';
import { buildPluginDefinition, PLUGIN_ID, PLUGIN_VERSION, type PluginContextLike } from './plugin';
import type { ContentApiItem } from './emdash/content-store';

const SHOP = 'example-shop.myshopify.com';

/** A stub plugin context: an in-memory `ctx.content`, a recording `ctx.http.fetch` answering as Shopify, a Map for `ctx.kv`. */
function stubContext(
  options: {
    channel?: { id: string; handle: string; title: string }[];
    content?: boolean;
    http?: boolean;
    /** Holds every Shopify request until it resolves, so a test can press Sync while a run is in flight. */
    gate?: Promise<void>;
    onFetch?: () => void;
  } = {},
) {
  const channel = options.channel ?? [{ id: '101', handle: 'blue-mug', title: 'Blue Mug' }];
  const items: ContentApiItem[] = [];
  const urls: string[] = [];
  const kv = new Map<string, unknown>();
  const revisions = new Map<string, number>();
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
              options.onFetch?.();
              await options.gate;
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
        revisions.set(key, (revisions.get(key) ?? 0) + 1);
      },
      async getVersioned<T>(key: string) {
        return kv.has(key) ? { value: kv.get(key) as T, revision: String(revisions.get(key) ?? 0) } : null;
      },
      // Like the host's: applies only when the stored revision is the one expected (null: only when absent).
      async compareAndSet(key: string, expected: string | null, value: unknown) {
        const current = kv.has(key) ? String(revisions.get(key) ?? 0) : null;
        if (current !== expected) return { applied: false as const };
        kv.set(key, value);
        revisions.set(key, (revisions.get(key) ?? 0) + 1);
        return { applied: true as const, revision: String(revisions.get(key)) };
      },
      async compareAndDelete(key: string, expected: string) {
        if (!kv.has(key) || String(revisions.get(key) ?? 0) !== expected) return { applied: false };
        kv.delete(key);
        return { applied: true };
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

  it('throws a PluginRouteError carrying the reason when the run is refused, so the caller is told why', async () => {
    const { definition } = build({ readEnv: async () => ({}) });
    const { ctx } = stubContext();

    const error = await definition.routes.sync.handler({ ...ctx, input: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PluginRouteError);
    expect(error).toMatchObject({ status: 500, code: 'SYNC_FAILED' });
    expect((error as Error).message).toContain('SHOPIFY_STOREFRONT_TOKEN');
  });
});

describe('both routes take POST only', () => {
  it('declares POST as the only method, which the host enforces with a 405', () => {
    const { definition } = build();
    for (const route of Object.values(definition.routes)) expect(route.methods).toEqual(['POST']);
  });
});

describe('performSync never rejects', () => {
  it('reads the environment inside the guard: a reader that throws is a banner, not a failed request', async () => {
    const { definition } = build({
      readEnv: async () => {
        throw new Error('cloudflare:workers is not available');
      },
    });
    const { ctx } = stubContext();

    const response = (await definition.routes.admin.handler({ ...ctx, input: pressSync })) as { blocks: { type: string; description?: string }[] };

    expect(response.blocks.find((b) => b.type === 'banner')?.description).toContain('cloudflare:workers is not available');
    await expect(definition.routes.sync.handler({ ...ctx, input: {} })).rejects.toMatchObject({ code: 'SYNC_FAILED' });
  });
});

describe('a second Sync while one is running', () => {
  const LOCK_KEY = 'sync:lock';

  /** Start a run and hold it inside Shopify's answer until `release()`. */
  async function runInFlight(definition: ReturnType<typeof build>['definition'], stub: ReturnType<typeof stubContext>, release: () => void, started: Promise<void>) {
    const first = definition.routes.admin.handler({ ...stub.ctx, input: pressSync });
    await started;
    return { first, release };
  }

  function gatedStub() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const stub = stubContext({ gate, onFetch: () => markStarted() });
    return { stub, release, started };
  }

  it('is refused with a clear message, makes no draft of its own, and leaves the first run to finish', async () => {
    const { definition, purges } = build();
    const { stub, release, started } = gatedStub();
    const { first } = await runInFlight(definition, stub, release, started);

    const second = (await definition.routes.admin.handler({ ...stub.ctx, input: pressSync })) as {
      blocks: unknown[];
      toast?: { type: string; message: string };
    };

    expect(second.toast).toMatchObject({ type: 'info' });
    expect(second.toast?.message).toContain('already running');
    expect(stub.items).toHaveLength(0);
    release();
    await first;
    expect(stub.items).toHaveLength(1);
    expect(purges).toHaveLength(1);
  });

  it('does not overwrite the last run record with the refusal', async () => {
    const { definition } = build();
    const { stub, release, started } = gatedStub();
    stub.kv.set('sync:last-run', { at: 'earlier', report: { created: [], flagged: [], unchanged: 5, warnings: [] } });
    const { first } = await runInFlight(definition, stub, release, started);

    await definition.routes.admin.handler({ ...stub.ctx, input: pressSync });

    expect(stub.kv.get('sync:last-run')).toMatchObject({ at: 'earlier' });
    release();
    await first;
  });

  it('is a 409 conflict from the sync route, with the message kept', async () => {
    const { definition } = build();
    const { stub, release, started } = gatedStub();
    const { first } = await runInFlight(definition, stub, release, started);

    const error = await definition.routes.sync.handler({ ...stub.ctx, input: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PluginRouteError);
    expect(error).toMatchObject({ status: 409 });
    expect((error as Error).message).toContain('already running');
    release();
    await first;
  });

  it('frees the lock when the run ends, so the next press runs', async () => {
    const { definition } = build();
    const stub = stubContext();
    await definition.routes.admin.handler({ ...stub.ctx, input: pressSync });
    expect(stub.kv.has(LOCK_KEY)).toBe(false);

    const again = (await definition.routes.admin.handler({ ...stub.ctx, input: pressSync })) as { toast?: { type: string } };
    expect(again.toast?.type).toBe('success');
  });

  it('frees the lock when the run fails', async () => {
    const { definition } = build();
    const stub = stubContext();
    stub.ctx.http = {
      async fetch() {
        throw new Error('network down');
      },
    };
    await definition.routes.admin.handler({ ...stub.ctx, input: pressSync });
    expect(stub.kv.has(LOCK_KEY)).toBe(false);
  });

  it('takes over a lock older than ten minutes, left by a run that died', async () => {
    const { definition } = build();
    const stub = stubContext();
    stub.kv.set(LOCK_KEY, { at: new Date(Date.now() - 11 * 60 * 1000).toISOString() });

    const response = (await definition.routes.admin.handler({ ...stub.ctx, input: pressSync })) as { toast?: { type: string } };

    expect(response.toast?.type).toBe('success');
    expect(stub.items).toHaveLength(1);
    expect(stub.kv.has(LOCK_KEY)).toBe(false);
  });

  it('respects a lock younger than ten minutes', async () => {
    const { definition } = build();
    const stub = stubContext();
    stub.kv.set(LOCK_KEY, { at: new Date(Date.now() - 9 * 60 * 1000).toISOString() });

    const response = (await definition.routes.admin.handler({ ...stub.ctx, input: pressSync })) as { toast?: { type: string } };

    expect(response.toast?.type).toBe('info');
    expect(stub.items).toHaveLength(0);
  });

  it('takes over a lock with no readable timestamp, so junk in the store cannot block syncing for good', async () => {
    const { definition } = build();
    const stub = stubContext();
    stub.kv.set(LOCK_KEY, 'garbage');

    const response = (await definition.routes.admin.handler({ ...stub.ctx, input: pressSync })) as { toast?: { type: string } };

    expect(response.toast?.type).toBe('success');
  });

  it('a run whose lock was taken over does not delete the new holder\'s lock when it ends', async () => {
    const { definition } = build();
    const { stub, release, started } = gatedStub();
    const { first } = await runInFlight(definition, stub, release, started);
    // Time passes; another run takes the lock over.
    await stub.ctx.kv.set(LOCK_KEY, { at: new Date().toISOString(), holder: 'someone else' });

    release();
    await first;

    expect(stub.kv.get(LOCK_KEY)).toMatchObject({ holder: 'someone else' });
  });
});

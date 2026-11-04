import { createStorefrontProductsClient } from './core/storefront-products';
import type { PurgeTags } from './core/purge';
import type { ContentFieldNames, ContentApi } from './emdash/content-store';
import { createEmdashContentStore } from './emdash/content-store';
import { emdashProductOptionsRefresher } from './emdash/block-types';
import { handleAdminInteraction, type StoredRun } from './emdash/admin-page';
import type { ProductOptionsConfig } from './emdash/product-options';
import { purgeWorkerCache, readWorkerEnv } from './emdash/workers';
import { runSync } from './sync/run-sync';
import type { RefreshProductOptions, SyncReport } from './sync/types';

/** The plugin's id: an unscoped kebab-case name, also the URL segment under `/_emdash/api/plugins/`. */
export const PLUGIN_ID = 'shopify';
/** Kept equal to package.json's version (a test checks). */
export const PLUGIN_VERSION = '0.3.0';

/** Options the site passes in `astro.config`. Serialised into a virtual module: never put a token here. */
export interface ShopifyPluginOptions extends Partial<ContentFieldNames> {
  /**
   * Shop domain, for example `example-shop.myshopify.com`. Not a secret. It is the one host the
   * plugin may call, so it has to be known when the config loads.
   */
  shop: string;
  /** The Worker environment variable holding the Storefront token. Default `SHOPIFY_STOREFRONT_TOKEN`. */
  tokenEnv?: string;
  /** `private` if the token is a private (server-side) Storefront token. Default `public`. */
  tokenKind?: 'public' | 'private';
  /** Storefront API version; the core's default applies when unset. */
  apiVersion?: string;
  /**
   * The product grid block's picker: after each sync, the block type's select field lists every
   * product's slug (added, never removed). Off unless set.
   */
  productOptions?: ProductOptionsConfig;
}

/**
 * Parts a site can replace. They are functions, so they cannot travel in the serialised options: a
 * site that needs one wraps the plugin in a small local module (see the README).
 */
export interface ShopifyPluginHooks {
  /** Invalidate cache tags after a run. Default: the Worker's own cache, `cache.purge({ tags })`. */
  purge?: PurgeTags;
  /** Replaces the built-in picker refresher (and the `productOptions` option). */
  refreshProductOptions?: RefreshProductOptions;
  /** The Worker environment. Default: `env` from `cloudflare:workers`. */
  readEnv?: () => Promise<Record<string, unknown>>;
}

/** The part of the plugin context the sync uses. */
export interface PluginContextLike {
  content?: ContentApi;
  http?: { fetch(url: string, init?: RequestInit): Promise<Response> };
  kv: { get<T>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<void> };
  log: { info(message: string, data?: unknown): void; warn(message: string, data?: unknown): void; error(message: string, data?: unknown): void };
}

type RouteContextLike = PluginContextLike & { input: unknown };

const LAST_RUN_KEY = 'sync:last-run';
const DEFAULT_TOKEN_ENV = 'SHOPIFY_STOREFRONT_TOKEN';

/** Run one sync with whatever the context allows. Never rejects: a refusal is `{ error }`. */
async function performSync(
  ctx: PluginContextLike,
  options: ShopifyPluginOptions,
  hooks: ShopifyPluginHooks,
): Promise<StoredRun> {
  const at = new Date().toISOString();
  const refuse = (error: string): StoredRun => {
    ctx.log.warn(`Shopify sync did not run: ${error}`);
    return { at, error };
  };

  const tokenEnv = options.tokenEnv ?? DEFAULT_TOKEN_ENV;
  const token = (await (hooks.readEnv ?? readWorkerEnv)())[tokenEnv];
  if (typeof token !== 'string' || token === '') {
    return refuse(`The Storefront token is not set. Add it as the Worker secret ${tokenEnv}.`);
  }
  const http = ctx.http;
  if (!http) return refuse('The plugin has no network access: it needs the network:request capability.');
  if (!ctx.content?.create) return refuse('The plugin cannot write content: it needs the content:write capability.');

  // Every request goes through `ctx.http.fetch`, which only reaches the hosts the plugin declared.
  const shopify = createStorefrontProductsClient({
    shop: options.shop,
    token,
    ...(options.tokenKind ? { tokenKind: options.tokenKind } : {}),
    ...(options.apiVersion ? { apiVersion: options.apiVersion } : {}),
    fetch: ((input: string | URL | Request, init?: RequestInit) => http.fetch(String(input), init)) as typeof fetch,
  });
  const refreshProductOptions =
    hooks.refreshProductOptions ?? (options.productOptions ? emdashProductOptionsRefresher(options.productOptions) : undefined);

  try {
    const report = await runSync({
      shopify,
      store: createEmdashContentStore(ctx.content, options),
      purge: hooks.purge ?? purgeWorkerCache,
      ...(refreshProductOptions ? { refreshProductOptions } : {}),
    });
    ctx.log.info(`Shopify sync: ${report.created.length} created, ${report.flagged.length} flagged, ${report.unchanged} unchanged`);
    return { at, report };
  } catch (error) {
    ctx.log.error('Shopify sync failed', error);
    return { at, error: error instanceof Error ? error.message : 'The sync failed.' };
  }
}

/**
 * The plugin definition, as `definePlugin` takes it. Kept free of `emdash` so tests run in plain Node;
 * `src/index.ts` passes it to `definePlugin`.
 */
export function buildPluginDefinition(options: ShopifyPluginOptions, hooks: ShopifyPluginHooks = {}) {
  const adminDeps = (ctx: PluginContextLike) => ({
    sync: () => performSync(ctx, options, hooks),
    lastRun: () => ctx.kv.get<StoredRun>(LAST_RUN_KEY),
    saveRun: (run: StoredRun) => ctx.kv.set(LAST_RUN_KEY, run),
  });

  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,
    // content:write implies content:read. Network access is limited to the shop by allowedHosts.
    capabilities: ['content:write', 'network:request'] as ('content:write' | 'network:request')[],
    allowedHosts: [options.shop],
    admin: { pages: [{ path: '/sync', label: 'Shopify sync' }] },
    routes: {
      // The Block Kit page posts every interaction here. Editors (who can create content) may use it.
      admin: {
        permission: 'content:create' as const,
        handler: async (ctx: RouteContextLike) => handleAdminInteraction(ctx.input, adminDeps(ctx)),
      },
      // The same run as plain JSON, for scripts (the migration) that call it with a token.
      sync: {
        permission: 'content:create' as const,
        handler: async (ctx: RouteContextLike): Promise<SyncReport> => {
          const run = await performSync(ctx, options, hooks);
          await ctx.kv.set(LAST_RUN_KEY, run);
          if (!run.report) throw new Error(run.error ?? 'The sync did not run.');
          return run.report;
        },
      },
    },
  };
}

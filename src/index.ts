/**
 * Package root: the EmDash plugin. A site lists `shopifyPlugin({ shop })` in `emdash({ plugins: [...] })`;
 * EmDash then loads `createPlugin` from this module. The plugin adds a Sync page to the admin that
 * links Shopify products to product entries. The shop core, which works without EmDash, is
 * `@losrc/emdash-plugin-shopify/core`.
 *
 * This module is imported by Node when `astro.config` loads, so nothing here imports
 * `cloudflare:workers` at load.
 */
import { definePlugin, type PluginDescriptor } from 'emdash';
import { buildPluginDefinition, PLUGIN_ID, PLUGIN_VERSION, type ShopifyPluginHooks, type ShopifyPluginOptions } from './plugin';

export { PLUGIN_ID, PLUGIN_VERSION };
export type { ShopifyPluginHooks, ShopifyPluginOptions };
export { runSync, SyncRefusedError, normaliseShopifyId } from './sync/run-sync';
export type { SyncDeps } from './sync/run-sync';
export type {
  ContentStore,
  LinkedEntry,
  NewDraft,
  CreatedEntry,
  FlaggedEntry,
  SyncReport,
  RefreshProductOptions,
  PurgeTags,
} from './sync/types';
export { createEmdashContentStore, DEFAULT_FIELDS } from './emdash/content-store';
export type { ContentApi, ContentFieldNames } from './emdash/content-store';
export { createProductOptionsRefresher } from './emdash/product-options';
export type { ProductOptionsConfig } from './emdash/product-options';

/** The plugin descriptor for `emdash({ plugins: [shopifyPlugin({ shop })] })`. */
export function shopifyPlugin(options: ShopifyPluginOptions): PluginDescriptor<ShopifyPluginOptions> {
  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,
    format: 'native',
    entrypoint: '@losrc/emdash-plugin-shopify',
    options,
  };
}

/**
 * What EmDash calls with the descriptor's options. A site that must replace the purge, the picker
 * refresher or the environment reader passes `hooks` from a small local module of its own.
 */
export function createPlugin(options: ShopifyPluginOptions, hooks: ShopifyPluginHooks = {}) {
  return definePlugin(buildPluginDefinition(options, hooks));
}

export default createPlugin;

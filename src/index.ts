/**
 * Package root: the EmDash plugin entry. Placeholder in 0.1.0: it exports the descriptor a site
 * lists in `emdash({ plugins: [...] })`, and the plugin itself (routes, admin page, sync) lands with
 * the sync plugin work. The shop core, which works without EmDash, is `@losrc/emdash-plugin-shopify/core`.
 */

/** The plugin's id: an unscoped kebab-case name, also the URL segment under `/_emdash/api/plugins/`. */
export const PLUGIN_ID = 'shopify';

/** Options the site passes in `astro.config`. Serialised into a virtual module: never put a token here. */
export interface ShopifyPluginOptions {
  /** Shop domain, e.g. `example-shop.myshopify.com`. Not a secret; the outbound host allow-list needs it at config time. */
  shop: string;
}

/** The plugin descriptor for `emdash({ plugins: [shopifyPlugin({ shop })] })`. */
export function shopifyPlugin(options: ShopifyPluginOptions) {
  return {
    id: PLUGIN_ID,
    version: '0.1.0',
    format: 'native' as const,
    entrypoint: '@losrc/emdash-plugin-shopify',
    options,
  };
}

# Changelog

## 0.3.0

- The package root is now an EmDash native plugin: `shopifyPlugin({ shop })` for `astro.config`, and `createPlugin` for EmDash to load. It adds a **Shopify sync** page to the admin with a Sync button and a results view (created, flagged, unchanged, warnings), and a private `sync` route that returns the same report as JSON. Both routes need the `content:create` permission, so editors can use them. Outbound access is limited to the shop's Storefront host, and the token comes from the Worker environment at request time.
- `runSync({ shopify, store, purge, refreshProductOptions? })`: makes one draft per channel product with no entry (the handle in `title`, so the slug derives from it, and the title in `shopify_title`), reports (never writes) entries whose product Shopify no longer returns, and never updates or deletes. It purges `SHOP_DATA_CACHE_TAG` once per run. A second run with no Shopify change changes nothing. An empty channel while entries are linked, or any Shopify failure, stops the run before any write or purge.
- The content store is a narrow interface (`ContentStore`: list linked entries, create a draft). `createEmdashContentStore` implements it over `ctx.content`, listing the collection in pages; collection and field names are options (defaults `products`, `shopify_product_id`, `title`, `shopify_title`).
- Product picker: with the `productOptions` option, each run adds every product slug to the option list of the product grid block type's select field (add-only). This reaches EmDash's block type registry in-process, because the plugin context has no block-type API.
- `/core` gains `handlePurge(purge)`: the function behind a site's editor-only purge endpoint, which invalidates `SHOP_DATA_CACHE_TAG`.
- `emdash` is a dev dependency (types and the plugin tests); the peer range is unchanged.

## 0.2.0

- Shop data: `readShopData(client, ids)` reads the main image, title, description, price range, variants, availability and handle of one or many products by Shopify product ID. It never throws; each id is `ok` or `unavailable`, and `cacheable` is `false` whenever any id was unavailable or Shopify failed.
- The client interface gains a products capability (`ShopifyProductsClient`: `getProducts`, `listChannelProducts`; `ShopifyClient` is the cart and the products together).
- Storefront adapter: `createStorefrontProductsClient` and `createStorefrontClient`. Storefront token only; ids are chunked at 250 per `nodes` request and the channel list follows pagination.
- The in-memory fake (`/core/testing`) gains a product catalogue with publish state: `seedProduct`, `setPublished`, `removeProduct`.

## 0.1.0

- First release: the shop core (`/core`), a Worker-owned Shopify cart that works without JavaScript, with a Storefront transport, an in-memory fake and Lime-parity form handlers.

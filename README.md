# @losrc/emdash-plugin-shopify: the shop core works on any Astro site

The shop core (`@losrc/emdash-plugin-shopify/core`) works on any Astro site, with or without EmDash. It is a Worker-owned Shopify cart that works without JavaScript, and a hand-off to Shopify's hosted checkout.

A simple, robust Shopify integration for [EmDash](https://emdashcms.com) sites on Cloudflare.

- **Shop core (`/core`):** a Worker-owned cart on the Shopify Storefront API that works without JavaScript, with the cart id kept in the Astro session and never in a URL.
- **Sync plugin (package root):** an EmDash admin page with a Sync button that links Shopify products to EmDash product entries by Shopify product ID, making drafts for new products and never overwriting editorial content.

Status: 0.3.0, in development. First used by christophergoddard.net.

## Install

```sh
pnpm add @losrc/emdash-plugin-shopify
```

Until the package is on npm, depend on it from git and allow pnpm 11 to run its build:

```sh
pnpm add github:LOSRC/emdash-plugin-shopify#<tag-or-sha>
```

```yaml
# pnpm-workspace.yaml
allowBuilds:
  '@losrc/emdash-plugin-shopify': true
```

## The cart core

The core has no dependency on `emdash`, `astro` or `cloudflare:workers`. You give it four things: a Storefront config, a cart client, a session, and the request. It gives you a `Response`.

### Configuration

The defaults read the environment names `SHOPIFY_SHOP` (for example `example-shop.myshopify.com`), `SHOPIFY_STOREFRONT_TOKEN` and, optionally, `SHOPIFY_API_VERSION`. The token is a Storefront access token from your Headless channel; keep it a Wrangler secret.

```ts
import { storefrontConfigFromEnv } from '@losrc/emdash-plugin-shopify/core';

const config = storefrontConfigFromEnv(env); // throws, naming the variable, if one is missing
```

`config` is a plain object (`shop`, `token`, `apiVersion?`, `tokenKind?`, `buyerIp?`, `fetch?`), so you can build it any other way. `tokenKind: 'private'` sends the token as `Shopify-Storefront-Private-Token`; pair it with `buyerIp` (the visitor's IP) on buyer-originated requests. `fetch` is injectable; it defaults to the global `fetch`.

### Session types

Declare the cart's session shape once, in `src/env.d.ts`:

```ts
declare namespace App {
  interface SessionData {
    cart: import('@losrc/emdash-plugin-shopify/core').StoredCart;
  }
}
```

### Routes

Each route is a thin adapter. With `output: 'server'` or `export const prerender = false`:

```ts
// src/pages/api/cart/add.ts   (update.ts and remove.ts are the same with handleUpdate / handleRemove)
import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import {
  astroCartSession,
  createStorefrontCartClient,
  handleAdd,
  storefrontConfigFromEnv,
} from '@losrc/emdash-plugin-shopify/core';

export const prerender = false;

export function POST(context: APIContext): Promise<Response> {
  const client = createStorefrontCartClient(storefrontConfigFromEnv(env));
  return handleAdd(context.request, client, astroCartSession(context.session));
}
```

```ts
// src/pages/api/cart/summary.ts
import type { APIContext } from 'astro';
import { astroCartSession, handleSummary } from '@losrc/emdash-plugin-shopify/core';

export const prerender = false;

export function GET(context: APIContext): Promise<Response> {
  return handleSummary(astroCartSession(context.session));
}
```

The handlers serve two callers from one endpoint. A plain `<form method="POST">` gets a `303` to `/cart/` (or to `/cart/?error=add|update|remove` when something went wrong). A `fetch` that sends `Accept: application/json` or `X-Requested-With: fetch` gets JSON: the cart snapshot `{ lineCount, subtotal, currency }` on add, and `{ error }` with status 400, 422 or 502 on failure. The cart id is never put in a redirect or a response body. `CART_ERROR_MESSAGE` and `CART_REJECTED_MESSAGE` are the friendly texts for the error banner.

### Forms

| Action | Field names |
|---|---|
| `POST /api/cart/add` | `merchandiseId` (a `gid://shopify/ProductVariant/...` id), `quantity` (default 1) |
| `POST /api/cart/update` | `lineId` (a `gid://shopify/CartLine/...` id), `quantity` |
| `POST /api/cart/remove` | `lineId` |

### Rendering a cart

`toCartView(cart)` reduces Shopify's cart to a flat `CartView` (`lineCount`, `subtotal`, `checkoutUrl`, `lines`). Get the cart with `client.getCart(stored.id)` where `stored` comes from `astroCartSession(Astro.session).read()`; `null` means Shopify no longer has it (expired or checked out). `checkoutUrl` carries Shopify's cart token, so render it into the page but never into a redirect.

`formatMoney('14.99', 'GBP')` gives `£14.99`; `formatPriceRange(min, max)` gives `£12.50–£18.00`, or one price when they match.

### Testing

`@losrc/emdash-plugin-shopify/core/testing` exports `createFakeCartClient()`, an in-memory client with real cart behaviour (reuse, stale-cart recovery, line merging, exact-decimal totals), a product catalogue with publish state (`seedProduct`, `setPublished`, `removeProduct`; an unpublished product is invisible, as on Shopify) and switches to simulate Shopify failing (`failNextWith`, which also fails the next product read) or refusing a change (`rejectMutationsWith`). Drive the handlers with it and a plain `CartSession`; no Worker runtime or Shopify account is needed.

## Reading shop data

Shop data is what a page shows about a product: main image, title, description, price range, variants, availability and handle. Shopify is its only source; an EmDash entry stores the Shopify product ID and nothing else of it.

```ts
import { createStorefrontClient, readShopData, storefrontConfigFromEnv, SHOP_DATA_CACHE_TAG } from '@losrc/emdash-plugin-shopify/core';

const client = createStorefrontClient(storefrontConfigFromEnv(env));
const { products, cacheable } = await readShopData(client, ['7463040909518', '7463040910000']);

const result = products['7463040909518'];
if (result.status === 'ok') {
  result.product.title; // also gid, handle, description, image, priceRange, options, variants, availableForSale
} else {
  result.reason; // 'not-found' (unknown or not published to the channel) or 'shopify-error'
}
```

`readShopData(client, ids)` never throws. Ids are numeric Shopify product IDs (a `gid://shopify/Product/...` also works); the result is keyed by the id as you wrote it. Each id is either `{ status: 'ok', product }` or `{ status: 'unavailable', reason }`, so a page can always render something. `cacheable` is `false` whenever any id was unavailable or Shopify failed (every id is then `shopify-error`): send such a page with `Cache-Control: no-store` and without the `SHOP_DATA_CACHE_TAG` cache tag, so it never enters the cache. Prices are raw `Money`; format them with `formatMoney` and `formatPriceRange`.

Only a Storefront token is used, never the Admin API. Shopify answers only for products published to the token's sales channel, so an unpublished product looks the same as an unknown one. Ids are sent to Shopify 250 at a time.

`client.listChannelProducts()` returns `{ id, handle, title }` for every product on the token's sales channel, following pagination. Unlike `readShopData`, it and `client.getProducts(ids)` reject when Shopify fails, so a caller that must not act on a bad answer can stop.

## The sync plugin (EmDash)

The package root is a native EmDash plugin. It adds a **Shopify sync** page to the admin. **Sync now** makes a draft product entry for each product on the sales channel that has no entry yet, lists entries whose product Shopify no longer returns, and refreshes the shop data the site shows. It never changes or deletes an entry, and a second press with nothing new in Shopify changes nothing.

### Install

```ts
// astro.config.mjs
import { shopifyPlugin } from '@losrc/emdash-plugin-shopify';

export default defineConfig({
  integrations: [
    emdash({
      plugins: [
        shopifyPlugin({
          shop: 'example-shop.myshopify.com', // the one host the plugin may call; not a secret
          // Optional, with their defaults:
          // tokenEnv: 'SHOPIFY_STOREFRONT_TOKEN', // Worker env var holding the Storefront token
          // tokenKind: 'public',                  // 'private' for a private Storefront token
          // collection: 'products',
          // idField: 'shopify_product_id',
          // handleField: 'title',
          // labelField: 'shopify_title',
          // productOptions: { blockType: 'product-grid', field: 'products' },
        }),
      ],
    }),
  ],
});
```

Set the token as a Worker secret (`wrangler secret put SHOPIFY_STOREFRONT_TOKEN`). It is read from the Worker environment when a sync runs; it is never in the plugin options, which are serialised into the build. The plugin's only outbound host is `shop`, and every Shopify request goes through EmDash's `ctx.http.fetch`.

Editors need the `content:create` permission (Contributor and up) to open the page and press the button. The same run is available as `POST /_emdash/api/plugins/shopify/sync`, which answers with the report as JSON, for scripts that call it with an API token.

### The Products collection

The collection (default `products`) needs three text fields:

| Field | Holds | Notes |
|---|---|---|
| `shopify_product_id` | the numeric Shopify product ID | the link between the entry and Shopify |
| `title` | the Shopify **handle** | label it "Shopify handle" in the editor. A plugin cannot set a slug, so the sync writes the handle here and EmDash derives the slug from it. The field must be named `title` (or `name`) for that to happen |
| `shopify_title` | the Shopify title | set as the collection's `titleField`, so it is the admin label |

After creating each draft, the sync checks that its slug equals the handle, and reports any entry where it does not (a clash with another entry's slug, for example).

Shop data (price, images, availability, the handle) is not stored on the entry; pages read it from Shopify with `readShopData`.

### What a run does

1. Lists the products on the sales channel. If Shopify fails, or answers with no products while entries exist, the run stops before it changes anything.
2. Lists the collection in pages of 100 and picks out the entries that carry a Shopify product ID.
3. Makes one draft for each channel product with no entry. A draft that cannot be made is a warning; the run carries on.
4. Reports entries whose product the channel does not return (deleted or unpublished). This is report-only: nothing is written to them.
5. If configured, adds the product slugs to the product grid's picker.
6. Purges the `SHOP_DATA_CACHE_TAG` cache tag, once. A failed purge is a warning in the report.

The report is `{ created, flagged, unchanged, warnings }`. The page shows the last run when it opens.

### Refreshing the product picker

A product grid block with a `multiSelect` of products needs its option list to contain the new products' slugs. EmDash's plugin context has no block-type API (`ctx.schema` reads collections only), so set `productOptions: { blockType, field }` and the plugin reaches the block type registry in-process, through `getDb` from `emdash/runtime`, and adds the missing slugs. It only adds options (a compatible change, so no new block type version), and it writes with the fingerprint it read, so a concurrent edit makes it fail with a warning rather than overwrite. This is a schema write made under a `content:create` route, which is why it is off unless you set the option. Without it, run the site's own script after Sync (as `testimonials:sync` does for Creative Care), or pass `refreshProductOptions` in the hooks below.

### Purging the cache after a sync

Pages that show shop data are cached with the `SHOP_DATA_CACHE_TAG` tag (exported from `/core`) and refreshed at once after a sync. There are two ways to purge, and a site picks one:

1. **The plugin route purges directly (default).** The route runs in the same Worker entrypoint that serves the cached pages, so it calls `cache.purge({ tags })` from `cloudflare:workers`. This does not work under `wrangler dev --local` (no Workers cache there); the report then carries a warning and the sync still succeeds.
2. **The site supplies the purge.** Wrap the plugin in a small local module and pass `purge`; it receives the tag list:

   ```ts
   // plugins/shopify/index.ts (in the site)
   import { createPlugin as create, shopifyPlugin, type ShopifyPluginOptions } from '@losrc/emdash-plugin-shopify';

   // astro.config: emdash({ plugins: [localShopifyPlugin({ shop })] })
   export function localShopifyPlugin(options: ShopifyPluginOptions) {
     return { ...shopifyPlugin(options), entrypoint: new URL('./index.ts', import.meta.url).pathname };
   }

   // EmDash loads this named export from the entrypoint.
   export function createPlugin(options: ShopifyPluginOptions) {
     return create(options, {
       purge: async (tags) => { /* the site's mechanism */ },
       // refreshProductOptions: async (slugs) => { /* add the slugs to the picker */ },
     });
   }
   ```

Either way the site can also mount an editor-only endpoint for purging by hand, backed by the core handler:

```ts
// src/pages/api/shop/purge.ts
import { cache } from 'cloudflare:workers';
import { handlePurge } from '@losrc/emdash-plugin-shopify/core';

export const prerender = false;

export async function POST(context) {
  if (!context.locals.user) return new Response(null, { status: 403 }); // use the site's own editor check
  return handlePurge((tags) => cache.purge({ tags }));
}
```

`handlePurge(purge)` purges `SHOP_DATA_CACHE_TAG` and nothing else, and answers `200 { purged: true }` or `502` with a fixed message.

### Testing a sync

`runSync` depends on the products capability of the client and on a two-method `ContentStore` (`listLinked`, `createDraft`), so a test drives it with `createFakeCartClient()` from `/core/testing` and an in-memory store, without EmDash or a Worker.

## Licence

MIT

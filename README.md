# @losrc/emdash-plugin-shopify: the shop core works on any Astro site

The shop core (`@losrc/emdash-plugin-shopify/core`) works on any Astro site, with or without EmDash. It is a Worker-owned Shopify cart that works without JavaScript, and a hand-off to Shopify's hosted checkout.

A simple, robust Shopify integration for [EmDash](https://emdashcms.com) sites on Cloudflare.

- **Shop core (`/core`):** a Worker-owned cart on the Shopify Storefront API that works without JavaScript, with the cart id kept in the Astro session and never in a URL.
- **Sync plugin (package root):** an EmDash admin page with a Sync button that links Shopify products to EmDash product entries by Shopify product ID, making drafts for new products and never overwriting editorial content. In development.

Status: 0.2.0, in development. First used by christophergoddard.net.

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

## Licence

MIT

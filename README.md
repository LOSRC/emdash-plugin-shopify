# @losrc/emdash-plugin-shopify: the shop core works on any Astro site

The shop core (`@losrc/emdash-plugin-shopify/core`) works on any Astro site, with or without EmDash. It is a Worker-owned Shopify cart that works without JavaScript, and a hand-off to Shopify's hosted checkout.

A simple, robust Shopify integration for [EmDash](https://emdashcms.com) sites on Cloudflare.

- **Shop core (`/core`):** a Worker-owned cart on the Shopify Storefront API that works without JavaScript, with the cart id kept in the Astro session and never in a URL.
- **Sync plugin (package root):** an EmDash admin page with a Sync button that links Shopify products to EmDash product entries by Shopify product ID, making drafts for new products and never overwriting editorial content.
- **Cart UI (`/components/*`, `/elements/*`):** Tailwind 4 Astro components for a `/cart/` page, a slide-out cart drawer and a header count. The page works with no JavaScript; the drawer and count are small custom elements with no framework dependency.

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

The handlers serve two callers from one endpoint. A plain `<form method="POST">` gets a `303` to `/cart/` (or to `/cart/?error=add|update|remove` when something went wrong). A `fetch` that sends `Accept: application/json` or `X-Requested-With: fetch`, or any request with a JSON body, gets JSON; see [the JSON contract](#the-json-contract). The cart id is never put in a redirect or a response body. `CART_ERROR_MESSAGE` and `CART_REJECTED_MESSAGE` are the friendly texts for the error banner.

### The JSON contract

| Route | JSON response |
|---|---|
| `POST /api/cart/add` | the snapshot `{ lineCount, subtotal, currency }`; with `X-Cart-View: 1` as well, the `CartView` |
| `POST /api/cart/update`, `POST /api/cart/remove` | the refreshed `CartView` |
| `GET /api/cart/view` (`handleView`) | the stored cart as a `CartView`, fresh from Shopify |
| `GET /api/cart/summary` | `{ lineCount }` from the session, with no Shopify round trip |

A `CartView` is `{ lineCount, subtotal: { amount, currencyCode }, checkoutUrl, lines: [{ id, quantity, productTitle, productHandle, variantTitle, unitPrice, lineTotal, image }] }`. A cart that does not exist (none started, or Shopify no longer has it) is an empty view: `lines: []`, `checkoutUrl: ''`. Failures are `{ error }`: `400` for invalid input, `422` when Shopify refuses the change, `502` when Shopify cannot be reached. Nothing is written to the session on a failure. Every response from the view and summary routes, and every `CartView`, is sent `Cache-Control: private, no-store` (so is the purge endpoint's answer), because `checkoutUrl` carries Shopify's cart token and the count exists precisely because pages are cached and shared.

`handleView(client, session)` is the one new route to mount for the drawer:

```ts
// src/pages/api/cart/view.ts
export function GET(context: APIContext): Promise<Response> {
  const client = createStorefrontCartClient(storefrontConfigFromEnv(env));
  return handleView(client, astroCartSession(context.session));
}
```

### Forms

Every action reads its fields from a form body (`application/x-www-form-urlencoded` or `multipart/form-data`) or from a JSON object (`Content-Type: application/json`, e.g. `{ "lineId": "...", "quantity": 2 }`). A body that cannot be read at all is a `400` with `{ error: 'The request body could not be read.' }`.

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

## The cart UI

The components are Astro source, shipped in `src/components`; the two custom elements are built to `dist/elements`. They need the four cart routes above, plus `view` and `summary`, mounted under one base path (default `/api/cart`).

### Tailwind 4: the `@source` line

The components are styled with Tailwind 4 utility classes. Tailwind skips `node_modules` when it scans for class names, so the site's stylesheet must point it at the components or the classes are never generated:

```css
/* src/styles/global.css, the file that has @import 'tailwindcss' */
@import 'tailwindcss';
@source '../../node_modules/@losrc/emdash-plugin-shopify/src/components';
```

The path is relative to the CSS file. (In `astro dev` the classes appear without the line, because Tailwind sees the component modules as Vite loads them; a production build does not, so check a build.) Only default-theme utilities are used (`stone`, `red`, `size-*`, `max-w-md`), so the look follows the site's theme. Every component takes a `class` prop that is added after the defaults.

### Components

Import by path: `import CartPage from '@losrc/emdash-plugin-shopify/components/CartPage.astro'`.

| Component | Props |
|---|---|
| `CartPage` | `cart` (a `CartView` or `null`), `loadFailed?`, `actionFailed?`, `apiBase?` (`/api/cart`), `productPath?` (`/product/{handle}`), `shippingNote?` (`Free shipping (UK)`), `continueHref?` (`/`), `class?` |
| `CartTotals` | `cart`, `shippingNote?`, `continueHref?`, `class?` (used by `CartPage`) |
| `CartEmpty` | `href?` (`/`), `class?` (used by `CartPage`) |
| `CartDrawer` | `apiBase?`, `cartPath?` (`/cart/`), `productPath?`, `shippingNote?`, `title?` (`Your cart`), `class?` |
| `CartCount` | `href?` (`/cart/`), `apiBase?`, `label?` (`Cart`), `openDrawer?` (`false`), `class?` |

**`/cart/` page.** All plain form posts, so it works with no JavaScript. The site's page reads the session and the cart:

```astro
---
import { env } from 'cloudflare:workers';
import CartPage from '@losrc/emdash-plugin-shopify/components/CartPage.astro';
import { astroCartSession, createStorefrontCartClient, storefrontConfigFromEnv, toCartView } from '@losrc/emdash-plugin-shopify/core';
export const prerender = false;

const client = createStorefrontCartClient(storefrontConfigFromEnv(env));
const stored = await astroCartSession(Astro.session).read();
let cart = null;
let loadFailed = false;
try {
  const raw = stored ? await client.getCart(stored.id) : null; // null: Shopify no longer has it
  cart = raw ? toCartView(raw) : null;
} catch {
  loadFailed = true;
}
---
<CartPage cart={cart} loadFailed={loadFailed} actionFailed={Astro.url.searchParams.has('error')} />
```

**Drawer.** Render `<CartDrawer />` once in the layout, but not on the `/cart/` page. It brings its own script. It enhances every `<form method="post">` on the page that posts to `/api/cart/add`, `/api/cart/update` or `/api/cart/remove`: the form is sent with `fetch` and the drawer slides out showing the refreshed cart. Without JavaScript those forms post as usual and land on `/cart/`. On the `/cart/` page itself the drawer is not rendered, so its update and remove forms stay plain posts (the page works with no JavaScript, and a reload shows the result). Any element with a `data-cart-drawer-open` attribute opens it too. The drawer is a native modal `<dialog>` (dialog role, focus trapped, Escape and the backdrop close it, focus returns to the button that opened it), with a polite live region for "Added to your cart", quantity changes and removals. At quantity 1 the minus button removes the line.

**Count.** `<CartCount />` renders the link to `/cart/`; the `<cart-count>` element inside fills the number from `GET /api/cart/summary` once per page view, so it is right on cached pages. `<CartCount openDrawer />` makes the link open the drawer when one is on the page.

The checkout link and product images are only rendered when their URL is `https:` (the drawer and `CartPage` use the same check, `isHttpsUrl` from `/core`). The defaults the components share (`CART_API_BASE`, `cartRoutes`, `DEFAULT_PRODUCT_PATH`, `DEFAULT_SHIPPING_NOTE`, `DEFAULT_VARIANT_TITLE`) are exported from `/core` too.

The elements talk to each other through a `shopify-cart:change` event on `document` (`detail.lineCount`), so a site script can listen to it too.

### Without the components

`@losrc/emdash-plugin-shopify/elements/cart-drawer` and `.../elements/cart-count` are the custom elements alone. They expect the markup `CartDrawer.astro` and `CartCount.astro` render, so use the components rather than writing it by hand.

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

### Trashed entries

EmDash 1.3.1's `ctx.content.list` leaves out trashed entries, and the plugin has no other way to find them: `list` takes no option to include them, and the only trash-aware call, `getTrashedVersioned(collection, id)`, needs an entry id the plugin does not have and the `content:restore` capability (the power to restore content, which a sync should not hold). So Sync cannot tell that a product's entry is in the trash, and it makes a new draft for that product. If you trash a product's entry on purpose, either restore it, delete it for good (the new draft is then the only entry), or unpublish the product in Shopify. If you find a new draft for a product you had trashed, delete the draft and restore the original.

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

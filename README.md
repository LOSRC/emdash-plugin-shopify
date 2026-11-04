# @losrc/emdash-plugin-shopify: the shop core works on any Astro site

The shop core (`@losrc/emdash-plugin-shopify/core`) works on any Astro site, with or without EmDash. It is a Worker-owned Shopify cart that works without JavaScript, and a hand-off to Shopify's hosted checkout.

A simple, robust Shopify integration for [EmDash](https://emdashcms.com) sites on Cloudflare.

- **Shop core (`/core`):** a Worker-owned cart on the Shopify Storefront API that works without JavaScript, with the cart id kept in the Astro session and never in a URL.
- **Sync plugin (package root):** an EmDash admin page with a Sync button that links Shopify products to EmDash product entries by Shopify product ID, making drafts for new products and never overwriting editorial content. In development.

- **Cart UI (`/components/*`, `/elements/*`):** Tailwind 4 Astro components for a `/cart/` page, a slide-out cart drawer and a header count. The page works with no JavaScript; the drawer and count are small custom elements with no framework dependency.

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

The handlers serve two callers from one endpoint. A plain `<form method="POST">` gets a `303` to `/cart/` (or to `/cart/?error=add|update|remove` when something went wrong). A `fetch` that sends `Accept: application/json` or `X-Requested-With: fetch` gets JSON; see [the JSON contract](#the-json-contract). The cart id is never put in a redirect or a response body. `CART_ERROR_MESSAGE` and `CART_REJECTED_MESSAGE` are the friendly texts for the error banner.

### The JSON contract

| Route | JSON response |
|---|---|
| `POST /api/cart/add` | the snapshot `{ lineCount, subtotal, currency }`; with `X-Cart-View: 1` as well, the `CartView` |
| `POST /api/cart/update`, `POST /api/cart/remove` | the refreshed `CartView` |
| `GET /api/cart/view` (`handleCart`) | the stored cart as a `CartView`, fresh from Shopify |
| `GET /api/cart/summary` | `{ lineCount }` from the session, with no Shopify round trip |

A `CartView` is `{ lineCount, subtotal: { amount, currencyCode }, checkoutUrl, lines: [{ id, quantity, productTitle, productHandle, variantTitle, unitPrice, lineTotal, image }] }`. A cart that does not exist (none started, or Shopify no longer has it) is an empty view: `lines: []`, `checkoutUrl: ''`. Failures are `{ error }`: `400` for invalid input, `422` when Shopify refuses the change, `502` when Shopify cannot be reached. Nothing is written to the session on a failure. Every response that carries the cart (`CartView` and summary) is sent `Cache-Control: private, no-store`, because `checkoutUrl` carries Shopify's cart token and the count exists precisely because pages are cached and shared.

`handleCart(client, session)` is the one new route to mount for the drawer:

```ts
// src/pages/api/cart/view.ts
export function GET(context: APIContext): Promise<Response> {
  const client = createStorefrontCartClient(storefrontConfigFromEnv(env));
  return handleCart(client, astroCartSession(context.session));
}
```

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

`@losrc/emdash-plugin-shopify/core/testing` exports `createFakeCartClient()`, an in-memory cart client with real cart behaviour (reuse, stale-cart recovery, line merging, exact-decimal totals) and switches to simulate Shopify failing (`failNextWith`) or refusing a change (`rejectMutationsWith`). Drive the handlers with it and a plain `CartSession`; no Worker runtime or Shopify account is needed.

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

**Drawer.** Render `<CartDrawer />` once in the layout, but not on the `/cart/` page. It brings its own script. It enhances every `<form method="post" action="/api/cart/add">` on the page: the add is sent with `fetch` and the drawer slides out. Without JavaScript those forms post as usual and land on `/cart/`. Any element with a `data-cart-drawer-open` attribute opens it too. The drawer is a native modal `<dialog>` (dialog role, focus trapped, Escape and the backdrop close it, focus returns to the button that opened it), with a polite live region for "Added to your cart", quantity changes and removals. At quantity 1 the minus button removes the line.

**Count.** `<CartCount />` renders the link to `/cart/`; the `<cart-count>` element inside fills the number from `GET /api/cart/summary` once per page view, so it is right on cached pages. `<CartCount openDrawer />` makes the link open the drawer when one is on the page.

The elements talk to each other through a `shopify-cart:change` event on `document` (`detail.lineCount`), so a site script can listen to it too.

### Without the components

`@losrc/emdash-plugin-shopify/elements/cart-drawer` and `.../elements/cart-count` are the custom elements alone. They expect the markup `CartDrawer.astro` and `CartCount.astro` render, so use the components rather than writing it by hand.

## Licence

MIT

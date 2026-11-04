# Changelog

## 0.2.0

Shop data and the cart UI.

- Shop data: `readShopData(client, ids)` reads the main image, title, description, price range, variants, availability and handle of one or many products by Shopify product ID. It never throws; each id is `ok` or `unavailable`, and `cacheable` is `false` whenever any id was unavailable or Shopify failed.
- The client interface gains a products capability (`ShopifyProductsClient`: `getProducts`, `listChannelProducts`; `ShopifyClient` is the cart and the products together).
- Storefront adapter: `createStorefrontProductsClient` and `createStorefrontClient`. Storefront token only; ids are chunked at 250 per `nodes` request and the channel list follows pagination.
- The in-memory fake (`/core/testing`) gains a product catalogue with publish state: `seedProduct`, `setPublished`, `removeProduct`.

The cart UI:

- Added `CartPage`, `CartTotals`, `CartEmpty`, `CartDrawer` and `CartCount` Astro components (`@losrc/emdash-plugin-shopify/components/*`), styled with Tailwind 4. Lime's Tailwind 3.4 classes were brought across with its pixel-keyed spacing converted (`N` to `N/4`, so `px-24` is `px-6`) and its custom theme dropped for default-theme utilities. Sites need an `@source` line so Tailwind scans the components; see the README.
- Added the `<cart-drawer>` and `<cart-count>` custom elements (`@losrc/emdash-plugin-shopify/elements/*`): no framework dependency, a native modal `<dialog>`, a live region, focus handling.
- Added JSON to `handleUpdate` and `handleRemove`: a `fetch` now gets the refreshed `CartView` (400, 422 and 502 on failure); plain form posts still get the 303.
- Added `X-Cart-View: 1` on `handleAdd`, which answers the `CartView` instead of the snapshot. Without it the JSON is unchanged.
- Added `handleCart(client, session)`, a GET route that returns the stored cart as a `CartView`.
- Cart view and summary responses are now `Cache-Control: private, no-store`.
- Added the free UK shipping line to the totals (`shippingNote`, default `Free shipping (UK)`).

## 0.1.0

- First release: the shop core (`/core`), a Worker-owned Shopify cart that works without JavaScript, with a Storefront transport, an in-memory fake and Lime-parity form handlers.

# Changelog

## 0.2.0

The cart UI.

- Added `CartPage`, `CartTotals`, `CartEmpty`, `CartDrawer` and `CartCount` Astro components (`@losrc/emdash-plugin-shopify/components/*`), styled with Tailwind 4. Lime's Tailwind 3.4 classes were brought across with its pixel-keyed spacing converted (`N` to `N/4`, so `px-24` is `px-6`) and its custom theme dropped for default-theme utilities. Sites need an `@source` line so Tailwind scans the components; see the README.
- Added the `<cart-drawer>` and `<cart-count>` custom elements (`@losrc/emdash-plugin-shopify/elements/*`): no framework dependency, a native modal `<dialog>`, a live region, focus handling.
- Added JSON to `handleUpdate` and `handleRemove`: a `fetch` now gets the refreshed `CartView` (400, 422 and 502 on failure); plain form posts still get the 303.
- Added `X-Cart-View: 1` on `handleAdd`, which answers the `CartView` instead of the snapshot. Without it the JSON is unchanged.
- Added `handleCart(client, session)`, a GET route that returns the stored cart as a `CartView`.
- Cart view and summary responses are now `Cache-Control: private, no-store`.
- Added the free UK shipping line to the totals (`shippingNote`, default `Free shipping (UK)`).

## 0.1.0

The shop core: Storefront cart client, session, handlers, in-memory fake, money formatting.

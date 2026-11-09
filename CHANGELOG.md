# Changelog

## Unreleased

- Product picker: `productOptions.field` may also name a `repeater` whose one `select` sub-field holds a product per row, which lets an editor drag the products into order. The refresher reads the field's type from the block type's active version on every run, so a site that moves the field from a `multiSelect` to a repeater in a new block type version keeps the same `productOptions`, and Sync works before and after the new version is activated. Adding a sub-field option is a compatible change in EmDash, so this still needs no new version. A repeater with no `select` sub-field, or more than one, is refused.

## 0.4.0

- The cart components no longer depend on the site's spacing scale: each component's root sets `--spacing: 0.25rem`, so a site with `--spacing: 0.0625rem` (pixel-keyed) gets the same padding, gaps and sizes as one on Tailwind's default. A site that worked around it with `cart-drawer, .shop-cart { --spacing: 0.25rem }` can delete the rule. The README now says what a site's theme does change (colours, fonts, type sizes, shadows, breakpoints) and what it does not (spacing).
- The fake cart client names a line for a seeded variant from its catalogue: the product title and handle, the variant title, the variant's price (an explicit `prices` entry still wins) and the product image. A variant that was never seeded, or whose product was removed, keeps the stub ("Fake product", `defaultPrice`, no image).
- Sync runs one at a time: a run takes a lock in `ctx.kv` (atomic, with a ten-minute TTL, so a dead run's lock is taken over), and a second press gets "A sync is already running" (a `409` from the route) without overwriting the last run. `runSync` also lists the store again once, just before the first draft, so an entry that appeared mid-run is not duplicated.
- The routes take POST only. A refused or failed run from the `sync` route is now a `PluginRouteError` (`SYNC_FAILED`, status 500), so the host keeps the reason instead of answering a generic 500. The README says plainly that a script needs an `admin`-scoped token.
- `performSync` reads the Worker environment inside its guard, so it never rejects.
- The block type slug in the docs and tests is `product_grid`: EmDash slugs match `^[a-z][a-z0-9_]*$`.
- A stored cart Shopify no longer resolves is forgotten (`CartSession` gains `clear()`; `astroCartSession` calls the Astro session's `delete`), so the header count follows an empty view. A custom `CartSession` must now implement `clear`.
- A null cart whose userErrors are not about `cartId` is no longer assumed to be a refusal: the cart routes ask `getCart`, and a cart Shopify no longer returns is treated as lost (add recreates it, update and remove forget it). The fake answers that way with `answerMissingCartWith('fieldless')`.

- The package root is now an EmDash native plugin: `shopifyPlugin({ shop })` for `astro.config`, and `createPlugin` for EmDash to load. It adds a **Shopify sync** page to the admin with a Sync button and a results view (created, flagged, unchanged, warnings), and a private `sync` route that returns the same report as JSON. Both routes need the `content:create` permission, so editors can use them. Outbound access is limited to the shop's Storefront host, and the token comes from the Worker environment at request time.
- `runSync({ shopify, store, purge, refreshProductOptions? })`: makes one draft per channel product with no entry (the handle in `title`, so the slug derives from it, and the title in `shopify_title`), reports (never writes) entries whose product Shopify no longer returns, and never updates or deletes. It purges `SHOP_DATA_CACHE_TAG` once per run. A second run with no Shopify change changes nothing. An empty channel while entries are linked, or any Shopify failure, stops the run before any write or purge.
- The content store is a narrow interface (`ContentStore`: list linked entries, create a draft). `createEmdashContentStore` implements it over `ctx.content`, listing the collection in pages; collection and field names are options (defaults `products`, `shopify_product_id`, `title`, `shopify_title`).
- Product picker: with the `productOptions` option, each run adds every product slug to the option list of the product grid block type's select field (add-only). This reaches EmDash's block type registry in-process, because the plugin context has no block-type API.
- `/core` gains `handlePurge(purge)`: the function behind a site's editor-only purge endpoint, which invalidates `SHOP_DATA_CACHE_TAG`. Its `PurgeTags` type accepts `(tags) => cache.purge({ tags })` as it is.
- A purge that resolves `{ success: false, errors }` (which is how `cache.purge()` reports a refusal) is a failure: a warning in the Sync report, a 502 from `handlePurge`.
- `shopifyPlugin()` and `createPlugin` refuse a `shop` that is not a bare `*.myshopify.com` hostname.
- Known limit: EmDash 1.3.1 gives a plugin no way to see trashed entries, so Sync makes a new draft for a product whose entry is in the trash. See the README.
- `emdash` is a dev dependency (types and the plugin tests); the peer range is unchanged.

## 0.3.0

- A lost cart is told from a refused change: Shopify answers a missing `cartId` with `cart: null` and a userError whose field is `["cartId"]`, and `isCartGone` (new, from `/core`) reads that. Only a lost cart is recreated on add, or forgotten on update and remove; a refusal on a live cart keeps the cart and its lines, and is a `422`. The fake answers a missing cart that way (`answerMissingCartWith('null')` gives the old bare form) and mints CartLine ids that carry the cart token, as Shopify's do. The cart queries now ask for each userError's `code`.
- `DEFAULT_PRODUCT_PATH` is `/product/{handle}/`, with the trailing slash.
- The JSON add snapshot is `private, no-store` like every other cart response.
- The drawer says "Your cart is still updating" in its live region when a second submit arrives while one is in flight, instead of dropping it silently.

- Added `CartPage`, `CartTotals`, `CartEmpty`, `CartDrawer` and `CartCount` Astro components (`@losrc/emdash-plugin-shopify/components/*`), styled with Tailwind 4. Lime's Tailwind 3.4 classes were brought across with its pixel-keyed spacing converted (`N` to `N/4`, so `px-24` is `px-6`) and its custom theme dropped for default-theme utilities. Sites need an `@source` line so Tailwind scans the components; see the README.
- Added the `<cart-drawer>` and `<cart-count>` custom elements (`@losrc/emdash-plugin-shopify/elements/*`): no framework dependency, a native modal `<dialog>`, a live region, focus handling.
- Added JSON to `handleUpdate` and `handleRemove`: a `fetch` now gets the refreshed `CartView` (400, 422 and 502 on failure); plain form posts still get the 303.
- Added `X-Cart-View: 1` on `handleAdd`, which answers the `CartView` instead of the snapshot. Without it the JSON is unchanged.
- Added `handleView(client, session)`, a GET route that returns the stored cart as a `CartView`.
- Cart view and summary responses are now `Cache-Control: private, no-store`, from one helper that the purge response also uses.
- `<cart-drawer>` also enhances update and remove form posts (to its `update-url` and `remove-url`) on any page it is rendered on, not just add. `/cart/` keeps plain posts, because the drawer is not rendered there.
- `CartPage` and `CartTotals` render the checkout and image URLs only when they are `https:`, the rule the drawer already used (`isHttpsUrl`).
- The components, the drawer and the count take their defaults (`/api/cart` and its route names, `/product/{handle}/`, `Free shipping (UK)`, `Default Title`) from one module, exported from `/core` as `CART_API_BASE`, `cartRoutes`, `DEFAULT_PRODUCT_PATH`, `DEFAULT_SHIPPING_NOTE` and `DEFAULT_VARIANT_TITLE`.
- Added the free UK shipping line to the totals (`shippingNote`, default `Free shipping (UK)`).

## 0.2.0

- Shop data: `readShopData(client, ids)` reads the main image, title, description, price range, variants, availability and handle of one or many products by Shopify product ID. It never throws; each id is `ok` or `unavailable`, and `cacheable` is `false` whenever any id was unavailable or Shopify failed.
- The client interface gains a products capability (`ShopifyProductsClient`: `getProducts`, `listChannelProducts`; `ShopifyClient` is the cart and the products together).
- Storefront adapter: `createStorefrontProductsClient` and `createStorefrontClient`. Storefront token only; ids are chunked at 250 per `nodes` request and the channel list follows pagination.
- The in-memory fake (`/core/testing`) gains a product catalogue with publish state: `seedProduct`, `setPublished`, `removeProduct`.

## 0.1.0

- First release: the shop core (`/core`), a Worker-owned Shopify cart that works without JavaScript, with a Storefront transport, an in-memory fake and Lime-parity form handlers.
- The handlers read form bodies and JSON bodies (by `Content-Type`); a body that cannot be read is a `400`, not a raw 500.
- The transport and `storefrontConfigFromEnv` refuse a `shop` that is not a bare `*.myshopify.com` hostname, since it is put in the URL that carries the token.

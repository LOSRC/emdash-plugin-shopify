# Changelog

## 0.2.0

- Shop data: `readShopData(client, ids)` reads the main image, title, description, price range, variants, availability and handle of one or many products by Shopify product ID. It never throws; each id is `ok` or `unavailable`, and `cacheable` is `false` whenever any id was unavailable or Shopify failed.
- The client interface gains a products capability (`ShopifyProductsClient`: `getProducts`, `listChannelProducts`; `ShopifyClient` is the cart and the products together).
- Storefront adapter: `createStorefrontProductsClient` and `createStorefrontClient`. Storefront token only; ids are chunked at 250 per `nodes` request and the channel list follows pagination.
- The in-memory fake (`/core/testing`) gains a product catalogue with publish state: `seedProduct`, `setPublished`, `removeProduct`.

## 0.1.0

- First release: the shop core (`/core`), a Worker-owned Shopify cart that works without JavaScript, with a Storefront transport, an in-memory fake and Lime-parity form handlers.

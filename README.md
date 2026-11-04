# @losrc/emdash-plugin-shopify

A simple, robust Shopify integration for [EmDash](https://emdashcms.com) sites on Cloudflare. The shop core (`@losrc/emdash-plugin-shopify/core`) works on any Astro site, with or without EmDash.

- **Shop core:** reads shop data from the Shopify Storefront API, runs a Worker-owned cart that works without JavaScript, provides a framework-free cart drawer, and hands off to Shopify's hosted checkout.
- **Sync plugin:** an EmDash admin page with a Sync button that links Shopify products to EmDash product entries by Shopify product ID, making drafts for new products and never overwriting editorial content.

Status: in development. First used by christophergoddard.net.

## Licence

MIT

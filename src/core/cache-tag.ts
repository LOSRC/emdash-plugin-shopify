/**
 * The cache tag carried by every response that shows shop data. The site's pages send it in a
 * `Cache-Tag` header; the purge after a product sync names it, so the package and the site agree on
 * one string.
 */
export const SHOP_DATA_CACHE_TAG = 'shopify-shop-data';

const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

/**
 * Check that a shop is a bare `*.myshopify.com` hostname, and return it lower-cased. The shop is
 * interpolated into the Storefront URL that carries the access token, so anything else (a path, a
 * port, credentials, another domain) must not get that far.
 */
export function assertShopHost(shop: string): string {
  if (typeof shop !== 'string' || !SHOP_HOST.test(shop)) {
    throw new Error(
      `The shop must be a bare myshopify.com hostname such as example-shop.myshopify.com (got ${JSON.stringify(shop)}).`,
    );
  }
  return shop.toLowerCase();
}

/**
 * The cart UI's defaults, in one place: the three Astro components, `<cart-drawer>` and
 * `<cart-count>` all import from here, so a default is changed once. Also the one https-only rule for
 * links that come from Shopify.
 */
/** Where the site mounts the cart routes unless it says otherwise. */
export const CART_API_BASE = '/api/cart';

/** The cart page, and where every no-JS cart form post is sent back to. */
export const CART_PAGE_PATH = '/cart/';

/** A product page path; `{handle}` is replaced by the product's handle. */
export const DEFAULT_PRODUCT_PATH = '/product/{handle}';

/** The free-shipping line in the totals. */
export const DEFAULT_SHIPPING_NOTE = 'Free shipping (UK)';

/** The variant title Shopify gives a product with no options; not worth showing. */
export const DEFAULT_VARIANT_TITLE = 'Default Title';

/** The cart route URLs under a base path (a trailing slash is ignored). */
export function cartRoutes(base: string = CART_API_BASE) {
  const root = base.replace(/\/$/, '');
  return {
    add: `${root}/add`,
    update: `${root}/update`,
    remove: `${root}/remove`,
    view: `${root}/view`,
    summary: `${root}/summary`,
  };
}

/** A product page's URL: `productPath` with `{handle}` replaced by the encoded handle. */
export function productHref(productPath: string, handle: string): string {
  return productPath.replace('{handle}', encodeURIComponent(handle));
}

/**
 * True for an `https:` URL. Checkout and image URLs come from Shopify and are rendered into `href` and
 * `src`; anything else (`javascript:`, `data:`, plain `http:`) is refused.
 */
export function isHttpsUrl(url: string): boolean {
  return /^https:\/\//i.test(url);
}

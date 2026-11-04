import { describe, it, expect } from 'vitest';
import * as core from './index';
import * as testing from './testing';

describe('the /core public API', () => {
  it('exports exactly the documented runtime names', () => {
    expect(Object.keys(core).sort()).toEqual(
      [
        'CART_API_BASE',
        'CART_ERROR_MESSAGE',
        'CART_PAGE_PATH',
        'CART_PATH',
        'CART_REJECTED_MESSAGE',
        'DEFAULT_API_VERSION',
        'DEFAULT_PRODUCT_PATH',
        'DEFAULT_SHIPPING_NOTE',
        'DEFAULT_VARIANT_TITLE',
        'SHOP_DATA_CACHE_TAG',
        'astroCartSession',
        'cartRoutes',
        'createShopifyTransport',
        'createStorefrontCartClient',
        'createStorefrontClient',
        'createStorefrontProductsClient',
        'formatMoney',
        'formatPriceRange',
        'handleAdd',
        'handleView',
        'handlePurge',
        'handleRemove',
        'handleSummary',
        'handleUpdate',
        'isHttpsUrl',
        'isCartGone',
        'isStaleCart',
        'jsonResponse',
        'parseLineForm',
        'parseRemoveForm',
        'parseUpdateForm',
        'productHref',
        'readShopData',
        'storefrontConfigFromEnv',
        'toCartView',
        'toSnapshot',
        'wantsJson',
      ].sort(),
    );
  });

  it('keeps the in-memory fake out of /core and in /core/testing', () => {
    expect(Object.keys(core)).not.toContain('createFakeCartClient');
    expect(Object.keys(testing)).toEqual(['createFakeCartClient']);
  });
});

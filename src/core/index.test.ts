import { describe, it, expect } from 'vitest';
import * as core from './index';
import * as testing from './testing';

describe('the /core public API', () => {
  it('exports exactly the documented runtime names', () => {
    expect(Object.keys(core).sort()).toEqual(
      [
        'CART_ERROR_MESSAGE',
        'CART_PATH',
        'CART_REJECTED_MESSAGE',
        'DEFAULT_API_VERSION',
        'SHOP_DATA_CACHE_TAG',
        'astroCartSession',
        'createShopifyTransport',
        'createStorefrontCartClient',
        'formatMoney',
        'formatPriceRange',
        'handleAdd',
        'handleRemove',
        'handleSummary',
        'handleUpdate',
        'isStaleCart',
        'jsonResponse',
        'parseLineForm',
        'parseRemoveForm',
        'parseUpdateForm',
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

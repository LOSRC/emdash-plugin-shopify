import { describe, it, expect } from 'vitest';
import { shopifyPlugin } from './index';

describe('shopifyPlugin', () => {
  it('describes a native EmDash plugin loaded from this package, carrying the shop and no secrets', () => {
    expect(shopifyPlugin({ shop: 'example-shop.myshopify.com' })).toEqual({
      id: 'shopify',
      version: '0.3.0',
      format: 'native',
      entrypoint: '@losrc/emdash-plugin-shopify',
      options: { shop: 'example-shop.myshopify.com' },
    });
  });
});

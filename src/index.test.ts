import { describe, it, expect } from 'vitest';
import { shopifyPlugin, createPlugin } from './index';

describe('shopifyPlugin', () => {
  it('describes a native EmDash plugin loaded from this package, carrying the shop and no secrets', () => {
    expect(shopifyPlugin({ shop: 'example-shop.myshopify.com' })).toEqual({
      id: 'shopify',
      version: '0.4.0',
      format: 'native',
      entrypoint: '@losrc/emdash-plugin-shopify',
      options: { shop: 'example-shop.myshopify.com' },
    });
  });

  it('refuses a shop that is not a bare myshopify.com hostname', () => {
    expect(() => shopifyPlugin({ shop: 'evil.example.com' })).toThrow(/myshopify\.com/);
    expect(() => shopifyPlugin({ shop: 'example-shop.myshopify.com/x' })).toThrow(/myshopify\.com/);
    expect(() => createPlugin({ shop: 'evil.example.com' })).toThrow(/myshopify\.com/);
  });
});

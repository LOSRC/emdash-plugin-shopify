import { describe, it, expect } from 'vitest';
import {
  CART_API_BASE,
  DEFAULT_PRODUCT_PATH,
  DEFAULT_SHIPPING_NOTE,
  DEFAULT_VARIANT_TITLE,
  cartRoutes,
  isHttpsUrl,
  productHref,
} from './cart-defaults';

describe('cart defaults', () => {
  it('names the cart routes under the default base, and under any other base', () => {
    expect(CART_API_BASE).toBe('/api/cart');
    expect(cartRoutes()).toEqual({
      add: '/api/cart/add',
      update: '/api/cart/update',
      remove: '/api/cart/remove',
      view: '/api/cart/view',
      summary: '/api/cart/summary',
    });
    expect(cartRoutes('/shop/cart/').update).toBe('/shop/cart/update');
  });

  it('holds the default texts and paths', () => {
    expect(DEFAULT_PRODUCT_PATH).toBe('/product/{handle}');
    expect(DEFAULT_SHIPPING_NOTE).toBe('Free shipping (UK)');
    expect(DEFAULT_VARIANT_TITLE).toBe('Default Title');
  });

  it('builds a product link, encoding the handle', () => {
    expect(productHref(DEFAULT_PRODUCT_PATH, 'blue mug')).toBe('/product/blue%20mug');
    expect(productHref('/shop/{handle}/', 'a')).toBe('/shop/a/');
  });

  it('accepts only https URLs', () => {
    expect(isHttpsUrl('https://example.com/x')).toBe(true);
    expect(isHttpsUrl('HTTPS://example.com/x')).toBe(true);
    for (const bad of ['http://example.com', 'javascript:alert(1)', 'data:text/html,x', '//example.com', '/cart', '']) {
      expect(isHttpsUrl(bad)).toBe(false);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { parseLineForm, parseUpdateForm, parseRemoveForm, toSnapshot, toCartView, isStaleCart } from './cart';
import type { Cart } from './types';
import cartFixture from './fixtures/cart.json';

const cart = cartFixture as Cart;

/** Build a FormData the way a zero-JS add-to-cart <form> POST arrives at the Worker. */
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

const VARIANT = 'gid://shopify/ProductVariant/40993523892280';
const LINE = 'gid://shopify/CartLine/7b9ed49f-830e-4142-9c81-e7f8249863ad?cart=50b74bf9dc2bc7a410053b5ffb31ba51';

describe('parseLineForm', () => {
  it('accepts a variant GID with an explicit quantity', () => {
    const result = parseLineForm(form({ merchandiseId: VARIANT, quantity: '2' }));
    expect(result).toEqual({ ok: true, value: { merchandiseId: VARIANT, quantity: 2 } });
  });

  it('defaults the quantity to 1 when the form omits it', () => {
    const result = parseLineForm(form({ merchandiseId: VARIANT }));
    expect(result).toEqual({ ok: true, value: { merchandiseId: VARIANT, quantity: 1 } });
  });

  it('rejects a missing merchandiseId', () => {
    expect(parseLineForm(form({ quantity: '1' })).ok).toBe(false);
  });

  it('rejects a Product GID — only a ProductVariant GID is a valid merchandiseId', () => {
    const result = parseLineForm(form({ merchandiseId: 'gid://shopify/Product/7463070335182' }));
    expect(result.ok).toBe(false);
  });

  it.each(['0', '-1', '1.5', 'abc', ''])('rejects a non-positive-integer quantity %j', (quantity) => {
    expect(parseLineForm(form({ merchandiseId: VARIANT, quantity })).ok).toBe(false);
  });
});

describe('parseUpdateForm', () => {
  it('accepts a CartLine GID with a new quantity', () => {
    const result = parseUpdateForm(form({ lineId: LINE, quantity: '3' }));
    expect(result).toEqual({ ok: true, value: { id: LINE, quantity: 3 } });
  });

  it('rejects a variant GID — update targets a CartLine, not a variant', () => {
    expect(parseUpdateForm(form({ lineId: VARIANT, quantity: '3' })).ok).toBe(false);
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects a non-positive-integer quantity %j', (quantity) => {
    expect(parseUpdateForm(form({ lineId: LINE, quantity })).ok).toBe(false);
  });
});

describe('parseRemoveForm', () => {
  it('accepts a CartLine GID', () => {
    expect(parseRemoveForm(form({ lineId: LINE }))).toEqual({ ok: true, value: { lineId: LINE } });
  });

  it('rejects a missing lineId', () => {
    expect(parseRemoveForm(form({})).ok).toBe(false);
  });

  it('rejects a variant GID', () => {
    expect(parseRemoveForm(form({ lineId: VARIANT })).ok).toBe(false);
  });
});

describe('toSnapshot', () => {
  it('reduces an authoritative cart to the cached badge view — count, subtotal, currency', () => {
    expect(toSnapshot(cart)).toEqual({ lineCount: 3, subtotal: '46.00', currency: 'GBP' });
  });
});

describe('isStaleCart', () => {
  it('treats a null cart as stale — Shopify returns null once a cart is expired or checked out', () => {
    expect(isStaleCart(null)).toBe(true);
  });

  it('treats a live cart as fresh', () => {
    expect(isStaleCart(cart)).toBe(false);
  });
});

describe('toCartView', () => {
  it('reshapes an authoritative cart into the flat view a cart page or drawer renders', () => {
    expect(toCartView(cart)).toEqual({
      lineCount: 3,
      subtotal: { amount: '46.00', currencyCode: 'GBP' },
      checkoutUrl: 'https://example-shop.myshopify.com/cart/c/c1-abc123',
      lines: [
        {
          id: 'gid://shopify/CartLine/line-1',
          quantity: 2,
          productTitle: 'Harbour at dusk',
          productHandle: 'harbour-at-dusk',
          variantTitle: 'A3 print',
          unitPrice: { amount: '18.00', currencyCode: 'GBP' },
          lineTotal: { amount: '36.00', currencyCode: 'GBP' },
          image: { url: 'https://cdn.shopify.com/harbour-at-dusk.jpg', altText: 'Harbour at dusk' },
        },
        {
          id: 'gid://shopify/CartLine/line-2',
          quantity: 1,
          productTitle: 'Field guide',
          productHandle: 'field-guide',
          variantTitle: 'Default Title',
          unitPrice: { amount: '10.00', currencyCode: 'GBP' },
          lineTotal: { amount: '10.00', currencyCode: 'GBP' },
          image: null,
        },
      ],
    });
  });

  it('contains no cart id anywhere in the view except as the checkout URL token', () => {
    const json = JSON.stringify(toCartView(cart));
    expect(json).not.toContain('gid://shopify/Cart/');
  });
});

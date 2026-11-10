import { describe, it, expect } from 'vitest';
import { cartActionOf, fetchLineCount, requestCartView, showCount, GENERIC_ERROR } from './cart-client';
import type { CountBadge, FetchLike } from './cart-client';
import { handleAdd, handleRemove, CART_REJECTED_MESSAGE } from '../core/cart-runtime';
import type { CartSession, StoredCart } from '../core/cart-session';
import { createFakeCartClient } from '../core/testing';

/**
 * The browser half of the JSON contract, checked against the real handlers: the client's `fetch` is
 * wired straight to `handleAdd` / `handleRemove` over the in-memory fake, so a change on either side
 * of the contract fails here.
 */

const VARIANT = 'gid://shopify/ProductVariant/10000000001';

function memorySession(): { session: CartSession; state: { current?: StoredCart } } {
  const state: { current?: StoredCart } = {};
  return {
    session: {
      read: async () => state.current,
      write: (cart) => (state.current = cart),
      clear: () => (state.current = undefined),
    },
    state,
  };
}

/** A `fetch` that hands each request to the real handlers, as the site's routes do. */
function wiredFetch(client = createFakeCartClient({ prices: { [VARIANT]: '18.00' } })) {
  const { session } = memorySession();
  const seen: Request[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const request = new Request(new URL(input, 'https://example.com'), init);
    seen.push(request.clone());
    return input.endsWith('/add') ? handleAdd(request, client, session) : handleRemove(request, client, session);
  };
  return { fetchLike, client, seen };
}

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};

describe('requestCartView', () => {
  it('posts a form with the JSON headers and reads the CartView back from the real add handler', async () => {
    const { fetchLike, seen } = wiredFetch();

    const outcome = await requestCartView('/api/cart/add', form({ merchandiseId: VARIANT, quantity: '2' }), fetchLike);

    expect(outcome).toMatchObject({ ok: true, view: { lineCount: 2, subtotal: { amount: '36.00' } } });
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.headers.get('x-cart-view')).toBe('1');
    expect(seen[0]!.headers.get('accept')).toBe('application/json');
    expect(seen[0]!.headers.get('x-requested-with')).toBe('fetch');
  });

  it('passes the server\'s curated message through for a refused add (422)', async () => {
    const { fetchLike, client } = wiredFetch();
    client.rejectMutationsWith('nope');

    expect(await requestCartView('/api/cart/add', form({ merchandiseId: VARIANT }), fetchLike)).toEqual({
      ok: false,
      message: CART_REJECTED_MESSAGE,
    });
  });

  it('shows the generic text for a 400, which carries a developer message', async () => {
    const { fetchLike } = wiredFetch();
    expect(await requestCartView('/api/cart/add', form({ merchandiseId: 'nope' }), fetchLike)).toEqual({
      ok: false,
      message: GENERIC_ERROR,
    });
  });

  it('shows the generic text when the network fails or the body is not a cart', async () => {
    const offline: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    const html: FetchLike = async () => new Response('<html>', { status: 200 });
    const boom: FetchLike = async () => new Response('Internal', { status: 500 });

    for (const fetchLike of [offline, html, boom]) {
      expect(await requestCartView('/api/cart/view', undefined, fetchLike)).toEqual({ ok: false, message: GENERIC_ERROR });
    }
  });

  it('uses GET when there is no body', async () => {
    let method = '';
    const fetchLike: FetchLike = async (_url, init) => {
      method = init?.method ?? '';
      return Response.json({ lineCount: 0, subtotal: { amount: '0.00', currencyCode: 'GBP' }, checkoutUrl: '', lines: [] });
    };
    expect((await requestCartView('/api/cart/view', undefined, fetchLike)).ok).toBe(true);
    expect(method).toBe('GET');
  });
});

describe('fetchLineCount', () => {
  it('reads lineCount from the summary route', async () => {
    expect(await fetchLineCount('/s', async () => Response.json({ lineCount: 3 }))).toBe(3);
  });

  it('is null when the route fails or answers something else', async () => {
    expect(await fetchLineCount('/s', async () => new Response('', { status: 500 }))).toBeNull();
    expect(await fetchLineCount('/s', async () => Response.json({ nope: 1 }))).toBeNull();
    expect(await fetchLineCount('/s', async () => { throw new Error('offline'); })).toBeNull();
  });
});

describe('cartActionOf', () => {
  const urls = { add: '/api/cart/add', update: '/api/cart/update', remove: '/api/cart/remove' };
  const page = 'https://example.com/product/mug';

  it('recognises a form posting to the add, update or remove route', () => {
    expect(cartActionOf('/api/cart/add', urls, page)).toBe('add');
    expect(cartActionOf('https://example.com/api/cart/update', urls, page)).toBe('update');
    expect(cartActionOf('/api/cart/remove?x=1', urls, page)).toBe('remove');
  });

  it('ignores any other path or another origin', () => {
    expect(cartActionOf('/api/cart/summary', urls, page)).toBeNull();
    expect(cartActionOf('/somewhere/else', urls, page)).toBeNull();
    expect(cartActionOf('https://evil.example.org/api/cart/add', urls, page)).toBeNull();
  });
});

describe('showCount', () => {
  /** A badge as `CartCount.astro` serves it: hidden, with no `aria-hidden`. */
  function badge(): CountBadge & { attributes: Record<string, string> } {
    const attributes: Record<string, string> = {};
    return {
      textContent: '0',
      hidden: true,
      attributes,
      setAttribute: (name, value) => void (attributes[name] = value),
      removeAttribute: (name) => void delete attributes[name],
    };
  }

  it('shows a count, kept from screen readers because the label says it', () => {
    const element = badge();
    showCount(element, 3);

    expect(element.textContent).toBe('3');
    expect(element.hidden).toBe(false);
    expect(element.attributes['aria-hidden']).toBe('true');
  });

  it('hides an empty cart, with no aria-hidden beside hidden', () => {
    const element = badge();
    showCount(element, 2);
    showCount(element, 0);

    expect(element.textContent).toBe('0');
    expect(element.hidden).toBe(true);
    expect(element.attributes).toEqual({});
  });
});

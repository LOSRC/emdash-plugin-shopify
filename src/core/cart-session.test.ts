import { describe, it, expect } from 'vitest';
import { astroCartSession } from './cart-session';
import type { StoredCart } from './cart-session';

const STORED: StoredCart = {
  id: 'gid://shopify/Cart/live',
  snapshot: { lineCount: 2, subtotal: '36.00', currency: 'GBP' },
};

/** A stand-in for Astro's session: a Map behind get/set, recording the keys used. */
function fakeAstroSession() {
  const data = new Map<string, unknown>();
  const keys: string[] = [];
  return {
    data,
    keys,
    get: async (key: 'cart') => {
      keys.push(key);
      return data.get(key);
    },
    set: (key: 'cart', value: StoredCart) => {
      keys.push(key);
      data.set(key, value);
    },
    delete: (key: 'cart') => {
      keys.push(key);
      data.delete(key);
    },
  };
}

describe('astroCartSession', () => {
  it('round-trips the stored cart through the Astro session under the cart key', async () => {
    const astro = fakeAstroSession();
    const session = astroCartSession(astro);

    expect(await session.read()).toBeUndefined();
    session.write(STORED);

    expect(await session.read()).toEqual(STORED);
    expect(new Set(astro.keys)).toEqual(new Set(['cart']));
  });

  it('forgets the stored cart on clear', async () => {
    const session = astroCartSession(fakeAstroSession());
    session.write(STORED);
    session.clear();
    expect(await session.read()).toBeUndefined();
  });

  it('is inert when the site has no session: reads are empty and writes are no-ops', async () => {
    const session = astroCartSession(undefined);
    session.write(STORED);
    session.clear();
    expect(await session.read()).toBeUndefined();
  });

  it('treats a null session value as no cart', async () => {
    const astro = fakeAstroSession();
    astro.data.set('cart', null);
    expect(await astroCartSession(astro).read()).toBeUndefined();
  });
});

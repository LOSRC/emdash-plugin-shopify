import type { CartSnapshot } from './types';

/**
 * The cart's session seam. The runtime and the site's cart page read and write the stored cart
 * through a `CartSession`; only `astroCartSession` knows it is backed by the Astro session. That keeps
 * the stored shape and the session key in one place and lets tests inject an in-memory session.
 *
 * The site declares the session shape once, in its `src/env.d.ts`:
 * `declare namespace App { interface SessionData { cart: import('@losrc/emdash-plugin-shopify/core').StoredCart } }`
 */

/** The record persisted to the session: the Shopify cart id plus the cached badge snapshot. */
export interface StoredCart {
  id: string;
  snapshot: CartSnapshot;
}

/** The read/write seam the cart runtime uses. `read` resolves `undefined` when there is no cart (or no session). */
export interface CartSession {
  read(): Promise<StoredCart | undefined>;
  write(cart: StoredCart): void;
}

/** The slice of the Astro session this seam uses: structural, so core imports no Astro types. */
export interface AstroSessionLike {
  get(key: 'cart'): Promise<unknown>;
  set(key: 'cart', value: StoredCart): void;
}

/**
 * Wrap the Astro session (`context.session` / `Astro.session`) as a `CartSession`. The session is
 * `undefined` when the site has no session driver (plain `astro dev`); reads then resolve
 * `undefined` and writes are no-ops.
 */
export function astroCartSession(session: AstroSessionLike | undefined): CartSession {
  return {
    async read() {
      return ((await session?.get('cart')) as StoredCart | null | undefined) ?? undefined;
    },
    write(cart) {
      session?.set('cart', cart);
    },
  };
}

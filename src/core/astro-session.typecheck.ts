/**
 * Type-level check, compiled by `pnpm typecheck` and never run: `context.session` from a real Astro
 * `APIContext` must be accepted by `astroCartSession`, both with and without the site's
 * `App.SessionData` augmentation.
 */
import type { APIContext } from 'astro';
import { astroCartSession } from './cart-session';
import type { StoredCart } from './cart-session';

declare global {
  namespace App {
    interface SessionData {
      cart: StoredCart;
    }
  }
}

export function routeAdapter(context: APIContext) {
  return astroCartSession(context.session);
}

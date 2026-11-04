import type { Cart } from './types';
import type { CartLineInput, CartLineUpdate } from './cart';

/**
 * The cart client interface: the one seam between the cart runtime and Shopify. Two adapters
 * implement it: the Storefront adapter (storefront.ts) does the real network I/O, and the in-memory
 * fake (`@losrc/emdash-plugin-shopify/core/testing`) backs tests. The runtime depends only on this
 * interface, so the orchestration is exercised end to end without a live Shopify or the Workers
 * runtime.
 */

/** A Storefront `userError`: a non-throwing, user-facing problem (e.g. sold out, quantity rejected). */
export interface UserError {
  field: string[] | null;
  message: string;
}

/** Every mutation returns Shopify's authoritative cart (or `null` if it could not act) plus userErrors. */
export interface CartMutationResult {
  cart: Cart | null;
  userErrors: UserError[];
}

/**
 * The operations the cart runtime needs from Shopify. Mutations return the authoritative cart (never
 * a locally-synthesised one); `getCart` returns `null` when Shopify no longer resolves the id
 * (expired or checked out). Transport and GraphQL failures reject; callers degrade at the seam.
 */
export interface ShopifyCartClient {
  /** Create a new cart seeded with the given lines. */
  cartCreate(lines: CartLineInput[]): Promise<CartMutationResult>;
  /** Add lines to an existing cart. `cart: null` means the id no longer resolves (stale). */
  cartLinesAdd(cartId: string, lines: CartLineInput[]): Promise<CartMutationResult>;
  /** Change the quantity of existing cart lines (by CartLine id). */
  cartLinesUpdate(cartId: string, lines: CartLineUpdate[]): Promise<CartMutationResult>;
  /** Remove cart lines by their CartLine ids. */
  cartLinesRemove(cartId: string, lineIds: string[]): Promise<CartMutationResult>;
  /** Fetch a cart by id; `null` once Shopify no longer resolves it. */
  getCart(cartId: string): Promise<Cart | null>;
}

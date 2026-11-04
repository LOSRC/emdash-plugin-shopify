import type { Cart } from './types';
import type { ChannelProduct, ShopProduct } from './shop-data';
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
  /** Shopify's `CartErrorCode` (for example `INVALID`), when it gives one. Too coarse to tell a lost cart apart: see `isCartGone`. */
  code?: string;
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
  /** Add lines to an existing cart. A lost cart answers `cart: null` with a userError about `cartId` (see `isCartGone`). */
  cartLinesAdd(cartId: string, lines: CartLineInput[]): Promise<CartMutationResult>;
  /** Change the quantity of existing cart lines (by CartLine id). */
  cartLinesUpdate(cartId: string, lines: CartLineUpdate[]): Promise<CartMutationResult>;
  /** Remove cart lines by their CartLine ids. */
  cartLinesRemove(cartId: string, lineIds: string[]): Promise<CartMutationResult>;
  /** Fetch a cart by id; `null` once Shopify no longer resolves it. */
  getCart(cartId: string): Promise<Cart | null>;
}

/**
 * The products capability: shop data by product ID, and the products on the token's sales channel.
 * Unlike `readShopData` (the public reader, which never throws), both methods reject on transport
 * and GraphQL failures, so a caller that must not act on a bad answer (the sync) sees the failure.
 */
export interface ShopifyProductsClient {
  /**
   * Shop data for the given numeric product IDs. Every id asked for is a key of the result; the value
   * is `null` when Shopify does not return the product (unknown, deleted or not published to the
   * channel). Batches over Shopify's per-request limit internally.
   */
  getProducts(ids: string[]): Promise<Map<string, ShopProduct | null>>;
  /** Every product published to the token's sales channel (id, handle, title), following pagination. */
  listChannelProducts(): Promise<ChannelProduct[]>;
}

/** Everything the shop core asks of Shopify: the cart and the products. */
export type ShopifyClient = ShopifyCartClient & ShopifyProductsClient;

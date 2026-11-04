import type { Cart } from './types';
import type { CartLineInput, CartLineUpdate } from './cart';
import type { CartMutationResult, ShopifyCartClient } from './client';
import { createShopifyTransport } from './transport';
import type { ShopifyTransportConfig } from './transport';

/**
 * Storefront Cart API adapter: the production implementation of `ShopifyCartClient`, the impure
 * boundary the cart routes round-trip at request time. Shopify owns the authoritative cart; these
 * calls create it and mutate its lines, always returning Shopify's own response (never a
 * locally-synthesised cart). Pure reductions of that response live in cart.ts; the orchestration in
 * cart-runtime.ts.
 *
 * The config is injected into `createStorefrontCartClient(config)`; this module imports no
 * `cloudflare:workers`, so it (and everything downstream) is importable under vitest. Endpoint, auth
 * header and error modes live in the one transport (./transport). Network I/O is covered by a
 * fetch-stub test and by creds-gated integration runs; the in-memory fake backs the orchestration tests.
 */

/** The config the adapter needs: the transport's config (shop, token, token kind, fetch, ...). */
export type StorefrontConfig = ShopifyTransportConfig;

/** The environment variable names `storefrontConfigFromEnv` reads; the documented defaults. */
export interface StorefrontEnv {
  /** Shop domain, e.g. `example-shop.myshopify.com`. */
  SHOPIFY_SHOP?: string;
  /** Storefront API access token: a runtime secret. */
  SHOPIFY_STOREFRONT_TOKEN?: string;
  /** Storefront API version; the transport's default applies when unset. */
  SHOPIFY_API_VERSION?: string;
}

/**
 * Build a {@link StorefrontConfig} from an environment shaped like the Workers `env`
 * (`SHOPIFY_SHOP`, `SHOPIFY_STOREFRONT_TOKEN`, optional `SHOPIFY_API_VERSION`). Throws a readable
 * error naming the missing variable. Spread the result and add `tokenKind`, `buyerIp` or `fetch`
 * as needed.
 */
export function storefrontConfigFromEnv(env: StorefrontEnv): StorefrontConfig {
  if (!env.SHOPIFY_SHOP) throw new Error('SHOPIFY_SHOP is not set');
  if (!env.SHOPIFY_STOREFRONT_TOKEN) throw new Error('SHOPIFY_STOREFRONT_TOKEN is not set');
  return {
    shop: env.SHOPIFY_SHOP,
    token: env.SHOPIFY_STOREFRONT_TOKEN,
    ...(env.SHOPIFY_API_VERSION ? { apiVersion: env.SHOPIFY_API_VERSION } : {}),
  };
}

// Shared selection so every cart response deserialises to the same `Cart` shape (./types).
// `lines(first: 100)` with `nodes` (not edges) — flat to match the type; 100 covers any realistic basket.
const CART_FIELDS = `
fragment CartFields on Cart {
  id
  checkoutUrl
  totalQuantity
  cost {
    subtotalAmount { amount currencyCode }
    totalAmount { amount currencyCode }
  }
  lines(first: 100) {
    nodes {
      id
      quantity
      cost { totalAmount { amount currencyCode } }
      merchandise {
        ... on ProductVariant {
          id
          title
          price { amount currencyCode }
          product { title handle }
          image { url altText }
        }
      }
    }
  }
}`;

/**
 * Build a `ShopifyCartClient` bound to the given config. The route calls this at request time; all
 * I/O goes through the shared Storefront transport.
 */
export function createStorefrontCartClient(config: StorefrontConfig): ShopifyCartClient {
  const transport = createShopifyTransport(config);

  return {
    async cartCreate(lines: CartLineInput[]): Promise<CartMutationResult> {
      const data = await transport.request<{ cartCreate: CartMutationResult }>(
        `${CART_FIELDS}
        mutation CartCreate($lines: [CartLineInput!]!) {
          cartCreate(input: { lines: $lines }) {
            cart { ...CartFields }
            userErrors { field message }
          }
        }`,
        { lines },
      );
      return data.cartCreate;
    },

    async cartLinesAdd(cartId: string, lines: CartLineInput[]): Promise<CartMutationResult> {
      const data = await transport.request<{ cartLinesAdd: CartMutationResult }>(
        `${CART_FIELDS}
        mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
          cartLinesAdd(cartId: $cartId, lines: $lines) {
            cart { ...CartFields }
            userErrors { field message }
          }
        }`,
        { cartId, lines },
      );
      return data.cartLinesAdd;
    },

    async cartLinesUpdate(cartId: string, lines: CartLineUpdate[]): Promise<CartMutationResult> {
      const data = await transport.request<{ cartLinesUpdate: CartMutationResult }>(
        `${CART_FIELDS}
        mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
          cartLinesUpdate(cartId: $cartId, lines: $lines) {
            cart { ...CartFields }
            userErrors { field message }
          }
        }`,
        { cartId, lines },
      );
      return data.cartLinesUpdate;
    },

    async cartLinesRemove(cartId: string, lineIds: string[]): Promise<CartMutationResult> {
      const data = await transport.request<{ cartLinesRemove: CartMutationResult }>(
        `${CART_FIELDS}
        mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
          cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
            cart { ...CartFields }
            userErrors { field message }
          }
        }`,
        { cartId, lineIds },
      );
      return data.cartLinesRemove;
    },

    async getCart(cartId: string): Promise<Cart | null> {
      const data = await transport.request<{ cart: Cart | null }>(
        `${CART_FIELDS}
        query GetCart($cartId: ID!) {
          cart(id: $cartId) { ...CartFields }
        }`,
        { cartId },
      );
      return data.cart;
    },
  };
}

/**
 * The one Shopify Storefront GraphQL transport. Every Storefront call (cart, shop data) goes through
 * it. It takes an injectable `fetch` (the sync plugin passes EmDash's `ctx.http.fetch`, the only way
 * the plugin's outbound-host limit is enforced) and falls back to the global `fetch`, so it runs
 * identically in a Worker and in Node and is importable under vitest. Config is injected by the
 * caller (never read here), so nothing pulls in `cloudflare:workers` or `process.env`.
 */
import { assertShopHost } from './shop-host';

/**
 * Which Storefront token the config carries. A `public` token is sent as
 * `X-Shopify-Storefront-Access-Token`; a `private` (server-side) token is sent as
 * `Shopify-Storefront-Private-Token` and should be paired with the visitor's IP via `buyerIp`.
 */
export type StorefrontTokenKind = 'public' | 'private';

/** Storefront API version used when the config does not name one. */
export const DEFAULT_API_VERSION = '2026-10';

export interface ShopifyTransportConfig {
  /** Shop domain, e.g. `example-shop.myshopify.com`. A bare `*.myshopify.com` hostname; anything else throws. */
  shop: string;
  /** API version; defaults to {@link DEFAULT_API_VERSION} when unset. */
  apiVersion?: string;
  /** The Storefront access token. */
  token: string;
  /** Which kind of token `token` is; defaults to `public`. */
  tokenKind?: StorefrontTokenKind;
  /**
   * The visitor's IP, forwarded as `Shopify-Storefront-Buyer-IP`. Send it with a private token on
   * buyer-originated requests so Shopify does not throttle the Worker's own address. Ignored for
   * public tokens.
   */
  buyerIp?: string;
  /** The fetch to use; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** A transport bound to one shop, API version and token: POST a GraphQL op, get its `data` back. */
export interface ShopifyTransport {
  /** POST a GraphQL operation and return its `data`. Throws on transport or GraphQL errors. */
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

/** Build a transport for the Storefront API. */
export function createShopifyTransport(config: ShopifyTransportConfig): ShopifyTransport {
  const version = config.apiVersion ?? DEFAULT_API_VERSION;
  const endpoint = `https://${assertShopHost(config.shop)}/api/${version}/graphql.json`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.tokenKind === 'private') {
    headers['Shopify-Storefront-Private-Token'] = config.token;
    if (config.buyerIp) headers['Shopify-Storefront-Buyer-IP'] = config.buyerIp;
  } else {
    headers['X-Shopify-Storefront-Access-Token'] = config.token;
  }

  return {
    async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      // Resolved per call so a test (or a runtime) that swaps the global fetch is honoured.
      const doFetch = config.fetch ?? fetch;
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) throw new Error(`Storefront API HTTP ${response.status} ${response.statusText}`);
      const body = (await response.json()) as { data?: T; errors?: unknown };
      if (body.errors) throw new Error(`Storefront API GraphQL errors: ${JSON.stringify(body.errors)}`);
      if (!body.data) throw new Error('Storefront API returned no data');
      return body.data;
    },
  };
}

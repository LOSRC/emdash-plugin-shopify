import type { Money } from './types';
import type { ShopifyProductsClient } from './client';

/**
 * Shop data: what a site shows about a Shopify product (image, title, description, price range,
 * variants, availability, handle), and `readShopData`, the one function a page calls to get it.
 *
 * Shopify is the only source of this data. Pages that show it are cached, so the reader tells the
 * page when its answer must not be cached: the page always gets something it can render, and a page
 * built while Shopify was failing or a product was missing never lands in the cache.
 */

/** The main image of a product. */
export interface ShopImage {
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
}

/** One purchasable variant. `id` is the `merchandiseId` the cart accepts. */
export interface ShopVariant {
  id: string;
  /** Shopify's `Default Title` sentinel for single-variant products. */
  title: string;
  availableForSale: boolean;
  price: Money;
  selectedOptions: { name: string; value: string }[];
}

/** The shop data of one product, as Shopify's Storefront API answers it. Prices are raw {@link Money}. */
export interface ShopProduct {
  /** The numeric Shopify product ID, e.g. `7463040909518`: the key an entry stores to link to Shopify. */
  id: string;
  /** The same product as a global ID, `gid://shopify/Product/7463040909518`. */
  gid: string;
  handle: string;
  title: string;
  /** Plain text with HTML stripped. */
  description: string;
  /** True when at least one variant can be bought. */
  availableForSale: boolean;
  image: ShopImage | null;
  priceRange: { min: Money; max: Money };
  options: { name: string; values: string[] }[];
  variants: ShopVariant[];
}

/** A product on the token's sales channel, as much as the sync needs. */
export interface ChannelProduct {
  /** Numeric Shopify product ID, the same form as {@link ShopProduct.id}. */
  id: string;
  handle: string;
  title: string;
}

/**
 * The answer for one id. `not-found` covers an id Shopify does not know and one that is not published
 * to the sales channel (Shopify treats the two alike); `shopify-error` means Shopify could not be
 * asked or answered badly.
 */
export type ShopDataResult =
  | { status: 'ok'; product: ShopProduct }
  | { status: 'unavailable'; reason: 'not-found' | 'shopify-error' };

export interface ShopDataReadout {
  /** One entry per distinct id asked for, keyed by the id exactly as the caller wrote it. */
  products: Record<string, ShopDataResult>;
  /**
   * False whenever any id came back unavailable or Shopify failed: the page must not be cached
   * (send `Cache-Control: no-store`, no cache tag). True only when every id resolved (and for an
   * empty request).
   */
  cacheable: boolean;
}

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/(\d+)$/;

/** The numeric product ID of a numeric ID or a product GID, or `null` for anything else. */
export function productIdOf(idOrGid: string): string | null {
  if (/^\d+$/.test(idOrGid)) return idOrGid;
  return PRODUCT_GID.exec(idOrGid)?.[1] ?? null;
}

/**
 * Read the shop data of one or many products by Shopify product ID (numeric `7463040909518` or a
 * `gid://shopify/Product/...`; the result is keyed by the id as given). Never throws: an unknown or
 * unpublished id, a malformed id, or Shopify failing each yield `unavailable` for the affected ids
 * and `cacheable: false`. If Shopify fails, every id is `shopify-error` (no partial answers).
 */
export async function readShopData(client: ShopifyProductsClient, ids: string[]): Promise<ShopDataReadout> {
  const asked = [...new Set(ids)];
  const numeric = new Map<string, string>(); // as given -> numeric id
  for (const id of asked) {
    const parsed = productIdOf(id);
    if (parsed) numeric.set(id, parsed);
  }

  let found: Map<string, ShopProduct | null> = new Map();
  let failed = false;
  const toFetch = [...new Set(numeric.values())];
  if (toFetch.length > 0) {
    try {
      found = await client.getProducts(toFetch);
    } catch {
      failed = true;
    }
  }

  const results = asked.map((id): [string, ShopDataResult] => {
    if (failed && numeric.has(id)) return [id, { status: 'unavailable', reason: 'shopify-error' }];
    const product = found.get(numeric.get(id) ?? '');
    return [id, product ? { status: 'ok', product } : { status: 'unavailable', reason: 'not-found' }];
  });

  return {
    products: Object.fromEntries(results),
    cacheable: results.every(([, result]) => result.status === 'ok'),
  };
}

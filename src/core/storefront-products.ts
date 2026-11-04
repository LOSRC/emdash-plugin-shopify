import type { ShopifyClient, ShopifyProductsClient } from './client';
import { createStorefrontCartClient } from './storefront';
import type { StorefrontConfig } from './storefront';
import { createShopifyTransport } from './transport';
import { productIdOf } from './shop-data';
import type { ChannelProduct, ShopProduct } from './shop-data';
import type { Money } from './types';

/**
 * Storefront products adapter: the production implementation of `ShopifyProductsClient`. It reads
 * through the shared Storefront transport with a Storefront access token only; nothing here talks to
 * the Admin API. Shopify's visibility rule does the publish filtering: the Storefront API only
 * answers for products published to the token's sales channel, so an unpublished product comes back
 * as `null` from `nodes(ids:)` and is left out of `products`.
 */

/** Shopify's limit on ids in one `nodes(ids:)` call. */
const NODES_LIMIT = 250;
/** Shopify's cap on one page of a connection. */
const PAGE_SIZE = 250;

const SHOP_PRODUCT_FIELDS = `
fragment ShopProduct on Product {
  id
  handle
  title
  description
  availableForSale
  featuredImage { url altText width height }
  priceRange {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount currencyCode }
  }
  options { name values }
  variants(first: 100) {
    nodes {
      id
      title
      availableForSale
      price { amount currencyCode }
      selectedOptions { name value }
    }
  }
}`;

/** The slice of Shopify's Product response `toShopProduct` reads; any of it may be missing. */
interface RawProduct {
  id?: string;
  handle?: string;
  title?: string;
  description?: string | null;
  availableForSale?: boolean;
  featuredImage?: { url: string; altText?: string | null; width?: number | null; height?: number | null } | null;
  priceRange?: { minVariantPrice: Money; maxVariantPrice: Money };
  options?: { name: string; values: string[] }[];
  variants?: { nodes?: NonNullable<RawVariant>[] };
}

type RawVariant = {
  id: string;
  title: string;
  availableForSale: boolean;
  price: Money;
  selectedOptions?: { name: string; value: string }[];
};

/**
 * Reduce a `nodes` entry to a {@link ShopProduct}, or `null` when it is not one: `null` (not found or
 * not published) and `{}` (a node of another type matches no fragment) both mean "no product".
 */
function toShopProduct(node: RawProduct | null | undefined): ShopProduct | null {
  const id = node?.id ? productIdOf(node.id) : null;
  if (!node || !id || !node.priceRange) return null;
  return {
    id,
    gid: node.id!,
    handle: node.handle ?? '',
    title: node.title ?? '',
    description: node.description ?? '',
    availableForSale: node.availableForSale ?? false,
    image: node.featuredImage
      ? {
          url: node.featuredImage.url,
          altText: node.featuredImage.altText ?? null,
          width: node.featuredImage.width ?? null,
          height: node.featuredImage.height ?? null,
        }
      : null,
    priceRange: { min: node.priceRange.minVariantPrice, max: node.priceRange.maxVariantPrice },
    options: node.options ?? [],
    variants: (node.variants?.nodes ?? []).map((variant) => ({
      id: variant.id,
      title: variant.title,
      availableForSale: variant.availableForSale,
      price: variant.price,
      selectedOptions: variant.selectedOptions ?? [],
    })),
  };
}

/** Build the products capability over the Storefront API. All I/O goes through the shared transport. */
export function createStorefrontProductsClient(config: StorefrontConfig): ShopifyProductsClient {
  const transport = createShopifyTransport(config);

  return {
    async getProducts(ids: string[]): Promise<Map<string, ShopProduct | null>> {
      const result = new Map<string, ShopProduct | null>();
      const numericIds = new Set<string>(); // what to put to Shopify
      for (const id of new Set(ids)) {
        const numeric = productIdOf(id);
        if (numeric) numericIds.add(numeric);
        result.set(id, null);
      }
      const toAsk = [...numericIds];

      const found = new Map<string, ShopProduct>();
      for (let start = 0; start < toAsk.length; start += NODES_LIMIT) {
        const chunk = toAsk.slice(start, start + NODES_LIMIT);
        const data = await transport.request<{ nodes: (RawProduct | null)[] }>(
          `${SHOP_PRODUCT_FIELDS}
          query ShopProducts($ids: [ID!]!) {
            nodes(ids: $ids) { ... on Product { ...ShopProduct } }
          }`,
          { ids: chunk.map((id) => `gid://shopify/Product/${id}`) },
        );
        for (const node of data.nodes) {
          const product = toShopProduct(node);
          if (product) found.set(product.id, product);
        }
      }

      for (const id of result.keys()) {
        const numeric = productIdOf(id);
        result.set(id, (numeric && found.get(numeric)) || null);
      }
      return result;
    },

    async listChannelProducts(): Promise<ChannelProduct[]> {
      const products: ChannelProduct[] = [];
      let after: string | null = null;
      for (;;) {
        const data: {
          products: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: { id: string; handle: string; title: string }[];
          };
        } = await transport.request(
          `query ChannelProducts($first: Int!, $after: String) {
            products(first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id handle title }
            }
          }`,
          { first: PAGE_SIZE, after },
        );
        for (const node of data.products.nodes) {
          const id = productIdOf(node.id);
          if (id) products.push({ id, handle: node.handle, title: node.title });
        }
        const { hasNextPage, endCursor } = data.products.pageInfo;
        // A next page without a cursor cannot be followed; stop instead of looping on page one.
        if (!hasNextPage || !endCursor) return products;
        after = endCursor;
      }
    },
  };
}

/** Build the full {@link ShopifyClient} (cart and products) over the Storefront API. */
export function createStorefrontClient(config: StorefrontConfig): ShopifyClient {
  return { ...createStorefrontCartClient(config), ...createStorefrontProductsClient(config) };
}

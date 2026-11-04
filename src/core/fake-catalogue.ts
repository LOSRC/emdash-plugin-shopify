import type { ShopifyProductsClient } from './client';
import type { ChannelProduct, ShopImage, ShopProduct, ShopVariant } from './shop-data';

/**
 * The product catalogue behind the in-memory fake (see testing.ts): the products capability of the
 * client, with real publish state. Like Shopify, only a published product is visible: an unpublished
 * or removed id is simply absent from `getProducts` and `listChannelProducts`.
 */

export interface FakeVariantInput {
  /** Defaults to a generated `gid://shopify/ProductVariant/...`. */
  id?: string;
  /** Defaults to `Default Title`, as for a single-variant product on Shopify. */
  title?: string;
  /** Decimal amount string, in the fake's currency. Defaults to `10.00`. */
  price?: string;
  /** Defaults to true. */
  availableForSale?: boolean;
  selectedOptions?: { name: string; value: string }[];
}

export interface FakeProductInput {
  /** Numeric Shopify product ID. */
  id: string;
  handle: string;
  title: string;
  description?: string;
  image?: Partial<ShopImage> & { url: string };
  /** Defaults to one `Default Title` variant. */
  variants?: FakeVariantInput[];
  /** Whether the product is published to the sales channel. Defaults to true. */
  published?: boolean;
}

export interface FakeCatalogue extends ShopifyProductsClient {
  /** Add or replace a product. */
  seedProduct(product: FakeProductInput): void;
  /** Publish or unpublish a seeded product; unknown ids are ignored. */
  setPublished(id: string, published: boolean): void;
  /** Delete a product, as if removed in Shopify. */
  removeProduct(id: string): void;
}

interface Entry {
  product: ShopProduct;
  published: boolean;
}

export function createFakeCatalogue(deps: { currency: string; checkFailure: () => void }): FakeCatalogue {
  const { currency, checkFailure } = deps;
  const entries = new Map<string, Entry>();
  let variantSeq = 0;

  function build(input: FakeProductInput): ShopProduct {
    const variants: ShopVariant[] = (input.variants ?? [{}]).map((variant) => ({
      id: variant.id ?? `gid://shopify/ProductVariant/fake-${++variantSeq}`,
      title: variant.title ?? 'Default Title',
      availableForSale: variant.availableForSale ?? true,
      price: { amount: variant.price ?? '10.00', currencyCode: currency },
      selectedOptions: variant.selectedOptions ?? [],
    }));
    const byPrice = [...variants].sort((a, b) => Number(a.price.amount) - Number(b.price.amount));
    const options: ShopProduct['options'] = [];
    for (const variant of variants) {
      for (const { name, value } of variant.selectedOptions) {
        const option = options.find((candidate) => candidate.name === name) ?? options[options.push({ name, values: [] }) - 1]!;
        if (!option.values.includes(value)) option.values.push(value);
      }
    }
    return {
      id: input.id,
      gid: `gid://shopify/Product/${input.id}`,
      handle: input.handle,
      title: input.title,
      description: input.description ?? '',
      availableForSale: variants.some((variant) => variant.availableForSale),
      image: input.image
        ? { url: input.image.url, altText: input.image.altText ?? null, width: input.image.width ?? null, height: input.image.height ?? null }
        : null,
      priceRange: { min: byPrice[0]!.price, max: byPrice[byPrice.length - 1]!.price },
      options,
      variants,
    };
  }

  return {
    seedProduct(input) {
      entries.set(input.id, { product: build(input), published: input.published ?? true });
    },

    setPublished(id, published) {
      const entry = entries.get(id);
      if (entry) entry.published = published;
    },

    removeProduct(id) {
      entries.delete(id);
    },

    async getProducts(ids) {
      checkFailure();
      const result = new Map<string, ShopProduct | null>();
      for (const id of ids) {
        const entry = entries.get(id);
        result.set(id, entry?.published ? structuredClone(entry.product) : null);
      }
      return result;
    },

    async listChannelProducts(): Promise<ChannelProduct[]> {
      checkFailure();
      return [...entries.values()]
        .filter((entry) => entry.published)
        .map(({ product }) => ({ id: product.id, handle: product.handle, title: product.title }));
    },
  };
}

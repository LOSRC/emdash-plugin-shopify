import { describe, it, expect } from 'vitest';
import { createStorefrontClient, createStorefrontProductsClient } from './storefront-products';
import { readShopData } from './shop-data';
import cartFixture from './fixtures/cart.json';

const SHOP = 'example-shop.myshopify.com';

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, any> };
}

/** A fetch stub that records each request and answers with the given function's JSON, or a status. */
function stubFetch(answer: (call: Recorded, index: number) => { status?: number; json?: unknown }) {
  const calls: Recorded[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Recorded = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    };
    calls.push(call);
    const reply = answer(call, calls.length - 1);
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

const gidOf = (id: string) => `gid://shopify/Product/${id}`;

const shopifyProduct = (id: string, extra: Record<string, unknown> = {}) => ({
  id: gidOf(id),
  handle: `product-${id}`,
  title: `Product ${id}`,
  description: 'Plain text.',
  availableForSale: true,
  featuredImage: { url: 'https://cdn.example/a.jpg', altText: null, width: 600, height: 400 },
  priceRange: {
    minVariantPrice: { amount: '12.0', currencyCode: 'GBP' },
    maxVariantPrice: { amount: '18.5', currencyCode: 'GBP' },
  },
  options: [{ name: 'Size', values: ['A3', 'A2'] }],
  variants: {
    nodes: [
      {
        id: 'gid://shopify/ProductVariant/1',
        title: 'A3',
        availableForSale: true,
        price: { amount: '12.0', currencyCode: 'GBP' },
        selectedOptions: [{ name: 'Size', value: 'A3' }],
      },
    ],
  },
  ...extra,
});

describe('Storefront products client: getProducts', () => {
  it('asks nodes(ids:) for the product GIDs and maps the answer, with null for what Shopify does not return', async () => {
    const { fetch, calls } = stubFetch(() => ({
      json: { data: { nodes: [shopifyProduct('11'), null, {}] } },
    }));
    const client = createStorefrontProductsClient({ shop: SHOP, token: 'tok', fetch });

    const result = await client.getProducts(['11', '22', '33']);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://${SHOP}/api/2026-10/graphql.json`);
    expect(calls[0]!.headers['x-shopify-storefront-access-token']).toBe('tok');
    expect(calls[0]!.body.query).toContain('nodes(ids: $ids)');
    expect(calls[0]!.body.variables).toEqual({ ids: [gidOf('11'), gidOf('22'), gidOf('33')] });
    expect([...result.keys()]).toEqual(['11', '22', '33']);
    expect(result.get('11')).toEqual({
      id: '11',
      gid: gidOf('11'),
      handle: 'product-11',
      title: 'Product 11',
      description: 'Plain text.',
      availableForSale: true,
      image: { url: 'https://cdn.example/a.jpg', altText: null, width: 600, height: 400 },
      priceRange: {
        min: { amount: '12.0', currencyCode: 'GBP' },
        max: { amount: '18.5', currencyCode: 'GBP' },
      },
      options: [{ name: 'Size', values: ['A3', 'A2'] }],
      variants: [
        {
          id: 'gid://shopify/ProductVariant/1',
          title: 'A3',
          availableForSale: true,
          price: { amount: '12.0', currencyCode: 'GBP' },
          selectedOptions: [{ name: 'Size', value: 'A3' }],
        },
      ],
    });
    expect(result.get('22')).toBeNull();
    expect(result.get('33')).toBeNull();
  });

  it('maps a product with no main image to image: null', async () => {
    const { fetch } = stubFetch(() => ({ json: { data: { nodes: [shopifyProduct('11', { featuredImage: null })] } } }));

    const result = await createStorefrontProductsClient({ shop: SHOP, token: 't', fetch }).getProducts(['11']);

    expect(result.get('11')?.image).toBeNull();
  });

  it('sends a private token under its own header', async () => {
    const { fetch, calls } = stubFetch(() => ({ json: { data: { nodes: [null] } } }));

    await createStorefrontProductsClient({ shop: SHOP, token: 'priv', tokenKind: 'private', fetch }).getProducts(['1']);

    expect(calls[0]!.headers['shopify-storefront-private-token']).toBe('priv');
    expect(calls[0]!.headers['x-shopify-storefront-access-token']).toBeUndefined();
  });

  it('splits more than 250 ids into requests of at most 250 and merges the answers', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => String(1000 + i));
    const { fetch, calls } = stubFetch((call) => ({
      json: { data: { nodes: (call.body.variables.ids as string[]).map((gid) => shopifyProduct(gid.split('/').pop()!)) } },
    }));

    const result = await createStorefrontProductsClient({ shop: SHOP, token: 't', fetch }).getProducts(ids);

    expect(calls.map((call) => call.body.variables.ids.length)).toEqual([250, 250, 100]);
    expect(result.size).toBe(600);
    expect(result.get('1000')?.handle).toBe('product-1000');
    expect(result.get('1599')?.handle).toBe('product-1599');
  });

  it('sends exactly 250 ids in one request', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(1 + i));
    const { fetch, calls } = stubFetch((call) => ({ json: { data: { nodes: call.body.variables.ids.map(() => null) } } }));

    await createStorefrontProductsClient({ shop: SHOP, token: 't', fetch }).getProducts(ids);

    expect(calls).toHaveLength(1);
  });

  it('makes no request for no ids', async () => {
    const { fetch, calls } = stubFetch(() => ({}));

    const result = await createStorefrontProductsClient({ shop: SHOP, token: 't', fetch }).getProducts([]);

    expect(result.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('rejects when Shopify answers an error, and rejects the whole call if any chunk fails', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => String(1 + i));
    const { fetch } = stubFetch((_, index) =>
      index === 0 ? { json: { data: { nodes: [] } } } : { status: 503 },
    );

    await expect(createStorefrontProductsClient({ shop: SHOP, token: 't', fetch }).getProducts(ids)).rejects.toThrow('503');
  });

  it('lets readShopData turn a Shopify outage into unavailable plus do-not-cache', async () => {
    const { fetch } = stubFetch(() => ({ status: 503 }));
    const client = createStorefrontProductsClient({ shop: SHOP, token: 't', fetch });

    expect(await readShopData(client, ['11'])).toEqual({
      products: { '11': { status: 'unavailable', reason: 'shopify-error' } },
      cacheable: false,
    });
  });
});

describe('Storefront products client: listChannelProducts', () => {
  const page = (ids: string[], next: string | null) => ({
    json: {
      data: {
        products: {
          pageInfo: { hasNextPage: next !== null, endCursor: next },
          nodes: ids.map((id) => ({ id: gidOf(id), handle: `product-${id}`, title: `Product ${id}` })),
        },
      },
    },
  });

  it('reads one page of id, handle and title', async () => {
    const { fetch, calls } = stubFetch(() => page(['11', '12'], null));

    const products = await createStorefrontProductsClient({ shop: SHOP, token: 't', fetch }).listChannelProducts();

    expect(products).toEqual([
      { id: '11', handle: 'product-11', title: 'Product 11' },
      { id: '12', handle: 'product-12', title: 'Product 12' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.variables).toEqual({ first: 250, after: null });
  });

  it('follows the cursor until there is no next page', async () => {
    const pages = [page(['11'], 'cursor-1'), page(['12'], 'cursor-2'), page(['13'], null)];
    const { fetch, calls } = stubFetch((_, index) => pages[index]!);

    const products = await createStorefrontProductsClient({ shop: SHOP, token: 't', fetch }).listChannelProducts();

    expect(products.map((product) => product.id)).toEqual(['11', '12', '13']);
    expect(calls.map((call) => call.body.variables.after)).toEqual([null, 'cursor-1', 'cursor-2']);
  });

  it('stops rather than loop forever if Shopify claims a next page without a cursor', async () => {
    const { fetch, calls } = stubFetch(() => ({
      json: { data: { products: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } },
    }));

    await createStorefrontProductsClient({ shop: SHOP, token: 't', fetch }).listChannelProducts();

    expect(calls).toHaveLength(1);
  });

  it('rejects when a later page fails, instead of returning a partial list', async () => {
    const { fetch } = stubFetch((_, index) => (index === 0 ? page(['11'], 'cursor-1') : { status: 502 }));

    await expect(createStorefrontProductsClient({ shop: SHOP, token: 't', fetch }).listChannelProducts()).rejects.toThrow('502');
  });
});

describe('Storefront client', () => {
  it('serves the cart and the products from one client, only ever over the Storefront endpoint', async () => {
    const { fetch, calls } = stubFetch((call) =>
      call.body.query.includes('cartCreate')
        ? { json: { data: { cartCreate: { cart: cartFixture, userErrors: [] } } } }
        : { json: { data: { nodes: [shopifyProduct('11')] } } },
    );
    const client = createStorefrontClient({ shop: SHOP, token: 't', fetch });

    const created = await client.cartCreate([{ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1 }]);
    const products = await client.getProducts(['11']);

    expect(created.cart?.id).toBe(cartFixture.id);
    expect(products.get('11')?.handle).toBe('product-11');
    for (const call of calls) {
      expect(call.url).toMatch(/\/api\/[^/]+\/graphql\.json$/);
      expect(call.url).not.toContain('/admin');
    }
  });
});

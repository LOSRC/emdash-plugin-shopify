import { describe, it, expect, vi, afterEach } from 'vitest';
import { createShopifyTransport, DEFAULT_API_VERSION } from './transport';
import { createStorefrontCartClient, storefrontConfigFromEnv } from './storefront';
import { handleAdd } from './cart-runtime';
import type { CartSession, StoredCart } from './cart-session';
import cartFixture from './fixtures/cart.json';

const SHOP = 'example-shop.myshopify.com';
const VARIANT = 'gid://shopify/ProductVariant/10000000001';

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
}

/** A fetch stub that records each request and answers with the queued JSON bodies (or a status). */
function stubFetch(...replies: Array<{ status?: number; statusText?: string; json?: unknown }>) {
  const calls: Recorded[] = [];
  const queue = [...replies];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    const reply = queue.shift() ?? { json: { data: {} } };
    return new Response(JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
      statusText: reply.statusText ?? '',
    });
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('Storefront transport shop host', () => {
  it.each([
    'evil.example.com',
    'example-shop.myshopify.com.evil.com',
    'example-shop.myshopify.com/path',
    'user@example-shop.myshopify.com',
    'example-shop.myshopify.com:8443',
    'https://example-shop.myshopify.com',
    'example-shop.myshopify.com?x=1',
    '.myshopify.com',
    '-shop.myshopify.com',
    'a b.myshopify.com',
    '',
  ])('refuses %j before any request is made', (shop) => {
    const { fetch, calls } = stubFetch();
    expect(() => createShopifyTransport({ shop, token: 't', fetch })).toThrow(/myshopify\.com/);
    expect(calls).toHaveLength(0);
  });

  it('accepts a bare myshopify.com hostname in any case', async () => {
    const { fetch, calls } = stubFetch({ json: { data: { ok: true } } });
    await createShopifyTransport({ shop: 'Example-Shop.MyShopify.com', token: 't', fetch }).request('q');
    expect(calls[0]!.url).toBe('https://example-shop.myshopify.com/api/' + DEFAULT_API_VERSION + '/graphql.json');
  });

  it('is checked by the cart and products clients and by storefrontConfigFromEnv', () => {
    expect(() => createStorefrontCartClient({ shop: 'evil.example.com', token: 't' })).toThrow(/myshopify\.com/);
    expect(() => storefrontConfigFromEnv({ SHOPIFY_SHOP: 'evil.example.com', SHOPIFY_STOREFRONT_TOKEN: 't' })).toThrow(
      /SHOPIFY_SHOP.*myshopify\.com/,
    );
  });
});

describe('Storefront transport', () => {
  it('POSTs the GraphQL operation to the shop Storefront endpoint with the public token header', async () => {
    const { fetch, calls } = stubFetch({ json: { data: { ok: true } } });
    const transport = createShopifyTransport({ shop: SHOP, token: 'public-token', fetch });

    const data = await transport.request('query Q { shop { name } }', { a: 1 });

    expect(data).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://${SHOP}/api/${DEFAULT_API_VERSION}/graphql.json`);
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.headers['x-shopify-storefront-access-token']).toBe('public-token');
    expect(calls[0]!.headers['shopify-storefront-private-token']).toBeUndefined();
    expect(calls[0]!.body).toEqual({ query: 'query Q { shop { name } }', variables: { a: 1 } });
  });

  it('sends a private token under its own header, with the buyer IP, and never the public header', async () => {
    const { fetch, calls } = stubFetch({ json: { data: {} } });
    const transport = createShopifyTransport({
      shop: SHOP,
      token: 'private-token',
      tokenKind: 'private',
      buyerIp: '203.0.113.7',
      fetch,
    });

    await transport.request('query Q { shop { name } }');

    expect(calls[0]!.headers['shopify-storefront-private-token']).toBe('private-token');
    expect(calls[0]!.headers['shopify-storefront-buyer-ip']).toBe('203.0.113.7');
    expect(calls[0]!.headers['x-shopify-storefront-access-token']).toBeUndefined();
  });

  it('omits the buyer IP header when none is given', async () => {
    const { fetch, calls } = stubFetch({ json: { data: {} } });
    await createShopifyTransport({ shop: SHOP, token: 't', tokenKind: 'private', fetch }).request('q');
    expect(calls[0]!.headers['shopify-storefront-buyer-ip']).toBeUndefined();
  });

  it('honours an explicit API version', async () => {
    const { fetch, calls } = stubFetch({ json: { data: {} } });
    await createShopifyTransport({ shop: SHOP, token: 't', apiVersion: '2026-04', fetch }).request('q');
    expect(calls[0]!.url).toBe(`https://${SHOP}/api/2026-04/graphql.json`);
  });

  it('uses only the injected fetch, never the global one', async () => {
    const globalFetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', globalFetch);
    const { fetch } = stubFetch({ json: { data: {} } });

    await createShopifyTransport({ shop: SHOP, token: 't', fetch }).request('q');

    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('falls back to the global fetch when none is injected', async () => {
    const globalFetch = vi.fn(async () => new Response(JSON.stringify({ data: { ok: 1 } })));
    vi.stubGlobal('fetch', globalFetch);

    await createShopifyTransport({ shop: SHOP, token: 't' }).request('q');

    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-2xx response', async () => {
    const { fetch } = stubFetch({ status: 503, statusText: 'Service Unavailable' });
    await expect(createShopifyTransport({ shop: SHOP, token: 't', fetch }).request('q')).rejects.toThrow(
      'Storefront API HTTP 503 Service Unavailable',
    );
  });

  it('throws on GraphQL errors', async () => {
    const { fetch } = stubFetch({ json: { errors: [{ message: 'Throttled' }] } });
    await expect(createShopifyTransport({ shop: SHOP, token: 't', fetch }).request('q')).rejects.toThrow(
      'Storefront API GraphQL errors',
    );
  });

  it('throws when the response has no data', async () => {
    const { fetch } = stubFetch({ json: {} });
    await expect(createShopifyTransport({ shop: SHOP, token: 't', fetch }).request('q')).rejects.toThrow(
      'Storefront API returned no data',
    );
  });
});

describe('Storefront cart client', () => {
  it('cartCreate sends the lines and returns Shopify\'s authoritative cart', async () => {
    const { fetch, calls } = stubFetch({
      json: { data: { cartCreate: { cart: cartFixture, userErrors: [] } } },
    });
    const client = createStorefrontCartClient({ shop: SHOP, token: 't', fetch });

    const result = await client.cartCreate([{ merchandiseId: VARIANT, quantity: 2 }]);

    expect(result.cart?.id).toBe(cartFixture.id);
    expect(calls[0]!.body.query).toContain('cartCreate');
    expect(calls[0]!.body.variables).toEqual({ lines: [{ merchandiseId: VARIANT, quantity: 2 }] });
  });

  it('getCart resolves null when Shopify no longer knows the cart', async () => {
    const { fetch, calls } = stubFetch({ json: { data: { cart: null } } });
    const client = createStorefrontCartClient({ shop: SHOP, token: 't', fetch });

    expect(await client.getCart('gid://shopify/Cart/gone')).toBeNull();
    expect(calls[0]!.body.variables).toEqual({ cartId: 'gid://shopify/Cart/gone' });
  });

  it('drives the handlers end to end: an add against a stubbed Storefront writes the snapshot', async () => {
    const { fetch } = stubFetch({ json: { data: { cartCreate: { cart: cartFixture, userErrors: [] } } } });
    const client = createStorefrontCartClient({ shop: SHOP, token: 't', fetch });
    let stored: StoredCart | undefined;
    const session: CartSession = { read: async () => stored, write: (cart) => (stored = cart), clear: () => (stored = undefined) };
    const form = new FormData();
    form.append('merchandiseId', VARIANT);

    const res = await handleAdd(new Request('https://example.com/api/cart/add', { method: 'POST', body: form }), client, session);

    expect(res.status).toBe(303);
    expect(stored).toEqual({ id: cartFixture.id, snapshot: { lineCount: 3, subtotal: '46.00', currency: 'GBP' } });
  });
});

describe('storefrontConfigFromEnv', () => {
  it('maps the documented env names to a config, leaving the token kind public by default', () => {
    const config = storefrontConfigFromEnv({
      SHOPIFY_SHOP: SHOP,
      SHOPIFY_STOREFRONT_TOKEN: 'tok',
      SHOPIFY_API_VERSION: '2026-07',
    });
    expect(config).toEqual({ shop: SHOP, token: 'tok', apiVersion: '2026-07' });
  });

  it('leaves the API version unset when the env does not carry one', () => {
    const config = storefrontConfigFromEnv({ SHOPIFY_SHOP: SHOP, SHOPIFY_STOREFRONT_TOKEN: 'tok' });
    expect(config.apiVersion).toBeUndefined();
  });

  it('names the missing variable instead of building a broken client', () => {
    expect(() => storefrontConfigFromEnv({ SHOPIFY_STOREFRONT_TOKEN: 'tok' })).toThrow('SHOPIFY_SHOP');
    expect(() => storefrontConfigFromEnv({ SHOPIFY_SHOP: SHOP })).toThrow('SHOPIFY_STOREFRONT_TOKEN');
  });
});

import { describe, it, expect } from 'vitest';
import { readShopData } from './shop-data';
import { createFakeCartClient } from './testing';

const POSTER = '7463040909518';
const PRINT = '7463040909999';

function shopWithPoster() {
  const client = createFakeCartClient();
  client.seedProduct({
    id: POSTER,
    handle: 'night-poster',
    title: 'Night poster',
    description: 'A poster of the night sky.',
    image: { url: 'https://cdn.example/night.jpg', altText: 'Stars', width: 800, height: 1000 },
    variants: [
      { id: 'gid://shopify/ProductVariant/1', title: 'A3', price: '12.00', selectedOptions: [{ name: 'Size', value: 'A3' }] },
      { id: 'gid://shopify/ProductVariant/2', title: 'A2', price: '18.50', availableForSale: false, selectedOptions: [{ name: 'Size', value: 'A2' }] },
    ],
  });
  return client;
}

describe('readShopData', () => {
  it('returns the shop data of one product by its Shopify id', async () => {
    const readout = await readShopData(shopWithPoster(), [POSTER]);

    expect(readout.cacheable).toBe(true);
    expect(readout.products[POSTER]).toEqual({
      status: 'ok',
      product: {
        id: POSTER,
        gid: `gid://shopify/Product/${POSTER}`,
        handle: 'night-poster',
        title: 'Night poster',
        description: 'A poster of the night sky.',
        availableForSale: true,
        image: { url: 'https://cdn.example/night.jpg', altText: 'Stars', width: 800, height: 1000 },
        priceRange: {
          min: { amount: '12.00', currencyCode: 'GBP' },
          max: { amount: '18.50', currencyCode: 'GBP' },
        },
        options: [{ name: 'Size', values: ['A3', 'A2'] }],
        variants: [
          {
            id: 'gid://shopify/ProductVariant/1',
            title: 'A3',
            availableForSale: true,
            price: { amount: '12.00', currencyCode: 'GBP' },
            selectedOptions: [{ name: 'Size', value: 'A3' }],
          },
          {
            id: 'gid://shopify/ProductVariant/2',
            title: 'A2',
            availableForSale: false,
            price: { amount: '18.50', currencyCode: 'GBP' },
            selectedOptions: [{ name: 'Size', value: 'A2' }],
          },
        ],
      },
    });
  });

  it('returns many products at once, keyed by id', async () => {
    const client = shopWithPoster();
    client.seedProduct({ id: PRINT, handle: 'moon-print', title: 'Moon print', variants: [{ price: '9.00' }] });

    const readout = await readShopData(client, [PRINT, POSTER]);

    expect(readout.cacheable).toBe(true);
    expect(Object.keys(readout.products).sort()).toEqual([POSTER, PRINT].sort());
    expect(readout.products[PRINT]).toMatchObject({ status: 'ok', product: { handle: 'moon-print', title: 'Moon print' } });
    expect(readout.products[POSTER]).toMatchObject({ status: 'ok', product: { handle: 'night-poster' } });
  });

  it('accepts a product GID and keys the answer by the id as given', async () => {
    const gid = `gid://shopify/Product/${POSTER}`;

    const readout = await readShopData(shopWithPoster(), [gid]);

    expect(readout.products[gid]).toMatchObject({ status: 'ok', product: { id: POSTER } });
  });

  it('reports an unknown id as unavailable and not cacheable, without losing the known ones', async () => {
    const readout = await readShopData(shopWithPoster(), [POSTER, '999']);

    expect(readout.products['999']).toEqual({ status: 'unavailable', reason: 'not-found' });
    expect(readout.products[POSTER]).toMatchObject({ status: 'ok' });
    expect(readout.cacheable).toBe(false);
  });

  it('reports an unpublished product as unavailable and not cacheable, and a republished one as ok again', async () => {
    const client = shopWithPoster();
    client.setPublished(POSTER, false);

    const hidden = await readShopData(client, [POSTER]);
    expect(hidden.products[POSTER]).toEqual({ status: 'unavailable', reason: 'not-found' });
    expect(hidden.cacheable).toBe(false);

    client.setPublished(POSTER, true);
    const shown = await readShopData(client, [POSTER]);
    expect(shown.products[POSTER]).toMatchObject({ status: 'ok' });
    expect(shown.cacheable).toBe(true);
  });

  it('reports a removed product as unavailable', async () => {
    const client = shopWithPoster();
    client.removeProduct(POSTER);

    const readout = await readShopData(client, [POSTER]);

    expect(readout.products[POSTER]).toEqual({ status: 'unavailable', reason: 'not-found' });
  });

  it('reports a malformed id as unavailable without asking Shopify about it', async () => {
    const client = shopWithPoster();

    const readout = await readShopData(client, ['not-an-id', '__proto__', POSTER]);

    expect(readout.products['not-an-id']).toEqual({ status: 'unavailable', reason: 'not-found' });
    expect(readout.products['__proto__']).toEqual({ status: 'unavailable', reason: 'not-found' });
    expect(readout.products[POSTER]).toMatchObject({ status: 'ok' });
    expect(readout.cacheable).toBe(false);
  });

  it('does not throw when Shopify fails: every id is unavailable and the page is not cacheable', async () => {
    const client = shopWithPoster();
    client.failNextWith(new Error('Storefront API HTTP 503'));

    const readout = await readShopData(client, [POSTER, PRINT]);

    expect(readout).toEqual({
      products: {
        [POSTER]: { status: 'unavailable', reason: 'shopify-error' },
        [PRINT]: { status: 'unavailable', reason: 'shopify-error' },
      },
      cacheable: false,
    });
    // The failure was one-shot: the next read is fine.
    expect((await readShopData(client, [POSTER])).cacheable).toBe(true);
  });

  it('answers an empty request as cacheable without asking Shopify', async () => {
    const client = shopWithPoster();
    client.failNextWith(new Error('must not be reached'));

    expect(await readShopData(client, [])).toEqual({ products: {}, cacheable: true });
    await expect(client.getProducts([POSTER])).rejects.toThrow('must not be reached');
  });

  it('reads the same id twice as one entry', async () => {
    const readout = await readShopData(shopWithPoster(), [POSTER, POSTER]);

    expect(Object.keys(readout.products)).toEqual([POSTER]);
  });

  it('shows a product with no available variant as ok but not available for sale', async () => {
    const client = createFakeCartClient();
    client.seedProduct({ id: PRINT, handle: 'moon-print', title: 'Moon print', variants: [{ availableForSale: false }] });

    const readout = await readShopData(client, [PRINT]);

    expect(readout.products[PRINT]).toMatchObject({ status: 'ok', product: { availableForSale: false } });
    expect(readout.cacheable).toBe(true);
  });
});

describe('the sales channel list', () => {
  it('lists the published products and leaves out unpublished and removed ones', async () => {
    const client = shopWithPoster();
    client.seedProduct({ id: PRINT, handle: 'moon-print', title: 'Moon print', published: false });
    client.seedProduct({ id: '5', handle: 'gone', title: 'Gone' });
    client.removeProduct('5');

    expect(await client.listChannelProducts()).toEqual([{ id: POSTER, handle: 'night-poster', title: 'Night poster' }]);
  });

  it('rejects when Shopify fails, so a sync can stop before it writes anything', async () => {
    const client = shopWithPoster();
    client.failNextWith(new Error('Storefront API HTTP 503'));

    await expect(client.listChannelProducts()).rejects.toThrow('503');
  });
});

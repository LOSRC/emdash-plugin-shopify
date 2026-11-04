import { describe, it, expect } from 'vitest';
import {
  handleAdd,
  handleUpdate,
  handleRemove,
  handleSummary,
  CART_PATH,
  CART_ERROR_MESSAGE,
  CART_REJECTED_MESSAGE,
} from './cart-runtime';
import { createFakeCartClient } from './testing';
import type { CartSession, StoredCart } from './cart-session';

/**
 * Cart orchestration behaviour, driven end-to-end through the public seam: the four
 * `handle*` entry points, the in-memory `ShopifyCartClient` fake, and an in-memory `CartSession`.
 * The assertions are on observable outcomes (the written snapshot, the cart id, the HTTP response),
 * never on internal calls - so they survive a refactor of how the orchestration is wired.
 */

const VARIANT = 'gid://shopify/ProductVariant/10000000001';
const VARIANT_2 = 'gid://shopify/ProductVariant/10000000002';

/** An in-memory CartSession that records what was written, standing in for the Astro session. */
function memorySession(initial?: StoredCart) {
  const state = { current: initial as StoredCart | undefined, writes: 0 };
  const session: CartSession = {
    read: async () => state.current,
    write: (cart) => {
      state.current = cart;
      state.writes += 1;
    },
  };
  return { session, state };
}

/** Build the POST Request a cart <form> (or a progressive-enhancement fetch, with `json`) sends to the Worker. */
function postForm(fields: Record<string, string>, opts: { json?: boolean } = {}): Request {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  return new Request('https://example.com/api/cart', {
    method: 'POST',
    body: fd,
    headers: opts.json ? { accept: 'application/json' } : {},
  });
}

/** The single cart the fake is currently holding (these tests only ever create one). */
function onlyCart(client: ReturnType<typeof createFakeCartClient>) {
  const carts = [...client.carts.values()];
  expect(carts).toHaveLength(1);
  return carts[0]!;
}

describe('handleAdd - create / reuse / recreate', () => {
  it('creates a cart when the session has none, and writes its snapshot', async () => {
    const client = createFakeCartClient({ prices: { [VARIANT]: '18.00' } });
    const { session, state } = memorySession();

    const res = await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '2' }), client, session);

    expect(res.status).toBe(303);
    expect(client.carts.size).toBe(1);
    expect(state.current).toBeDefined();
    expect(state.current!.id).toBe(onlyCart(client).id);
    expect(state.current!.snapshot.lineCount).toBe(2);
  });

  it('reuses the existing cart on a second add - same id, lines accumulate', async () => {
    const client = createFakeCartClient();
    const { session, state } = memorySession();

    await handleAdd(postForm({ merchandiseId: VARIANT }), client, session);
    const firstId = state.current!.id;
    await handleAdd(postForm({ merchandiseId: VARIANT_2 }), client, session);

    expect(state.current!.id).toBe(firstId);
    expect(state.current!.snapshot.lineCount).toBe(2);
    expect(client.carts.size).toBe(1);
  });

  it('consolidates a repeated variant into one line with the summed quantity (Storefront parity)', async () => {
    const client = createFakeCartClient();
    const { session, state } = memorySession();

    await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '2' }), client, session);
    await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '3' }), client, session);

    const lines = onlyCart(client).lines.nodes;
    expect(lines).toHaveLength(1); // real cartLinesAdd merges same merchandise - not two lines
    expect(lines[0]!.quantity).toBe(5);
    expect(state.current!.snapshot.lineCount).toBe(5);
  });

  it('recreates a fresh cart when the stored id is stale (Shopify no longer resolves it)', async () => {
    const client = createFakeCartClient();
    const stale: StoredCart = {
      id: 'gid://shopify/Cart/expired-xyz',
      snapshot: { lineCount: 5, subtotal: '100.00', currency: 'GBP' },
    };
    const { session, state } = memorySession(stale);

    await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '1' }), client, session);

    expect(state.current!.id).not.toBe(stale.id);
    expect(client.carts.has(state.current!.id)).toBe(true);
    expect(state.current!.snapshot.lineCount).toBe(1); // fresh cart, only the newly-added line
  });
});

describe('handleAdd - content negotiation', () => {
  it('returns the badge snapshot as JSON when the caller sends Accept: application/json', async () => {
    const client = createFakeCartClient({ prices: { [VARIANT]: '18.00' } });
    const { session } = memorySession();

    const res = await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '2' }, { json: true }), client, session);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ lineCount: 2, subtotal: '36.00', currency: 'GBP' });
  });

  it('redirects a plain no-JS form POST to /cart/ with 303', async () => {
    const client = createFakeCartClient();
    const { session } = memorySession();

    const res = await handleAdd(postForm({ merchandiseId: VARIANT }), client, session);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(CART_PATH);
  });

  it('rejects invalid input as 400 JSON (no cart created) when JSON was requested', async () => {
    const client = createFakeCartClient();
    const { session } = memorySession();

    const res = await handleAdd(postForm({ merchandiseId: 'not-a-gid' }, { json: true }), client, session);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringContaining('ProductVariant') });
    expect(client.carts.size).toBe(0);
  });

  it('redirects invalid no-JS input to /cart/ (303) and writes nothing', async () => {
    const client = createFakeCartClient();
    const { session, state } = memorySession();

    const res = await handleAdd(postForm({}), client, session);

    expect(res.status).toBe(303);
    expect(state.current).toBeUndefined();
    expect(state.writes).toBe(0);
  });
});

describe('exact-decimal money (Storefront parity)', () => {
  it('sums line money with decimal, not float, arithmetic - 1.005 × 3 → 3.02, not 3.01', async () => {
    const client = createFakeCartClient({ prices: { [VARIANT]: '1.005' } });
    const { session, state } = memorySession();

    await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '3' }, { json: true }), client, session);

    // Float: 1.005 * 3 = 3.01499… → toFixed(2) → '3.01'. Exact decimal: 3.015 → '3.02', as Shopify returns.
    expect(state.current!.snapshot.subtotal).toBe('3.02');
  });
});

describe('handleUpdate', () => {
  it('changes a line quantity and writes the refreshed snapshot', async () => {
    const client = createFakeCartClient({ prices: { [VARIANT]: '18.00' } });
    const { session, state } = memorySession();
    await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '1' }), client, session);
    const lineId = onlyCart(client).lines.nodes[0]!.id;

    const res = await handleUpdate(postForm({ lineId, quantity: '4' }), client, session);

    expect(res.status).toBe(303);
    expect(state.current!.snapshot.lineCount).toBe(4);
  });

  it('is a no-op (303, no write) when there is no stored cart', async () => {
    const client = createFakeCartClient();
    const { session, state } = memorySession();

    const res = await handleUpdate(
      postForm({ lineId: 'gid://shopify/CartLine/none', quantity: '2' }),
      client,
      session,
    );

    expect(res.status).toBe(303);
    expect(state.writes).toBe(0);
  });
});

describe('handleRemove', () => {
  it('drops a line and writes the refreshed snapshot', async () => {
    const client = createFakeCartClient();
    const { session, state } = memorySession();
    await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '2' }), client, session);
    await handleAdd(postForm({ merchandiseId: VARIANT_2, quantity: '1' }), client, session);
    expect(state.current!.snapshot.lineCount).toBe(3);
    const secondLineId = onlyCart(client).lines.nodes[1]!.id;

    const res = await handleRemove(postForm({ lineId: secondLineId }), client, session);

    expect(res.status).toBe(303);
    expect(state.current!.snapshot.lineCount).toBe(2);
  });
});

describe('handleSummary', () => {
  it('returns the cached badge count from the snapshot (no Shopify round-trip)', async () => {
    const { session } = memorySession({
      id: 'gid://shopify/Cart/live',
      snapshot: { lineCount: 7, subtotal: '1.00', currency: 'GBP' },
    });

    expect(await (await handleSummary(session)).json()).toEqual({ lineCount: 7 });
  });

  it('returns lineCount 0 when the session has no cart', async () => {
    const { session } = memorySession();
    expect(await (await handleSummary(session)).json()).toEqual({ lineCount: 0 });
  });
});

describe('snapshot is written on every mutation', () => {
  it('writes once per successful add, update, and remove', async () => {
    const client = createFakeCartClient();
    const { session, state } = memorySession();

    await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '2' }), client, session);
    expect(state.writes).toBe(1);

    const lineId = onlyCart(client).lines.nodes[0]!.id;
    await handleUpdate(postForm({ lineId, quantity: '3' }), client, session);
    expect(state.writes).toBe(2);

    await handleRemove(postForm({ lineId }), client, session);
    expect(state.writes).toBe(3);
  });
});

describe('graceful degradation when Shopify fails', () => {
  const EXISTING: StoredCart = {
    id: 'gid://shopify/Cart/live',
    snapshot: { lineCount: 4, subtotal: '400.00', currency: 'GBP' },
  };

  it('add (PE): returns a 502 JSON error - never a raw 500 - and leaves the snapshot intact', async () => {
    const client = createFakeCartClient();
    client.failNextWith(new Error('Storefront API HTTP 503'));
    const { session, state } = memorySession(EXISTING);

    const res = await handleAdd(postForm({ merchandiseId: VARIANT }, { json: true }), client, session);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: CART_ERROR_MESSAGE });
    expect(state.current).toEqual(EXISTING); // snapshot untouched - the badge doesn't lie
    expect(state.writes).toBe(0);
  });

  it('add (no-JS): redirects to /cart/?error=add and leaves the snapshot intact', async () => {
    const client = createFakeCartClient();
    client.failNextWith(new Error('network'));
    const { session, state } = memorySession(EXISTING);

    const res = await handleAdd(postForm({ merchandiseId: VARIANT }), client, session);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${CART_PATH}?error=add`);
    expect(state.current).toEqual(EXISTING);
    expect(state.writes).toBe(0);
  });

  it('update: redirects to /cart/?error=update and leaves the snapshot intact', async () => {
    const client = createFakeCartClient();
    client.failNextWith(new Error('boom'));
    const { session, state } = memorySession(EXISTING);

    const res = await handleUpdate(postForm({ lineId: 'gid://shopify/CartLine/x', quantity: '2' }), client, session);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${CART_PATH}?error=update`);
    expect(state.current).toEqual(EXISTING);
    expect(state.writes).toBe(0);
  });

  it('remove: redirects to /cart/?error=remove and leaves the snapshot intact', async () => {
    const client = createFakeCartClient();
    client.failNextWith(new Error('boom'));
    const { session, state } = memorySession(EXISTING);

    const res = await handleRemove(postForm({ lineId: 'gid://shopify/CartLine/x' }), client, session);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${CART_PATH}?error=remove`);
    expect(state.current).toEqual(EXISTING);
    expect(state.writes).toBe(0);
  });
});

describe('add rejected by Shopify (cart: null + userErrors) - a failure, never a fake success', () => {
  const EXISTING: StoredCart = {
    id: 'gid://shopify/Cart/live',
    snapshot: { lineCount: 4, subtotal: '400.00', currency: 'GBP' },
  };

  it('add (PE): returns a 422 JSON error - not 200 with an empty snapshot that wipes the badge', async () => {
    const client = createFakeCartClient();
    client.rejectMutationsWith('The merchandise does not exist');
    const { session, state } = memorySession(EXISTING);

    const res = await handleAdd(postForm({ merchandiseId: VARIANT }, { json: true }), client, session);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: CART_REJECTED_MESSAGE });
    expect(state.current).toEqual(EXISTING); // snapshot untouched - the badge keeps telling the truth
    expect(state.writes).toBe(0);
  });

  it('add (no-JS): redirects to /cart/?error=add and leaves the snapshot intact', async () => {
    const client = createFakeCartClient();
    client.rejectMutationsWith('The merchandise does not exist');
    const { session, state } = memorySession(EXISTING);

    const res = await handleAdd(postForm({ merchandiseId: VARIANT }), client, session);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${CART_PATH}?error=add`);
    expect(state.current).toEqual(EXISTING);
    expect(state.writes).toBe(0);
  });

  it('add with no stored cart: a rejected create is also a 422, and nothing is written', async () => {
    const client = createFakeCartClient();
    client.rejectMutationsWith('unpurchasable');
    const { session, state } = memorySession();

    const res = await handleAdd(postForm({ merchandiseId: VARIANT }, { json: true }), client, session);

    expect(res.status).toBe(422);
    expect(state.current).toBeUndefined();
    expect(state.writes).toBe(0);
  });
});


describe('no cart id in any URL the handlers produce', () => {
  const CART_GID = 'gid://shopify/Cart/';

  it('keeps the cart id out of every redirect and JSON body, on success and on failure', async () => {
    const client = createFakeCartClient();
    const { session, state } = memorySession();
    const responses: Response[] = [];

    responses.push(await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '2' }), client, session));
    responses.push(await handleAdd(postForm({ merchandiseId: VARIANT }, { json: true }), client, session));
    const cartId = state.current!.id;
    const cartToken = cartId.split('/').pop()!;
    const lineId = onlyCart(client).lines.nodes[0]!.id;
    responses.push(await handleUpdate(postForm({ lineId, quantity: '3' }), client, session));
    responses.push(await handleSummary(session));

    client.failNextWith(new Error('boom'));
    responses.push(await handleUpdate(postForm({ lineId, quantity: '4' }), client, session));
    client.failNextWith(new Error('boom'));
    responses.push(await handleAdd(postForm({ merchandiseId: VARIANT }, { json: true }), client, session));
    client.failNextWith(new Error('boom'));
    responses.push(await handleRemove(postForm({ lineId }), client, session));
    responses.push(await handleAdd(postForm({ merchandiseId: 'bad' }), client, session));
    client.rejectMutationsWith('nope');
    responses.push(await handleAdd(postForm({ merchandiseId: VARIANT }, { json: true }), client, session));
    responses.push(await handleRemove(postForm({ lineId }), client, session));

    for (const res of responses) {
      const location = res.headers.get('location') ?? '';
      // The acceptance criterion is about URLs: neither the full id nor its token may appear.
      expect(location).not.toContain(cartId);
      expect(location).not.toContain(cartToken);
      // Bodies must not carry the cart GID either (line ids are not cart ids and may appear later).
      const body = await res.text();
      expect(body).not.toContain(CART_GID);
    }
    // And the responses really did exercise redirects, not just empty bodies.
    expect(responses.filter((res) => res.headers.has('location')).length).toBeGreaterThan(3);
  });
});

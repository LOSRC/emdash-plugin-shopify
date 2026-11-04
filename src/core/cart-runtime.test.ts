import { describe, it, expect } from 'vitest';
import {
  handleAdd,
  handleUpdate,
  handleRemove,
  handleSummary,
  CART_PATH,
  CART_ERROR_MESSAGE,
  CART_REJECTED_MESSAGE,
  CART_UPDATE_REJECTED_MESSAGE,
  handleView,
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
    clear: () => {
      state.current = undefined;
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


describe('no cart id or token in any Location the handlers produce', () => {
  const CART_GID = 'gid://shopify/Cart/';

  it('keeps the cart id and token out of every redirect, and the cart GID out of every body, on success and on failure', async () => {
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
      // Bodies never carry the cart GID. They may carry the cart token: a CartLine id ends `?cart=<token>`
      // and the view's checkoutUrl embeds it, which the next test pins down.
      const body = await res.text();
      expect(body).not.toContain(CART_GID);
    }
    // And the responses really did exercise redirects, not just empty bodies.
    expect(responses.filter((res) => res.headers.has('location')).length).toBeGreaterThan(3);
  });
});

/** A fetch-style request that also asks for the full cart view (the drawer's contract). */
function viewRequest(fields: Record<string, string>): Request {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  return new Request('https://example.com/api/cart', {
    method: 'POST',
    body: fd,
    headers: { accept: 'application/json', 'x-requested-with': 'fetch', 'x-cart-view': '1' },
  });
}

describe('handleAdd - cart view on request', () => {
  it('returns the CartView instead of the snapshot when the caller opts in with X-Cart-View', async () => {
    const client = createFakeCartClient({ prices: { [VARIANT]: '18.00' } });
    const { session } = memorySession();

    const res = await handleAdd(viewRequest({ merchandiseId: VARIANT, quantity: '2' }), client, session);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const view = await res.json();
    expect(view).toMatchObject({
      lineCount: 2,
      subtotal: { amount: '36.00', currencyCode: 'GBP' },
      lines: [{ quantity: 2, unitPrice: { amount: '18.00', currencyCode: 'GBP' }, lineTotal: { amount: '36.00' } }],
    });
    expect(view.checkoutUrl).toMatch(/^https:\/\//);
    expect(view.lines[0].id).toMatch(/^gid:\/\/shopify\/CartLine\//);
  });
});

describe('handleUpdate / handleRemove - JSON', () => {
  /** A cart holding two lines (2 x VARIANT at 18.00, 1 x VARIANT_2 at 5.50) and its session. */
  async function twoLineCart() {
    const client = createFakeCartClient({ prices: { [VARIANT]: '18.00', [VARIANT_2]: '5.50' } });
    const memory = memorySession();
    await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '2' }), client, memory.session);
    await handleAdd(postForm({ merchandiseId: VARIANT_2 }), client, memory.session);
    const [first, second] = onlyCart(client).lines.nodes;
    return { client, ...memory, first: first!, second: second! };
  }

  it('update returns the refreshed CartView, private, and writes the snapshot', async () => {
    const { client, session, state, first } = await twoLineCart();

    const res = await handleUpdate(viewRequest({ lineId: first.id, quantity: '3' }), client, session);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const view = await res.json();
    expect(view.lineCount).toBe(4);
    expect(view.subtotal).toEqual({ amount: '59.50', currencyCode: 'GBP' });
    expect(view.lines.map((line: { quantity: number }) => line.quantity)).toEqual([3, 1]);
    expect(state.current!.snapshot.lineCount).toBe(4);
  });

  it('remove returns the CartView without the removed line', async () => {
    const { client, session, state, first, second } = await twoLineCart();

    const res = await handleRemove(viewRequest({ lineId: first.id }), client, session);

    const view = await res.json();
    expect(res.status).toBe(200);
    expect(view.lines.map((line: { id: string }) => line.id)).toEqual([second.id]);
    expect(view.subtotal.amount).toBe('5.50');
    expect(state.current!.snapshot.lineCount).toBe(1);
  });

  it('answers JSON on Accept alone, as the add route does', async () => {
    const { client, session, first } = await twoLineCart();
    const res = await handleRemove(postForm({ lineId: first.id }, { json: true }), client, session);
    expect(res.status).toBe(200);
    expect((await res.json()).lines).toHaveLength(1);
  });

  it('keeps the plain-form 303 when JSON was not requested', async () => {
    const { client, session, first } = await twoLineCart();
    const res = await handleUpdate(postForm({ lineId: first.id, quantity: '3' }), client, session);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(CART_PATH);
  });

  it('rejects invalid input as 400 JSON without touching Shopify or the session', async () => {
    const { client, session, state, first } = await twoLineCart();
    const writes = state.writes;

    const badQuantity = await handleUpdate(viewRequest({ lineId: first.id, quantity: '0' }), client, session);
    const badLine = await handleRemove(viewRequest({ lineId: 'not-a-gid' }), client, session);

    expect(badQuantity.status).toBe(400);
    expect(await badQuantity.json()).toEqual({ error: expect.stringContaining('quantity') });
    expect(badLine.status).toBe(400);
    expect(await badLine.json()).toEqual({ error: expect.stringContaining('CartLine') });
    expect(state.writes).toBe(writes);
    expect(onlyCart(client).totalQuantity).toBe(3);
  });

  it('degrades to a 502 JSON error when Shopify fails, leaving the snapshot alone', async () => {
    const { client, session, state, first } = await twoLineCart();
    const before = state.current;
    client.failNextWith(new Error('Storefront API HTTP 503'));

    const res = await handleUpdate(viewRequest({ lineId: first.id, quantity: '3' }), client, session);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: CART_ERROR_MESSAGE });
    expect(state.current).toBe(before);
  });

  it('answers an empty view when there is no stored cart', async () => {
    const client = createFakeCartClient();
    const { session, state } = memorySession();

    const res = await handleRemove(viewRequest({ lineId: 'gid://shopify/CartLine/none' }), client, session);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lineCount: 0, lines: [], checkoutUrl: '' });
    expect(state.writes).toBe(0);
  });

  it('answers an empty view when Shopify no longer resolves the stored cart', async () => {
    const client = createFakeCartClient();
    const stale: StoredCart = {
      id: 'gid://shopify/Cart/expired-xyz',
      snapshot: { lineCount: 5, subtotal: '100.00', currency: 'GBP' },
    };
    const { session } = memorySession(stale);

    const res = await handleUpdate(viewRequest({ lineId: 'gid://shopify/CartLine/x', quantity: '2' }), client, session);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lineCount: 0, lines: [], subtotal: { currencyCode: 'GBP' } });
  });

  it('reports a Shopify refusal as 422 JSON', async () => {
    const { client, session, state, first } = await twoLineCart();
    const before = state.current;
    client.rejectMutationsWith('Not available');

    const res = await handleUpdate(viewRequest({ lineId: first.id, quantity: '9' }), client, session);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: CART_UPDATE_REJECTED_MESSAGE });
    expect(state.current).toBe(before);
  });
});

describe('handleView (GET the cart view)', () => {
  it('returns the stored cart as a private CartView', async () => {
    const client = createFakeCartClient({ prices: { [VARIANT]: '18.00' } });
    const { session } = memorySession();
    await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '2' }), client, session);

    const res = await handleView(client, session);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ lineCount: 2, subtotal: { amount: '36.00' }, lines: [{ quantity: 2 }] });
  });

  it('returns an empty view when there is no cart, and when Shopify no longer resolves it', async () => {
    const client = createFakeCartClient();
    expect(await (await handleView(client, memorySession().session)).json()).toMatchObject({ lineCount: 0, lines: [] });

    const stale: StoredCart = {
      id: 'gid://shopify/Cart/expired-xyz',
      snapshot: { lineCount: 5, subtotal: '100.00', currency: 'GBP' },
    };
    const res = await handleView(client, memorySession(stale).session);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lineCount: 0, lines: [] });
  });

  it('degrades to a 502 JSON error when Shopify fails', async () => {
    const client = createFakeCartClient();
    const { session } = memorySession({
      id: 'gid://shopify/Cart/live',
      snapshot: { lineCount: 1, subtotal: '10.00', currency: 'GBP' },
    });
    client.failNextWith(new Error('boom'));

    const res = await handleView(client, session);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: CART_ERROR_MESSAGE });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('a stored cart Shopify no longer resolves is forgotten, so the header count follows', () => {
  const stale = (): StoredCart => ({
    id: 'gid://shopify/Cart/expired-xyz',
    snapshot: { lineCount: 3, subtotal: '30.00', currency: 'GBP' },
  });
  const summaryOf = async (session: CartSession) => (await handleSummary(session)).json();

  it('handleView answers an empty view, then the summary is zero', async () => {
    const { session, state } = memorySession(stale());
    await handleView(createFakeCartClient(), session);
    expect(await summaryOf(session)).toEqual({ lineCount: 0 });
    expect(state.current).toBeUndefined();
  });

  it('a JSON update answers an empty view, then the summary is zero', async () => {
    const { session } = memorySession(stale());
    await handleUpdate(viewRequest({ lineId: 'gid://shopify/CartLine/x', quantity: '2' }), createFakeCartClient(), session);
    expect(await summaryOf(session)).toEqual({ lineCount: 0 });
  });

  it('a JSON remove answers an empty view, then the summary is zero', async () => {
    const { session } = memorySession(stale());
    await handleRemove(viewRequest({ lineId: 'gid://shopify/CartLine/x' }), createFakeCartClient(), session);
    expect(await summaryOf(session)).toEqual({ lineCount: 0 });
  });

  it('a no-JS update and remove forget it too', async () => {
    for (const handle of [handleUpdate, handleRemove]) {
      const { session } = memorySession(stale());
      const res = await handle(postForm({ lineId: 'gid://shopify/CartLine/x', quantity: '2' }), createFakeCartClient(), session);
      expect(res.status).toBe(303);
      expect(await summaryOf(session)).toEqual({ lineCount: 0 });
    }
  });

  it('keeps the stored cart when Shopify fails, since nothing is known about it', async () => {
    const client = createFakeCartClient();
    client.failNextWith(new Error('boom'));
    const { session, state } = memorySession(stale());
    await handleView(client, session);
    expect(state.current).toEqual(stale());
  });
});

describe.each(['userErrors', 'null'] as const)('a cart Shopify has lost, answered as %s', (form) => {
  const lost = (): StoredCart => ({
    id: 'gid://shopify/Cart/expired-xyz',
    snapshot: { lineCount: 3, subtotal: '30.00', currency: 'GBP' },
  });
  const lostClient = () => {
    const client = createFakeCartClient();
    client.answerMissingCartWith(form);
    return client;
  };

  it('add starts a fresh cart', async () => {
    const client = lostClient();
    const { session, state } = memorySession(lost());

    const res = await handleAdd(postForm({ merchandiseId: VARIANT }, { json: true }), client, session);

    expect(res.status).toBe(200);
    expect(state.current!.id).not.toBe(lost().id);
    expect(state.current!.snapshot.lineCount).toBe(1);
    expect(client.carts.size).toBe(1);
  });

  it('update and remove forget it and answer an empty view', async () => {
    for (const handle of [handleUpdate, handleRemove]) {
      const { session, state } = memorySession(lost());
      const res = await handle(viewRequest({ lineId: 'gid://shopify/CartLine/x', quantity: '2' }), lostClient(), session);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ lineCount: 0, lines: [] });
      expect(state.current).toBeUndefined();
    }
  });
});

describe('a refusal on a live cart is not a lost cart', () => {
  const REFUSAL = { field: ['lines', '0', 'merchandiseId'], message: 'The merchandise is not available.' };

  /** A live cart with one line, whose line mutations Shopify refuses with a userError that is not about the cart id. */
  async function liveCartThatRefuses() {
    const real = createFakeCartClient();
    const { session, state } = memorySession();
    await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '2' }), real, session);
    const lineId = onlyCart(real).lines.nodes[0]!.id;
    const refusing = { cart: null, userErrors: [REFUSAL] };
    const client = {
      ...real,
      cartLinesAdd: async () => refusing,
      cartLinesUpdate: async () => refusing,
      cartLinesRemove: async () => refusing,
    };
    return { real, client, session, state, lineId, before: state.current };
  }

  it('add answers 422 and keeps the cart and its other lines', async () => {
    const { real, client, session, state, before } = await liveCartThatRefuses();

    const res = await handleAdd(postForm({ merchandiseId: VARIANT_2 }, { json: true }), client, session);

    expect(res.status).toBe(422);
    expect(state.current).toEqual(before);
    expect(real.carts.size).toBe(1); // no replacement cart was made
    expect(onlyCart(real).lines.nodes).toHaveLength(1);
  });

  it('update and remove answer 422 and keep the stored cart', async () => {
    for (const handle of [handleUpdate, handleRemove]) {
      const { client, session, state, lineId, before } = await liveCartThatRefuses();
      const res = await handle(viewRequest({ lineId, quantity: '9' }), client, session);
      expect(res.status).toBe(422);
      expect(state.current).toEqual(before);
    }
  });

  it('no-JS update and remove redirect and keep the stored cart', async () => {
    for (const handle of [handleUpdate, handleRemove]) {
      const { client, session, state, lineId, before } = await liveCartThatRefuses();
      const res = await handle(postForm({ lineId, quantity: '9' }), client, session);
      expect(res.status).toBe(303);
      expect(state.current).toEqual(before);
    }
  });
});

describe('handleSummary - caching', () => {
  it('is private and uncacheable, since the count element exists because pages are cached and shared', async () => {
    const res = await handleSummary(memorySession().session);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('what a cart view body carries of the cart id', () => {
  it('has no cart GID; the cart token appears only in line ids and checkoutUrl', async () => {
    const client = createFakeCartClient();
    const { session, state } = memorySession();
    const responses = [
      await handleAdd(viewRequest({ merchandiseId: VARIANT }), client, session),
      await handleView(client, session),
    ];
    const lineId = onlyCart(client).lines.nodes[0]!.id;
    const token = state.current!.id.split('/').pop()!;
    responses.push(await handleUpdate(viewRequest({ lineId, quantity: '2' }), client, session));
    for (const res of responses) {
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('location')).toBeNull();
      const view = await res.json();
      expect(JSON.stringify(view)).not.toContain('gid://shopify/Cart/');
      expect(view.checkoutUrl).toContain(token);
      for (const line of view.lines) expect(line.id).toContain(`?cart=${token}`);
      // Nowhere else: strip the two fields that carry it and it is gone.
      const rest = { ...view, checkoutUrl: undefined, lines: view.lines.map((line: object) => ({ ...line, id: undefined })) };
      expect(JSON.stringify(rest)).not.toContain(token);
    }
    expect(state.current!.id).toContain('Cart');
  });
});

/** A POST carrying a JSON body, as a script (not a <form>) would send it. */
function postJson(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/cart', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('request bodies: forms and JSON', () => {
  it('add accepts a JSON body, answering JSON because the caller sent JSON', async () => {
    const client = createFakeCartClient({ prices: { [VARIANT]: '18.00' } });
    const { session, state } = memorySession();

    const res = await handleAdd(postJson(JSON.stringify({ merchandiseId: VARIANT, quantity: 2 })), client, session);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lineCount: 2 });
    expect(state.current!.snapshot.lineCount).toBe(2);
  });

  it('update and remove accept JSON bodies', async () => {
    const client = createFakeCartClient({ prices: { [VARIANT]: '18.00' } });
    const { session } = memorySession();
    await handleAdd(postForm({ merchandiseId: VARIANT, quantity: '2' }), client, session);
    const lineId = onlyCart(client).lines.nodes[0]!.id;

    const updated = await handleUpdate(postJson(JSON.stringify({ lineId, quantity: 5 })), client, session);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ lineCount: 5 });

    const removed = await handleRemove(postJson(JSON.stringify({ lineId })), client, session);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ lineCount: 0, lines: [] });
  });

  it('answers invalid JSON fields with the same 400 as an invalid form', async () => {
    const client = createFakeCartClient();
    const res = await handleAdd(postJson(JSON.stringify({ merchandiseId: 'nope' })), client, memorySession().session);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'merchandiseId must be a ProductVariant GID' });
  });

  it.each([
    ['malformed JSON', () => postJson('{not json')],
    ['a JSON array', () => postJson('[1,2]')],
    ['a JSON string', () => postJson('"hello"')],
    ['null', () => postJson('null')],
    [
      'a broken multipart body',
      () =>
        new Request('https://example.com/api/cart', {
          method: 'POST',
          body: 'not multipart',
          headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
        }),
    ],
  ])('answers %s with a friendly 400, never a raw 500, on every handler', async (_name, make) => {
    const client = createFakeCartClient();
    for (const handler of [handleAdd, handleUpdate, handleRemove]) {
      const { session, state } = memorySession();
      const res = await handler(make(), client, session);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'The request body could not be read.' });
      expect(state.writes).toBe(0);
    }
  });
});

import { parseLineForm, parseUpdateForm, parseRemoveForm, toSnapshot, isStaleCart } from './cart';
import type { ParseResult } from './cart';
import type { CartMutationResult, ShopifyCartClient } from './client';
import type { CartSession } from './cart-session';
import { wantsJson, jsonResponse } from './negotiation';

/**
 * Cart orchestration: the request-time logic behind the site's cart routes (create, reuse or recreate
 * the cart; JSON versus 303 content negotiation; the snapshot write on every mutation). It depends
 * only on the `ShopifyCartClient` interface and the `CartSession` port, so it runs under vitest
 * against the in-memory fake with no Workers runtime and no live Shopify. The site's routes are thin
 * adapters that build the client and session and hand off here.
 *
 * Responses are built explicitly (not via `context.redirect`) so a redirect is just a 303 with a
 * `Location`, assertable in a unit test. No cart id is ever put in a `Location` or a response body.
 */

/** Where every mutating action sends the no-JS <form> POST back to. */
export const CART_PATH = '/cart/';

/**
 * The user-facing message when Shopify can't be reached. Deliberately generic: the raw transport or
 * GraphQL error never reaches the customer (and never a raw 500). The no-JS path surfaces it via the
 * `?error` banner on /cart/; the enhanced path returns it as JSON.
 */
export const CART_ERROR_MESSAGE = "Sorry, we couldn't reach the store just now. Please try again in a moment.";

/**
 * The user-facing message when Shopify was reached but refused the add (`cart: null` + userErrors,
 * e.g. the variant is no longer purchasable). Distinct from CART_ERROR_MESSAGE: retrying won't help,
 * so don't invite one.
 */
export const CART_REJECTED_MESSAGE = "Sorry, that item couldn't be added to your cart. It may no longer be available.";

/** The 303 back to /cart/: the no-JS degrade path. */
function redirectToCart(): Response {
  return new Response(null, { status: 303, headers: { Location: CART_PATH } });
}

/** No-JS failure degrade: 303 to /cart/?error=<action>, which renders a visible error banner. */
function redirectToCartWithError(action: string): Response {
  return new Response(null, { status: 303, headers: { Location: `${CART_PATH}?error=${action}` } });
}

/**
 * Add-to-cart (POST /api/cart/add). Content-negotiated: a `fetch` gets the refreshed snapshot as JSON
 * (page stays put); a plain <form> POST gets the 303 to /cart/. Adds to the stored cart, creating one
 * when absent or when the stored id no longer resolves (stale), and refreshes the cached snapshot from
 * Shopify's authoritative response.
 */
export async function handleAdd(
  request: Request,
  client: ShopifyCartClient,
  session: CartSession,
): Promise<Response> {
  const json = wantsJson(request);
  const parsed = parseLineForm(await request.formData());
  if (!parsed.ok) {
    return json ? jsonResponse({ error: parsed.error }, 400) : redirectToCart();
  }

  const stored = await session.read();
  let result;
  try {
    // Add to the stored cart; a null cart back means Shopify no longer resolves it (expired or checked
    // out), so create a fresh one. A non-null cart is authoritative even when a userError rode along.
    // The try covers only the Shopify round-trips: once a mutation has succeeded, a local failure
    // must not masquerade as "couldn't reach the store" and invite a duplicating retry.
    result = stored
      ? await client.cartLinesAdd(stored.id, [parsed.value])
      : await client.cartCreate([parsed.value]);
    if (stored && isStaleCart(result.cart)) result = await client.cartCreate([parsed.value]);
  } catch {
    // Shopify transport or GraphQL failure: degrade instead of a raw 500, and leave the existing
    // session snapshot untouched (we never wrote it) so the badge keeps telling the truth.
    return json ? jsonResponse({ error: CART_ERROR_MESSAGE }, 502) : redirectToCartWithError('add');
  }

  if (!result.cart) {
    // Shopify answered but refused the add (userErrors), even on the recreate attempt. Report a
    // failure; never a 200 with an empty snapshot, which would wipe a truthful badge and let the
    // cart UI announce "Item added".
    return json ? jsonResponse({ error: CART_REJECTED_MESSAGE }, 422) : redirectToCartWithError('add');
  }

  session.write({ id: result.cart.id, snapshot: toSnapshot(result.cart) });
  return json ? jsonResponse(toSnapshot(result.cart)) : redirectToCart();
}

/**
 * The shared no-JS line-mutation sequence behind handleUpdate and handleRemove. Sequence: parse, read
 * the stored cart, one guarded Shopify mutation (transport failure: 303 to /cart/?error=<action>,
 * snapshot left untouched), write the refreshed snapshot on a non-null cart, 303 back to /cart/. No
 * stored cart or invalid input is a no-op, then back to /cart/.
 *
 * handleAdd stays out: it is content-negotiated and carries the create/recreate and
 * rejected-mutation logic, so folding it in would trade duplication for a worse abstraction.
 */
async function handleLineMutation<T>(
  request: Request,
  client: ShopifyCartClient,
  session: CartSession,
  op: {
    parse: (form: FormData) => ParseResult<T>;
    mutate: (client: ShopifyCartClient, cartId: string, value: T) => Promise<CartMutationResult>;
    action: string;
  },
): Promise<Response> {
  const parsed = op.parse(await request.formData());
  const stored = await session.read();
  if (parsed.ok && stored) {
    let result;
    try {
      result = await op.mutate(client, stored.id, parsed.value);
    } catch {
      return redirectToCartWithError(op.action); // no raw 500; snapshot left intact.
    }
    if (result.cart) session.write({ id: result.cart.id, snapshot: toSnapshot(result.cart) });
  }
  return redirectToCart();
}

/**
 * Update-line-quantity (POST /api/cart/update). Validate the CartLine id and new quantity, apply it to
 * the session's Shopify cart, refresh the cached snapshot, and 303 back to /cart/. Removal is a
 * separate action, so quantity is always at least 1.
 */
export async function handleUpdate(
  request: Request,
  client: ShopifyCartClient,
  session: CartSession,
): Promise<Response> {
  return handleLineMutation(request, client, session, {
    parse: parseUpdateForm,
    mutate: (client, cartId, value) => client.cartLinesUpdate(cartId, [value]),
    action: 'update',
  });
}

/**
 * Remove-line (POST /api/cart/remove). Validate the CartLine id, drop it from the session's Shopify
 * cart, refresh the cached snapshot, and 303 back to /cart/.
 */
export async function handleRemove(
  request: Request,
  client: ShopifyCartClient,
  session: CartSession,
): Promise<Response> {
  return handleLineMutation(request, client, session, {
    parse: parseRemoveForm,
    mutate: (client, cartId, value) => client.cartLinesRemove(cartId, [value.lineId]),
    action: 'remove',
  });
}

/**
 * Cart badge summary (GET /api/cart/summary). Returns only the cached line count from the session
 * snapshot, with no Shopify round-trip. No stored cart gives `{ lineCount: 0 }`.
 */
export async function handleSummary(session: CartSession): Promise<Response> {
  const stored = await session.read();
  return jsonResponse({ lineCount: stored?.snapshot.lineCount ?? 0 });
}

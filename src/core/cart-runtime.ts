import { parseLineForm, parseUpdateForm, parseRemoveForm, toSnapshot, toCartView, isStaleCart } from './cart';
import type { ParseResult } from './cart';
import type { CartMutationResult, ShopifyCartClient } from './client';
import type { CartSession } from './cart-session';
import { CART_PAGE_PATH } from './cart-defaults';
import { wantsJson, jsonResponse, privateJson, readFormBody, unreadableBodyResponse } from './negotiation';
import type { CartView } from './types';

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

/** The three cart-changing routes; also what `/cart/?error=` names. */
export type CartAction = 'add' | 'update' | 'remove';

/** Where every mutating action sends the no-JS <form> POST back to. */
export const CART_PATH = CART_PAGE_PATH;

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

/**
 * The user-facing message when Shopify was reached but refused a change to a line (`cart: null` +
 * userErrors on update or remove). Only the enhanced path shows it; the no-JS path carries on silently.
 */
export const CART_UPDATE_REJECTED_MESSAGE =
  "Sorry, we couldn't change your cart. Some items may no longer be available.";

/** True when a `fetch` asks for the full {@link CartView} (the drawer) rather than the badge snapshot. */
function wantsCartView(request: Request): boolean {
  return request.headers.get('x-cart-view') === '1';
}

/** The view of a cart that does not exist (none started, or Shopify no longer resolves it). */
function emptyCartView(currency = ''): CartView {
  return { lineCount: 0, subtotal: { amount: '0.00', currencyCode: currency }, checkoutUrl: '', lines: [] };
}

/** The 303 back to /cart/: the no-JS degrade path. */
function redirectToCart(): Response {
  return new Response(null, { status: 303, headers: { Location: CART_PATH } });
}

/** No-JS failure degrade: 303 to /cart/?error=<action>, which renders a visible error banner. */
function redirectToCartWithError(action: CartAction): Response {
  return new Response(null, { status: 303, headers: { Location: `${CART_PATH}?error=${action}` } });
}

/**
 * Add-to-cart (POST /api/cart/add). Content-negotiated: a `fetch` gets the refreshed snapshot as JSON
 * (page stays put), or the full CartView when it also sends `X-Cart-View: 1`; a plain <form> POST gets
 * the 303 to /cart/. Adds to the stored cart, creating one
 * when absent or when the stored id no longer resolves (stale), and refreshes the cached snapshot from
 * Shopify's authoritative response.
 */
export async function handleAdd(
  request: Request,
  client: ShopifyCartClient,
  session: CartSession,
): Promise<Response> {
  const json = wantsJson(request);
  const form = await readFormBody(request);
  if (!form) return unreadableBodyResponse();
  const parsed = parseLineForm(form);
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
  if (!json) return redirectToCart();
  return wantsCartView(request) ? privateJson(toCartView(result.cart)) : jsonResponse(toSnapshot(result.cart));
}

/**
 * The shared line-mutation sequence behind handleUpdate and handleRemove. Sequence: parse, read the
 * stored cart, one guarded Shopify mutation, write the refreshed snapshot on a non-null cart, then
 * answer. Content-negotiated like the add route:
 * - a plain <form> POST gets the 303 back to /cart/ (to /cart/?error=<action> when Shopify failed),
 *   and invalid input or no stored cart is a no-op 303;
 * - a `fetch` gets the refreshed {@link CartView} as JSON. Invalid input is 400, a Shopify failure
 *   502, a Shopify refusal 422 (each `{ error }`, nothing written). No stored cart, or one Shopify no
 *   longer resolves, is an empty view: there is nothing to change and the UI should show that.
 *
 * handleAdd stays out: it carries the create/recreate and rejected-mutation logic, so folding it in
 * would trade duplication for a worse abstraction.
 */
async function handleLineMutation<T>(
  request: Request,
  client: ShopifyCartClient,
  session: CartSession,
  op: {
    parse: (form: FormData) => ParseResult<T>;
    mutate: (client: ShopifyCartClient, cartId: string, value: T) => Promise<CartMutationResult>;
    action: CartAction;
  },
): Promise<Response> {
  const json = wantsJson(request);
  const form = await readFormBody(request);
  if (!form) return unreadableBodyResponse();
  const parsed = op.parse(form);
  if (!parsed.ok) return json ? jsonResponse({ error: parsed.error }, 400) : redirectToCart();

  const stored = await session.read();
  if (!stored) return json ? privateJson(emptyCartView()) : redirectToCart();

  let result;
  try {
    result = await op.mutate(client, stored.id, parsed.value);
  } catch {
    // No raw 500; the snapshot is left intact.
    return json ? jsonResponse({ error: CART_ERROR_MESSAGE }, 502) : redirectToCartWithError(op.action);
  }

  if (result.cart) {
    session.write({ id: result.cart.id, snapshot: toSnapshot(result.cart) });
    return json ? privateJson(toCartView(result.cart)) : redirectToCart();
  }
  // A null cart is either a refusal (userErrors) or a cart Shopify no longer resolves (stale).
  if (json && result.userErrors.length > 0) return jsonResponse({ error: CART_UPDATE_REJECTED_MESSAGE }, 422);
  session.clear();
  return json ? privateJson(emptyCartView(stored.snapshot.currency)) : redirectToCart();
}

/**
 * Update-line-quantity (POST /api/cart/update). Validate the CartLine id and new quantity, apply it to
 * the session's Shopify cart, refresh the cached snapshot, and 303 back to /cart/ (or answer the
 * refreshed CartView to a `fetch`; see handleLineMutation). Removal is a separate action, so quantity
 * is always at least 1.
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
 * cart, refresh the cached snapshot, and 303 back to /cart/ (or answer the refreshed CartView to a
 * `fetch`; see handleLineMutation).
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
  return privateJson({ lineCount: stored?.snapshot.lineCount ?? 0 });
}

/**
 * Cart view (GET /api/cart/view). The stored cart as a {@link CartView}, fetched fresh from Shopify:
 * what the drawer shows when it is opened without a mutation. No stored cart, or one Shopify no
 * longer resolves, is an empty view. A Shopify failure is a 502 `{ error }`.
 */
export async function handleView(client: ShopifyCartClient, session: CartSession): Promise<Response> {
  const stored = await session.read();
  if (!stored) return privateJson(emptyCartView());
  let cart;
  try {
    cart = await client.getCart(stored.id);
  } catch {
    return privateJson({ error: CART_ERROR_MESSAGE }, 502);
  }
  if (!cart) {
    // Shopify no longer has it: forget it, so the header count stops showing the old lines.
    session.clear();
    return privateJson(emptyCartView(stored.snapshot.currency));
  }
  return privateJson(toCartView(cart));
}

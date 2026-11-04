import type { Cart, CartSnapshot, CartView } from './types';

/**
 * Pure cart logic: request-input validation and the authoritative-response reductions (snapshot,
 * view, staleness). No I/O: the Storefront round-trip lives in storefront.ts, the session plumbing in
 * cart-session.ts, the orchestration in cart-runtime.ts. Money formatting is in money.ts.
 */

/** A validated add-to-cart line: a ProductVariant GID and a positive integer quantity. */
export interface CartLineInput {
  merchandiseId: string;
  quantity: number;
}

/** A validated line update: a CartLine GID (not a variant id) and a new positive integer quantity. */
export interface CartLineUpdate {
  id: string;
  quantity: number;
}

/** Validation result: a discriminated outcome so callers branch without try/catch. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
// CartLine ids are a UUID, often with a `?cart=...` suffix: not numeric, so match leniently after the path.
const CART_LINE_GID = /^gid:\/\/shopify\/CartLine\/.+$/;

/** Parse a quantity field (absent: `fallback`); valid only as a positive integer. */
function parseQuantity(raw: FormDataEntryValue | null, fallback: number): number | null {
  const quantity = Number(raw ?? fallback);
  return Number.isInteger(quantity) && quantity >= 1 ? quantity : null;
}

/** Validate the `lineId` field shared by update and remove: a CartLine GID. */
function parseLineId(form: FormData): ParseResult<string> {
  const lineId = form.get('lineId');
  if (typeof lineId !== 'string' || !CART_LINE_GID.test(lineId)) {
    return { ok: false, error: 'lineId must be a CartLine GID' };
  }
  return { ok: true, value: lineId };
}

/** Validate a zero-JS add-to-cart form POST: a ProductVariant GID and an optional quantity (default 1). */
export function parseLineForm(form: FormData): ParseResult<CartLineInput> {
  const merchandiseId = form.get('merchandiseId');
  if (typeof merchandiseId !== 'string' || !VARIANT_GID.test(merchandiseId)) {
    return { ok: false, error: 'merchandiseId must be a ProductVariant GID' };
  }
  const quantity = parseQuantity(form.get('quantity'), 1);
  if (quantity === null) return { ok: false, error: 'quantity must be a positive integer' };
  return { ok: true, value: { merchandiseId, quantity } };
}

/** Validate a cart line quantity-change POST: a CartLine GID and a positive integer quantity. */
export function parseUpdateForm(form: FormData): ParseResult<CartLineUpdate> {
  const id = parseLineId(form);
  if (!id.ok) return id;
  const quantity = parseQuantity(form.get('quantity'), 1);
  if (quantity === null) return { ok: false, error: 'quantity must be a positive integer' };
  return { ok: true, value: { id: id.value, quantity } };
}

/** Validate a cart line removal POST: a CartLine GID. */
export function parseRemoveForm(form: FormData): ParseResult<{ lineId: string }> {
  const lineId = parseLineId(form);
  return lineId.ok ? { ok: true, value: { lineId: lineId.value } } : lineId;
}

/**
 * Reduce an authoritative Shopify cart to the denormalised snapshot cached in the session, so a cart
 * badge renders without a Shopify round-trip. `totalQuantity` and `subtotalAmount` are Shopify's own
 * totals; we never recompute them from the lines.
 */
export function toSnapshot(cart: Cart): CartSnapshot {
  return {
    lineCount: cart.totalQuantity,
    subtotal: cart.cost.subtotalAmount.amount,
    currency: cart.cost.subtotalAmount.currencyCode,
  };
}

/** Reshape an authoritative Shopify cart into the flat {@link CartView} a cart page or drawer renders. */
export function toCartView(cart: Cart): CartView {
  return {
    lineCount: cart.totalQuantity,
    subtotal: cart.cost.subtotalAmount,
    checkoutUrl: cart.checkoutUrl,
    lines: cart.lines.nodes.map((line) => ({
      id: line.id,
      quantity: line.quantity,
      productTitle: line.merchandise.product.title,
      productHandle: line.merchandise.product.handle,
      variantTitle: line.merchandise.title,
      unitPrice: line.merchandise.price,
      lineTotal: line.cost.totalAmount,
      image: line.merchandise.image,
    })),
  };
}

/**
 * A stored cart id is stale once Shopify no longer resolves it: `cart(id:)` returns `null` after the
 * cart expires (about 10 days idle) or is completed at checkout. An empty-but-live cart is not stale.
 */
export function isStaleCart(cart: Cart | null): boolean {
  return cart === null;
}

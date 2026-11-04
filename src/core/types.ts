/**
 * Cart types. These mirror the Shopify Storefront Cart API response shapes the Worker round-trips
 * at request time. Shopify is authoritative for the cart; we never synthesise these, only parse
 * them from a response.
 */

/** A Storefront `MoneyV2`: a decimal amount string paired with its ISO 4217 currency code. */
export interface Money {
  amount: string;
  currencyCode: string;
}

/** The product variant a cart line refers to; its `id` is the `merchandiseId` the cart accepts. */
export interface CartMerchandise {
  id: string;
  title: string;
  price: Money;
  product: { title: string; handle: string };
  image: { url: string; altText: string | null } | null;
}

/** One line in a Shopify cart. `id` is a CartLine GID (used by update/remove, not the variant id). */
export interface CartLine {
  id: string;
  quantity: number;
  cost: { totalAmount: Money };
  merchandise: CartMerchandise;
}

/** A Shopify cart as the Storefront API returns it. `cart(id:)` returns `null` when expired or completed. */
export interface Cart {
  id: string;
  checkoutUrl: string;
  /** Authoritative total item count across all lines; the source for the badge. */
  totalQuantity: number;
  cost: { subtotalAmount: Money; totalAmount: Money };
  lines: { nodes: CartLine[] };
}

/**
 * The cheap, denormalised view persisted to the session so a cart badge can render without a
 * Shopify round-trip. The session is a cache only; Shopify stays authoritative.
 */
export interface CartSnapshot {
  /** Total item count: `Cart.totalQuantity`. */
  lineCount: number;
  /** Subtotal as a decimal amount string in `currency`: `Cart.cost.subtotalAmount.amount`. */
  subtotal: string;
  /** ISO 4217 code of the subtotal. */
  currency: string;
}

/** One line of a {@link CartView}: what a cart page or drawer shows for a line. */
export interface CartViewLine {
  /** CartLine GID: what update and remove post back. */
  id: string;
  quantity: number;
  productTitle: string;
  productHandle: string;
  /** Variant title; Shopify's `Default Title` sentinel for single-variant products. */
  variantTitle: string;
  unitPrice: Money;
  lineTotal: Money;
  image: { url: string; altText: string | null } | null;
}

/**
 * The render-ready view of a Shopify cart: everything a cart page or drawer needs, with no Shopify
 * nesting. `checkoutUrl` embeds Shopify's cart token, so it may be rendered into HTML but must
 * never be put in a redirect `Location` or any other URL the handlers produce.
 */
export interface CartView {
  lineCount: number;
  subtotal: Money;
  checkoutUrl: string;
  lines: CartViewLine[];
}

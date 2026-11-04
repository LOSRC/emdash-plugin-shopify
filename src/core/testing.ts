import type { Cart, CartLine } from './types';
import type { CartLineInput, CartLineUpdate } from './cart';
import type { CartMutationResult, ShopifyClient } from './client';
import { createFakeCatalogue } from './fake-catalogue';
import type { FakeCatalogue } from './fake-catalogue';

export type { FakeProductInput, FakeVariantInput } from './fake-catalogue';

/**
 * In-memory Shopify cart client, exported as `@losrc/emdash-plugin-shopify/core/testing`. It is the
 * second implementation of `ShopifyCartClient`, standing in for the Storefront network adapter in
 * tests. It keeps real cart state in a Map, so tests observe genuine behaviour (a reused cart keeps
 * its id, a mutation against an unknown id answers as a lost cart does, totals track
 * the lines) rather than asserting against mock call-spies. `failNextWith` arms the next call to
 * reject, so the graceful-degradation paths can be driven through the same fake.
 */

interface FakeLine {
  id: string;
  merchandiseId: string;
  quantity: number;
}

interface FakeCart {
  id: string;
  lines: FakeLine[];
}

export interface FakeCartClient extends ShopifyClient, Pick<FakeCatalogue, 'seedProduct' | 'setPublished' | 'removeProduct'> {
  /** The carts currently held in memory, for assertions/introspection. */
  readonly carts: ReadonlyMap<string, Cart>;
  /** Arm the next client call (cart or product read/write) to reject with `error`. One-shot. */
  failNextWith(error: Error): void;
  /**
   * Make every subsequent mutation resolve `{ cart: null, userErrors: [{ message }] }` - Shopify was
   * reached but rejected the mutation (e.g. the variant is no longer purchasable). Persistent, unlike
   * `failNextWith`, because a rejected variant rejects on the recreate attempt too.
   */
  rejectMutationsWith(message: string): void;
  /**
   * How a mutation against a cart the fake does not hold is answered. `'userErrors'` (the default) is
   * how Shopify answers a lost cart: `cart: null` plus a userError whose field is `["cartId"]`.
   * `'null'` is the older bare `{ cart: null, userErrors: [] }`. `'fieldless'` is a userError with
   * `field: null`: a lost cart Shopify does not flag on `cartId` (a completed cart can answer so).
   */
  answerMissingCartWith(form: 'userErrors' | 'null' | 'fieldless'): void;
}

export interface FakeClientOptions {
  /**
   * Per-variant unit price (decimal string). It wins over a seeded variant's own price. A variant
   * in neither falls back to `defaultPrice`.
   */
  prices?: Record<string, string>;
  /** Fallback unit price for any variant not in `prices`. */
  defaultPrice?: string;
  /** ISO 4217 currency shared by every amount the fake mints. */
  currency?: string;
}

/**
 * Money is held as integer units at PRICE_SCALE decimal places (ten-thousandths) so line totals and
 * subtotals are computed with exact integer arithmetic - never IEEE-754 floats, whose binary rounding
 * diverges from the decimal rounding the real Storefront API uses (e.g. `1.005 * 3`). Amounts render
 * back to the standard 2-dp money string with half-up rounding at the boundary.
 */
const PRICE_SCALE = 4;
const MINOR = 10 ** PRICE_SCALE; // scaled units per major currency unit
const PER_CENT = MINOR / 100; // scaled units per cent

/** Parse a decimal price string into integer units at PRICE_SCALE, with no float multiplication. */
function toScaledUnits(decimal: string): number {
  const [whole, fraction = ''] = decimal.split('.');
  if (fraction.length > PRICE_SCALE) {
    throw new Error(`fake-client: price "${decimal}" exceeds ${PRICE_SCALE}-dp supported precision`);
  }
  return Number(whole) * MINOR + Number(fraction.padEnd(PRICE_SCALE, '0'));
}

/** Render scaled units to a 2-dp money amount string, rounding half-up - no float arithmetic. */
function formatAmount(scaled: number): string {
  const cents = Math.trunc(scaled / PER_CENT);
  const remainder = scaled - cents * PER_CENT;
  const rounded = remainder * 2 >= PER_CENT ? cents + 1 : cents; // half-up at the cent
  const minor = rounded % 100;
  const major = (rounded - minor) / 100;
  return `${major}.${String(minor).padStart(2, '0')}`;
}

const money = (scaled: number, currencyCode: string) => ({ amount: formatAmount(scaled), currencyCode });

export function createFakeCartClient(options: FakeClientOptions = {}): FakeCartClient {
  const currency = options.currency ?? 'GBP';
  const catalogue = createFakeCatalogue({ currency, checkFailure });
  // Unit price as exact scaled integer units - the source for all money the fake mints.
  // Then, in order: `options.prices`, the seeded variant's price, `defaultPrice`, `10.00`. A seeded variant
  // has a price of its own (10.00 unless seeded otherwise), so `defaultPrice` only reaches unseeded ones.
  const priceOf = (variantId: string) =>
    toScaledUnits(
      options.prices?.[variantId] ?? catalogue.findVariant(variantId)?.variant.price.amount ?? options.defaultPrice ?? '10.00',
    );

  const store = new Map<string, FakeCart>();
  let cartSeq = 0;
  let lineSeq = 0;
  let pendingError: Error | null = null;
  let rejection: string | null = null;
  let missingCartForm: 'userErrors' | 'null' | 'fieldless' = 'userErrors';

  /** Throw the armed error if one is pending (one-shot), before any state change. */
  function checkFailure() {
    if (pendingError) {
      const error = pendingError;
      pendingError = null;
      throw error;
    }
  }

  /** The armed userError rejection, if any - Shopify answered but refused the mutation. */
  function checkRejection(): CartMutationResult | null {
    return rejection ? { cart: null, userErrors: [{ field: null, message: rejection }] } : null;
  }

  /** Render the in-memory cart into the authoritative `Cart` shape the real Storefront returns. */
  function render(cart: FakeCart): Cart {
    const lines: CartLine[] = cart.lines.map((line) => {
      const unit = priceOf(line.merchandiseId);
      // A seeded variant is named from the catalogue; the stub is for an id the catalogue has never seen.
      const found = catalogue.findVariant(line.merchandiseId);
      return {
        id: line.id,
        quantity: line.quantity,
        cost: { totalAmount: money(unit * line.quantity, currency) },
        merchandise: {
          id: line.merchandiseId,
          title: found?.variant.title ?? 'Default Title',
          price: money(unit, currency),
          product: found ? { title: found.product.title, handle: found.product.handle } : { title: 'Fake product', handle: 'fake-product' },
          image: found?.product.image ? { url: found.product.image.url, altText: found.product.image.altText } : null,
        },
      };
    });
    const totalQuantity = cart.lines.reduce((sum, line) => sum + line.quantity, 0);
    const subtotal = cart.lines.reduce((sum, line) => sum + priceOf(line.merchandiseId) * line.quantity, 0);
    return {
      id: cart.id,
      checkoutUrl: `https://fake.myshopify.com/cart/c/${cart.id.split('/').pop()}`,
      totalQuantity,
      cost: { subtotalAmount: money(subtotal, currency), totalAmount: money(subtotal, currency) },
      lines: { nodes: lines },
    };
  }

  /** Real CartLine ids look like `gid://shopify/CartLine/<uuid>?cart=<cart token>`: the token rides along. */
  const lineIdFor = (cart: FakeCart) => `gid://shopify/CartLine/fake-${++lineSeq}?cart=${cart.id.split('/').pop()}`;

  function addLines(cart: FakeCart, lines: CartLineInput[]) {
    for (const line of lines) {
      // Real Storefront `cartLinesAdd` merges identical merchandise into one line with a summed
      // quantity, rather than appending a duplicate - mirror that so a repeated add targets a line id
      // that also exists in production.
      const existing = cart.lines.find((candidate) => candidate.merchandiseId === line.merchandiseId);
      if (existing) existing.quantity += line.quantity;
      else cart.lines.push({ id: lineIdFor(cart), merchandiseId: line.merchandiseId, quantity: line.quantity });
    }
  }

  const ok = (cart: FakeCart): CartMutationResult => ({ cart: render(cart), userErrors: [] });
  const gone = (): CartMutationResult => {
    if (missingCartForm === 'null') return { cart: null, userErrors: [] };
    const field = missingCartForm === 'fieldless' ? null : ['cartId'];
    return { cart: null, userErrors: [{ field, message: 'The specified cart does not exist.', code: 'INVALID' }] };
  };

  return {
    get carts() {
      const snapshot = new Map<string, Cart>();
      for (const [id, cart] of store) snapshot.set(id, render(cart));
      return snapshot;
    },

    seedProduct: catalogue.seedProduct,
    setPublished: catalogue.setPublished,
    removeProduct: catalogue.removeProduct,
    getProducts: catalogue.getProducts,
    listChannelProducts: catalogue.listChannelProducts,

    failNextWith(error: Error) {
      pendingError = error;
    },

    rejectMutationsWith(message: string) {
      rejection = message;
    },

    answerMissingCartWith(form) {
      missingCartForm = form;
    },

    async cartCreate(lines: CartLineInput[]): Promise<CartMutationResult> {
      checkFailure();
      const rejected = checkRejection();
      if (rejected) return rejected;
      const cart: FakeCart = { id: `gid://shopify/Cart/fake-${++cartSeq}`, lines: [] };
      addLines(cart, lines);
      store.set(cart.id, cart);
      return ok(cart);
    },

    async cartLinesAdd(cartId: string, lines: CartLineInput[]): Promise<CartMutationResult> {
      checkFailure();
      const rejected = checkRejection();
      if (rejected) return rejected;
      const cart = store.get(cartId);
      if (!cart) return gone(); // unknown id: Shopify would not resolve it
      addLines(cart, lines);
      return ok(cart);
    },

    async cartLinesUpdate(cartId: string, updates: CartLineUpdate[]): Promise<CartMutationResult> {
      checkFailure();
      const rejected = checkRejection();
      if (rejected) return rejected;
      const cart = store.get(cartId);
      if (!cart) return gone();
      for (const update of updates) {
        const line = cart.lines.find((candidate) => candidate.id === update.id);
        if (line) line.quantity = update.quantity;
      }
      return ok(cart);
    },

    async cartLinesRemove(cartId: string, lineIds: string[]): Promise<CartMutationResult> {
      checkFailure();
      const rejected = checkRejection();
      if (rejected) return rejected;
      const cart = store.get(cartId);
      if (!cart) return gone();
      cart.lines = cart.lines.filter((line) => !lineIds.includes(line.id));
      return ok(cart);
    },

    async getCart(cartId: string): Promise<Cart | null> {
      checkFailure();
      const cart = store.get(cartId);
      return cart ? render(cart) : null;
    },
  };
}

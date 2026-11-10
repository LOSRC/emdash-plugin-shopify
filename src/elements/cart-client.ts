import type { CartAction } from '../core/cart-runtime';
import type { CartView } from '../core/types';

/**
 * The browser side of the cart JSON contract, shared by `<cart-drawer>` and `<cart-count>`. It talks to
 * the site's cart routes (see the core's `handleAdd`, `handleUpdate`, `handleRemove`, `handleView` and
 * `handleSummary`) and turns every outcome into a value the elements can render: never a throw.
 */

/** Shown for anything the customer can't act on: a bad status, an unreadable body, no network. */
export const GENERIC_ERROR = 'Sorry, something went wrong. Please try again.';

export type CartOutcome = { ok: true; view: CartView } | { ok: false; message: string };

/** The `fetch` the elements use; injectable so the contract is testable without a browser. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isCartView(value: unknown): value is CartView {
  const view = value as Partial<CartView> | null;
  return (
    typeof view === 'object' &&
    view !== null &&
    typeof view.lineCount === 'number' &&
    Array.isArray(view.lines) &&
    typeof view.subtotal === 'object' &&
    view.subtotal !== null
  );
}

/**
 * Call a cart route and read the {@link CartView} it answers. Sends the headers that make the route
 * answer JSON rather than a 303, and `X-Cart-View: 1`, which makes `add` answer the view instead of
 * the badge snapshot. On failure the message is the server's own `error` only for 422 and 502, the
 * curated texts written for customers; any other status gets the generic text.
 */
export async function requestCartView(
  url: string,
  body?: FormData,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<CartOutcome> {
  try {
    const res = await fetchImpl(url, {
      method: body ? 'POST' : 'GET',
      body,
      headers: { Accept: 'application/json', 'X-Requested-With': 'fetch', 'X-Cart-View': '1' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const data: unknown = await res.json().catch(() => null);
    if (res.ok) return isCartView(data) ? { ok: true, view: data } : { ok: false, message: GENERIC_ERROR };
    const error = (data as { error?: unknown } | null)?.error;
    const curated = (res.status === 422 || res.status === 502) && typeof error === 'string' && error;
    return { ok: false, message: curated || GENERIC_ERROR };
  } catch {
    return { ok: false, message: GENERIC_ERROR };
  }
}

/** The cart's item count from the summary route, or `null` when it can't be read. */
export async function fetchLineCount(
  url: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<number | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'X-Requested-With': 'fetch' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { lineCount?: unknown };
    return typeof data.lineCount === 'number' ? data.lineCount : null;
  } catch {
    return null;
  }
}

/**
 * Which cart action a form posts to, or `null` when it posts anywhere else: its resolved `action` has
 * the same origin and path as one of the cart routes. `pageUrl` resolves relative URLs.
 */
export function cartActionOf(formAction: string, urls: Record<CartAction, string>, pageUrl: string): CartAction | null {
  const target = new URL(formAction, pageUrl);
  for (const action of ['add', 'update', 'remove'] as const) {
    const route = new URL(urls[action], pageUrl);
    if (target.origin === route.origin && target.pathname === route.pathname) return action;
  }
  return null;
}

/** The document event both elements use to stay in step: `detail.lineCount` is the new item count. */
/** What `showCount` writes to: the `[data-count]` badge, or a stand-in for it in a test. */
export interface CountBadge {
  textContent: string | null;
  /** `HTMLElement.hidden` is also `'until-found'`; this only ever writes a boolean. */
  hidden: boolean | string;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Puts the count in the header's badge: hidden while it is zero, shown otherwise. A shown badge is
 * `aria-hidden`, because the link's label already says the count ("Cart, 3 items") and a screen
 * reader would otherwise read the number twice. The attribute is set here and not in the markup:
 * the badge is served `hidden`, and `aria-hidden` on a `hidden` element is redundant (the Nu HTML
 * Checker warns about it).
 */
export function showCount(badge: CountBadge, count: number): void {
  badge.textContent = String(count);
  badge.hidden = count === 0;
  if (count === 0) badge.removeAttribute('aria-hidden');
  else badge.setAttribute('aria-hidden', 'true');
}

export const CART_CHANGE_EVENT = 'shopify-cart:change';

export interface CartChangeDetail {
  lineCount: number;
}

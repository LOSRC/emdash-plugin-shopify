import { cartRoutes } from '../core/cart-defaults';
import { CART_CHANGE_EVENT, fetchLineCount, showCount } from './cart-client';
import type { CartChangeDetail } from './cart-client';

/**
 * `<cart-count>`: the header's item count. Pages are cached and shared, so the count is never in the
 * HTML; this reads it from the summary route once per page view (and again when a page is restored
 * from the back/forward cache) and follows `<cart-drawer>` through the `shopify-cart:change` event.
 *
 * Markup it expects (rendered by `CartCount.astro`): a `[data-count]` badge, hidden while the count is
 * zero (and kept from screen readers while it shows, see `showCount`), and a `[data-label]` visually-hidden label, whose text is kept as the base for "Cart, 3 items".
 *
 * Attribute: `src`, the summary route (default: the summary route under `/api/cart`).
 */
export class CartCountElement extends HTMLElement {
  #label = '';

  connectedCallback(): void {
    this.#label = this.querySelector('[data-label]')?.textContent?.trim() || 'Cart';
    document.addEventListener(CART_CHANGE_EVENT, this.#onChange);
    window.addEventListener('pageshow', this.#onPageShow);
    void this.#refresh();
  }

  disconnectedCallback(): void {
    document.removeEventListener(CART_CHANGE_EVENT, this.#onChange);
    window.removeEventListener('pageshow', this.#onPageShow);
  }

  async #refresh(): Promise<void> {
    const count = await fetchLineCount(this.getAttribute('src') ?? cartRoutes().summary);
    if (count !== null) this.#show(count);
  }

  #onChange = (event: Event): void => {
    this.#show((event as CustomEvent<CartChangeDetail>).detail.lineCount);
  };

  #onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) void this.#refresh();
  };

  #show(count: number): void {
    const badge = this.querySelector<HTMLElement>('[data-count]');
    if (badge) showCount(badge, count);
    const label = this.querySelector('[data-label]');
    if (label) label.textContent = count === 0 ? this.#label : `${this.#label}, ${count} ${count === 1 ? 'item' : 'items'}`;
  }
}

if (!customElements.get('cart-count')) customElements.define('cart-count', CartCountElement);

declare global {
  interface HTMLElementTagNameMap {
    'cart-count': CartCountElement;
  }
}

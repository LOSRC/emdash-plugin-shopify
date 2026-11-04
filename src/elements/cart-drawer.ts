import { DEFAULT_PRODUCT_PATH, DEFAULT_VARIANT_TITLE, cartRoutes, isHttpsUrl, productHref } from '../core/cart-defaults';
import { formatMoney } from '../core/money';
import type { CartView, CartViewLine } from '../core/types';
import { CART_CHANGE_EVENT, cartActionOf, requestCartView } from './cart-client';
import type { CartChangeDetail, CartOutcome } from './cart-client';

/**
 * `<cart-drawer>`: the slide-out cart. A progressive enhancement: without JavaScript the add-to-cart
 * form posts and lands on /cart/, and this element's markup stays hidden. With it, the drawer
 * intercepts add-to-cart forms, posts them with `fetch`, and slides out showing the cart. It also
 * intercepts forms posting to its `update-url` and `remove-url` the same way, wherever they are on the
 * page; on the /cart/ page the drawer is not rendered, so those forms stay plain posts.
 *
 * It fills markup rendered by `CartDrawer.astro` (a `<dialog>` and a line `<template>`), so every
 * class name lives in the component and the element only toggles, fills and announces.
 *
 * Attributes (all set by the component): `add-url`, `update-url`, `remove-url`, `view-url` (the cart
 * routes) and `product-path` (a path with `{handle}`).
 *
 * Triggers: any element with `data-cart-drawer-open` opens the drawer when clicked.
 * Events: dispatches `shopify-cart:change` on `document` after every cart change, with
 * `detail.lineCount`; `<cart-count>` follows it.
 */

/** Matches the dialog's slide transition, as a fallback when no `transitionend` arrives. */
const CLOSE_FALLBACK_MS = 400;

const EMPTY_VIEW_NOTE = 'Your cart is empty.';

export class CartDrawerElement extends HTMLElement {
  #view: CartView | null = null;
  #busy = false;
  #opener: Element | null = null;
  #closing = false;
  #viewLoaded = false;

  connectedCallback(): void {
    document.addEventListener('submit', this.#onSubmit);
    document.addEventListener('click', this.#onDocumentClick);
    this.#dialog.addEventListener('click', this.#onDialogClick);
    this.#dialog.addEventListener('cancel', this.#onCancel);
    this.#dialog.addEventListener('close', this.#onClosed);
  }

  disconnectedCallback(): void {
    document.removeEventListener('submit', this.#onSubmit);
    document.removeEventListener('click', this.#onDocumentClick);
    this.#dialog.removeEventListener('click', this.#onDialogClick);
    this.#dialog.removeEventListener('cancel', this.#onCancel);
    this.#dialog.removeEventListener('close', this.#onClosed);
  }

  /** Slide the drawer out. Loads the cart from the server the first time it opens without a mutation. */
  async open(): Promise<void> {
    this.#showDialog();
    if (!this.#viewLoaded) await this.#load();
  }

  /** Slide the drawer away, then close the dialog. Focus returns to whatever opened it. */
  close(): void {
    const dialog = this.#dialog;
    if (!dialog.open || this.#closing) return;
    this.#closing = true;
    const finish = () => {
      dialog.removeEventListener('transitionend', onEnd);
      clearTimeout(timer);
      this.#closing = false;
      // A reopen during the slide-out (an add while closing) wins.
      if (dialog.open && dialog.dataset.open === 'false') dialog.close();
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === dialog) finish();
    };
    const timer = setTimeout(finish, CLOSE_FALLBACK_MS);
    dialog.addEventListener('transitionend', onEnd);
    dialog.dataset.open = 'false';
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
  }

  // --- parts -------------------------------------------------------------------------------------

  get #dialog(): HTMLDialogElement {
    return this.querySelector('dialog')!;
  }

  #part<T extends HTMLElement = HTMLElement>(name: string): T {
    return this.querySelector<T>(`[data-${name}]`)!;
  }

  #url(name: 'add' | 'update' | 'remove' | 'view'): string {
    return this.getAttribute(`${name}-url`) ?? cartRoutes()[name];
  }

  // --- opening and closing -----------------------------------------------------------------------

  #showDialog(): void {
    const dialog = this.#dialog;
    this.#closing = false;
    if (dialog.open) {
      dialog.dataset.open = 'true';
      return;
    }
    this.#opener = document.activeElement;
    dialog.showModal();
    document.documentElement.style.overflow = 'hidden';
    // Next frame, so the slide transition runs from the off-screen position.
    requestAnimationFrame(() => {
      if (!this.#closing) dialog.dataset.open = 'true';
    });
  }

  #onCancel = (event: Event): void => {
    // Escape: take over so the drawer slides away instead of vanishing.
    event.preventDefault();
    this.close();
  };

  #onClosed = (): void => {
    document.documentElement.style.overflow = '';
    this.#dialog.dataset.open = 'false';
    const opener = this.#opener;
    this.#opener = null;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  };

  #onDialogClick = (event: MouseEvent): void => {
    const target = event.target as Element;
    // A click on the backdrop lands on the dialog itself; the panel's content fills the dialog.
    if (target === this.#dialog || target.closest('[data-close]')) {
      this.close();
      return;
    }
    const button = target.closest<HTMLButtonElement>('button[data-decrease], button[data-increase], button[data-remove]');
    const item = button?.closest<HTMLElement>('[data-line-id]');
    if (!button || !item) return;
    const quantity = Number(item.dataset.lineQuantity);
    if (button.hasAttribute('data-remove') || (button.hasAttribute('data-decrease') && quantity <= 1)) {
      void this.#removeLine(item);
    } else {
      const increase = button.hasAttribute('data-increase');
      void this.#updateLine(item, quantity + (increase ? 1 : -1), increase ? 'data-increase' : 'data-decrease');
    }
  };

  #onDocumentClick = (event: MouseEvent): void => {
    const trigger = (event.target as Element | null)?.closest('[data-cart-drawer-open]');
    if (!trigger || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    void this.open();
  };

  // --- form posts on the page --------------------------------------------------------------------

  /** Add, update and remove forms anywhere on the page: sent with `fetch`, answered in the drawer. */
  #onSubmit = (event: SubmitEvent): void => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || event.defaultPrevented) return;
    if (form.method.toLowerCase() !== 'post') return;
    const urls = { add: this.#url('add'), update: this.#url('update'), remove: this.#url('remove') };
    const action = cartActionOf(form.action, urls, location.href);
    if (!action) return;

    event.preventDefault();
    if (this.#busy) return;
    const submitter = event.submitter;
    submitter?.setAttribute('aria-busy', 'true');
    const announce = {
      add: (view: CartView) => this.#addedNote(view),
      update: () => 'Cart updated.',
      remove: () => 'Item removed from your cart.',
    }[action];
    void this.#send(new URL(urls[action], location.href).pathname, new FormData(form), { announce }).finally(() => {
      submitter?.removeAttribute('aria-busy');
    });
  };

  // --- line changes ------------------------------------------------------------------------------

  #updateLine(item: HTMLElement, quantity: number, part: string): Promise<void> {
    const title = this.#titleOf(item);
    const body = new FormData();
    body.set('lineId', item.dataset.lineId!);
    body.set('quantity', String(quantity));
    return this.#send(this.#url('update'), body, {
      announce: () => `${title}: quantity ${quantity}.`,
      keepFocus: { lineId: item.dataset.lineId!, part },
    });
  }

  #removeLine(item: HTMLElement): Promise<void> {
    const title = this.#titleOf(item);
    const body = new FormData();
    body.set('lineId', item.dataset.lineId!);
    return this.#send(this.#url('remove'), body, { announce: () => `${title} removed from your cart.` });
  }

  #titleOf(item: HTMLElement): string {
    return item.querySelector('[data-title]')?.textContent ?? 'Item';
  }

  // --- talking to the server ---------------------------------------------------------------------

  async #load(): Promise<void> {
    await this.#send(this.#url('view'), undefined, {});
  }

  /** One request at a time: a second tap while one is in flight is ignored, not queued. */
  async #send(
    url: string,
    body: FormData | undefined,
    options: { announce?: (view: CartView) => string; keepFocus?: { lineId: string; part?: string } },
  ): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.#setBusy(true);
    // Open first, so the customer sees the drawer working rather than a button that did nothing.
    this.#showDialog();
    let outcome: CartOutcome;
    try {
      outcome = await requestCartView(url, body);
    } finally {
      this.#busy = false;
      this.#setBusy(false);
    }
    if (outcome.ok) {
      this.#showError('');
      this.#render(outcome.view, options.keepFocus);
      this.#announce(options.announce?.(outcome.view) ?? '');
      document.dispatchEvent(
        new CustomEvent<CartChangeDetail>(CART_CHANGE_EVENT, { detail: { lineCount: outcome.view.lineCount } }),
      );
    } else {
      this.#showError(outcome.message);
      // Show what the cart holds now, if it has never been shown (an add that failed on a fresh page).
      if (!this.#viewLoaded && body) {
        const reload = await requestCartView(this.#url('view'));
        if (reload.ok) this.#render(reload.view);
      }
    }
  }

  #setBusy(busy: boolean): void {
    this.#dialog.dataset.busy = String(busy);
    this.#part('loading').hidden = !(busy && !this.#viewLoaded);
    this.#part('body').setAttribute('aria-busy', String(busy));
  }

  // --- rendering ---------------------------------------------------------------------------------

  #render(view: CartView, keepFocus?: { lineId: string; part?: string }): void {
    this.#view = view;
    this.#viewLoaded = true;
    const dialog = this.#dialog;
    const list = this.#part('lines');
    const hadFocus = dialog.contains(document.activeElement) && document.activeElement !== dialog;

    list.replaceChildren(...view.lines.map((line) => this.#renderLine(line)));
    const empty = view.lines.length === 0;
    this.#part('empty').hidden = !empty;
    this.#part('footer').hidden = empty;
    list.hidden = empty;

    if (!empty) {
      this.#part('subtotal').textContent = formatMoney(view.subtotal.amount, view.subtotal.currencyCode);
      const checkout = this.#part<HTMLAnchorElement>('checkout');
      // The checkout URL is Shopify's, rendered here and nowhere else; refuse anything but https.
      checkout.hidden = !isHttpsUrl(view.checkoutUrl);
      if (!checkout.hidden) checkout.href = view.checkoutUrl;
    }

    // Keep the keyboard where it was: the same button on the same line, else somewhere sensible.
    if (hadFocus) {
      const item = keepFocus && list.querySelector<HTMLElement>(`[data-line-id="${CSS.escape(keepFocus.lineId)}"]`);
      const same = item && keepFocus.part ? item.querySelector<HTMLElement>(`[${keepFocus.part}]`) : null;
      (same ?? this.#part('close')).focus();
    }
  }

  #renderLine(line: CartViewLine): HTMLElement {
    const template = this.querySelector<HTMLTemplateElement>('template[data-line]')!;
    const item = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
    const text = (name: string, value: string) => {
      const el = item.querySelector<HTMLElement>(`[data-${name}]`);
      if (el) el.textContent = value;
    };

    item.dataset.lineId = line.id;
    item.dataset.lineQuantity = String(line.quantity);
    text('title', line.productTitle);
    text('variant', line.variantTitle);
    item.querySelector<HTMLElement>('[data-variant]')!.hidden = line.variantTitle === DEFAULT_VARIANT_TITLE;
    text('price', formatMoney(line.unitPrice.amount, line.unitPrice.currencyCode));
    text('quantity', String(line.quantity));
    text('total', formatMoney(line.lineTotal.amount, line.lineTotal.currencyCode));
    item.querySelector<HTMLAnchorElement>('a[data-title]')!.href = productHref(
      this.getAttribute('product-path') ?? DEFAULT_PRODUCT_PATH,
      line.productHandle,
    );

    const image = item.querySelector<HTMLImageElement>('img[data-image]');
    if (image) {
      if (line.image && isHttpsUrl(line.image.url)) {
        image.src = line.image.url;
        image.alt = line.image.altText ?? '';
      } else {
        image.hidden = true;
      }
    }

    // At quantity 1 the minus button removes the line: update refuses a quantity below 1.
    const decrease = item.querySelector<HTMLButtonElement>('[data-decrease]');
    decrease?.setAttribute('aria-label', `${line.quantity <= 1 ? 'Remove' : 'Decrease quantity of'} ${line.productTitle}`);
    item.querySelector('[data-increase]')?.setAttribute('aria-label', `Increase quantity of ${line.productTitle}`);
    item.querySelector('[data-remove]')?.setAttribute('aria-label', `Remove ${line.productTitle} from your cart`);
    return item;
  }

  #showError(message: string): void {
    const el = this.#part('error');
    el.textContent = message;
    el.hidden = message === '';
  }

  #announce(message: string): void {
    const live = this.#part('live');
    // Clear first so repeating the same message is still announced.
    live.textContent = '';
    if (message) requestAnimationFrame(() => (live.textContent = message));
  }

  #addedNote(view: CartView): string {
    if (view.lines.length === 0) return EMPTY_VIEW_NOTE;
    const items = `${view.lineCount} ${view.lineCount === 1 ? 'item' : 'items'}`;
    return `Added to your cart. ${items}, subtotal ${formatMoney(view.subtotal.amount, view.subtotal.currencyCode)}.`;
  }
}

if (!customElements.get('cart-drawer')) customElements.define('cart-drawer', CartDrawerElement);

declare global {
  interface HTMLElementTagNameMap {
    'cart-drawer': CartDrawerElement;
  }
}

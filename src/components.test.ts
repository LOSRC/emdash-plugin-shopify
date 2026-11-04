import { describe, it, expect } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import CartPage from './components/CartPage.astro';
import CartCount from './components/CartCount.astro';
import CartDrawer from './components/CartDrawer.astro';
import { toCartView } from './core/cart';
import { createFakeCartClient } from './core/testing';

const VARIANT = 'gid://shopify/ProductVariant/10000000001';

/** A real cart view: two lines through the fake client, reduced the way the site's page does. */
async function sampleCart() {
  const client = createFakeCartClient({ prices: { [VARIANT]: '14.99' } });
  const created = await client.cartCreate([{ merchandiseId: VARIANT, quantity: 2 }]);
  return toCartView(created.cart!);
}

async function render(component: Parameters<AstroContainer['renderToString']>[0], props: Record<string, unknown> = {}) {
  const container = await AstroContainer.create();
  return container.renderToString(component, { props });
}

describe('CartPage (no JavaScript)', () => {
  it('renders each line with plain update and remove form posts carrying the line id', async () => {
    const cart = await sampleCart();
    const html = await render(CartPage, { cart });

    expect(html).toContain('action="/api/cart/update"');
    expect(html).toContain('action="/api/cart/remove"');
    expect(html).toContain(`name="lineId" value="${cart.lines[0]!.id}"`);
    expect(html).toMatch(/name="quantity"[^>]*value="2"/);
    expect(html.match(/method="post"/g)).toHaveLength(2);
    expect(html).not.toContain('<script');
  });

  it('shows the subtotal, the free UK shipping line and a Checkout link to Shopify', async () => {
    const cart = await sampleCart();
    const html = await render(CartPage, { cart });

    expect(html).toContain('£29.98');
    expect(html).toContain('Free shipping (UK)');
    expect(html).toContain(`href="${cart.checkoutUrl}"`);
    expect(html).toContain('Checkout');
  });

  it('follows apiBase, productPath and shippingNote', async () => {
    const cart = await sampleCart();
    const html = await render(CartPage, {
      cart,
      apiBase: '/shop/cart/',
      productPath: '/shop/{handle}/',
      shippingNote: 'Free UK delivery',
    });

    expect(html).toContain('action="/shop/cart/update"');
    expect(html).toContain('href="/shop/fake-product/"');
    expect(html).toContain('Free UK delivery');
  });

  it('shows the empty state for no cart and for a cart with no lines', async () => {
    expect(await render(CartPage, { cart: null })).toContain('Your shopping cart is empty');
    const empty = { ...(await sampleCart()), lines: [], lineCount: 0 };
    expect(await render(CartPage, { cart: empty })).toContain('Your shopping cart is empty');
  });

  it('explains a failed load or action in an alert, and the load failure wins', async () => {
    const both = await render(CartPage, { cart: null, loadFailed: true, actionFailed: true });
    expect(both).toContain('role="alert"');
    expect(both).toContain("couldn&#39;t reach the store");
    expect(both).not.toContain('Your shopping cart is empty');

    const action = await render(CartPage, { cart: await sampleCart(), actionFailed: true });
    expect(action).toContain('role="alert"');
    expect(action).toContain('Checkout');
  });
});

describe('CartCount', () => {
  it('links to the cart page with the count left to the browser', async () => {
    const html = await render(CartCount);

    expect(html).toContain('href="/cart/"');
    expect(html).toContain('<cart-count src="/api/cart/summary"');
    expect(html).toMatch(/data-count[^>]*hidden/);
    expect(html).not.toContain('data-cart-drawer-open');
  });

  it('opens the drawer on request', async () => {
    expect(await render(CartCount, { openDrawer: true })).toContain('data-cart-drawer-open');
  });
});

describe('CartDrawer', () => {
  it('is a hidden dialog the element fills, pointed at the cart routes', async () => {
    const html = await render(CartDrawer);

    expect(html).toContain('<cart-drawer');
    expect(html).toContain('add-url="/api/cart/add"');
    expect(html).toContain('view-url="/api/cart/view"');
    expect(html).toContain('<dialog');
    expect(html).toContain('aria-labelledby="cart-drawer-title"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Free shipping (UK)');
    expect(html).toContain('<template data-line>');
  });
});

import { describe, it, expect } from 'vitest';
import { formatMoney, formatPriceRange } from './money';

describe('formatMoney', () => {
  it('renders GBP with two decimals', () => {
    expect(formatMoney('14.99', 'GBP')).toBe('£14.99');
  });

  it('keeps two decimals on whole pounds', () => {
    expect(formatMoney('12.00', 'GBP')).toBe('£12.00');
    expect(formatMoney('12', 'GBP')).toBe('£12.00');
  });

  it('pads a single decimal place', () => {
    expect(formatMoney('12.5', 'GBP')).toBe('£12.50');
  });

  it('groups thousands', () => {
    expect(formatMoney('1250.00', 'GBP')).toBe('£1,250.00');
  });

  it('uses the currency Shopify supplies, not a default', () => {
    expect(formatMoney('9.50', 'USD')).toBe('US$9.50');
  });
});

describe('formatPriceRange', () => {
  const gbp = (amount: string) => ({ amount, currencyCode: 'GBP' });

  it('joins min and max with an en dash when they differ', () => {
    expect(formatPriceRange(gbp('12.50'), gbp('18.00'))).toBe('£12.50–£18.00');
  });

  it('shows a single price when min and max are equal', () => {
    expect(formatPriceRange(gbp('14.99'), gbp('14.99'))).toBe('£14.99');
  });

  it('treats 12 and 12.00 as the same price', () => {
    expect(formatPriceRange(gbp('12'), gbp('12.00'))).toBe('£12.00');
  });
});

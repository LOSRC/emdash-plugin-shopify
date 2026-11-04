import type { Money } from './types';

/**
 * Money formatting. Amounts are decimal strings from Shopify in the currency Shopify supplies (never
 * a default). Rendered en-GB with the currency's own fraction digits, so GBP is always two decimals:
 * `£14.99`, `£12.00`.
 */
export function formatMoney(amount: string, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(Number(amount));
}

/** A price range: a single price when min equals max, else `min–max` (en dash). */
export function formatPriceRange(min: Money, max: Money): string {
  const low = formatMoney(min.amount, min.currencyCode);
  const high = formatMoney(max.amount, max.currencyCode);
  return low === high ? low : `${low}–${high}`;
}

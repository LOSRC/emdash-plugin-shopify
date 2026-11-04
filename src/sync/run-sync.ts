import { SHOP_DATA_CACHE_TAG } from '../core/cache-tag';
import type { ShopifyProductsClient } from '../core/client';
import { productIdOf } from '../core/shop-data';
import { purgeFailure } from '../core/purge';
import type { PurgeTags } from '../core/purge';
import type { ContentStore, FlaggedEntry, LinkedEntry, RefreshProductOptions, SyncReport } from './types';

export interface SyncDeps {
  /** Only the channel listing is used; the real client and the in-memory fake both fit. */
  shopify: Pick<ShopifyProductsClient, 'listChannelProducts'>;
  store: ContentStore;
  /** Invalidates cache tags. Its failure is a warning in the report, never a crash. */
  purge: PurgeTags;
  /** Adds the product slugs to the product grid's picker. Optional; its failure is a warning. */
  refreshProductOptions?: RefreshProductOptions;
}

/** A sync run was refused because Shopify's answer cannot be trusted. Nothing was written or purged. */
export class SyncRefusedError extends Error {
  override readonly name = 'SyncRefusedError';
}

/** The product id an entry's stored value stands for: numeric, or a product GID; anything else stays as written (trimmed). */
function linkedProductId(entry: LinkedEntry): string {
  const stored = entry.shopifyId.trim();
  return productIdOf(stored) ?? stored;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One sync run. It links Shopify's channel products to content entries by Shopify product ID:
 * it makes a draft for each product with no entry, reports (never writes) entries whose product
 * the channel no longer returns, and leaves every other entry alone. It never updates or deletes.
 *
 * Just before each draft it lists the store again, so an entry that appeared since the run started
 * (another run, an editor) is not duplicated. That narrows the window rather than closing it: the
 * plugin's run lock is what keeps two runs apart.
 *
 * Shopify and the store are read before anything is written: if either rejects, or Shopify returns
 * an empty channel while entries are linked (a bad token looks like that), the run rejects before any
 * write or purge. Past that point, problems are warnings in the report and the run carries on.
 */
export async function runSync(deps: SyncDeps): Promise<SyncReport> {
  const { shopify, store, purge, refreshProductOptions } = deps;

  const channel = await shopify.listChannelProducts();
  const linked = await store.listLinked();
  if (channel.length === 0 && linked.length > 0) {
    throw new SyncRefusedError(
      'Shopify returned no products for the sales channel, but the site has product entries. Nothing was changed. Check the Storefront token and that the products are published to the channel.',
    );
  }

  const report: SyncReport = { created: [], flagged: [], unchanged: 0, warnings: [] };
  const channelIds = new Set(channel.map((product) => product.id));

  const entriesById = new Map<string, LinkedEntry[]>();
  for (const entry of linked) {
    // A stored id is numeric or a product GID; anything else stays as written (trimmed) and so is flagged.
    const id = linkedProductId(entry);
    entriesById.set(id, [...(entriesById.get(id) ?? []), entry]);
  }

  const flagged: FlaggedEntry[] = [];
  for (const [id, entries] of entriesById) {
    if (!channelIds.has(id)) {
      for (const { entryId, slug, title } of entries) flagged.push({ entryId, shopifyId: id, slug, title });
      continue;
    }
    report.unchanged += entries.length;
    if (entries.length > 1) {
      const names = entries.map((entry) => `"${entry.slug ?? entry.entryId}"`).join(', ');
      report.warnings.push(`More than one entry carries Shopify product ${id}: ${names}.`);
    }
  }
  report.flagged = flagged;

  for (const product of channel) {
    if (entriesById.has(product.id)) continue;
    try {
      // Look again just before writing: an entry may have appeared since the listing above (a second
      // run, an editor). The run lock in the plugin is what stops two runs; this is the backstop. It
      // costs one more listing per draft made, and nothing when there is nothing to make.
      const appeared = (await store.listLinked()).find((entry) => linkedProductId(entry) === product.id);
      if (appeared) {
        report.unchanged += 1;
        report.warnings.push(
          `An entry for Shopify product ${product.id} ("${product.handle}") appeared while the sync was running, so no draft was made. Was another sync running?`,
        );
        continue;
      }
      const draft = await store.createDraft({ shopifyId: product.id, handle: product.handle, title: product.title });
      report.created.push({
        entryId: draft.entryId,
        shopifyId: product.id,
        handle: product.handle,
        title: product.title,
        slug: draft.slug,
      });
      if (draft.slug !== product.handle) {
        report.warnings.push(
          `The draft for "${product.handle}" got the slug "${draft.slug ?? ''}", not the handle. Product links on the site use the slug.`,
        );
      }
    } catch (error) {
      report.warnings.push(`Could not make a draft for "${product.handle}": ${message(error)}`);
    }
  }

  if (refreshProductOptions) {
    const slugs = [...linked, ...report.created].flatMap((entry) => (entry.slug ? [entry.slug] : []));
    try {
      await refreshProductOptions([...new Set(slugs)]);
    } catch (error) {
      report.warnings.push(
        `The product picker could not be refreshed (${message(error)}). New products are not pickable until the next sync.`,
      );
    }
  }

  try {
    const failure = purgeFailure(await purge([SHOP_DATA_CACHE_TAG]));
    if (failure) throw new Error(failure);
  } catch (error) {
    report.warnings.push(
      `The shop-data cache could not be purged (${message(error)}). Pages show the old data until their cache expires.`,
    );
  }

  return report;
}

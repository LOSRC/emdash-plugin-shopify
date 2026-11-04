/**
 * The sync's seams. `runSync` depends on these and on the products capability of the Shopify
 * client, nothing else: no `emdash`, no `astro`, no Workers runtime.
 */

/** A content entry that carries a Shopify product ID. */
export interface LinkedEntry {
  entryId: string;
  /** The Shopify product ID as stored (numeric, or a `gid://shopify/Product/...`). */
  shopifyId: string;
  /** The entry's slug; `null` until EmDash has derived one. */
  slug: string | null;
  /** The admin label (the Shopify title at the time the draft was made, or an editor's edit). */
  title: string;
}

/** What a draft is made from. */
export interface NewDraft {
  /** Numeric Shopify product ID. */
  shopifyId: string;
  /** The Shopify handle. The store puts it where the slug is derived from. */
  handle: string;
  /** The Shopify title, for the admin label. */
  title: string;
}

/**
 * The narrow content-store seam: list the entries that carry a Shopify product ID, and create a
 * draft. There is deliberately no update and no delete, so a sync run cannot overwrite or remove an
 * editor's work.
 */
export interface ContentStore {
  /** Every entry that carries a Shopify product ID, whatever its status. */
  listLinked(): Promise<LinkedEntry[]>;
  /** Make one draft entry. Resolves with the id and the slug the CMS gave it. */
  createDraft(draft: NewDraft): Promise<{ entryId: string; slug: string | null }>;
}

export type { PurgeTags } from '../core/purge';

/**
 * Adds the products' slugs to the option list of the product grid's block field. `slugs` is every
 * product entry's slug; an implementation only ever adds options.
 */
export type RefreshProductOptions = (slugs: string[]) => Promise<void>;

/** A draft the run made. */
export interface CreatedEntry {
  entryId: string;
  shopifyId: string;
  handle: string;
  title: string;
  slug: string | null;
}

/** An entry whose Shopify product the channel no longer returns (deleted or unpublished). */
export interface FlaggedEntry {
  entryId: string;
  shopifyId: string;
  slug: string | null;
  title: string;
}

/** What a sync run did. */
export interface SyncReport {
  created: CreatedEntry[];
  /** Report-only: nothing is written to these entries. */
  flagged: FlaggedEntry[];
  /** How many linked entries Shopify still returns, and so were left alone. */
  unchanged: number;
  /** Things the editor should know: a slug that is not the handle, a failed purge, and so on. */
  warnings: string[];
}

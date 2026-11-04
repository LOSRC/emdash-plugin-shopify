import type { ContentStore, LinkedEntry } from '../sync/types';

/** Where the product entries live and what their fields are called. Defaults match the site's Products collection. */
export interface ContentFieldNames {
  collection: string;
  /** Text field holding the Shopify product ID. */
  idField: string;
  /**
   * The text field EmDash derives the slug from. A plugin cannot set a slug, so the sync writes the
   * Shopify handle here: it must be a field literally named `title` (or `name`) for the slug to follow it.
   */
  handleField: string;
  /** The text field the collection uses as its admin label (`titleField`); gets the Shopify title. */
  labelField: string;
}

export const DEFAULT_FIELDS: ContentFieldNames = {
  collection: 'products',
  idField: 'shopify_product_id',
  handleField: 'title',
  labelField: 'shopify_title',
};

/** The part of an EmDash `ContentItem` the store reads. */
export interface ContentApiItem {
  id: string;
  slug: string | null;
  data: Record<string, unknown>;
}

/** The part of `ctx.content` the store uses. `create` is absent without the `content:write` capability. */
export interface ContentApi {
  list(
    collection: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<{ items: ContentApiItem[]; cursor?: string; hasMore: boolean }>;
  create?(collection: string, data: Record<string, unknown>): Promise<ContentApiItem>;
}

/** Said when `ctx.content.create` is absent: the plugin lacks the capability. */
export const CONTENT_WRITE_REQUIRED = 'The plugin cannot write content: it needs the content:write capability.';

const PAGE_SIZE = 100; // the most `ctx.content.list` returns
const MAX_PAGES = 1000;

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

/**
 * The {@link ContentStore} over EmDash's `ctx.content`. It lists the whole collection in pages and
 * picks the entries that carry a Shopify id in memory, so it works whether or not the site marked the
 * id field as indexed. A new entry is always a draft: `ctx.content.create` makes drafts.
 */
export function createEmdashContentStore(
  content: ContentApi,
  fields: Partial<ContentFieldNames> = {},
): ContentStore {
  const { collection, idField, handleField, labelField } = { ...DEFAULT_FIELDS, ...fields };

  return {
    async listLinked() {
      const linked: LinkedEntry[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await content.list(collection, cursor ? { limit: PAGE_SIZE, cursor } : { limit: PAGE_SIZE });
        for (const item of result.items) {
          const shopifyId = text(item.data[idField]);
          if (!shopifyId) continue;
          linked.push({
            entryId: item.id,
            shopifyId,
            slug: item.slug,
            title: text(item.data[labelField]) ?? item.slug ?? text(item.data[handleField]) ?? item.id,
          });
        }
        if (!result.hasMore || !result.cursor || result.cursor === cursor) break;
        cursor = result.cursor;
      }
      return linked;
    },

    async createDraft({ shopifyId, handle, title }) {
      if (!content.create) {
        throw new Error(CONTENT_WRITE_REQUIRED);
      }
      const created = await content.create(collection, {
        [handleField]: handle,
        [labelField]: title,
        [idField]: shopifyId,
      });
      return { entryId: created.id, slug: created.slug };
    },
  };
}

import { describe, it, expect } from 'vitest';
import { createEmdashContentStore, DEFAULT_FIELDS, type ContentApi, type ContentApiItem } from './content-store';

function item(id: string, slug: string | null, data: Record<string, unknown>): ContentApiItem {
  return { id, slug, data };
}

/** A stub of `ctx.content`: pages of a fixed size over a fixed list, and a recorder for creates. */
function stubContent(items: ContentApiItem[], pageSize = 100) {
  const listCalls: { collection: string; options: { limit?: number; cursor?: string } | undefined }[] = [];
  const created: { collection: string; data: Record<string, unknown> }[] = [];
  const content: ContentApi = {
    async list(collection, options) {
      listCalls.push({ collection, options });
      const start = options?.cursor ? Number(options.cursor) : 0;
      const page = items.slice(start, start + Math.min(pageSize, options?.limit ?? 50));
      const next = start + page.length;
      return next < items.length
        ? { items: page, cursor: String(next), hasMore: true }
        : { items: page, hasMore: false };
    },
    async create(collection, data) {
      created.push({ collection, data });
      return item(`new-${created.length}`, typeof data.title === 'string' ? data.title : null, data);
    },
  };
  return { content, listCalls, created };
}

describe('createEmdashContentStore: listLinked', () => {
  it('lists the products collection in pages of 100 and keeps the entries that carry a Shopify id', async () => {
    const all = Array.from({ length: 230 }, (_, n) =>
      item(`e${n}`, `p-${n}`, { shopify_product_id: String(1000 + n), shopify_title: `Product ${n}`, title: `p-${n}` }),
    );
    const editorMade = item('x', 'editor-made', { title: 'editor-made', shopify_title: 'By hand' });
    const { content, listCalls } = stubContent([...all, editorMade], 100);

    const linked = await createEmdashContentStore(content).listLinked();

    expect(linked).toHaveLength(230);
    expect(linked[0]).toEqual({ entryId: 'e0', shopifyId: '1000', slug: 'p-0', title: 'Product 0' });
    expect(listCalls.map((call) => [call.collection, call.options])).toEqual([
      ['products', { limit: 100 }],
      ['products', { limit: 100, cursor: '100' }],
      ['products', { limit: 100, cursor: '200' }],
    ]);
  });

  it('does not rely on indexed field filters', async () => {
    const { content, listCalls } = stubContent([]);
    await createEmdashContentStore(content).listLinked();
    expect(JSON.stringify(listCalls)).not.toContain('fieldFilters');
  });

  it('reads a numeric Shopify id as text and falls back to the slug when there is no admin label', async () => {
    const { content } = stubContent([item('e1', 'blue-mug', { shopify_product_id: 101 })]);
    expect(await createEmdashContentStore(content).listLinked()).toEqual([
      { entryId: 'e1', shopifyId: '101', slug: 'blue-mug', title: 'blue-mug' },
    ]);
  });

  it('stops paging if the cursor does not advance, instead of looping forever', async () => {
    let calls = 0;
    const content: ContentApi = {
      async list() {
        calls += 1;
        return { items: [], cursor: 'same', hasMore: true };
      },
    };
    await createEmdashContentStore(content).listLinked();
    expect(calls).toBe(2);
  });

  it('uses the configured collection and field names', async () => {
    const { content, listCalls } = stubContent([
      item('e1', 'mug', { sid: 'gid://shopify/Product/7', label: 'Mug' }),
    ]);
    const store = createEmdashContentStore(content, { collection: 'goods', idField: 'sid', labelField: 'label' });
    expect(await store.listLinked()).toEqual([
      { entryId: 'e1', shopifyId: 'gid://shopify/Product/7', slug: 'mug', title: 'Mug' },
    ]);
    expect(listCalls[0]?.collection).toBe('goods');
  });
});

describe('createEmdashContentStore: createDraft', () => {
  it('writes the handle to the slug source field, the title to the admin label and the id, and nothing else', async () => {
    const { content, created } = stubContent([]);
    const store = createEmdashContentStore(content);

    const result = await store.createDraft({ shopifyId: '101', handle: 'blue-mug', title: 'Blue Mug' });

    expect(created).toEqual([
      {
        collection: 'products',
        data: { title: 'blue-mug', shopify_title: 'Blue Mug', shopify_product_id: '101' },
      },
    ]);
    expect(result).toEqual({ entryId: 'new-1', slug: 'blue-mug' });
  });

  it('is a plain error, not a TypeError, when the plugin has no write access', async () => {
    const { content } = stubContent([]);
    const readOnly: ContentApi = { list: content.list };
    await expect(
      createEmdashContentStore(readOnly).createDraft({ shopifyId: '1', handle: 'a', title: 'A' }),
    ).rejects.toThrow(/content:write/);
  });

  it('defaults match the Products collection', () => {
    expect(DEFAULT_FIELDS).toEqual({
      collection: 'products',
      idField: 'shopify_product_id',
      handleField: 'title',
      labelField: 'shopify_title',
    });
  });
});

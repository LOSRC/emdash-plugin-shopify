import { describe, it, expect } from 'vitest';
import { createProductOptionsRefresher, type BlockTypeLike, type BlockTypeRegistryLike } from './product-options';

function blockType(options: string[], type = 'multiSelect'): BlockTypeLike {
  return {
    slug: 'product_grid',
    currentVersion: 2,
    versions: [
      { version: 1, fingerprint: 'old', fields: [] },
      {
        version: 2,
        fingerprint: 'fp-2',
        fields: [
          { slug: 'heading', label: 'Heading', type: 'string' },
          { slug: 'products', label: 'Products', type: type as 'multiSelect', required: true, validation: { options } },
        ],
      },
    ],
  };
}

function fakeRegistry(initial: BlockTypeLike | null) {
  const updates: { slug: string; input: Parameters<BlockTypeRegistryLike['updateBlockType']>[1] }[] = [];
  const registry: BlockTypeRegistryLike = {
    async getBlockType() {
      return initial;
    },
    async updateBlockType(slug, input) {
      updates.push({ slug, input });
    },
    async listAffectedCollections() {
      return ['pages'];
    },
  };
  return { registry, updates };
}

describe('createProductOptionsRefresher', () => {
  it('adds only the missing slugs, keeps every existing option, and compares against the fingerprint it read', async () => {
    const { registry, updates } = fakeRegistry(blockType(['blue-mug', 'gone-mug']));
    const invalidated: string[] = [];
    const refresh = createProductOptionsRefresher({
      registry: async () => registry,
      blockType: 'product_grid',
      field: 'products',
      invalidateCollection: (collection) => void invalidated.push(collection),
    });

    await refresh(['blue-mug', 'red-mug', 'green-mug']);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.slug).toBe('product_grid');
    expect(updates[0]?.input.expectedFingerprint).toBe('fp-2');
    expect(updates[0]?.input.breaking).toBeUndefined();
    expect(updates[0]?.input.fields).toEqual([
      { slug: 'heading', label: 'Heading', type: 'string' },
      {
        slug: 'products',
        label: 'Products',
        type: 'multiSelect',
        required: true,
        validation: { options: ['blue-mug', 'gone-mug', 'red-mug', 'green-mug'] },
      },
    ]);
    expect(invalidated).toEqual(['pages']);
  });

  it('writes nothing when every slug is already an option', async () => {
    const { registry, updates } = fakeRegistry(blockType(['blue-mug', 'red-mug']));
    const refresh = createProductOptionsRefresher({ registry: async () => registry, blockType: 'product_grid', field: 'products' });
    await refresh(['red-mug']);
    expect(updates).toEqual([]);
  });

  it('fails readably when the block type does not exist', async () => {
    const { registry } = fakeRegistry(null);
    const refresh = createProductOptionsRefresher({ registry: async () => registry, blockType: 'product_grid', field: 'products' });
    await expect(refresh(['a'])).rejects.toThrow('Block type "product_grid" not found');
  });

  it('fails readably when the field is missing or not a select', async () => {
    const { registry } = fakeRegistry(blockType([]));
    const missing = createProductOptionsRefresher({ registry: async () => registry, blockType: 'product_grid', field: 'nope' });
    await expect(missing(['a'])).rejects.toThrow('Block type "product_grid" has no select or multiSelect field "nope"');

    const heading = createProductOptionsRefresher({ registry: async () => registry, blockType: 'product_grid', field: 'heading' });
    await expect(heading(['a'])).rejects.toThrow('has no select or multiSelect field "heading"');
  });

  it('extends the select sub-field of a repeater, keeping its other sub-fields and validation', async () => {
    const grid: BlockTypeLike = {
      slug: 'product_grid',
      currentVersion: 2,
      versions: [
        { version: 1, fingerprint: 'fp-1', fields: [] },
        {
          version: 2,
          fingerprint: 'fp-2',
          fields: [
            { slug: 'title', label: 'Title', type: 'string' },
            {
              slug: 'products',
              label: 'Products',
              type: 'repeater',
              validation: {
                maxItems: 100,
                subFields: [
                  { slug: 'product', label: 'Product', type: 'select', required: true, options: ['blue-mug'] },
                  { slug: 'note', label: 'Note', type: 'string' },
                ],
              },
            },
          ],
        },
      ],
    };
    const { registry, updates } = fakeRegistry(grid);
    const refresh = createProductOptionsRefresher({ registry: async () => registry, blockType: 'product_grid', field: 'products' });

    await refresh(['blue-mug', 'red-mug']);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.input.expectedFingerprint).toBe('fp-2');
    expect(updates[0]?.input.breaking).toBeUndefined();
    expect(updates[0]?.input.fields).toEqual([
      { slug: 'title', label: 'Title', type: 'string' },
      {
        slug: 'products',
        label: 'Products',
        type: 'repeater',
        validation: {
          maxItems: 100,
          subFields: [
            { slug: 'product', label: 'Product', type: 'select', required: true, options: ['blue-mug', 'red-mug'] },
            { slug: 'note', label: 'Note', type: 'string' },
          ],
        },
      },
    ]);
  });

  it('reads the active version, so the same config follows a field moved from multiSelect to repeater', async () => {
    const grid: BlockTypeLike = {
      slug: 'product_grid',
      currentVersion: 1,
      versions: [
        {
          version: 1,
          fingerprint: 'fp-1',
          fields: [{ slug: 'products', label: 'Products', type: 'multiSelect', validation: { options: ['a'] } }],
        },
        {
          version: 2,
          fingerprint: 'fp-2',
          fields: [
            {
              slug: 'products',
              label: 'Products',
              type: 'repeater',
              validation: { subFields: [{ slug: 'product', label: 'Product', type: 'select', options: ['a'] }] },
            },
          ],
        },
      ],
    };
    const { registry, updates } = fakeRegistry(grid);
    const refresh = createProductOptionsRefresher({ registry: async () => registry, blockType: 'product_grid', field: 'products' });

    await refresh(['b']);
    expect(updates[0]?.input.expectedFingerprint).toBe('fp-1');
    expect(updates[0]?.input.fields[0]?.validation?.options).toEqual(['a', 'b']);

    grid.currentVersion = 2;
    await refresh(['b']);
    expect(updates[1]?.input.expectedFingerprint).toBe('fp-2');
    expect(updates[1]?.input.fields[0]?.validation?.subFields?.[0]?.options).toEqual(['a', 'b']);
  });

  it('refuses a repeater without exactly one select sub-field', async () => {
    const repeater = (subFields: { slug: string; label: string; type: string; options?: string[] }[]): BlockTypeLike => ({
      slug: 'product_grid',
      currentVersion: 1,
      versions: [
        { version: 1, fingerprint: 'fp-1', fields: [{ slug: 'products', label: 'Products', type: 'repeater', validation: { subFields } }] },
      ],
    });
    const none = fakeRegistry(repeater([{ slug: 'note', label: 'Note', type: 'string' }]));
    const two = fakeRegistry(
      repeater([
        { slug: 'product', label: 'Product', type: 'select', options: ['a'] },
        { slug: 'other', label: 'Other', type: 'select', options: ['a'] },
      ]),
    );
    for (const { registry, updates } of [none, two]) {
      const refresh = createProductOptionsRefresher({ registry: async () => registry, blockType: 'product_grid', field: 'products' });
      await expect(refresh(['b'])).rejects.toThrow('nor a repeater "products" with one select sub-field');
      expect(updates).toEqual([]);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { createProductOptionsRefresher, type BlockTypeLike, type BlockTypeRegistryLike } from './product-options';

function blockType(options: string[], type = 'multiSelect'): BlockTypeLike {
  return {
    slug: 'product-grid',
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
      blockType: 'product-grid',
      field: 'products',
      invalidateCollection: (collection) => void invalidated.push(collection),
    });

    await refresh(['blue-mug', 'red-mug', 'green-mug']);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.slug).toBe('product-grid');
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
    const refresh = createProductOptionsRefresher({ registry: async () => registry, blockType: 'product-grid', field: 'products' });
    await refresh(['red-mug']);
    expect(updates).toEqual([]);
  });

  it('fails readably when the block type does not exist', async () => {
    const { registry } = fakeRegistry(null);
    const refresh = createProductOptionsRefresher({ registry: async () => registry, blockType: 'product-grid', field: 'products' });
    await expect(refresh(['a'])).rejects.toThrow('Block type "product-grid" not found');
  });

  it('fails readably when the field is missing or not a select', async () => {
    const { registry } = fakeRegistry(blockType([]));
    const missing = createProductOptionsRefresher({ registry: async () => registry, blockType: 'product-grid', field: 'nope' });
    await expect(missing(['a'])).rejects.toThrow('Block type "product-grid" has no select or multiSelect field "nope"');

    const heading = createProductOptionsRefresher({ registry: async () => registry, blockType: 'product-grid', field: 'heading' });
    await expect(heading(['a'])).rejects.toThrow('has no select or multiSelect field "heading"');
  });
});

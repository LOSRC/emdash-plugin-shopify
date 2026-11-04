/**
 * Keeps the product grid block's picker in step with the product entries: each sync run adds the
 * products' slugs to the option list of the block type's `multiSelect` field. It only adds. The
 * options are what the editor can pick, so removing one would break a page that already uses it; and
 * adding an option is a compatible change, so no new block type version is needed.
 *
 * The plugin context has no block-type API (`ctx.schema` reads collections only), so the registry
 * comes from the host in-process; see {@link defaultBlockTypeRegistry}.
 */

/** A block type field, as the registry returns and accepts it. */
export interface BlockFieldLike {
  slug: string;
  label: string;
  type: string;
  required?: boolean;
  defaultValue?: unknown;
  validation?: { options?: string[]; [key: string]: unknown };
  options?: unknown;
}

export interface BlockTypeLike {
  slug: string;
  currentVersion: number;
  versions: { version: number; fingerprint: string; fields: BlockFieldLike[] }[];
}

/** The part of EmDash's `BlockTypeRegistry` this uses. */
export interface BlockTypeRegistryLike {
  getBlockType(slug: string): Promise<BlockTypeLike | null>;
  updateBlockType(
    slug: string,
    input: { expectedFingerprint: string; fields: BlockFieldLike[]; breaking?: boolean },
  ): Promise<unknown>;
  listAffectedCollections?(slug: string): Promise<string[]>;
}

export interface ProductOptionsConfig {
  /** Block type slug, for example `product-grid`. */
  blockType: string;
  /** The `select` or `multiSelect` field of that block type that lists the products. */
  field: string;
}

export function createProductOptionsRefresher(
  config: ProductOptionsConfig & {
    registry: () => Promise<BlockTypeRegistryLike>;
    /** Drops EmDash's cached reads of a collection that uses the block type. */
    invalidateCollection?: (collection: string) => void;
  },
): (slugs: string[]) => Promise<void> {
  const { blockType, field, registry: getRegistry, invalidateCollection } = config;

  return async (slugs) => {
    const registry = await getRegistry();
    const type = await registry.getBlockType(blockType);
    if (!type) throw new Error(`Block type "${blockType}" not found`);

    const active = type.versions.find((version) => version.version === type.currentVersion);
    const target = active?.fields.find((candidate) => candidate.slug === field);
    const known = target?.validation?.options;
    if (!active || !target || !known || (target.type !== 'select' && target.type !== 'multiSelect')) {
      throw new Error(`Block type "${blockType}" has no select or multiSelect field "${field}"`);
    }

    const added = [...new Set(slugs)].filter((slug) => !known.includes(slug));
    if (added.length === 0) return;

    // The whole field list goes back with only this field's options extended. The fingerprint makes
    // the write a compare-and-swap, so a change made meanwhile is refused rather than overwritten.
    const fields = active.fields.map((candidate) =>
      candidate === target
        ? { ...candidate, validation: { ...candidate.validation, options: [...known, ...added] } }
        : candidate,
    );
    await registry.updateBlockType(blockType, { expectedFingerprint: active.fingerprint, fields });

    if (invalidateCollection && registry.listAffectedCollections) {
      for (const collection of await registry.listAffectedCollections(blockType)) invalidateCollection(collection);
    }
  };
}

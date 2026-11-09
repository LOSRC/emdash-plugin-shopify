/**
 * Keeps the product grid block's picker in step with the product entries: each sync run adds the
 * products' slugs to the option list of the block type's field. The field is a `select` or
 * `multiSelect`, or a `repeater` with one `select` sub-field (one product per row, so an editor can
 * drag the rows into order). It only adds. The options are what the editor can pick, so removing
 * one would break a page that already uses it; and adding an option is a compatible change, so no
 * new block type version is needed, for a sub-field too.
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
  validation?: { options?: string[]; subFields?: SubFieldLike[]; [key: string]: unknown };
  options?: unknown;
}

/** A repeater's sub-field: a `select` one carries its choices in `options`, not `validation`. */
export interface SubFieldLike {
  slug: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
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
  /** Block type slug, for example `product_grid`. */
  blockType: string;
  /**
   * The field of that block type that lists the products: a `select` or `multiSelect`, or a
   * `repeater` whose one `select` sub-field holds a product per row. Which it is is read from the
   * active version on each run, so a site can move the field to a repeater in a new block type
   * version without changing this.
   */
  field: string;
}

/** Where the slugs live in the active field, and how to write the field back with more of them. */
interface OptionList {
  known: string[];
  withOptions(options: string[]): BlockFieldLike;
}

function optionList(target: BlockFieldLike | undefined): OptionList | null {
  if (!target) return null;
  if (target.type === 'select' || target.type === 'multiSelect') {
    const known = target.validation?.options;
    if (!Array.isArray(known)) return null;
    return { known, withOptions: (options) => ({ ...target, validation: { ...target.validation, options } }) };
  }
  if (target.type === 'repeater') {
    const subFields = target.validation?.subFields ?? [];
    const selects = subFields.filter((subField) => subField.type === 'select');
    const select = selects.length === 1 ? selects[0] : undefined;
    if (!select || !Array.isArray(select.options)) return null;
    const known = select.options;
    return {
      known,
      withOptions: (options) => ({
        ...target,
        validation: {
          ...target.validation,
          subFields: subFields.map((subField) => (subField === select ? { ...subField, options } : subField)),
        },
      }),
    };
  }
  return null;
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
    const list = optionList(target);
    if (!active || !target || !list) {
      throw new Error(
        `Block type "${blockType}" has no select or multiSelect field "${field}", nor a repeater "${field}" with one select sub-field`,
      );
    }
    const { known } = list;

    const added = [...new Set(slugs)].filter((slug) => !known.includes(slug));
    if (added.length === 0) return;

    // The whole field list goes back with only this field's options extended. The fingerprint makes
    // the write a compare-and-swap, so a change made meanwhile is refused rather than overwritten.
    const fields = active.fields.map((candidate) =>
      candidate === target ? list.withOptions([...known, ...added]) : candidate,
    );
    await registry.updateBlockType(blockType, { expectedFingerprint: active.fingerprint, fields });

    if (invalidateCollection && registry.listAffectedCollections) {
      for (const collection of await registry.listAffectedCollections(blockType)) invalidateCollection(collection);
    }
  };
}

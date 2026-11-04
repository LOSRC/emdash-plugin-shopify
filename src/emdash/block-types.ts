import type { RefreshProductOptions } from '../sync/types';
import { createProductOptionsRefresher, type BlockTypeRegistryLike, type ProductOptionsConfig } from './product-options';

/**
 * The product grid's picker refresher, wired to the running EmDash. The plugin context has no
 * block-type API (`ctx.schema` is read-only and covers collections only), so this reaches EmDash's
 * block type registry in-process, through `getDb` from `emdash/runtime`. That is a schema write made
 * from a route that needs only `content:create`, so it is opt-in (`productOptions` in the plugin
 * options) and add-only. Both imports are dynamic: nothing loads until a sync runs.
 */
export function emdashProductOptionsRefresher(config: ProductOptionsConfig): RefreshProductOptions {
  let invalidate: ((collection: string) => void) | undefined;
  return createProductOptionsRefresher({
    ...config,
    registry: async () => {
      const [{ getDb }, emdash] = await Promise.all([import('emdash/runtime'), import('emdash')]);
      invalidate = emdash.invalidateCollectionCache;
      // The real registry takes the same shapes; its field type is narrower than the loose one used here.
      return new emdash.BlockTypeRegistry(await getDb()) as unknown as BlockTypeRegistryLike;
    },
    invalidateCollection: (collection) => invalidate?.(collection),
  });
}

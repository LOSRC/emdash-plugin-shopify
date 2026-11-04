import { SHOP_DATA_CACHE_TAG } from './cache-tag';
import { privateJson } from './negotiation';

/** Invalidates cache tags. Resolves once the purge is requested; rejects when it failed. */
export type PurgeTags = (tags: string[]) => Promise<void>;

/**
 * The site's purge endpoint, as a function. The site mounts a small route that is editor-only (it
 * checks the caller itself) and calls this with its own cache purge, for example `cache.purge` from
 * `cloudflare:workers`:
 *
 * ```ts
 * export const POST = async (context) => {
 *   if (!isEditor(context)) return new Response(null, { status: 403 });
 *   return handlePurge((tags) => cache.purge({ tags }));
 * };
 * ```
 *
 * It purges `SHOP_DATA_CACHE_TAG` and nothing else. A failure is a 502 with a fixed message, never
 * the error text.
 */
export async function handlePurge(purge: PurgeTags): Promise<Response> {
  try {
    await purge([SHOP_DATA_CACHE_TAG]);
  } catch {
    return privateJson({ purged: false, error: 'The shop-data cache could not be purged.' }, 502);
  }
  return privateJson({ purged: true, tags: [SHOP_DATA_CACHE_TAG] });
}

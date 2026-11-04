import { SHOP_DATA_CACHE_TAG } from './cache-tag';
import { privateJson } from './negotiation';

/**
 * Invalidates cache tags. Resolves once the purge is requested; rejects when it failed. It may resolve
 * a `cache.purge()` result (`{ success, errors }`), so `(tags) => cache.purge({ tags })` fits as it is:
 * `success: false` counts as a failure (see {@link purgeFailure}).
 */
export type PurgeTags = (tags: string[]) => Promise<unknown>;

/**
 * Why a purge failed, from what it resolved: `cache.purge()` answers `{ success: false, errors }`
 * instead of throwing when the purge is refused. `null` for anything else, including no result at all.
 */
export function purgeFailure(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || (result as { success?: unknown }).success !== false) return null;
  const errors = (result as { errors?: unknown }).errors;
  const reasons = Array.isArray(errors)
    ? errors.flatMap((error) => (typeof (error as { message?: unknown })?.message === 'string' ? [(error as { message: string }).message] : []))
    : [];
  return reasons.length > 0 ? reasons.join('; ') : 'the cache reported that the purge failed';
}

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
    if (purgeFailure(await purge([SHOP_DATA_CACHE_TAG]))) throw new Error('purge failed');
  } catch {
    return privateJson({ purged: false, error: 'The shop-data cache could not be purged.' }, 502);
  }
  return privateJson({ purged: true, tags: [SHOP_DATA_CACHE_TAG] });
}

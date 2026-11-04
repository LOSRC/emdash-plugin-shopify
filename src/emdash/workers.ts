import type { PurgeTags } from '../core/purge';

/**
 * The two things the plugin takes from the Workers runtime. Each imports `cloudflare:workers` when
 * called, never at load: the package root is also imported by Node when `astro.config` loads, where
 * that module does not exist.
 */

/** The Worker's environment: where the Storefront token lives. Never serialised, never in plugin options. */
export async function readWorkerEnv(): Promise<Record<string, unknown>> {
  const { env } = await import('cloudflare:workers');
  return env;
}

/**
 * Purge cache tags in the Worker's own cache, as Astro's Cloudflare cache provider does. The plugin
 * route runs in the same entrypoint that serves the cached pages, so the purge reaches them. It
 * rejects under `wrangler dev --local` (no Workers cache there); `runSync` reports that as a warning.
 */
export const purgeWorkerCache: PurgeTags = async (tags) => {
  const { cache } = await import('cloudflare:workers');
  await cache.purge({ tags });
};

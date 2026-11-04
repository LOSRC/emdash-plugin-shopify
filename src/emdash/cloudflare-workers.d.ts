// The slice of `cloudflare:workers` the plugin uses. The Workers runtime provides the module; this
// only lets the package typecheck without the Workers types, which would clash with the site's own.
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>;
  export const cache: { purge(options: { tags?: string[] }): Promise<unknown> };
}

import { fileURLToPath } from 'node:url';
import { getViteConfig } from 'astro/config';

// `getViteConfig` lets the tests import `.astro` components and render them with Astro's container.
// The components import the core by package name, as they do in a site; point that at the source.
export default getViteConfig({
  resolve: {
    alias: {
      '@losrc/emdash-plugin-shopify/core': fileURLToPath(new URL('./src/core/index.ts', import.meta.url)),
    },
  },
  test: { include: ['src/**/*.test.ts'] },
} as Parameters<typeof getViteConfig>[0]);

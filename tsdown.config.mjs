// Plain JavaScript on purpose: `prepare` runs this file when the package is installed from git, and
// pnpm does that inside its store, which can sit under a node_modules path (for example
// pnpm/action-setup's). Node refuses to strip types from TypeScript there, so a tsdown.config.ts
// fails with "Stripping types is currently unsupported for files under node_modules".
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/index': 'src/core/index.ts',
    'core/testing': 'src/core/testing.ts',
    'elements/cart-drawer': 'src/elements/cart-drawer.ts',
    'elements/cart-count': 'src/elements/cart-count.ts',
  },
  format: 'esm',
  platform: 'neutral',
  dts: true,
  clean: true,
  // Host-owned: the site provides these, and /core never imports them.
  deps: { neverBundle: ['emdash', 'astro', 'cloudflare:workers'] },
});

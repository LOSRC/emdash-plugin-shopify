import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/index': 'src/core/index.ts',
    'core/testing': 'src/core/testing.ts',
  },
  format: 'esm',
  platform: 'neutral',
  dts: true,
  clean: true,
  // Host-owned: the site provides these, and /core never imports them.
  deps: { neverBundle: ['emdash', 'astro', 'cloudflare:workers'] },
});

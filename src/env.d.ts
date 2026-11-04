// Lets the component tests import `.astro` files under plain `tsc`; Astro's own checker (`astro check`)
// is what understands their contents.
declare module '*.astro' {
  import type { AstroComponentFactory } from 'astro/runtime/server/index.js';
  const component: AstroComponentFactory;
  export default component;
}

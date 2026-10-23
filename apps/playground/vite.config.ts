import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  // Relative asset URLs, so the build works under any GitHub Pages path.
  base: './',
  resolve: {
    alias: {
      // Use the library source directly, so the playground needs no prior `vp pack`.
      '@mvd/memrel': fileURLToPath(new URL('../../packages/memrel/src/index.ts', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
  },
});

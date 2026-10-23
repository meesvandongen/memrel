import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    tsconfig: 'tsconfig.build.json',
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    dts: true,
    sourcemap: true,
    publint: true,
  },
  test: {
    include: ['test/**/*.test.ts'],
    typecheck: {
      enabled: true,
      include: ['test/**/*.test-d.ts'],
    },
    coverage: {
      include: ['src/**'],
    },
  },
});

import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    ignorePatterns: ['**/dist/**', '**/coverage/**', '**/*.md'],
    singleQuote: true,
    printWidth: 100,
    sortPackageJson: true,
  },
  lint: {
    ignorePatterns: ['**/dist/**', '**/coverage/**'],
    plugins: ['typescript', 'oxc', 'unicorn', 'import'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        files: ['**/test/**', '**/bench/**'],
        plugins: ['vitest'],
      },
      {
        // Type tests assert through `expectTypeOf` and `@ts-expect-error`.
        files: ['**/*.test-d.ts'],
        plugins: ['vitest'],
        rules: { 'vitest/expect-expect': 'off' },
      },
    ],
  },
  run: {
    cache: true,
  },
});

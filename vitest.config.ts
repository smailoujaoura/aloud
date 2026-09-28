import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Real WXT storage runs migrations against `browser.runtime` the moment a module defines
      // an item, which rejects under Node and made `npm test` exit 1 with every assertion green.
      'wxt/utils/storage': fileURLToPath(new URL('./tests/stubs/wxt-storage.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // A rejection nobody handled is a failure, not a note under a green summary.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});

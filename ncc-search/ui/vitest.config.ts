import path from 'node:path';

import { defineConfig } from 'vitest/config';

// Unit tests for the nsite edition's pure parts (row mapping, sorting,
// IndexedDB persistence). The crawl itself is exercised in a real browser --
// see ui/README.md -- because it is a Web Worker plus IndexedDB plus relays,
// and mocking all three would test the mocks.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@shared': path.resolve(import.meta.dirname, '../shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// A small standalone page: pick the built nsite folder, upload its files to
// Blossom, sign a NIP-5A manifest with NIP-07, publish it. Kept separate from
// ui/ on purpose -- it needs a signer and file access, neither of which the
// search page should ever ask for.
export default defineConfig({
  // Absolute asset paths: the same dist works from a dev server and from an
  // nsite, where every path must match the published manifest exactly.
  base: '/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
  },
  build: {
    // Same name as the search UI's nsite build: when publishing this page
    // itself, the folder to pick is `nsite-publisher/dist-nsite`, not a
    // generically named `dist` that could be anything.
    outDir: 'dist-nsite',
    emptyOutDir: true,
  },
});

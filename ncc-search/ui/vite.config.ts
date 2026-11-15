import path from 'node:path';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Same conventions as ../../test-app/vite.config.ts (the other MKStack app
// in this repo): path alias "@/*" -> "./src/*", Tailwind v4 via its Vite
// plugin (no tailwind.config.js needed). Build output goes to its own
// `dist/`, not `../../public/` -- this UI is served as its own thing, not
// bundled into the main site (see ui/README.md's Caddy routing note).
export default defineConfig(() => ({
  base: '/',
  server: {
    host: '::',
    port: 8081,
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
}));

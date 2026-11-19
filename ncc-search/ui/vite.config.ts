import path from 'node:path';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Same conventions as ../../test-app/vite.config.ts (the other MKStack app
// in this repo): path alias "@/*" -> "./src/*", Tailwind v4 via its Vite
// plugin (no tailwind.config.js needed). Build output goes to its own
// `dist/`, not `../../public/` -- this UI is served as its own thing, not
// bundled into the main site (see ui/README.md's Caddy routing note).
//
// `--mode nsite` builds the NIP-5A edition: the same UI, but the API path in
// lib/api.ts is replaced by the browser crawler/index in lib/local/. It gets
// its own output directory so a normal deployment build and an nsite build
// can sit side by side; the nsite publisher uploads `dist-nsite/`.
export default defineConfig(({ mode }) => {
  const nsite = mode === 'nsite';
  return {
    // The nsite edition is embedded both at an app protocol root and below
    // /nccsearch/ in the mobile shell. Relative assets work in either place.
    base: './',
    server: {
      host: '::',
      port: 8081,
      // The nsite edition imports the shared posted-at/Markdown rules from
      // ../shared, outside this package's root. Vite's dev server refuses
      // that by default even though the production build resolves it fine.
      fs: { allow: [path.resolve(import.meta.dirname, '..')] },
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
        '@shared': path.resolve(import.meta.dirname, '../shared'),
      },
    },
    build: {
      outDir: nsite ? 'dist-nsite' : 'dist',
      emptyOutDir: true,
    },
  };
});

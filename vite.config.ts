import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Build config (added by task Q2). The app itself needs no custom config —
 * the only reason this file exists is the SECOND HTML entry: `benchmark.html`,
 * the Q2 performance-harness page. Both pages are emitted by `npm run build`
 * (`dist/index.html` + `dist/benchmark.html`, each with its own chunk; the
 * optimizer worker chunk is shared). Not linked from the app UI anywhere — a
 * human opens it directly for acceptance measurements.
 *
 * `base: './'` (added for GitHub Pages hosting): the site is served from a
 * subpath (https://<user>.github.io/traffic/), so asset URLs must be relative
 * or they 404. Relative base also keeps `dist/` portable — the same build
 * works on Netlify/Cloudflare drag-and-drop or any subdirectory host.
 *
 * vitest keeps using vitest.config.ts (it takes priority over vite.config.ts),
 * so test discovery is unaffected.
 */
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        benchmark: fileURLToPath(new URL('./benchmark.html', import.meta.url)),
      },
    },
  },
});

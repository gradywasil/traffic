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
 * vitest keeps using vitest.config.ts (it takes priority over vite.config.ts),
 * so test discovery is unaffected.
 */
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        benchmark: fileURLToPath(new URL('./benchmark.html', import.meta.url)),
      },
    },
  },
});

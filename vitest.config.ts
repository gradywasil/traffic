import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests for the loop/world are pure TypeScript — no DOM needed.
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});

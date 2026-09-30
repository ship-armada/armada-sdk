// ABOUTME: Scratch vitest config for review repro tests under review-2026-09/repro/ (review branch only, never merged).
// ABOUTME: Mirrors vitest.config.ts settings (forks pool, externalized vendor dist) with a different include.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['review-2026-09/repro/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    server: { deps: { external: [/vendor[\\/]railgun-engine[\\/]dist/] } },
  },
});

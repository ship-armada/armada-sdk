// ABOUTME: Vitest config for @armada/sdk — offline unit/property tests + the differential vector suite.
// ABOUTME: No chains, no network; the vendored core is tested against test/vectors/ fixtures.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});

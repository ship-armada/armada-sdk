// ABOUTME: Vitest config for @armada/sdk — offline unit/property tests + the differential vector suite.
// ABOUTME: No chains, no network; the vendored core is tested against test/vectors/ fixtures.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Fork a real node process per test file. snarkjs's bn128 curve spawns worker_threads; under
    // vitest's default worker-thread pool that fails ("Worker is not a constructor"). Forks match
    // pure-node behavior so the prover's Groth16 proving works.
    pool: 'forks',
    server: {
      deps: {
        // The vendored engine is prebuilt CJS (dist/). Externalize it so Node's require dedupes
        // module instances by resolved path — otherwise Vite inlines the ESM-side import separately
        // from the dist's own internal requires, duplicating module-level state (e.g. the shared
        // WalletInfo.walletSource static that createTransfer sets and encryptV2 reads).
        external: [/vendor[\\/]railgun-engine[\\/]dist/],
      },
    },
  },
});

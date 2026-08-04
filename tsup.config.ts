// ABOUTME: tsup build config for @armada/sdk — browser-first ESM + Node CJS, per-subpath entries.
// ABOUTME: Emits dist/{index,core,wallet,payments,ops} with .js (ESM), .cjs (CJS), and .d.ts types.

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/index': 'src/core/index.ts',
    'wallet/index': 'src/wallet/index.ts',
    'payments/index': 'src/payments/index.ts',
    'ops/index': 'src/ops/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
});

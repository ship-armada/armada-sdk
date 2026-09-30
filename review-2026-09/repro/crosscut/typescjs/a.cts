// ABOUTME: CJS consumer on moduleResolution node16 — fails with TS1479 against the single ESM d.ts (XC-3).
// ABOUTME: Typecheck with tsc -p typescjs; b.mts (ESM) passes, this file fails.
import { createArmadaSdk } from '@armada/sdk';
import { poseidon } from '@armada/sdk/core';
export const x = [createArmadaSdk, poseidon];

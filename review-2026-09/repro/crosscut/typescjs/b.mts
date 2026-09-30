// ABOUTME: ESM counterpart of a.cts on moduleResolution node16 — typechecks cleanly (XC-3 control).
// ABOUTME: Typecheck with tsc -p typescjs alongside a.cts.
import { createArmadaSdk } from '@armada/sdk';
import { poseidon } from '@armada/sdk/core';
export const x = [createArmadaSdk, poseidon];

// ABOUTME: Consumer importing both the root and /core entries — shows the bundle doubling (XC-1).
// ABOUTME: Compare its esbuild output size against consumer-root.mjs.
import { createArmadaSdk } from '../../../dist/index.js';
import { poseidon } from '../../../dist/core/index.js';
console.log(typeof createArmadaSdk, typeof poseidon);

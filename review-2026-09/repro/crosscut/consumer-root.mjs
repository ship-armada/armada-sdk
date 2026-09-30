// ABOUTME: Minimal consumer importing only the @armada/sdk root — esbuild browser-bundle size baseline (XC-1).
// ABOUTME: Also the esbuild browser build that fails on bare fs/promises + path imports (XC-2).
import { createArmadaSdk } from '../../../dist/index.js';
console.log(typeof createArmadaSdk);

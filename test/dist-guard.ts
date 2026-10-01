// ABOUTME: Shared guard for tests of the BUILT package (dist/). Locally a fresh tree may not be built yet, so
// ABOUTME: those tests skip; in CI (which builds before testing) a missing dist/ is a failure, never a silent skip.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST_INDEX = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

/** True when dist/ is built. Otherwise skips the test locally, and throws in CI. */
export function distAvailable(ctx: { skip(): void }): boolean {
  if (existsSync(DIST_INDEX)) return true;
  if (process.env.CI) throw new Error('dist/ is missing in CI — run `npm run build` before `npm test`');
  ctx.skip();
  return false;
}

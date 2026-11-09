// ABOUTME: Stands in for Node's `crypto` in the browser ESM build (tsup alias) — only what bundled code calls there:
// ABOUTME: randomBytes (WebCrypto) and createHash('sha512') (noble). Replaces the 3.6 MB @jspm/core crypto polyfill.

import { sha512 } from '@noble/hashes/sha512';
import { InternalError } from '../errors';

// Who reaches this in the browser build, and when (the engine's own `crypto` uses sit behind `isNodejs`, which is
// false there because the bundled `process` polyfill has no `versions.node`):
//   - @noble/ed25519 — `randomBytes` / `createHash('sha512')` where there's no `self` (a Node ES-module importer);
//   - ffjavascript — `randomBytes(1)` for a random field element where there's no `window`.
// Anything else throws an InternalError, so a new caller fails loudly rather than getting a silently wrong result.

/** Cryptographically secure random bytes from WebCrypto (`globalThis.crypto`: browsers, workers, Node ≥ 19). */
export function randomBytes(length: number): Buffer {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(length)));
}

/** The streaming-hash subset callers use: `createHash('sha512').update(bytes).digest()`. */
export function createHash(algorithm: string): { update(data: Uint8Array): ReturnType<typeof createHash>; digest(): Buffer } {
  if (algorithm !== 'sha512') throw new InternalError(`crypto shim: unsupported hash "${algorithm}" (only sha512)`);
  const hash = sha512.create();
  const api = {
    update(data: Uint8Array) {
      hash.update(data);
      return api;
    },
    digest() {
      return Buffer.from(hash.digest());
    },
  };
  return api;
}

export default { randomBytes, createHash };

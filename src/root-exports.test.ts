// ABOUTME: Guards the bundled root `dist/index.d.ts` export surface — the note-crypto/keyset/token
// ABOUTME: helpers node10 (classic moduleResolution) consumers import from the package root (#facade-removal).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { distAvailable } from '../test/dist-guard';

/**
 * WHY: a bare `export *` from this multi-entry tsup build silently drops symbols the dts bundler
 * assigns to another entry's shared chunk (note-crypto/keyset land in the wallet/core chunks and
 * vanish from the root `.d.ts` even though they're present at runtime), and the `./core` token layer
 * is only reachable via the exports-map subpath. Classic-`moduleResolution` consumers (the POC relayer
 * + interface app) can't see either, forcing hand-typed facades. `src/index.ts` names these explicitly
 * to pin them into the bundled root types; this test fails if that regresses — which a src-level `tsc`
 * check can't catch, because the drop happens only during dts BUNDLING, not src type-resolution.
 */
const ROOT_DTS = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/index.d.ts');

// The exact set the node10 facade-removal depends on (values + types). Extend when a consumer needs more.
const REQUIRED_ROOT_EXPORTS = [
  // note-crypto (sync)
  'createTransferNote',
  'encryptNoteToReceiver',
  'tryDecryptCommitment',
  // keyset (wallet)
  'deriveKeyset',
  'deriveKeysetFromMnemonic',
  'Keyset',
  // token layer (core)
  'getTokenDataERC20',
  'getTokenDataHash',
  'initPoseidonPromise',
  'ChainType',
  'TokenData',
  'TokenDataGetter',
  'Chain',
  'AddressData',
  // 0zk address codec — on the root so consumers needn't load /core for it (#116)
  'decodeAddress',
  'encodeAddress',
  'Ciphertext',
  // scan/balance event surface (sync) — consumed via wallet.on()
  'SyncEventMap',
  'Unsubscribe',
] as const;

describe('root .d.ts export surface (node10 consumer contract)', () => {
  it('re-exports the note-crypto / keyset / token helpers on the package root', (ctx) => {
    // Guards the BUILT type surface, so it needs `dist/` (skipped on an unbuilt local tree; required in CI).
    if (!distAvailable(ctx)) return;
    const dts = readFileSync(ROOT_DTS, 'utf8');
    for (const symbol of REQUIRED_ROOT_EXPORTS) {
      expect(
        new RegExp(`\\b${symbol}\\b`).test(dts),
        `dist/index.d.ts must export "${symbol}" for node10 consumers`,
      ).toBe(true);
    }
  });
});

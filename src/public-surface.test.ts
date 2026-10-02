// ABOUTME: Pins the SDK's public export surface (#129) — internals stay off the stable entries and live on
// ABOUTME: `/internal`, and a committed snapshot of every stable entry's exports makes any surface change a reviewed diff.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { distAvailable } from '../test/dist-guard';

const DIST = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'dist');
const req = createRequire(import.meta.url);
const runtimeNames = (entry: string): string[] => Object.keys(req(join(DIST, entry)) as object).sort();

// Every name a bundled `.d.ts` exports (values and types): `export { a, type B as C }` lists plus `export declare …`.
function typeNames(dts: string): string[] {
  const code = readFileSync(join(DIST, dts), 'utf8');
  const names = new Set<string>();
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
      if (name !== '') names.add(name);
    }
  }
  for (const m of code.matchAll(/export\s+declare\s+(?:abstract\s+)?(?:class|function|const|let|enum|interface|type|namespace)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]!);
  }
  return [...names].sort();
}

// The building blocks moved off the root (the #129 allow-list). They're reachable only via `@armada/sdk/internal`.
const INTERNAL = [
  'WalletScanState', 'saveScanState', 'loadScanState', 'scanStateKey', 'UTXOMerkletree', 'SyncEmitter', 'startAutoSync',
  'decodePoolEvents', 'formatShieldEvent', 'formatTransactEvent', 'formatNullifiedEvent', 'formatCommitmentCiphertext',
  'POOL_V2_EVENT_ABI', 'fetchLogsRanged', 'RpcEventSource', 'IndexerEventSource', 'computeBalances', 'withTokenAddresses',
  'newReceivedNotes', 'ownSpendTxids', 'ownedNoteFromTransactNote', 'txoFromNote', 'tryDecryptShield',
  'decryptedCommitmentMatches', 'shieldCommitmentMatches', 'tokenHashKey', 'PendingSpends', 'loadPendingSpends',
  'savePendingSpends', 'pendingSpendsKey', 'EncryptedStore', 'deriveStorageKey', 'deriveWalletStorageKey', 'walletRecordId',
  'planTransfer', 'planConsolidate', 'planSpend', 'planWitnessInputs', 'buildWitness', 'prove', 'proveAll',
  'maxTransferAmount', 'maxUnshieldAmount', 'txosAfterConsolidation', 'runPreflight', 'readShieldsPaused', 'hashSpendBoundParams',
];

describe('public export surface (#129)', () => {
  it('keeps the internals off the root and exposes them on /internal', (ctx) => {
    // WHY: the root exported 148 symbols via `export *`, including scan state the instance-level chain-state work
    // must change and `saveScanState`, which writes scan state to the raw adapter unencrypted.
    if (!distAvailable(ctx)) return;
    const root = runtimeNames('index.cjs');
    expect(INTERNAL.filter((n) => root.includes(n))).toEqual([]);
    const internal = runtimeNames('internal/index.cjs');
    expect(INTERNAL.filter((n) => !internal.includes(n))).toEqual([]);
  });

  it('matches the committed snapshot of every stable entry (runtime + types)', async (ctx) => {
    // WHY: an export added or removed by accident is a breaking change for consumers. Any change to this surface
    // must show up as a diff to `__snapshots__/public-surface.json` in review. (`/internal` is unstable: not pinned.)
    if (!distAvailable(ctx)) return;
    const surface = {
      runtime: {
        '.': runtimeNames('index.cjs'),
        './core': runtimeNames('core/index.cjs'),
        './wallet': runtimeNames('wallet/index.cjs'),
        './prover': runtimeNames('prover/index.cjs'),
        './node': runtimeNames('node/index.cjs'),
      },
      types: {
        '.': typeNames('index.d.ts'),
        './core': typeNames('core/index.d.ts'),
        './wallet': typeNames('wallet/index.d.ts'),
        './prover': typeNames('prover/index.d.ts'),
        './node': typeNames('node/index.d.ts'),
      },
    };
    await expect(`${JSON.stringify(surface, null, 2)}\n`).toMatchFileSnapshot('./__snapshots__/public-surface.json');
  });
});

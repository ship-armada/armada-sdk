// ABOUTME: Offline tests for createArmadaSdk (§4.1) — instance lifecycle, wallet identity parity,
// ABOUTME: spend-capability gating, close(), and documented not-implemented factory methods. No network.

import { describe, it, expect, beforeAll } from 'vitest';
import { createArmadaSdk, planSyncWindow, quickSyncTelemetry } from './sdk';
import { deriveKeyset, LocalSigner } from './wallet/index';
import { MemoryStorageAdapter } from './storage/index';
import { NoSpendCapabilityError } from './errors';
import { initPoseidonPromise, Mnemonic } from './core/index';
import type { ProverAdapter, ArtifactSource, ArtifactSet, Groth16Proof } from './prover/index';
import type { ArmadaSdkConfig } from './index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const seed = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

// A prover/artifacts stub — the lifecycle tests never prove, but close() must reach prover.close().
let proverClosed = false;
const stubProver: ProverAdapter = {
  prove: async (): Promise<Groth16Proof> => ({ a: ['0', '0'], b: [['0', '0'], ['0', '0']], c: ['0', '0'] }),
  verify: async () => true,
  close: async () => { proverClosed = true; },
};
const stubArtifacts: ArtifactSource = {
  resolve: async (): Promise<ArtifactSet> => ({ wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} }),
};

const makeConfig = (): ArmadaSdkConfig => ({
  pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1, usdcAddress: USDC },
  rpc: { urls: ['http://127.0.0.1:1'] }, // never dialed in these tests
  storage: new MemoryStorageAdapter(),
  prover: stubProver,
  artifacts: stubArtifacts,
});

describe('createArmadaSdk (§4.1)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('loads a wallet whose 0zk matches deriveKeyset (identity parity)', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const wallet = await sdk.wallet.fromRootSecret(seed(0x11), { creationBlock: 1 });
    expect(wallet.shieldedAddress).toBe((await deriveKeyset(seed(0x11))).shieldedAddress);
  });

  it('gates spend capability on an attached signer', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const viewOnly = await sdk.wallet.fromRootSecret(seed(0x22), { creationBlock: 1 });
    expect(viewOnly.canSpend).toBe(false);

    const spendable = await sdk.wallet.fromRootSecret(seed(0x22), {
      creationBlock: 1,
      signer: await LocalSigner.fromRootSecret(seed(0x22)),
    });
    expect(spendable.canSpend).toBe(true);
  });

  it('close() releases the prover', async () => {
    proverClosed = false;
    const sdk = await createArmadaSdk(makeConfig());
    await sdk.close();
    expect(proverClosed).toBe(true);
  });

  it('fromMnemonic derives the same 0zk as the equivalent rootSecret', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const mnemonic = Mnemonic.fromEntropy(bytesToHex(seed(0x11)));
    const wallet = await sdk.wallet.fromMnemonic(mnemonic, { creationBlock: 1 });
    expect(wallet.shieldedAddress).toBe((await deriveKeyset(seed(0x11))).shieldedAddress);
    expect(wallet.canSpend).toBe(false);
  });

  it('ephemeralFromSeed derives a spendable wallet (auto-attached signer)', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const wallet = await sdk.wallet.ephemeralFromSeed(seed(0x55));
    expect(wallet.shieldedAddress).toBe((await deriveKeyset(seed(0x55))).shieldedAddress);
    expect(wallet.canSpend).toBe(true);
  });

  it('exportDisclosure throws a documented not-implemented error', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const wallet = await sdk.wallet.fromRootSecret(seed(0x33), { creationBlock: 1 });
    await expect(wallet.exportDisclosure('ref')).rejects.toThrow(/not implemented/);
  });

  it('shareViewingKey round-trips into a view-only wallet (same 0zk, no spend)', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const full = await sdk.wallet.fromRootSecret(seed(0x11), {
      creationBlock: 1,
      signer: await LocalSigner.fromRootSecret(seed(0x11)),
    });
    expect(full.canSpend).toBe(true);

    const viewOnly = await sdk.wallet.viewOnlyFromViewingKey(full.shareViewingKey(), { creationBlock: 1 });
    expect(viewOnly.shieldedAddress).toBe(full.shieldedAddress);
    expect(viewOnly.canSpend).toBe(false);

    // Spend-path calls on a view-only wallet throw NoSpendCapabilityError.
    const fee = { schedule: { transfer: '0' }, broadcasterShieldedAddress: '0zk', feesCacheId: 'x', expiresAt: 0 };
    await expect(viewOnly.planTransfer({ outputs: [{ to0zk: '0zk', amount: 1n }], fee })).rejects.toThrow(NoSpendCapabilityError);
  });

  it('supports multiple independent instances (no shared module state)', async () => {
    const a = await createArmadaSdk(makeConfig());
    const b = await createArmadaSdk(makeConfig());
    const wa = await a.wallet.fromRootSecret(seed(0x11), { creationBlock: 1 });
    const wb = await b.wallet.fromRootSecret(seed(0x44), { creationBlock: 1 });
    expect(wa.shieldedAddress).not.toBe(wb.shieldedAddress);
  });
});

describe('planSyncWindow — sync resume decision', () => {
  it('first run scans from the creation block (syncedThrough starts at creationBlock - 1)', () => {
    // WHY: a fresh wallet (creationBlock 10 → syncedThrough 9) with head 20 must cover 10..20.
    expect(planSyncWindow(9, 20)).toEqual({ fromBlock: 10, scanned: true });
  });

  it('resume scans ONLY the delta past the persisted checkpoint, never from genesis', () => {
    // WHY: this is the whole point of persistence. After a reload hydrate() restores
    // syncedThrough=20; a head of 25 must scan 21..25. A regression here (fromBlock reverting to
    // the deploy block) turns every reload into a full-history rescan — the exact failure this
    // observability work is meant to catch.
    expect(planSyncWindow(20, 25)).toEqual({ fromBlock: 21, scanned: true });
  });

  it('does no work when the head has not advanced past the checkpoint', () => {
    // WHY: the cheap path — a reload with no new blocks issues zero getLogs. `scanned:false` is
    // the greppable signal that the SDK resumed rather than rescanned. Also covers head < checkpoint
    // (transient RPC lag / reorg) as a no-op rather than a negative-range scan.
    expect(planSyncWindow(20, 20)).toEqual({ fromBlock: 21, scanned: false });
    expect(planSyncWindow(20, 15)).toEqual({ fromBlock: 21, scanned: false });
  });
});

describe('quickSyncTelemetry — quick-sync observability outcome (SPEC §8)', () => {
  it('returns null when no indexer is configured (a pure RPC sync has nothing to report)', () => {
    // WHY: emitting for every RPC-only sync would be noise the caller already knows (it passed no
    // indexer URL). The absence of an event IS the "no indexer" signal.
    expect(
      quickSyncTelemetry({ usingIndexer: false, tailCovered: false, fellBack: false, fromBlock: 5, head: 9 }),
    ).toBeNull();
  });

  it('reports `served` (no tail) when the indexer covered to head and the root verified', () => {
    // WHY: this is the healthy fast-path — the signal an operator greps for to confirm the indexer
    // is actually serving rather than silently degrading to RPC.
    expect(
      quickSyncTelemetry({ usingIndexer: true, tailCovered: false, fellBack: false, fromBlock: 5, head: 9 }),
    ).toEqual({ event: 'sync.quicksync', data: { outcome: 'served', fromBlock: 5, head: 9, tailCovered: false } });
  });

  it('flags `tailCovered` when the indexer lagged and RPC covered the remainder', () => {
    // WHY: a chronically-lagging indexer still counts as "served" but the RPC tail is the tell — an
    // operator should see the indexer trailing head before it turns into a support ticket.
    const ev = quickSyncTelemetry({ usingIndexer: true, tailCovered: true, fellBack: false, fromBlock: 5, head: 9 });
    expect(ev?.data.outcome).toBe('served');
    expect(ev?.data.tailCovered).toBe(true);
  });

  it('reports `root-mismatch-fallback` and clears tailCovered when the indexer batch was rejected', () => {
    // WHY: on root mismatch the indexer batch is discarded and the whole range RPC-rescanned, so
    // tail-cover is meaningless — the event must say the indexer served bad data (a data-integrity
    // alert), not that it served, even if the discarded attempt had lagged.
    const ev = quickSyncTelemetry({ usingIndexer: true, tailCovered: true, fellBack: true, fromBlock: 5, head: 9 });
    expect(ev?.data.outcome).toBe('root-mismatch-fallback');
    expect(ev?.data.tailCovered).toBe(false);
  });
});

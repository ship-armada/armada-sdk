// ABOUTME: Offline tests for createArmadaSdk (§4.1) — instance lifecycle, wallet identity parity,
// ABOUTME: spend-capability gating, close(), and documented not-implemented factory methods. No network.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  createArmadaSdk,
  planSyncWindow,
  quickSyncTelemetry,
  classifyQuickSyncReason,
  finalRootCheckRequired,
  resolveWalletStorage,
  effectiveScanHead,
  shouldRecoverFromReorg,
  scanStateMissingLeaves,
  buildBalanceUpdate,
  buildReceivedNote,
  resolveChainStorage,
} from './sdk';
import { RootMismatchError, QuickSyncSchemaError, IndexerHttpError, PositionGapError } from './errors';
import { deriveKeyset, LocalSigner, ExternalSigner, encodeShareableViewingKey, type Wallet } from './wallet/index';
import { saveChainState, saveWalletNotes, WalletScanState, walletRecordId } from './internal/index';
import { MemoryStorageAdapter } from './storage/index';
import { NoSpendCapabilityError, InvalidKeyMaterialError, InvalidRequestError, UnsupportedCircuitShapeError, SignerContractViolationError, InstanceClosedError } from './errors';
import { initPoseidonPromise, Mnemonic, getTokenDataERC20, getTokenDataHash } from './core/index';
import { feeForOperation, encodeCctpBinding } from './tx/index';
import type { ProverAdapter, ArtifactSource, ArtifactSet, Groth16Proof } from './prover/index';
import type { ArmadaSdk, ArmadaSdkConfig } from './index';
import type { Plan } from './tx/index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const seed = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

// A prover/artifacts stub — the lifecycle tests never prove, but close() must reach prover.close().
let proverClosed = false;
let proveCalls = 0;
const stubProver: ProverAdapter = {
  prove: async (): Promise<Groth16Proof> => {
    proveCalls += 1;
    return { a: ['0', '0'], b: [['0', '0'], ['0', '0']], c: ['0', '0'] };
  },
  verify: async () => true,
  close: async () => { proverClosed = true; },
};
const stubArtifacts: ArtifactSource = {
  resolve: async (): Promise<ArtifactSet> => ({ wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} }),
};

// Seed a store as an instance would have left it: the chain state in the shared scope, the notes in the wallet's (as
// plaintext — the test instances run with dangerouslyAllowPlaintextStorage), both synced through `syncedThrough`.
async function seedScanState(store: MemoryStorageAdapter, viewingPrivateKey: Uint8Array, state: WalletScanState, syncedThrough: number): Promise<void> {
  await saveChainState(resolveChainStorage(store), state.trees, { syncedThrough });
  await saveWalletNotes(resolveWalletStorage(store, viewingPrivateKey, true), state.walletNotes, { syncedThrough });
}

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

  it('watch() returns an unsubscribe, rejects a double-watch, and re-enables after stop (issue #59)', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const wallet = await sdk.wallet.fromRootSecret(seed(0x55), { creationBlock: 1 });
    // immediate:false + a long interval so the offline suite never dials the RPC (no network).
    const opts = { intervalMs: 3_600_000, immediate: false as const };

    const unsubscribe = wallet.watch(opts);
    expect(typeof unsubscribe).toBe('function');
    // A second watch while already watching is a programming error.
    expect(() => wallet.watch(opts)).toThrow(InvalidRequestError);

    unsubscribe();
    // After stopping, watching again is allowed (state was released); idempotent unsubscribe is safe.
    const again = wallet.watch(opts);
    expect(() => again()).not.toThrow();
    expect(() => again()).not.toThrow();
  });

  it('close() stops active watchers (issue #59)', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const wallet = await sdk.wallet.fromRootSecret(seed(0x56), { creationBlock: 1 });
    vi.useFakeTimers();
    try {
      wallet.watch({ intervalMs: 3_600_000, immediate: false });
      expect(vi.getTimerCount()).toBe(1); // the watcher's next tick
      await sdk.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('lifecycle (#140)', () => {
    it('after close(), the factory and every wallet call reject with INSTANCE_CLOSED; close() again is harmless', async () => {
      // WHY: a closed SDK kept handing out wallets and running calls against a destroyed provider and closed storage.
      const sdk = await createArmadaSdk(makeConfig());
      const wallet = await sdk.wallet.fromRootSecret(seed(0x61), { creationBlock: 1 });
      await sdk.close();
      await expect(sdk.wallet.fromRootSecret(seed(0x61), { creationBlock: 1 })).rejects.toBeInstanceOf(InstanceClosedError);
      await expect(sdk.wallet.ephemeralFromSeed(seed(0x62))).rejects.toBeInstanceOf(InstanceClosedError);
      await expect(wallet.sync()).rejects.toBeInstanceOf(InstanceClosedError);
      await expect(wallet.balances()).rejects.toBeInstanceOf(InstanceClosedError);
      await expect(wallet.history()).rejects.toBeInstanceOf(InstanceClosedError);
      expect(() => wallet.watch()).toThrow(InstanceClosedError);
      expect(() => wallet.shareViewingKey()).toThrow(InstanceClosedError);
      await expect(sdk.close()).resolves.toBeUndefined();
    });

    it('wallet.dispose() stops its watcher, wipes the signer the SDK made, and leaves an app-supplied signer alone', async () => {
      const sdk = await createArmadaSdk(makeConfig());
      const disposeSpy = vi.spyOn(LocalSigner.prototype, 'dispose');
      try {
        const own = await sdk.wallet.fromRootSecret(seed(0x63), { creationBlock: 1 });
        const appSigner = await LocalSigner.fromRootSecret(seed(0x64));
        const theirs = await sdk.wallet.fromRootSecret(seed(0x64), { creationBlock: 1, signer: appSigner });
        vi.useFakeTimers();
        try {
          own.watch({ intervalMs: 3_600_000, immediate: false });
          await own.dispose();
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
        await theirs.dispose();
        expect(disposeSpy).toHaveBeenCalledTimes(1);
        expect(disposeSpy.mock.instances[0]).not.toBe(appSigner);
        expect(await appSigner.signBatch([])).toEqual([]); // the app's signer still works
        await expect(own.balances()).rejects.toBeInstanceOf(InstanceClosedError);
        await expect(own.dispose()).resolves.toBeUndefined(); // disposing twice is harmless
        // Other wallets on the instance are unaffected.
        const other = await sdk.wallet.fromRootSecret(seed(0x65), { creationBlock: 1 });
        await expect(other.syncStatus()).resolves.toMatchObject({ syncing: false });
      } finally {
        disposeSpy.mockRestore();
      }
      await sdk.close();
    });
  });

  it('fromRootSecret is spend-capable by default; viewOnly opts out; explicit signer wins', async () => {
    const sdk = await createArmadaSdk(makeConfig());

    // Default (SPEC §4.2.1): the SDK auto-attaches a LocalSigner — the rootSecret already grants spend power.
    const spendable = await sdk.wallet.fromRootSecret(seed(0x22), { creationBlock: 1 });
    expect(spendable.canSpend).toBe(true);

    // Opt out for a view-only wallet from a rootSecret (no spend key held).
    const viewOnly = await sdk.wallet.fromRootSecret(seed(0x22), { creationBlock: 1, viewOnly: true });
    expect(viewOnly.canSpend).toBe(false);

    // An explicit signer (e.g. ExternalSigner) is used as-is.
    const explicit = await sdk.wallet.fromRootSecret(seed(0x22), {
      creationBlock: 1,
      signer: await LocalSigner.fromRootSecret(seed(0x22)),
    });
    expect(explicit.canSpend).toBe(true);
  });

  it('close() releases the prover', async () => {
    proverClosed = false;
    const sdk = await createArmadaSdk(makeConfig());
    await sdk.close();
    expect(proverClosed).toBe(true);
  });

  it('fromMnemonic derives the same 0zk as the equivalent rootSecret, spend-capable by default (P4.4)', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const mnemonic = Mnemonic.fromEntropy(bytesToHex(seed(0x11)));
    const wallet = await sdk.wallet.fromMnemonic(mnemonic, { creationBlock: 1 });
    expect(wallet.shieldedAddress).toBe((await deriveKeyset(seed(0x11))).shieldedAddress);
    expect(wallet.canSpend).toBe(true); // the relayer's mnemonic wallet can now actually spend
  });

  it('fromMnemonic rejects an invalid mnemonic (BIP-39 checksum) and honors derivationIndex (P4.4)', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const mnemonic = Mnemonic.fromEntropy(bytesToHex(seed(0x11)));

    // A typo'd mnemonic must fail loudly, not silently derive an empty wallet.
    await expect(sdk.wallet.fromMnemonic('not a valid mnemonic phrase at all', { creationBlock: 1 })).rejects.toThrow(
      InvalidKeyMaterialError,
    );

    // A non-zero derivation index yields a distinct wallet (and view-only opt-out drops spend).
    const w0 = await sdk.wallet.fromMnemonic(mnemonic, { creationBlock: 1 });
    const w1 = await sdk.wallet.fromMnemonic(mnemonic, { creationBlock: 1, derivationIndex: 1, viewOnly: true });
    expect(w1.shieldedAddress).not.toBe(w0.shieldedAddress);
    expect(w1.canSpend).toBe(false);
  });

  it('ephemeralFromSeed derives a spendable wallet (auto-attached signer)', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const wallet = await sdk.wallet.ephemeralFromSeed(seed(0x55));
    expect(wallet.shieldedAddress).toBe((await deriveKeyset(seed(0x55))).shieldedAddress);
    expect(wallet.canSpend).toBe(true);
  });

  it('has no exportDisclosure until selective disclosure ships (SPEC §5.3, Phase 3)', async () => {
    // WHY: a frozen API method that only throws an uncoded "not implemented" is a trap; it returns with Phase 3.
    const sdk = await createArmadaSdk(makeConfig());
    const wallet = await sdk.wallet.fromRootSecret(seed(0x33), { creationBlock: 1 });
    // @ts-expect-error — not part of the Wallet API
    expect(wallet.exportDisclosure).toBeUndefined();
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
    await expect(viewOnly.planTransfer({ outputs: [{ to0zk: '0zk', amount: 1n }] })).rejects.toThrow(NoSpendCapabilityError);
    await expect(viewOnly.proveAll([])).rejects.toThrow(NoSpendCapabilityError);
  });

  it('markSpendPending requires spend capability; clearSpendPending is always safe (issue #55)', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const full = await sdk.wallet.fromRootSecret(seed(0x11), {
      creationBlock: 1,
      signer: await LocalSigner.fromRootSecret(seed(0x11)),
    });
    const viewOnly = await sdk.wallet.viewOnlyFromViewingKey(full.shareViewingKey(), { creationBlock: 1 });

    // A plan only needs its selected inputs' (tree, position) to derive the nullifiers to hold.
    const plan = { selectedInputs: [{ tree: 0, position: 0 }] } as unknown as Plan;

    // View-only wallets can't spend, so they can't have an in-flight spend to track.
    await expect(viewOnly.markSpendPending(plan, '0xabc')).rejects.toThrow(NoSpendCapabilityError);
    // Spend-capable: marking + clearing resolve once the hold record is written.
    await expect(full.markSpendPending(plan, '0xabc')).resolves.toBeUndefined();
    // A split spend marks every group's inputs in one call.
    const group2 = { selectedInputs: [{ tree: 0, position: 1 }] } as unknown as Plan;
    await expect(full.markSpendPending([plan, group2], '0xabc')).resolves.toBeUndefined();
    await expect(viewOnly.markSpendPending([plan, group2], '0xabc')).rejects.toThrow(NoSpendCapabilityError);
    await expect(full.clearSpendPending('0xabc')).resolves.toBeUndefined();
    // clearSpendPending is a no-op safe call even with nothing pending / on a view-only wallet.
    await expect(viewOnly.clearSpendPending('0xdef')).resolves.toBeUndefined();
  });

  it('syncStatus reports the checkpoint (deployBlock-1 fresh) and syncing=false without a sync (P4.6, #118)', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const wallet = await sdk.wallet.fromRootSecret(seed(0x66), { creationBlock: 5 });
    // No persisted state yet. The tree is always built from the pool's deploy block (1), whatever the
    // wallet's creationBlock — creationBlock only limits note discovery.
    expect(await wallet.syncStatus()).toEqual({ syncedThrough: 0, syncing: false });
    await sdk.close();
  });

  it('a wallet loads its persisted checkpoint from storage when created (P4.6, #119)', async () => {
    const store = new MemoryStorageAdapter();
    await store.open({ schemaVersion: 4, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
    await seedScanState(store, (await deriveKeyset(seed(0x77))).viewingPrivateKey, new WalletScanState(), 500); // checkpoint at 500
    await store.close(); // the SDK opens it itself, as a fresh instance would

    // Plaintext storage so the wallet reads the raw adapter we seeded (bypasses the per-wallet key).
    const sdk = await createArmadaSdk({ ...makeConfig(), storage: store, dangerouslyAllowPlaintextStorage: true });
    const wallet = await sdk.wallet.fromRootSecret(seed(0x77), { creationBlock: 1 });
    expect(await wallet.syncStatus()).toEqual({ syncedThrough: 500, syncing: false });
    await sdk.close();
  });

  it('emits storage.chain-reset telemetry when a redeploy resets chain state (P3.7)', async () => {
    // WHY: an operator should see chain-derived state being wiped on a deploy-block change. Pre-open the
    // store under deployBlock 1, then construct an instance at deployBlock 2 → mismatch → reset → emit.
    const store = new MemoryStorageAdapter();
    await store.open({ schemaVersion: 4, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
    await store.close();
    const events: { event: string; data: unknown }[] = [];
    const cfg: ArmadaSdkConfig = {
      ...makeConfig(),
      storage: store,
      pool: { chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 2, usdcAddress: USDC },
      telemetry: { emit: (event, data) => events.push({ event, data }) },
    };
    const sdk = await createArmadaSdk(cfg);
    expect(events).toContainEqual({ event: 'storage.chain-reset', data: { chainId: 31337, deployBlock: 2 } });
    await sdk.close();
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
  it('first run scans from the deploy block (syncedThrough starts at deployBlock - 1)', () => {
    // WHY: a fresh wallet (deployBlock 10 → syncedThrough 9) with head 20 must cover 10..20.
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

  it('adds a `reason` (and HTTP `status`) discriminant on fallback without changing `outcome`', () => {
    // WHY: #83 — the single `root-mismatch-fallback` outcome mislabeled ≥4 distinct causes and sent a
    // debugging session down a merkle-root rabbit hole when the real failure was a 404 from a legacy
    // endpoint. `outcome` stays (back-compat, documented in SPEC §8); `reason` is added beside it.
    const ev = quickSyncTelemetry({
      usingIndexer: true,
      tailCovered: false,
      fellBack: true,
      fromBlock: 5,
      head: 9,
      cause: new IndexerHttpError('quick-sync: indexer responded 404', { status: 404 }),
    });
    expect(ev?.data.outcome).toBe('root-mismatch-fallback'); // unchanged contract
    expect(ev?.data.reason).toBe('indexer-http-error');
    expect(ev?.data.status).toBe(404);
  });

  it('omits `reason`/`status` on the served path (no fallback → nothing to classify)', () => {
    const ev = quickSyncTelemetry({ usingIndexer: true, tailCovered: false, fellBack: false, fromBlock: 5, head: 9 });
    expect(ev?.data.outcome).toBe('served');
    expect(ev?.data.reason).toBeUndefined();
    expect(ev?.data.status).toBeUndefined();
  });
});

describe('classifyQuickSyncReason — map a fallback cause to a telemetry reason (SPEC §8, #83)', () => {
  it('classifies an IndexerHttpError as `indexer-http-error` and surfaces its status', () => {
    expect(classifyQuickSyncReason(new IndexerHttpError('boom', { status: 503 }))).toEqual({
      reason: 'indexer-http-error',
      status: 503,
    });
  });

  it('classifies a QuickSyncSchemaError as `schema-mismatch`', () => {
    expect(classifyQuickSyncReason(new QuickSyncSchemaError('bad wire shape'))).toEqual({ reason: 'schema-mismatch' });
  });

  it('classifies a RootMismatchError as `root-mismatch` (the genuine case, not the catch-all)', () => {
    expect(classifyQuickSyncReason(new RootMismatchError('root differs'))).toEqual({ reason: 'root-mismatch' });
  });

  it('classifies a PositionGapError as `position-gap`', () => {
    expect(classifyQuickSyncReason(new PositionGapError('gap in tree 0'))).toEqual({ reason: 'position-gap' });
  });

  it('classifies an unrecognized cause as `unknown` — never mislabels an unexpected error', () => {
    // WHY: the whole point of #83 is to stop asserting a cause you do not actually know. An unexpected
    // error must NOT be bucketed as `root-mismatch`; it gets the honest `unknown` label.
    expect(classifyQuickSyncReason(new Error('some other failure'))).toEqual({ reason: 'unknown' });
  });

  it('keys on `code`, not identity — an error-shaped object with the code still buckets correctly', () => {
    // WHY: the codebase's frozen rule is "match on code, never message/identity" (errors.ts). instanceof
    // also breaks under the dual-package hazard — an error thrown by one SDK copy fails instanceof in
    // another and would fall to `unknown`. A plain object carrying the stable `code` must classify the
    // same as the real typed error.
    expect(classifyQuickSyncReason({ code: 'INDEXER_HTTP', status: 404 })).toEqual({
      reason: 'indexer-http-error',
      status: 404,
    });
    expect(classifyQuickSyncReason({ code: 'QUICK_SYNC_SCHEMA' })).toEqual({ reason: 'schema-mismatch' });
    expect(classifyQuickSyncReason({ code: 'ROOT_MISMATCH' })).toEqual({ reason: 'root-mismatch' });
    expect(classifyQuickSyncReason({ code: 'POSITION_GAP' })).toEqual({ reason: 'position-gap' });
    expect(classifyQuickSyncReason({ code: 'SOME_UNKNOWN_CODE' })).toEqual({ reason: 'unknown' });
  });
});

describe('feeForOperation — the relayer tier for an operation, strictly (SPEC §4.6.1, #121)', () => {
  const QUOTE = {
    schedule: { transfer: '10', unshield: '20', crossChainUnshield: '30', crossContract: '40' },
    broadcasterShieldedAddress: '0zk_relayer',
  };

  it('returns the per-proof fee and fee recipient for each operation', () => {
    expect(feeForOperation(QUOTE, 'transfer')).toEqual({ perProof: 10n, broadcasterShieldedAddress: '0zk_relayer' });
    expect(feeForOperation(QUOTE, 'unshield').perProof).toBe(20n);
    expect(feeForOperation(QUOTE, 'crossChainUnshield').perProof).toBe(30n);
    expect(feeForOperation(QUOTE, 'crossContract').perProof).toBe(40n);
  });

  it('throws instead of falling back when the quote has no tier for the operation', () => {
    // WHY: the old fallback (missing tier → transfer → '0') silently bound a lower fee or none at all, so
    // the relayer rejected the transaction only after the user had proved for ~30s.
    const partial = { schedule: { transfer: '10' }, broadcasterShieldedAddress: '0zk_relayer' };
    expect(() => feeForOperation(partial, 'crossChainUnshield')).toThrow(InvalidRequestError);
  });

  it('rejects a malformed tier value', () => {
    for (const bad of ['', 'abc', '-1', '1.5']) {
      expect(() => feeForOperation({ schedule: { transfer: bad }, broadcasterShieldedAddress: '0zk' }, 'transfer')).toThrow(InvalidRequestError);
    }
  });
});

describe('createArmadaSdk config validation — fails fast with INVALID_CONFIG, no network (#121)', () => {
  const bad: [string, (c: ArmadaSdkConfig) => ArmadaSdkConfig][] = [
    ['no RPC URLs', (c) => ({ ...c, rpc: { urls: [] } })],
    ['a malformed RPC URL', (c) => ({ ...c, rpc: { urls: ['not a url'] } })],
    ['a non-positive chainId', (c) => ({ ...c, pool: { ...c.pool, chainId: 0 } })],
    ['a malformed pool address', (c) => ({ ...c, pool: { ...c.pool, poolAddress: '0x1234' } })],
    ['a malformed USDC address', (c) => ({ ...c, pool: { ...c.pool, usdcAddress: 'usdc' as `0x${string}` } })],
    ['a negative deployBlock', (c) => ({ ...c, pool: { ...c.pool, deployBlock: -1 } })],
    ['a fractional confirmationDepth', (c) => ({ ...c, pool: { ...c.pool, confirmationDepth: 1.5 } })],
    ['a negative finalityThreshold', (c) => ({ ...c, pool: { ...c.pool, finalityThreshold: -1 } })],
    ['a negative sweepNoteThreshold', (c) => ({ ...c, pool: { ...c.pool, sweepNoteThreshold: -1 } })],
    ['a negative pendingSpendTtlMs', (c) => ({ ...c, pool: { ...c.pool, pendingSpendTtlMs: -1 } })],
    ['a zero autoSyncIntervalMs', (c) => ({ ...c, pool: { ...c.pool, autoSyncIntervalMs: 0 } })],
    ['a malformed circuit shape', (c) => ({ ...c, pool: { ...c.pool, supportedShapes: ['2x'] } })],
    ['a malformed yield adapter address', (c) => ({ ...c, pool: { ...c.pool, wrappers: { yieldAdapter: '0xabc' } } })],
    ['a malformed CCTP messenger address', (c) => ({ ...c, pool: { ...c.pool, cctp: { domain: 0, messenger: '0xabc' } } })],
  ];

  for (const [name, mutate] of bad) {
    it(`rejects ${name}`, async () => {
      await expect(createArmadaSdk(mutate(makeConfig()))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    });
  }

  it('accepts a valid config', async () => {
    const sdk = await createArmadaSdk({
      ...makeConfig(),
      pool: { ...makeConfig().pool, confirmationDepth: 1, finalityThreshold: 1, supportedShapes: ['1x2', '8x4'] },
    });
    await sdk.close();
  });
});

describe('ephemeral wallets are in-memory only (SPEC §4.2/§4.3/§6.5)', () => {
  it('ephemeralFromSeed produces a non-persisting wallet; enrolled wallets persist', async () => {
    // WHY: a claim wallet writing its decrypted note set to disk is the exact forensic residue §6
    // is designed to leave none of. `persists` is the observable guarantee, guarded in hydrate/save
    // (the sync() write path itself needs a live chain, so it is exercised in the POC integration suite).
    const sdk = await createArmadaSdk(makeConfig());
    const eph = await sdk.wallet.ephemeralFromSeed(seed(7));
    expect(eph.persists).toBe(false);

    const enrolled = await sdk.wallet.fromRootSecret(seed(8), { creationBlock: 1 });
    expect(enrolled.persists).toBe(true);
    await sdk.close();
  });

  it('an ephemeral wallet keeps its spend holds in memory — nothing is written to storage (#119)', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = await createArmadaSdk({ ...makeConfig(), storage });
    const eph = await sdk.wallet.ephemeralFromSeed(seed(7));
    await eph.markSpendPending({ selectedInputs: [{ tree: 0, position: 0 }] } as unknown as Plan, '0xclaim');

    const keys: string[] = [];
    for await (const { key } of storage.list('')) keys.push(key);
    expect(keys.filter((k) => !k.startsWith('identity/'))).toEqual([]); // only the namespace marker
    await sdk.close();
  });
});

describe('finalRootCheckRequired — every sync verifies the accepted tree against chain (SPEC §4.4)', () => {
  it('an RPC-only sync (no indexer) MUST run a final on-chain root check', () => {
    // WHY: the baseline path is the source of truth but was previously never root-verified — a provider
    // that silently truncated a getLogs range built a tree missing commitments with no detection (H3).
    expect(finalRootCheckRequired(false, false)).toBe(true);
  });

  it('an indexer batch that fell back to RPC MUST re-verify the RPC result', () => {
    // WHY: the fallback rescans from RPC after discarding the indexer's batch; that RPC result is
    // itself untrusted until checked against the on-chain root.
    expect(finalRootCheckRequired(true, true)).toBe(true);
  });

  it('an indexer batch already served+verified need not double-check', () => {
    // WHY: the served path verified the current root before acceptance; re-reading it is a wasted eth_call.
    expect(finalRootCheckRequired(true, false)).toBe(false);
  });
});

describe('effectiveScanHead — stay confirmationDepth blocks behind head (§4.4 reorg safety)', () => {
  it('scans to head when confirmationDepth is 0 (default), and holds back by the depth otherwise', () => {
    expect(effectiveScanHead(1000, 0)).toBe(1000); // default: scan to head (no behavior change)
    expect(effectiveScanHead(1000, 3)).toBe(997); // stay 3 blocks behind — a ≤3-deep reorg can't poison persisted leaves
    expect(effectiveScanHead(2, 5)).toBe(0); // floored at 0 (planSyncWindow then reports scanned:false)
  });
});

describe('scanStateMissingLeaves — a skipped range can only be healed by a rescan (#118)', () => {
  it('is true only for a POSITION_GAP whose leaf arrived past the next position', () => {
    // WHY: a tree missing leaves (checkpoint advanced past unapplied events, or a tree started after the
    // pool's first commitment) fails every retry identically; a re-sent leaf (received < expected) doesn't.
    expect(scanStateMissingLeaves(new PositionGapError('gap', { expected: 0, received: 3 }))).toBe(true);
    expect(scanStateMissingLeaves(new PositionGapError('dup', { expected: 3, received: 1 }))).toBe(false);
    expect(scanStateMissingLeaves(new PositionGapError('no fields'))).toBe(false);
    expect(scanStateMissingLeaves(new RootMismatchError('root'))).toBe(false);
    // Keyed on code + fields, not identity: an error-shaped object from another SDK copy still counts.
    expect(scanStateMissingLeaves({ code: 'POSITION_GAP', expected: 1, received: 2 })).toBe(true);
  });
});

describe('shouldRecoverFromReorg — self-heal a reorg-poisoned persisted tree (§4.4)', () => {
  const rme = new RootMismatchError('tree root not in history');

  it('recovers only on a RootMismatchError whose PERSISTED state is itself invalid, and not while recovering', () => {
    // A reorg removed an already-persisted leaf → the rolled-back (persisted) tree fails root verify → rescan.
    expect(shouldRecoverFromReorg(rme, true, false)).toBe(true);
    // The persisted state is fine → this was just a bad batch → rethrow (a retry re-fetches), no reset.
    expect(shouldRecoverFromReorg(rme, false, false)).toBe(false);
    // Already inside a recovery rescan → don't reset again (guards an infinite loop).
    expect(shouldRecoverFromReorg(rme, true, true)).toBe(false);
    // A non-root-mismatch error (e.g. RPC failure) is not a reorg → don't reset.
    expect(shouldRecoverFromReorg(new Error('rpc down'), true, false)).toBe(false);
  });
});

describe('resolveWalletStorage — at-rest encryption is on by default (SPEC §4.3, auto-wrap)', () => {
  const ns = { schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 } as const;
  const vk = new Uint8Array(32).fill(9);
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

  it('wraps the raw adapter in encryption by default — plaintext never reaches the underlying store', async () => {
    // WHY (H1): the SDK persists decrypted note data (values, note `random`, memos). Without the
    // auto-wrap a caller passing a bare adapter leaks all of it at rest with no warning.
    const raw = new MemoryStorageAdapter();
    await raw.open(ns);
    const secure = resolveWalletStorage(raw, vk, false);
    expect(secure).not.toBe(raw);

    await secure.put('chain/scan-state/x', enc('secret-note-random-and-value'));
    const atRest = await raw.get('chain/scan-state/x');
    expect(dec(atRest!)).not.toContain('secret-note-random-and-value'); // ciphertext at rest
    expect(dec((await secure.get('chain/scan-state/x'))!)).toBe('secret-note-random-and-value'); // readable to the wallet
  });

  it('the danger flag drops ONLY the encryption: records are still scoped to the wallet', async () => {
    const raw = new MemoryStorageAdapter();
    await raw.open(ns);
    const plain = resolveWalletStorage(raw, vk, true);
    await plain.put('chain/scan-state', enc('visible'));
    expect(dec((await raw.get(`chain/${walletRecordId(vk)}/scan-state`))!)).toBe('visible');
  });

  it('gives each wallet its own records: another wallet sees nothing under the same name (WS-2, #138)', async () => {
    // WHY: wallets shared one flat key space, so a fixed-name record of one overwrote another's, and listing a shared
    // prefix hit a GCM failure on the other wallet's records. Each wallet's records now live under its own scope.
    const raw = new MemoryStorageAdapter();
    await raw.open(ns);
    const a = resolveWalletStorage(raw, new Uint8Array(32).fill(1), false);
    const b = resolveWalletStorage(raw, new Uint8Array(32).fill(2), false);
    await a.put('chain/scan-state', enc('A private notes'));
    expect(await b.get('chain/scan-state')).toBeUndefined();
    await b.put('chain/scan-state', enc('B'));
    expect(dec((await a.get('chain/scan-state'))!)).toBe('A private notes');
  });
});

describe('wallet records on a shared adapter (#138)', () => {
  // A MemoryStorageAdapter that records every batch's options, to see which writes ask for durability.
  class RecordingStore extends MemoryStorageAdapter {
    readonly batches: { keys: string[]; durable: boolean }[] = [];
    override async batch(ops: Parameters<MemoryStorageAdapter['batch']>[0], options?: { durable?: boolean }): Promise<void> {
      this.batches.push({ keys: ops.map((o) => o.key), durable: options?.durable === true });
      return super.batch(ops);
    }
  }

  it('writes spend holds durably, under the wallet\'s own scope', async () => {
    // WHY: a lost hold re-exposes an in-flight note to the planner (a wasted proof), so the holds record is committed
    // to disk before markSpendPending resolves. Scan state is a cache and stays a relaxed write.
    const store = new RecordingStore();
    const sdk = await createArmadaSdk({ ...makeConfig(), storage: store });
    const wallet = await sdk.wallet.fromRootSecret(seed(0x33), { creationBlock: 1 });
    await wallet.markSpendPending([], `0x${'ab'.repeat(32)}`); // always writes the holds record (none → a delete)
    const tag = walletRecordId((await deriveKeyset(seed(0x33))).viewingPrivateKey);
    expect(store.batches).toContainEqual({ keys: [`chain/${tag}/pending-spends`], durable: true });
    await sdk.close();
  });

  it('a store written under the previous key layout (schema 1) is reset once, so its records are rebuilt (#138)', async () => {
    // WHY: scoping changed where every wallet record lives. The storage schema version moved to 2, so opening an older
    // store runs the deployment-change reset: the stale chain records go, and the wallet rescans into the new layout.
    const store = new MemoryStorageAdapter();
    await store.open({ schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
    await store.put('chain/scan-state/0123456789abcdef', new Uint8Array([1]));
    await store.close();
    const events: string[] = [];
    const sdk = await createArmadaSdk({ ...makeConfig(), storage: store, telemetry: { emit: (...[event]) => { events.push(event); } } });
    expect(events).toContain('storage.chain-reset');
    expect(await store.get('chain/scan-state/0123456789abcdef')).toBeUndefined();
    await sdk.close();
  });
});

// The `balance:updated` / `note:received` payloads carry BOTH the canonical `tokenHash` (joins
// `balances()`) and the resolved `tokenAddress`. An unregistered hash yields no address, so the
// builder returns undefined and the emit site skips it.
describe('event payload builders (token identifier resolution)', () => {
  const HASH = 'cd'.repeat(32);
  const ADDR = `0x${'ab'.repeat(20)}` as const;
  const UNREGISTERED = 'ff'.repeat(32);
  // Registered iff the (0x-normalized) hash is HASH.
  const resolve = (hash: string): `0x${string}` | undefined =>
    hash === HASH || hash === `0x${HASH}` ? ADDR : undefined;

  it('buildBalanceUpdate carries both tokenHash and tokenAddress', () => {
    expect(buildBalanceUpdate(HASH, 100n, 5n, resolve)).toEqual({
      tokenHash: HASH,
      tokenAddress: ADDR,
      spendable: 100n,
      pending: 5n,
    });
  });

  it('buildBalanceUpdate normalizes a 0x-prefixed hash to the balances() join key', () => {
    expect(buildBalanceUpdate(`0x${HASH}`, 1n, 0n, resolve)).toEqual({
      tokenHash: HASH,
      tokenAddress: ADDR,
      spendable: 1n,
      pending: 0n,
    });
  });

  it('buildBalanceUpdate returns undefined for an unregistered token (caller skips the emit)', () => {
    expect(buildBalanceUpdate(UNREGISTERED, 1n, 0n, resolve)).toBeUndefined();
  });

  it('buildReceivedNote carries both ids plus disclosed memo/sender', () => {
    const txo = {
      tree: 0,
      position: 0,
      tokenHash: HASH,
      value: 250n,
      blockNumber: 10,
      txid: `0x${'ee'.repeat(32)}`,
      origin: 'transact' as const,
      random: '00'.repeat(16),
      notePublicKey: 0n,
      memo: 'gm',
      senderShieldedAddress: '0zk_alice',
    };
    expect(buildReceivedNote(txo, resolve)).toEqual({
      tokenHash: HASH,
      tokenAddress: ADDR,
      value: 250n,
      memo: 'gm',
      senderShieldedAddress: '0zk_alice',
    });
  });

  it('buildReceivedNote omits absent memo/sender and skips an unregistered token', () => {
    const base = {
      tree: 0,
      position: 1,
      value: 7n,
      blockNumber: 10,
      txid: `0x${'ee'.repeat(32)}`,
      origin: 'transact' as const,
      random: '00'.repeat(16),
      notePublicKey: 0n,
    };
    expect(buildReceivedNote({ ...base, tokenHash: HASH }, resolve)).toEqual({
      tokenHash: HASH,
      tokenAddress: ADDR,
      value: 7n,
    });
    expect(buildReceivedNote({ ...base, tokenHash: UNREGISTERED }, resolve)).toBeUndefined();
  });
});

describe('wallet.consolidate + planTransferAfter (issue #98)', () => {
  // The armada-circuits v0.1.0-dev registered set (no Nx3 above N=4).
  const SHAPES = ['1x1', '1x2', '1x3', '2x1', '2x2', '2x3', '3x1', '3x2', '3x3', '4x1', '4x2', '4x3',
    '5x1', '5x2', '6x1', '6x2', '7x1', '8x1', '8x4'];
  const USDC_HASH = getTokenDataHash(getTokenDataERC20(USDC));
  const FEE = { perProof: 1n, broadcasterShieldedAddress: '0zk_broadcaster' };
  const leaf = (n: number): string => n.toString(16).padStart(64, '0');

  // A spend-capable wallet whose persisted scan state holds USDC notes of the given values, per tree.
  async function walletWithNotes(
    notesByTree: Record<number, bigint[]>,
    shapes: string[] | null = SHAPES,
    poolOptions: Partial<ArmadaSdkConfig['pool']> = {},
    // How the test loads its wallet (the seeded notes belong to seed 0x55's viewing key).
    load: (sdk: ArmadaSdk) => Promise<Wallet> = (sdk) => sdk.wallet.fromRootSecret(seed(0x55), { creationBlock: 1 }),
  ) {
    await initPoseidonPromise;
    const store = new MemoryStorageAdapter();
    await store.open({ schemaVersion: 4, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
    const trees = Object.entries(notesByTree).map(([tree, values]) => ({
      tree: Number(tree),
      leaves: values.map((_, i) => leaf(Number(tree) * 1000 + i + 1)),
    }));
    const txos = Object.entries(notesByTree).flatMap(([tree, values]) =>
      values.map((value, position) => ({
        tree: Number(tree), position, tokenHash: USDC_HASH, value: value.toString(), blockNumber: 1,
        txid: `0x${'ee'.repeat(32)}`, origin: 'transact' as const, random: '00'.repeat(16), notePublicKey: '0',
      })),
    );
    const state = WalletScanState.restore({ trees, txos, spent: [], unshields: [], sent: [] });
    await seedScanState(store, (await deriveKeyset(seed(0x55))).viewingPrivateKey, state, 500);
    await store.close(); // the SDK opens it itself, as a fresh instance would
    const base = makeConfig();
    const sdk = await createArmadaSdk({
      ...base,
      pool: { ...base.pool, ...(shapes ? { supportedShapes: shapes } : {}), ...poolOptions },
      storage: store,
      dangerouslyAllowPlaintextStorage: true,
    });
    const wallet = await load(sdk); // loads the saved scan state
    return { sdk, wallet };
  }

  describe('custody (#140)', () => {
    // An ExternalSigner standing in for an HSM: it reports `publicFrom`'s spending key and signs with `signWith`'s.
    async function externalSigner(publicFrom: number, signWith = publicFrom): Promise<ExternalSigner> {
      const reporter = await LocalSigner.fromRootSecret(seed(publicFrom));
      const signer = await LocalSigner.fromRootSecret(seed(signWith));
      return new ExternalSigner((requests) => signer.signBatch(requests), () => reporter.getSpendingPublicKey());
    }
    const viewingKeyOf = async (fill: number): Promise<string> => {
      const k = await deriveKeyset(seed(fill));
      return encodeShareableViewingKey({ viewingPrivateKey: k.viewingPrivateKey, spendingPublicKey: k.spendingPublicKey });
    };
    const recipient = async (): Promise<string> => (await deriveKeyset(seed(0x66))).shieldedAddress;

    it('spends from a viewing key plus an external signer, so the SDK never sees the root secret', async () => {
      // WHY: an external signer could only be attached to a wallet built from the root secret or mnemonic, so the SDK
      // derived (and held) the spend key anyway. A viewing key + signer keeps the spend key out of the process.
      const signer = await externalSigner(0x55);
      const svk = await viewingKeyOf(0x55);
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] }, SHAPES, {}, (s) => s.wallet.viewOnlyFromViewingKey(svk, { creationBlock: 1, signer }));
      expect(wallet.canSpend).toBe(true);
      const plans = await wallet.planTransfer({ outputs: [{ to0zk: await recipient(), amount: 5n }] });
      await expect(wallet.proveAll(plans)).resolves.toHaveLength(1);
      await sdk.close();
    });

    it("rejects, at load, a signer whose key isn't the wallet's", async () => {
      // WHY: the signer's key was never checked. A wrong-key signer was accepted as canSpend, and failed only as an
      // opaque circuit error after ~30s of proving, with its signatures already released.
      const wrong = await externalSigner(0x66);
      await expect(walletWithNotes({ 0: [20n] }, SHAPES, {}, (s) => s.wallet.fromRootSecret(seed(0x55), { creationBlock: 1, signer: wrong })))
        .rejects.toBeInstanceOf(SignerContractViolationError);
      const svk = await viewingKeyOf(0x55);
      await expect(walletWithNotes({ 0: [20n] }, SHAPES, {}, (s) => s.wallet.viewOnlyFromViewingKey(svk, { creationBlock: 1, signer: wrong })))
        .rejects.toBeInstanceOf(SignerContractViolationError);
    });

    it("verifies every signature before proving: a signature that doesn't match the wallet's key fails fast", async () => {
      const lying = await externalSigner(0x55, 0x66); // reports the right key, signs with another
      proveCalls = 0;
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] }, SHAPES, {}, (s) => s.wallet.fromRootSecret(seed(0x55), { creationBlock: 1, signer: lying }));
      const plans = await wallet.planTransfer({ outputs: [{ to0zk: await recipient(), amount: 5n }] });
      await expect(wallet.proveAll(plans)).rejects.toBeInstanceOf(SignerContractViolationError);
      await expect(wallet.prove(plans[0]!)).rejects.toBeInstanceOf(SignerContractViolationError);
      expect(proveCalls).toBe(0); // rejected before any proving
      await sdk.close();
    });

    it('dispose() cancels a proof waiting on the signer, rather than waiting for its approval', async () => {
      // WHY: dispose() and close() wait for in-flight proofs before wiping keys, so a proof waiting on a person's
      // approval held them until the person answered. The wallet aborts its proofs, and the signer is told.
      const reporter = await LocalSigner.fromRootSecret(seed(0x55));
      let asked!: () => void;
      const signing = new Promise<void>((r) => (asked = r));
      const awaitingApproval = new ExternalSigner(
        (requests, options) =>
          new Promise((resolve, reject) => {
            asked();
            options?.signal?.addEventListener('abort', () => reject(new Error(`approval of ${requests.length} withdrawn`)));
          }),
        () => reporter.getSpendingPublicKey(),
      );
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] }, SHAPES, {}, (s) => s.wallet.fromRootSecret(seed(0x55), { creationBlock: 1, signer: awaitingApproval }));
      const plans = await wallet.planTransfer({ outputs: [{ to0zk: await recipient(), amount: 5n }] });
      const proving = wallet.proveAll(plans).catch((err: unknown) => err);
      await signing;
      await wallet.dispose();
      expect(await proving).toBeInstanceOf(InstanceClosedError);
      await sdk.close();
    });
  });

  // A cross-chain (CCTP) unshield destination the pool accepts: it pays the pool (`0x11…`, the test pool), and its
  // decoded binding matches its adaptParams. Callers override fields to break one rule at a time.
  const POOL = `0x${'11'.repeat(20)}` as const;
  function crossChainDestination(maxFee: bigint) {
    const binding = { kind: 'cctp' as const, recipient: `0x${'ab'.repeat(20)}` as `0x${string}`, destDomain: 3, maxFee };
    const adaptParams = encodeCctpBinding(binding.recipient, binding.destDomain, binding.maxFee);
    return { recipient: POOL as `0x${string}`, adaptParams, adaptBinding: binding };
  }

  describe('cross-chain unshields the pool rejects on-chain (#134)', () => {
    // WHY: the hub pool reverts a cross-chain unshield that isn't USDC, doesn't pay the pool, names an
    // adaptContract, or has maxFee >= its value — after ~30s of proving. The wallet refuses them at plan time.
    const plan = (wallet: Awaited<ReturnType<typeof walletWithNotes>>['wallet'], unshield: object, tokenAddress?: `0x${string}`) =>
      wallet.planTransfer({ outputs: [], unshield: { amount: 10n, ...unshield } as never, ...(tokenAddress ? { tokenAddress } : {}) });

    it('plans a well-formed cross-chain unshield (USDC, pays the pool, decoded binding)', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] });
      const [p] = await plan(wallet, crossChainDestination(1n));
      expect(p!.boundParams.decodedAdaptParams?.maxFee).toBe(1n);
      await sdk.close();
    });

    it('requires the decoded adaptBinding, so the maxFee rule can be checked', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] });
      const { recipient, adaptParams } = crossChainDestination(1n);
      const withoutBinding = { recipient, adaptParams };
      await expect(plan(wallet, withoutBinding)).rejects.toThrow(/needs unshield.adaptBinding/);
      await expect(wallet.maxUnshieldAmount({ unshield: withoutBinding })).rejects.toBeInstanceOf(InvalidRequestError);
      await sdk.close();
    });

    it('requires it to pay the pool ("Cross-chain unshield must pay the pool")', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] });
      await expect(plan(wallet, { ...crossChainDestination(1n), recipient: `0x${'ab'.repeat(20)}` })).rejects.toThrow(/must pay the pool/);
      await sdk.close();
    });

    it('requires USDC ("Cross-chain unshield is USDC-only")', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] });
      const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f' as const;
      await expect(plan(wallet, crossChainDestination(1n), DAI)).rejects.toThrow(/USDC/);
      await sdk.close();
    });

    it('rejects an adaptContract ("unexpected adaptContract")', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] });
      await expect(plan(wallet, { ...crossChainDestination(1n), adaptContract: `0x${'cc'.repeat(20)}` })).rejects.toThrow(/adaptContract/);
      await sdk.close();
    });

    it('rejects maxFee >= the unshield value ("maxFee must be below amount")', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] });
      await expect(plan(wallet, crossChainDestination(10n))).rejects.toThrow(InvalidRequestError);
      await sdk.close();
    });

    it('leaves a yield-adapter unshield alone (it is not cross-chain, so needs no CCTP binding)', async () => {
      const ADAPTER = `0x${'ad'.repeat(20)}` as const;
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] }, SHAPES, { wrappers: { yieldAdapter: ADAPTER } });
      const [p] = await plan(wallet, { recipient: ADAPTER, adaptContract: ADAPTER, adaptParams: `0x${'ef'.repeat(32)}` });
      expect(p!.boundParams.adaptContract.toLowerCase()).toBe(ADAPTER);
      await sdk.close();
    });
  });

  it('plans a consolidation with each input\'s merkle proof, old-tree notes first, at the transfer fee', async () => {
    const { sdk, wallet } = await walletWithNotes({ 0: [9n], 1: [1n, 2n, 3n] });
    const plans = await wallet.consolidate({ fee: FEE });
    expect(plans.map((p) => p.boundParams.treeNumber)).toEqual([0, 1]);
    expect(plans.map((p) => p.summary.feeOutput?.value)).toEqual([1n, 1n]);
    expect(plans.map((p) => p.summary.changeValue)).toEqual([8n, 5n]);
    for (const p of plans) expect(p.merkleProofs).toHaveLength(p.selectedInputs.length);
    await sdk.close();
  });

  it('dry-runs a blocked unshield against the wallet as it would be after the consolidation', async () => {
    const { sdk, wallet } = await walletWithNotes({ 0: [3n, 3n, 3n, 3n, 3n] });
    const unshield = { outputs: [], unshield: { recipient: `0x${'ab'.repeat(20)}` as const, amount: 12n }, fee: FEE };
    // Five notes + unshield + fee + change = 5x3, which isn't registered — and unshields never split.
    await expect(wallet.planTransfer(unshield)).rejects.toThrow(UnsupportedCircuitShapeError);
    const consolidation = await wallet.consolidate({ fee: FEE });
    const after = await wallet.planTransferAfter(consolidation, unshield);
    expect(after).toHaveLength(1);
    expect(after[0]!.shape).toEqual({ nullifiers: 1, commitments: 3 });
    await sdk.close();
  });

  it('requires spend capability', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const full = await sdk.wallet.fromRootSecret(seed(0x11), { creationBlock: 1, signer: await LocalSigner.fromRootSecret(seed(0x11)) });
    const viewOnly = await sdk.wallet.viewOnlyFromViewingKey(full.shareViewingKey(), { creationBlock: 1 });
    await expect(viewOnly.consolidate({ fee: FEE })).rejects.toThrow(NoSpendCapabilityError);
    await sdk.close();
  });

  it('requires the pool\'s supportedShapes (consolidation groups are sized from them)', async () => {
    const { sdk, wallet } = await walletWithNotes({ 0: [1n, 2n] }, null);
    await expect(wallet.consolidate({ fee: FEE })).rejects.toThrow(InvalidRequestError);
    await sdk.close();
  });

  describe('sweeping small notes (fragmented wallets)', () => {
    const transfer = { outputs: [{ to0zk: '0zk_recipient', amount: 5n }], fee: FEE }

    it('by default, a wallet of 5+ notes spends its smallest ones into the change — with their merkle proofs', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [10n, 1n, 1n, 1n, 1n] })
      const [plan] = await wallet.planTransfer(transfer)
      expect(plan!.selectedInputs.map((t) => t.value)).toEqual([10n, 1n, 1n, 1n])
      expect(plan!.merkleProofs).toHaveLength(4)
      expect(plan!.summary.feeOutput?.value).toBe(1n)
      expect(plan!.summary.changeValue).toBe(7n)
      await sdk.close()
    })

    it('is configurable per pool (0 turns it off)', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [10n, 1n, 1n, 1n, 1n] }, SHAPES, { sweepNoteThreshold: 0 })
      const [plan] = await wallet.planTransfer(transfer)
      expect(plan!.selectedInputs.map((t) => t.value)).toEqual([10n])
      await sdk.close()
    })
  })

  describe('maxTransferAmount', () => {
    const FEE_3 = { ...FEE, perProof: 3n };
    const transferOf = (amount: bigint) => ({ outputs: [{ to0zk: '0zk_recipient', amount }], fee: FEE_3 });

    it('is the largest transfer planTransfer accepts, at the per-proof transfer fee', async () => {
      // Six 10s + a 2: all seven notes split into 2 proofs (62 − 6 = 56), but the six 10s fit ONE proof (60 − 3).
      const { sdk, wallet } = await walletWithNotes({ 0: [10n, 10n, 10n, 10n, 10n, 10n, 2n] });
      const max = await wallet.maxTransferAmount({ fee: FEE_3 });
      expect(max).toBe(57n);
      await expect(wallet.planTransfer(transferOf(max))).resolves.toHaveLength(1);
      await expect(wallet.planTransfer(transferOf(max + 1n))).rejects.toThrow();
      await sdk.close();
    });

    it('maxUnshieldAmount: one proof (unshields never split), at the given per-proof fee', async () => {
      // Seven 10s: a transfer could split, but an unshield's largest no-change proof is 6x2 → 60 − 3.
      const { sdk, wallet } = await walletWithNotes({ 0: Array.from({ length: 7 }, () => 10n) })
      const fee = { ...FEE, perProof: 3n }
      const recipient = `0x${'ab'.repeat(20)}` as const
      const max = await wallet.maxUnshieldAmount({ fee })
      expect(max).toBe(57n)
      const unshieldOf = (amount: bigint) => ({ outputs: [], unshield: { recipient, amount }, fee })
      await expect(wallet.planTransfer(unshieldOf(max))).resolves.toHaveLength(1)
      await expect(wallet.planTransfer(unshieldOf(max + 1n))).rejects.toThrow()
      await sdk.close()
    })

    it('maxUnshieldAmount: a CCTP-bound unshield at its (cross-chain) per-proof fee', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: Array.from({ length: 7 }, () => 10n) })
      const fee = { ...FEE, perProof: 5n }
      expect(await wallet.maxUnshieldAmount({ fee, unshield: crossChainDestination(1n) })).toBe(55n) // 60 − 5
      await sdk.close()
    })

    it('leaves out notes a pending spend holds', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [20n, 10n] });
      expect(await wallet.maxTransferAmount({ fee: FEE_3 })).toBe(27n); // 30 − 3
      const pending = await wallet.planTransfer(transferOf(15n)); // spends the 20
      await wallet.markSpendPending(pending, `0x${'ab'.repeat(32)}`);
      expect(await wallet.maxTransferAmount({ fee: FEE_3 })).toBe(7n); // the 10 − 3
      await sdk.close();
    });
  });

  describe('an in-proof fee is USDC-only (#115)', () => {
    // WHY: the fee note is minted in the spent token, so a fee on a shares (or any non-USDC) spend paid the relayer
    // in shares, which it doesn't count: the relayer rejected the spend after the proof (FEE_INSUFFICIENT). A yield
    // redeem's fee is already paid contract-side in USDC, so a fee there charged the user twice.
    const SHARES = `0x${'5e'.repeat(20)}` as const;

    it('rejects a non-USDC spend that carries a fee, pointing at the paths that pay the relayer in USDC', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] });
      const request = { outputs: [], unshield: { recipient: `0x${'ab'.repeat(20)}` as const, amount: 5n }, tokenAddress: SHARES, fee: FEE };
      await expect(wallet.planTransfer(request)).rejects.toThrow(/fee .*USDC/);
      await expect(wallet.maxUnshieldAmount({ fee: FEE, tokenAddress: SHARES })).rejects.toBeInstanceOf(InvalidRequestError);
      await sdk.close();
    });

    it('still plans a non-USDC spend with no fee (e.g. a yield redeem, paid contract-side)', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] }); // USDC notes only, so planning finds no shares
      const request = { outputs: [], unshield: { recipient: `0x${'ab'.repeat(20)}` as const, amount: 5n }, tokenAddress: SHARES };
      await expect(wallet.planTransfer(request)).rejects.toThrow(/no single tree covers/); // past the fee guard
      await sdk.close();
    });
  });

  describe('fee input (#121)', () => {
    it('with no fee, a plan carries no fee note (e.g. a yield redeem paid contract-side, or self-submission)', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] });
      const [plan] = await wallet.planTransfer({ outputs: [{ to0zk: '0zk_recipient', amount: 5n }] });
      expect(plan!.summary.feeOutput).toBeUndefined();
      expect(plan!.summary.changeValue).toBe(15n);
      await sdk.close();
    });

    it('with a fee, the plan pays exactly `perProof` to the broadcaster', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] });
      const [plan] = await wallet.planTransfer({ outputs: [{ to0zk: '0zk_recipient', amount: 5n }], fee: { perProof: 3n, broadcasterShieldedAddress: '0zk_broadcaster' } });
      expect(plan!.summary.feeOutput).toMatchObject({ toShieldedAddress: '0zk_broadcaster', value: 3n });
      await sdk.close();
    });
  });

  describe('prove expiresAt (#121)', () => {
    it('stamps the policy TTL onto every handle proveAll returns', async () => {
      const { sdk, wallet } = await walletWithNotes({ 0: [20n] });
      const plans = await wallet.planTransfer({ outputs: [{ to0zk: (await deriveKeyset(seed(0x66))).shieldedAddress, amount: 5n }] });
      const deadline = Date.now() + 60_000;
      const handles = await wallet.proveAll(plans, { expiresAt: deadline });
      expect(handles.map((h) => h.expiresAt)).toEqual([deadline]);
      await sdk.close();
    });
  });
});

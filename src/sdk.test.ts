// ABOUTME: Offline tests for createArmadaSdk (§4.1) — instance lifecycle, wallet identity parity,
// ABOUTME: spend-capability gating, close(), and documented not-implemented factory methods. No network.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createArmadaSdk,
  planSyncWindow,
  quickSyncTelemetry,
  classifyQuickSyncReason,
  feeScheduleKey,
  finalRootCheckRequired,
  resolveWalletStorage,
  effectiveScanHead,
  shouldRecoverFromReorg,
  buildBalanceUpdate,
  buildReceivedNote,
} from './sdk';
import { RootMismatchError, QuickSyncSchemaError, IndexerHttpError, PositionGapError } from './errors';
import { deriveKeyset, LocalSigner } from './wallet/index';
import { saveScanState, WalletScanState } from './sync/index';
import { MemoryStorageAdapter } from './storage/index';
import { NoSpendCapabilityError, InvalidKeyMaterialError } from './errors';
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

  it('syncStatus reports the checkpoint (creationBlock-1 fresh) and syncing=false without a sync (P4.6)', async () => {
    const sdk = await createArmadaSdk(makeConfig());
    const wallet = await sdk.wallet.fromRootSecret(seed(0x66), { creationBlock: 5 });
    expect(await wallet.syncStatus()).toEqual({ syncedThrough: 4, syncing: false }); // no persisted state yet
    await sdk.close();
  });

  it('syncStatus hydrates the persisted checkpoint from storage (P4.6)', async () => {
    const store = new MemoryStorageAdapter();
    await store.open({ schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
    const address = (await deriveKeyset(seed(0x77))).shieldedAddress;
    await saveScanState(store, address, new WalletScanState(), 500); // pre-seed a checkpoint at block 500

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
    await store.open({ schemaVersion: 1, chainId: 31337, poolAddress: `0x${'11'.repeat(20)}`, deployBlock: 1 });
    const events: { event: string; data: Readonly<Record<string, unknown>> }[] = [];
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
});

describe('feeScheduleKey — bind the fee tier matching the plan op (SPEC §4.6.1)', () => {
  const YIELD = `0x${'ab'.repeat(20)}` as const;
  const CCTP = `0x${'cd'.repeat(20)}` as const;

  it('a plain transfer (no unshield) binds the transfer tier', () => {
    expect(feeScheduleKey({}, undefined)).toBe('transfer');
  });

  it('a bare unshield (no adapt) binds the unshield tier', () => {
    expect(feeScheduleKey({ unshield: { recipient: CCTP, amount: 1n } }, undefined)).toBe('unshield');
  });

  it('a cross-chain unshield (CCTP adaptParams) binds the crossChainUnshield tier', () => {
    // WHY: the relayer submits this through atomicCrossChainUnshield → crossChainUnshield fee. Binding
    // the (lower) transfer tier makes the relayer reject the tx AFTER the user proved for ~30s.
    expect(
      feeScheduleKey(
        { unshield: { recipient: CCTP, amount: 1n, adaptParams: '0xdead', adaptContract: CCTP } },
        YIELD.toLowerCase(),
      ),
    ).toBe('crossChainUnshield');
  });

  it('a yield redeem (unshield to the yield adapter) binds the crossContract tier', () => {
    // WHY: redeemAndShield → crossContract fee; the yield adapter is the tell, not the presence of adaptParams.
    expect(
      feeScheduleKey(
        { unshield: { recipient: YIELD, amount: 1n, adaptParams: '0xbeef', adaptContract: YIELD } },
        YIELD.toLowerCase(),
      ),
    ).toBe('crossContract');
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

  it('returns the raw adapter unwrapped ONLY with the explicit danger flag', async () => {
    const raw = new MemoryStorageAdapter();
    expect(resolveWalletStorage(raw, vk, true)).toBe(raw);
  });

  it('derives distinct per-wallet keys so one wallet cannot read another\'s records', async () => {
    // WHY: storage is shared across wallets in an instance; an instance-wide key would let wallet B
    // decrypt wallet A's blobs. Per-wallet keys (from the viewing key) make that a GCM auth failure.
    const raw = new MemoryStorageAdapter();
    await raw.open(ns);
    const a = resolveWalletStorage(raw, new Uint8Array(32).fill(1), false);
    const b = resolveWalletStorage(raw, new Uint8Array(32).fill(2), false);
    await a.put('chain/scan-state/shared-key', enc('A private notes'));
    await expect(b.get('chain/scan-state/shared-key')).rejects.toThrow();
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

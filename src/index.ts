// ABOUTME: Root entry for @armada/sdk — the instance API (SPEC §4.1) plus the frozen public contracts
// ABOUTME: (errors + storage/sync/prover/tx/wallet interfaces). Implementations land per SPEC phases.

import type { StorageAdapter } from './storage/index';
import type { ProverAdapter, ArtifactSource } from './prover/index';
import type { WalletFactory } from './wallet/index';

export interface PoolConfig {
  readonly chainId: number;
  readonly poolAddress: `0x${string}`;
  readonly deployBlock: number;
  readonly usdcAddress: `0x${string}`;
  /**
   * @deprecated No longer required. ERC20 token hashes are self-describing (the hash is the padded
   * address), so the SDK scans, reports, and reconstructs history for ANY pool ERC20 without
   * pre-registration (issue #90). Retained for backward compatibility; currently ignored.
   */
  readonly additionalTokens?: readonly `0x${string}`[];
  readonly wrappers?: { gaslessShield?: `0x${string}`; yieldAdapter?: `0x${string}` };
  readonly cctp?: { domain: number; messenger: `0x${string}` };
  /**
   * Confirmations a commitment needs before it counts as **spendable** rather than **pending** in
   * `balances()` (default 0 = count immediately). Set it to the pool's finality depth to give recent
   * shields/transfers a reorg buffer in the balance view. (Spend-path gating and a checkpoint reorg
   * margin are tracked separately — they need reorg-aware tree truncation.)
   */
  readonly finalityThreshold?: number;
  /**
   * Blocks to stay behind chain head when scanning (SPEC §4.4 reorg safety, default 0 = scan to head).
   * The SDK only persists commitments up to `head − confirmationDepth`, so a reorg of that depth or
   * shallower can't remove an already-scanned leaf (the append-only tree can't un-append it). Set it to a
   * small value on a fast-finality hub (a few blocks) or the finality depth for zero reorg exposure; the
   * cost is that notes in the last `confirmationDepth` blocks aren't visible/spendable until they're deeper.
   */
  readonly confirmationDepth?: number;
  /**
   * Circuit shapes (`<nullifiers>x<commitments>`, e.g. `"2x3"`) the deployment has artifacts for. When
   * set, `wallet.planTransfer` lands every plan on a listed shape — splitting a fragmented
   * single-recipient transfer across several plans when one proof's shape isn't listed — and rejects a
   * spend it can't fit up front with `UnsupportedCircuitShapeError` (or `TooFragmentedError`) instead of
   * failing late at artifact resolution / on-chain. Omit to skip the check (and never split).
   */
  readonly supportedShapes?: readonly string[];
  /**
   * Keeps wallets from fragmenting (issue #108): when a token has at least this many spendable notes, a
   * single-proof spend also spends that tree's smallest notes as extra inputs — up to the largest listed
   * shape — merging them into its change at no extra fee. The fee, the amount, and whether a spend can be
   * made never change; the proof gets larger, which is why a wallet below the threshold is left alone.
   * Needs `supportedShapes`. Default 5; 0 turns it off.
   */
  readonly sweepNoteThreshold?: number;
  /**
   * How long (ms) an optimistic in-flight spend hold survives before it's auto-released (issue #55). When
   * a spend's transaction is submitted, `wallet.markSpendPending` holds its input notes out of selection
   * so a rapid follow-up spend can't reselect them before the on-chain `Nullified` event is scanned. A
   * confirmed spend clears its hold automatically; this TTL is the safety net so a dropped/never-mined
   * (or app-crash-before-`clearSpendPending`) submission can't lock its inputs forever, including across a
   * reload. Set it comfortably above the submit→confirm→scan latency (default 300000 = 5 min).
   */
  readonly pendingSpendTtlMs?: number;
  /**
   * Default interval (ms) for `wallet.watch()` auto-sync (issue #59). `watch()` runs `sync()` on this
   * cadence so a wallet stays current without the consumer writing a poll loop; a per-call `intervalMs`
   * overrides it. Default `10000` (10s), matching the stock railgun engine's polling cadence.
   */
  readonly autoSyncIntervalMs?: number;
}

export interface RpcConfig {
  readonly urls: readonly string[];
  readonly pollIntervalMs?: number;
}

/** Injected telemetry (SPEC §8). MUST NOT receive key material, seeds, memo plaintext, or 0zk addresses. */
export interface TelemetrySink {
  emit(event: string, data: Readonly<Record<string, unknown>>): void;
}

export interface ArmadaSdkConfig {
  readonly pool: PoolConfig;
  readonly rpc: RpcConfig;
  readonly storage: StorageAdapter;
  readonly prover: ProverAdapter;
  readonly artifacts: ArtifactSource;
  readonly telemetry?: TelemetrySink;
  /**
   * Optional native quick-sync indexer (e.g. the relayer-v2 watcher) serving the `/v2/quick-sync`
   * wire contract. When set it is the primary event source, with RPC getLogs covering the tail and
   * verifying results against the on-chain root. Omit to sync purely from RPC.
   */
  readonly indexer?: {
    readonly url: string;
    /** Inject a custom fetch (proxy, instrumentation, tests). Defaults to the global fetch. */
    readonly fetchFn?: typeof fetch;
  };
  /**
   * Escape hatch that disables the SDK's at-rest encryption (SPEC §4.3). Decrypted note data, TXO
   * records, balances, and history are AEAD-encrypted at rest by default under a per-wallet key the
   * SDK derives itself — the caller's `storage` adapter is auto-wrapped, so plaintext never reaches
   * disk without setting this flag. Set it ONLY for ephemeral/test stores where at-rest secrecy is a
   * non-goal; in production it defeats WS7.2 Option B.
   */
  readonly dangerouslyAllowPlaintextStorage?: boolean;
}

/**
 * Per-instance SDK handle — no singletons, no module-level mutable state (kills the
 * `snarkjsInitialized` bug class). `sync`, `tx`, `ops`, and `preflight` are surfaced as their
 * modules land in Phase 2+.
 */
export interface ArmadaSdk {
  readonly wallet: WalletFactory;
  close(): Promise<void>;
}

/**
 * Construct an SDK instance — replaces `startRailgunEngine` + `loadProvider` + NETWORK_CONFIG
 * patching. Multiple instances per process are supported; state is instance-scoped.
 */
export { createArmadaSdk } from './sdk';
// Quick-sync telemetry payload shape (SPEC §8) — exported so a sink author can type their handler
// and switch on `reason`.
export type { QuickSyncTelemetry, QuickSyncReason } from './sdk';

export const VERSION = '0.0.0';

// ── Frozen public contracts ────────────────────────────────
export * from './errors';
export * from './storage/index';
export * from './sync/index';
export * from './prover/index';
export * from './tx/index';
export * from './wallet/index';

// ── Explicit root re-exports for node10 (classic moduleResolution) consumers ──
// A bare `export *` from a multi-entry tsup build silently drops symbols that the dts bundler assigns
// to another entry's shared chunk (the note-crypto / keyset helpers land in the `wallet`/`core` chunks
// and vanish from the root `.d.ts` even though they're present at runtime). The `./core` token layer
// isn't starred here at all — it's only reachable via the `/core` exports-map subpath, which classic
// `moduleResolution: Node` consumers (the POC relayer + interface app) can't resolve. Naming these
// explicitly pins them into the root `.d.ts`, so those consumers can import everything from the
// package root instead of hand-typed facades. Values first, then the token/keyset types they need.
export {
  createTransferNote,
  encryptNoteToReceiver,
  tryDecryptCommitment,
  tryDecryptSentCommitment,
  reconstructReceiveHistory,
  reconstructHistory,
} from './sync/index';
export type { HistoryEntry, HistoryCategory, TokenAddressResolver, ReconstructHistoryInput, SentRecipient } from './sync/index';
// Scan/balance event surface — consumers subscribe via `wallet.on(...)` and type listeners/unsubscribes.
export type { SyncEventMap, Unsubscribe } from './sync/index';
export { deriveKeyset, deriveKeysetFromMnemonic } from './wallet/index';
export type { Keyset } from './wallet/index';
export {
  getTokenDataERC20,
  getTokenDataHash,
  initPoseidonPromise,
  ChainType,
} from './core/index';
export type {
  TokenData,
  TokenDataGetter,
  Chain,
  AddressData,
  Ciphertext,
} from './core/index';

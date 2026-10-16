// ABOUTME: Validates an ArmadaSdkConfig with no network access (#121) and resolves it (F1, #143): every default applied
// ABOUTME: in one place, so the rest of the SDK reads settled values. Bad input throws InvalidConfigError.

import { InvalidConfigError } from './errors';
import type { ArmadaSdkConfig } from './index';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SHAPE = /^[1-9]\d*x[1-9]\d*$/;
const URL_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

function fail(message: string): never {
  throw new InvalidConfigError(`createArmadaSdk: ${message}`);
}

function checkAddress(value: string | undefined, field: string): void {
  if (value !== undefined && !ADDRESS.test(value)) fail(`${field} must be a 0x-prefixed 20-byte address, got ${JSON.stringify(value)}`);
}

function checkUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${field} is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (!URL_PROTOCOLS.has(url.protocol)) fail(`${field} must be an http(s) or ws(s) URL, got ${JSON.stringify(value)}`);
}

function checkInteger(value: number | undefined, field: string, min: number): void {
  if (value !== undefined && (!Number.isInteger(value) || value < min)) {
    fail(`${field} must be an integer ≥ ${min}, got ${value}`);
  }
}

/**
 * Check every field `createArmadaSdk` can check without the network. Throws `InvalidConfigError` on the
 * first problem. (That the RPC actually serves `pool.chainId` and that `pool.poolAddress` has code is
 * checked lazily, before the first sync or preflight, so creating an SDK works offline.)
 */
export function validateConfig(config: ArmadaSdkConfig): void {
  const { pool, rpc } = config;
  if (rpc.urls.length === 0) fail('rpc.urls must list at least one RPC endpoint');
  rpc.urls.forEach((u, i) => checkUrl(u, `rpc.urls[${i}]`));
  if (config.indexer !== undefined) checkUrl(config.indexer.url, 'indexer.url');

  checkInteger(pool.chainId, 'pool.chainId', 1);
  checkAddress(pool.poolAddress, 'pool.poolAddress');
  checkAddress(pool.usdcAddress, 'pool.usdcAddress');
  checkInteger(pool.deployBlock, 'pool.deployBlock', 0);
  checkAddress(pool.wrappers?.yieldAdapter, 'pool.wrappers.yieldAdapter');
  checkAddress(pool.wrappers?.gaslessShield, 'pool.wrappers.gaslessShield');
  if (pool.cctp !== undefined) {
    checkInteger(pool.cctp.domain, 'pool.cctp.domain', 0);
    checkAddress(pool.cctp.messenger, 'pool.cctp.messenger');
  }
  checkInteger(pool.confirmationDepth, 'pool.confirmationDepth', 0);
  checkInteger(pool.finalityThreshold, 'pool.finalityThreshold', 0);
  checkInteger(pool.sweepNoteThreshold, 'pool.sweepNoteThreshold', 0);
  checkInteger(pool.pendingSpendTtlMs, 'pool.pendingSpendTtlMs', 0);
  checkInteger(pool.autoSyncIntervalMs, 'pool.autoSyncIntervalMs', 1);
  for (const shape of pool.supportedShapes ?? []) {
    if (!SHAPE.test(shape)) fail(`pool.supportedShapes entries must look like "2x3", got ${JSON.stringify(shape)}`);
  }
}

/**
 * The settings the SDK runs on: a validated `ArmadaSdkConfig` with every default applied. The adapters (storage,
 * prover, artifacts, telemetry) stay on the config; this carries only values.
 */
export interface ResolvedConfig {
  readonly chainId: number;
  readonly poolAddress: `0x${string}`;
  readonly usdcAddress: `0x${string}`;
  /** Pool deploy block — where every wallet's scan (and merkle tree) starts. */
  readonly deployBlock: number;
  readonly rpcUrls: readonly string[];
  readonly indexer?: { readonly url: string; readonly fetchFn?: typeof fetch };
  /** Confirmations before a commitment is spendable vs pending in the balance view (default 0). */
  readonly finalityThreshold: number;
  /** Blocks to stay behind head when scanning — reorg safety (default 0). */
  readonly confirmationDepth: number;
  /** TTL (ms) for optimistic in-flight spend holds before auto-release (issue #55; default 300000). */
  readonly pendingSpendTtlMs: number;
  /** Default cadence (ms) for `wallet.watch()` auto-sync (issue #59; default 10000). */
  readonly autoSyncIntervalMs: number;
  /** Spendable-note count from which single-proof spends sweep the tree's smallest notes (issue #108; default 5, 0 = off). */
  readonly sweepNoteThreshold: number;
  /** Circuit shapes the deployment can prove — plan-time fail-fast set, or undefined to skip the check. */
  readonly supportedShapes: ReadonlySet<string> | undefined;
  /** Yield adapter address (lowercased), when configured — an unshield to it marks a yield op. */
  readonly yieldAdapterAddress?: string;
  /** CCTP messenger address, when configured — preflight checks its liveness for cross-chain plans. */
  readonly cctpMessenger?: `0x${string}`;
  /** When true, wallets persist through the raw adapter unencrypted — the §4.3 escape hatch. */
  readonly allowPlaintextStorage: boolean;
}

/** Validate `config` (see `validateConfig`) and apply every default. */
export function resolveConfig(config: ArmadaSdkConfig): ResolvedConfig {
  validateConfig(config);
  const { pool } = config;
  return {
    chainId: pool.chainId,
    poolAddress: pool.poolAddress,
    usdcAddress: pool.usdcAddress,
    deployBlock: pool.deployBlock,
    rpcUrls: [...config.rpc.urls],
    ...(config.indexer !== undefined ? { indexer: config.indexer } : {}),
    finalityThreshold: pool.finalityThreshold ?? 0,
    confirmationDepth: pool.confirmationDepth ?? 0,
    pendingSpendTtlMs: pool.pendingSpendTtlMs ?? 300_000,
    autoSyncIntervalMs: pool.autoSyncIntervalMs ?? 10_000,
    sweepNoteThreshold: pool.sweepNoteThreshold ?? 5,
    supportedShapes: pool.supportedShapes !== undefined ? new Set(pool.supportedShapes) : undefined,
    ...(pool.wrappers?.yieldAdapter !== undefined ? { yieldAdapterAddress: pool.wrappers.yieldAdapter.toLowerCase() } : {}),
    ...(pool.cctp?.messenger !== undefined ? { cctpMessenger: pool.cctp.messenger } : {}),
    allowPlaintextStorage: config.dangerouslyAllowPlaintextStorage === true,
  };
}

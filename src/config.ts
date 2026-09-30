// ABOUTME: Static validation of an ArmadaSdkConfig at createArmadaSdk (#121) — malformed URLs, addresses, block
// ABOUTME: numbers, TTLs, and circuit shapes fail fast with InvalidConfigError, with no network access.

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

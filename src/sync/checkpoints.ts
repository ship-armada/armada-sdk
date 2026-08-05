// ABOUTME: Scan checkpoints per (wallet, chain), persisted in storage (SPEC §4.4) — replaces the
// ABOUTME: interface's localStorage `history-checkpoint`. Chain-derived, so wiped by resetChainState.

import type { StorageAdapter } from '../storage/index';

export interface ScanCheckpoint {
  /** Highest block scanned + persisted for this (wallet, chain). */
  readonly syncedThrough: number;
}

// A minimal KV surface satisfied by both StorageAdapter and EncryptedStore (works plaintext or encrypted).
type KV = Pick<StorageAdapter, 'get' | 'put' | 'del'>;

// `chain/` prefix → resetChainState() wipes checkpoints on redeploy (they are chain-derived).
function checkpointKey(walletId: string, chainId: number): string {
  return `chain/scan-checkpoint/${chainId}/${walletId}`;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class CheckpointStore {
  constructor(private readonly storage: KV) {}

  async get(walletId: string, chainId: number): Promise<ScanCheckpoint | undefined> {
    const raw = await this.storage.get(checkpointKey(walletId, chainId));
    if (raw === undefined) return undefined;
    return JSON.parse(decoder.decode(raw)) as ScanCheckpoint;
  }

  async set(walletId: string, chainId: number, checkpoint: ScanCheckpoint): Promise<void> {
    await this.storage.put(checkpointKey(walletId, chainId), encoder.encode(JSON.stringify(checkpoint)));
  }

  async clear(walletId: string, chainId: number): Promise<void> {
    await this.storage.del(checkpointKey(walletId, chainId));
  }
}

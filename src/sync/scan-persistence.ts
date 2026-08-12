// ABOUTME: Persist/restore a wallet's scan state through a StorageAdapter (SPEC §4.3/§4.4) so sync()
// ABOUTME: resumes from the last synced block instead of rescanning the pool from genesis every time.

import type { StorageAdapter } from '../storage/index';
import { WalletScanState, type ScanStateSnapshot } from './scan-engine';

interface PersistedScan {
  readonly snapshot: ScanStateSnapshot;
  readonly syncedThrough: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// `chain/` prefix → chain-derived, so resetChainState() wipes it on redeploy (keeps identity records).
export function scanStateKey(shieldedAddress: string): string {
  return `chain/scan-state/${shieldedAddress}`;
}

/** Persist a wallet's scan state + the highest synced block. */
export async function saveScanState(
  storage: StorageAdapter,
  shieldedAddress: string,
  state: WalletScanState,
  syncedThrough: number,
): Promise<void> {
  const data: PersistedScan = { snapshot: state.snapshot(), syncedThrough };
  await storage.put(scanStateKey(shieldedAddress), encoder.encode(JSON.stringify(data)));
}

/**
 * Load a wallet's persisted scan state, or `undefined` on a first run OR when the stored record is
 * unreadable. Scan state is a chain-derived cache: a corrupt blob (a bit-flip, an interrupted write, an
 * undecryptable record after a key/format change) must degrade to a cache MISS so `sync()` rescans from
 * `creationBlock` — not throw and brick every future sync (the "delete the DB by hand" pitfall §4.3
 * deletes). The next `saveScanState` overwrites the bad record.
 */
export async function loadScanState(
  storage: StorageAdapter,
  shieldedAddress: string,
): Promise<{ state: WalletScanState; syncedThrough: number } | undefined> {
  let raw: Uint8Array | undefined;
  try {
    raw = await storage.get(scanStateKey(shieldedAddress));
  } catch {
    // e.g. an EncryptedStore GCM auth failure on a corrupted/foreign blob — treat as a cache miss.
    return undefined;
  }
  if (raw === undefined) return undefined;
  try {
    const data = JSON.parse(decoder.decode(raw)) as PersistedScan;
    if (typeof data?.syncedThrough !== 'number' || data.snapshot === undefined) return undefined;
    return { state: WalletScanState.restore(data.snapshot), syncedThrough: data.syncedThrough };
  } catch {
    // Malformed JSON / snapshot shape restore failure — rescan rather than wedge.
    return undefined;
  }
}

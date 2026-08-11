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

/** Load a wallet's persisted scan state, or `undefined` on a first run. */
export async function loadScanState(
  storage: StorageAdapter,
  shieldedAddress: string,
): Promise<{ state: WalletScanState; syncedThrough: number } | undefined> {
  const raw = await storage.get(scanStateKey(shieldedAddress));
  if (raw === undefined) return undefined;
  const data = JSON.parse(decoder.decode(raw)) as PersistedScan;
  return { state: WalletScanState.restore(data.snapshot), syncedThrough: data.syncedThrough };
}

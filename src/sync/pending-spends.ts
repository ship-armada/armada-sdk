// ABOUTME: Optimistic in-flight spend holds (issue #55) — the wallet's own "submitted, don't reselect" intent,
// ABOUTME: kept apart from chain-derived scan state in its own record, written durably when a hold changes.

import type { StorageAdapter } from '../storage/index';
import type { PendingSpend, SpentNullifier } from './balances';

// Tree-scoped nullifier key — the same position in two trees yields the same nullifier value (Railgun 9.5.4).
function holdKey(tree: number, nullifier: bigint): string {
  return `${tree}:${nullifier.toString()}`;
}

/**
 * The notes a wallet has submitted spends for but not yet seen confirmed. Planning and balances leave
 * them out so a rapid follow-up spend can't reselect an input whose transaction is still in flight. A
 * hold ends when its `Nullified` event is scanned (`releaseConfirmed`), when the submission is known to
 * have failed (`clear`), or when it outlives the TTL (`prune`).
 */
export class PendingSpends {
  private readonly holds = new Map<string, PendingSpend>();

  /**
   * Hold notes for submission `txid`; `addedAt` (epoch ms) drives TTL expiry. Idempotent per
   * `(tree, nullifier)`. Notes already confirmed spent in `spent` are skipped — the chain is authoritative.
   */
  mark(
    entries: readonly { readonly tree: number; readonly nullifier: bigint }[],
    txid: string,
    addedAt: number,
    spent: readonly SpentNullifier[],
  ): void {
    const confirmed = new Set(spent.map((s) => holdKey(s.tree, s.nullifier)));
    for (const e of entries) {
      const key = holdKey(e.tree, e.nullifier);
      if (confirmed.has(key)) continue;
      this.holds.set(key, { tree: e.tree, nullifier: e.nullifier, txid, addedAt });
    }
  }

  /** Release every hold placed by submission `txid` (a dropped or reverted tx). Returns whether any changed. */
  clear(txid: string): boolean {
    return this.deleteWhere((h) => h.txid === txid);
  }

  /** Drop holds added before `cutoff` (epoch ms) — the TTL safety net. Returns whether any changed. */
  prune(cutoff: number): boolean {
    return this.deleteWhere((h) => h.addedAt < cutoff);
  }

  /** Drop holds whose spend is now confirmed on-chain (its nullifier is in `spent`). Returns whether any changed. */
  releaseConfirmed(spent: readonly SpentNullifier[]): boolean {
    const confirmed = new Set(spent.map((s) => holdKey(s.tree, s.nullifier)));
    return this.deleteWhere((h) => confirmed.has(holdKey(h.tree, h.nullifier)));
  }

  /** The current holds — what planning and balances exclude. */
  list(): readonly PendingSpend[] {
    return [...this.holds.values()];
  }

  private deleteWhere(match: (h: PendingSpend) => boolean): boolean {
    let changed = false;
    for (const [key, h] of this.holds) {
      if (match(h)) {
        this.holds.delete(key);
        changed = true;
      }
    }
    return changed;
  }
}

// `chain/` prefix: holds point at chain-derived notes, so a redeploy reset (resetChainState) drops them too.
export function pendingSpendsKey(recordId: string): string {
  return `chain/pending-spends/${recordId}`;
}

interface PersistedHold {
  readonly tree: number;
  readonly nullifier: string;
  readonly txid: string;
  readonly addedAt: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Write the holds record (deleted when there are none). Resolves once the adapter has accepted the write. */
export async function savePendingSpends(storage: StorageAdapter, recordId: string, holds: PendingSpends): Promise<void> {
  const list = holds.list();
  if (list.length === 0) {
    await storage.del(pendingSpendsKey(recordId));
    return;
  }
  const data: PersistedHold[] = list.map((h) => ({ tree: h.tree, nullifier: h.nullifier.toString(), txid: h.txid, addedAt: h.addedAt }));
  await storage.put(pendingSpendsKey(recordId), encoder.encode(JSON.stringify(data)));
}

/**
 * Load the holds record, or an empty set on a first run or an unreadable record — a lost hold only
 * re-exposes the note to selection (preflight still catches a spent input), so it must not brick loading.
 */
export async function loadPendingSpends(storage: StorageAdapter, recordId: string): Promise<PendingSpends> {
  const holds = new PendingSpends();
  let raw: Uint8Array | undefined;
  try {
    raw = await storage.get(pendingSpendsKey(recordId));
  } catch {
    return holds;
  }
  if (raw === undefined) return holds;
  try {
    const data = JSON.parse(decoder.decode(raw)) as PersistedHold[];
    for (const h of data) holds.mark([{ tree: h.tree, nullifier: BigInt(h.nullifier) }], h.txid, h.addedAt, []);
  } catch {
    // Malformed record — start with no holds rather than fail the wallet load.
  }
  return holds;
}

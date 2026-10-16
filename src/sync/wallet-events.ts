// ABOUTME: WalletEvents (F1, #143) — a wallet's scan/balance/note event stream: the emitter, the balance diff that sends
// ABOUTME: `balance:updated` only for tokens that changed, and the `note:received` baseline that never replays history.

import { SyncEmitter } from './emitter';
import { newReceivedNotes } from './history';
import { erc20AddressFromHash, tokenHashKey, type SpentNullifier, type TokenBalance, type TXO } from './balances';
import type { TokenAddressResolver } from './history';
import type { SyncEventMap, Unsubscribe } from './index';

/**
 * Build a `balance:updated` payload for a token, resolving its address via `resolve`. The payload
 * carries BOTH the canonical `tokenHash` (normalized to the `balances()` join key) and the resolved
 * `tokenAddress`. Returns `undefined` for a hash with no registered token — an address can't be
 * recovered, so the caller skips the emit. Pure so the payload shape is unit-testable without a wallet.
 */
export function buildBalanceUpdate(
  tokenHash: string,
  spendable: bigint,
  pending: bigint,
  resolve: TokenAddressResolver,
): SyncEventMap['balance:updated'] | undefined {
  const tokenAddress = resolve(tokenHash);
  if (tokenAddress === undefined) return undefined; // unregistered token — no address to report
  return { tokenHash: tokenHashKey(tokenHash), tokenAddress, spendable, pending };
}

/**
 * Build a `note:received` payload from a freshly discovered owned TXO, resolving its token address
 * via `resolve`. Carries both `tokenHash` and `tokenAddress`, plus memo/sender when the sender
 * disclosed them. Returns `undefined` for an unregistered token (skipped — no address to report).
 */
export function buildReceivedNote(txo: TXO, resolve: TokenAddressResolver): SyncEventMap['note:received'] | undefined {
  const tokenAddress = resolve(txo.tokenHash);
  if (tokenAddress === undefined) return undefined; // unregistered token — no address to report
  return {
    tokenHash: tokenHashKey(txo.tokenHash),
    tokenAddress,
    value: txo.value,
    ...(txo.memo !== undefined ? { memo: txo.memo } : {}),
    ...(txo.senderShieldedAddress !== undefined ? { senderShieldedAddress: txo.senderShieldedAddress } : {}),
  };
}


// Resolve an owned-note token hash to its ERC-20 address, or undefined for a non-ERC20 hash. ERC20 token hashes are
// self-describing (the hash IS the padded address) — any pool token resolves directly, no registry (issue #90).
// Shared by the event payloads, `balances()` and `history()`, so all speak the same hash↔address mapping.
export const resolveTokenAddress: TokenAddressResolver = (tokenHash) => erc20AddressFromHash(tokenHash);

export class WalletEvents {
  private readonly emitter = new SyncEmitter();
  // Last-emitted per-token balance (keyed by tokenHash, no 0x) so a sync only pushes `balance:updated`
  // for tokens that actually changed — the diff that lets consumers avoid redundant re-reads.
  private readonly lastBalances = new Map<string, { spendable: bigint; pending: bigint }>();
  // Received-transfer keys already emitted as `note:received`. A loaded wallet seeds this from its saved
  // notes; a wallet with no saved state seeds it on its first sync WITHOUT emitting (so a fresh wallet
  // doesn't replay its history as "received"). Later syncs emit only genuinely-new incoming notes.
  private readonly seenReceiveKeys = new Set<string>();
  private receiveBaselined = false;

  on<K extends keyof SyncEventMap>(event: K, listener: (payload: SyncEventMap[K]) => void): Unsubscribe {
    return this.emitter.on(event, listener);
  }

  emit<K extends keyof SyncEventMap>(event: K, payload: SyncEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  /**
   * Seed the receive baseline from saved notes (the wallet's load): they're already known, so the first sync
   * reports exactly the notes that arrived since the checkpoint (e.g. while the app was closed).
   */
  baselineReceives(owned: readonly TXO[], spent: readonly SpentNullifier[], nullifyingKey: bigint): void {
    newReceivedNotes(owned, spent, nullifyingKey, this.seenReceiveKeys);
    this.receiveBaselined = true;
  }

  /** Forget everything emitted (the wallet's notes were dropped for a rescan). */
  reset(): void {
    this.lastBalances.clear();
    this.seenReceiveKeys.clear();
    this.receiveBaselined = false;
  }

  /**
   * Push `note:received` for incoming transfers discovered since the last call (`newReceivedNotes` handles the
   * classification + `tree:position` de-dup, mutating `seenReceiveKeys`). A wallet with no saved state seeds the
   * baseline on its first sync WITHOUT emitting, so it doesn't replay history.
   */
  notesReceived(owned: readonly TXO[], spent: readonly SpentNullifier[], nullifyingKey: bigint): void {
    const fresh = newReceivedNotes(owned, spent, nullifyingKey, this.seenReceiveKeys);
    if (!this.receiveBaselined) {
      this.receiveBaselined = true;
      return; // baseline: `seenReceiveKeys` is now seeded; don't emit historical receives on first load
    }
    for (const txo of fresh) {
      const payload = buildReceivedNote(txo, resolveTokenAddress);
      if (payload === undefined) continue; // unregistered token — can't resolve an address
      this.emitter.emit('note:received', payload);
    }
  }

  /**
   * Push `balance:updated` for each token whose (spendable, pending) changed since the last emit — including a token
   * fully spent (drops out of `balances`, so we emit a zero). Unregistered tokens (unknown hash → no address) are
   * skipped. The first sync after load emits the baseline for held tokens.
   */
  balancesChanged(balances: readonly TokenBalance[]): void {
    const seen = new Set<string>();
    for (const b of balances) {
      seen.add(b.tokenHash);
      const prev = this.lastBalances.get(b.tokenHash);
      if (prev !== undefined && prev.spendable === b.spendable && prev.pending === b.pending) continue;
      this.lastBalances.set(b.tokenHash, { spendable: b.spendable, pending: b.pending });
      this.emitTokenBalance(b.tokenHash, b.spendable, b.pending);
    }
    for (const [tokenHash, prev] of this.lastBalances) {
      if (seen.has(tokenHash) || (prev.spendable === 0n && prev.pending === 0n)) continue;
      this.lastBalances.set(tokenHash, { spendable: 0n, pending: 0n });
      this.emitTokenBalance(tokenHash, 0n, 0n);
    }
  }

  private emitTokenBalance(tokenHash: string, spendable: bigint, pending: bigint): void {
    const payload = buildBalanceUpdate(tokenHash, spendable, pending, resolveTokenAddress);
    if (payload === undefined) return; // unregistered token — can't resolve an address to emit
    this.emitter.emit('balance:updated', payload);
  }
}

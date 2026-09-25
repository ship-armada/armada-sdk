// ABOUTME: Native tx-history reconstruction (SPEC §5) — derives HistoryEntry[] from the wallet's own
// ABOUTME: scan state (owned notes + spent nullifiers), NOT a port of Railgun's getWalletTransactionHistory.

import { TransactNote, OutputType } from '../core/index';
import { tokenHashKey } from './balances';
import { decodeSelfMetadata } from './self-metadata';
import type { TXO, SpentNullifier } from './balances';
import type { DecodedUnshield } from './event-decoder';
import type { SentOutput } from './scan-engine';

/** A recipient output of one of the wallet's own sends (recovered sender-side). */
export interface SentRecipient {
  readonly recipientShieldedAddress: string;
  readonly value: bigint;
  readonly memo?: string;
}

export type HistoryCategory =
  | 'shield'
  | 'transfer-received'
  | 'transfer-sent'
  | 'self-transfer'
  | 'unshield'
  | 'yield-deposit'
  | 'yield-withdraw';

/**
 * One value movement the wallet participated in. Flat per (txid, owned-note) — a consumer groups by
 * `txid` for a per-transaction view. `value` is the wallet delta for `tokenAddress`: positive for
 * receives, negative for sends (set by later phases). Amounts are token base units.
 */
export interface HistoryEntry {
  readonly txid: string;
  readonly blockNumber: number;
  readonly category: HistoryCategory;
  /** Canonical 32-byte token hash (no `0x`) — the identifier `balances()` and the token events join on. */
  readonly tokenHash: string;
  readonly tokenAddress: `0x${string}`;
  readonly value: bigint;
  /** Relayer fee PAID (gross) — the in-band broadcaster fee on sends/unshields, or, on a gasless shield
   *  (issue #88 lever 2), the relayer fee note's GROSS: its value + its own protocol shield fee, i.e.
   *  what the user paid the relayer. Populated in H3 (sends) / from the Shield event (shields). */
  readonly broadcasterFee?: bigint;
  /** The broadcaster's shielded (0zk) address that the fee note paid — recovered sender-side. */
  readonly broadcasterShieldedAddress?: string;
  /** Shield fee charged (shield receives). */
  readonly shieldFee?: bigint;
  /** Protocol unshield fee (unshield entries) — from the on-chain Unshield event. */
  readonly unshieldFee?: bigint;
  /** Vault shares redeemed (yield-withdraw entries) — the vault-token amount unshielded to the adapter.
   *  Surfaced on the USDC leg so a consumer that keeps only the USDC leg still sees the share count. */
  readonly shares?: bigint;
  /** Public recipient address (unshield entries). */
  readonly recipient?: string;
  /** Sender's 0zk, if they disclosed it (transfer receives). */
  readonly senderShieldedAddress?: string;
  /** Caller metadata recovered from the spend's change-note memo (issue #88 lever 3) — the opaque blob
   *  passed to `prove({ selfMetadata })`, reproduced on a fresh scan even after local storage is cleared. */
  readonly selfMetadata?: string;
  /** Recipient outputs of a send (transfer-sent), recovered sender-side — recipient 0zk + amount + memo. */
  readonly sentOutputs?: readonly SentRecipient[];
  readonly memo?: string;
  /** Unix seconds — attached by `wallet.history()` from the block; absent in the pure reconstruction. */
  readonly timestamp?: number;
}

/** Resolve a 32-byte token hash to its address; return undefined to skip notes in unknown tokens. */
export type TokenAddressResolver = (tokenHash: string) => `0x${string}` | undefined;

const nullifierKey = (tree: number, nullifier: bigint): string => `${tree}:${nullifier.toString()}`;

const sortEntries = (a: HistoryEntry, b: HistoryEntry): number =>
  a.blockNumber - b.blockNumber || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0);

/** The wallet's unique note id — stable across syncs (a leaf never moves once inserted). */
const noteId = (txo: TXO): string => `${txo.tree}:${txo.position}`;

/**
 * Txids in which THIS wallet spent an input — its transact-origin outputs there are its own change,
 * not incoming transfers. Requires the nullifying key (a view-only wallet has it). Shared by the
 * receive reconstruction and the incremental `newReceivedNotes` detector so they never diverge.
 */
export function ownSpendTxids(
  ownedTxos: readonly TXO[],
  spentNullifiers: readonly SpentNullifier[],
  nullifyingKey: bigint,
): Set<string> {
  const spendByKey = new Map(spentNullifiers.map((s) => [nullifierKey(s.tree, s.nullifier), s]));
  const txids = new Set<string>();
  for (const txo of ownedTxos) {
    const spend = spendByKey.get(nullifierKey(txo.tree, TransactNote.getNullifier(nullifyingKey, txo.position)));
    if (spend !== undefined) txids.add(spend.txid);
  }
  return txids;
}

/**
 * Incoming-transfer notes (transact-origin owned notes that aren't our own change, i.e. NOT shields
 * and NOT change from our own spends) whose note id is not yet in `seen`. ADDS the returned notes' ids
 * to `seen` — so a caller drives incremental `note:received` emission: seed a baseline on the first
 * call (ignore the return), then emit the delta each subsequent call.
 */
export function newReceivedNotes(
  ownedTxos: readonly TXO[],
  spentNullifiers: readonly SpentNullifier[],
  nullifyingKey: bigint,
  seen: Set<string>,
): TXO[] {
  const ownSpends = ownSpendTxids(ownedTxos, spentNullifiers, nullifyingKey);
  const fresh: TXO[] = [];
  for (const txo of ownedTxos) {
    if (txo.origin === 'shield' || ownSpends.has(txo.txid)) continue;
    const id = noteId(txo);
    if (seen.has(id)) continue;
    seen.add(id);
    fresh.push(txo);
  }
  return fresh;
}

/**
 * ONE `transfer-received` entry for every note a tx paid us in one token. A fragmented sender's split
 * transfer (#95) pays the recipient one note per proof, all in the same tx, and consumers key history by
 * txid — so the notes are folded into a single entry: `value` sums them, `blockNumber` is the earliest,
 * and the memo / disclosed sender come from whichever note carries them (the memo rides on one note).
 */
function transferReceivedEntry(
  notes: readonly TXO[],
  tokenHash: string,
  tokenAddress: `0x${string}`,
): HistoryEntry {
  const first = notes[0]!;
  const memo = notes.find((n) => n.memo !== undefined)?.memo;
  const sender = notes.find((n) => n.senderShieldedAddress !== undefined)?.senderShieldedAddress;
  return {
    txid: first.txid,
    blockNumber: Math.min(...notes.map((n) => n.blockNumber)),
    category: 'transfer-received',
    tokenHash,
    tokenAddress,
    value: notes.reduce((sum, n) => sum + n.value, 0n),
    ...(memo !== undefined ? { memo } : {}),
    ...(sender !== undefined ? { senderShieldedAddress: sender } : {}),
  };
}

/**
 * ONE `shield` entry for every note a tx shielded to us in one token. Anyone can batch `shield([...])`
 * requests to our 0zk and consumers key history by txid, so the notes are folded: `value` and the
 * per-note protocol `shieldFee` are summed, and the gasless relayer fee — a per-tx figure — is attached
 * once (`relayerFee`), not once per note.
 */
function shieldEntry(
  notes: readonly TXO[],
  tokenHash: string,
  tokenAddress: `0x${string}`,
  relayerFee: bigint | undefined,
): HistoryEntry {
  const first = notes[0]!;
  const feeNotes = notes.filter((n) => n.shieldFee !== undefined);
  const memo = notes.find((n) => n.memo !== undefined)?.memo;
  const sender = notes.find((n) => n.senderShieldedAddress !== undefined)?.senderShieldedAddress;
  return {
    txid: first.txid,
    blockNumber: Math.min(...notes.map((n) => n.blockNumber)),
    category: 'shield',
    tokenHash,
    tokenAddress,
    value: notes.reduce((sum, n) => sum + n.value, 0n),
    ...(feeNotes.length > 0 ? { shieldFee: feeNotes.reduce((sum, n) => sum + n.shieldFee!, 0n) } : {}),
    ...(relayerFee !== undefined && relayerFee > 0n ? { broadcasterFee: relayerFee } : {}),
    ...(memo !== undefined ? { memo } : {}),
    ...(sender !== undefined ? { senderShieldedAddress: sender } : {}),
  };
}

/**
 * Reconstruct RECEIVE history (H1): shields the wallet deposited + transfers it received. Owned
 * transact-origin notes created in a tx where the wallet ALSO spent an input are its own change, not
 * incoming transfers, so they are excluded here — the corresponding send entry is produced by the
 * spend-side reconstruction (H2). Requires the nullifying key to detect the wallet's own spends;
 * a view-only wallet has it (derived from the viewing key), so this works for view-only too. Several
 * notes of one kind in one tx (a split send, a batched shield) are ONE entry per `(txid, token)`.
 */
export function reconstructReceiveHistory(
  ownedTxos: readonly TXO[],
  spentNullifiers: readonly SpentNullifier[],
  nullifyingKey: bigint,
  resolveToken: TokenAddressResolver,
): HistoryEntry[] {
  const ownSpends = ownSpendTxids(ownedTxos, spentNullifiers, nullifyingKey);

  const entries: HistoryEntry[] = [];
  const transfersByKey = new Map<string, { notes: TXO[]; tokenAddress: `0x${string}` }>();
  const shieldsByKey = new Map<string, { notes: TXO[]; tokenAddress: `0x${string}` }>();
  const gather = (byKey: typeof transfersByKey, txo: TXO, tokenAddress: `0x${string}`): void => {
    const key = `${txo.txid}::${txo.tokenHash}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.notes.push(txo);
    else byKey.set(key, { notes: [txo], tokenAddress });
  };
  for (const txo of ownedTxos) {
    const tokenAddress = resolveToken(txo.tokenHash);
    if (tokenAddress === undefined) continue;

    // Shields and incoming transfers are each gathered per (txid, token), so a tx paying us several
    // notes of one kind is one entry.
    if (txo.origin === 'shield') {
      gather(shieldsByKey, txo, tokenAddress);
      continue;
    }
    // transact-origin: change (skip) if created in one of our own spends, else an incoming transfer.
    if (ownSpends.has(txo.txid)) continue;
    gather(transfersByKey, txo, tokenAddress);
  }
  for (const { notes, tokenAddress } of shieldsByKey.values()) {
    entries.push(shieldEntry(notes, tokenHashKey(notes[0]!.tokenHash), tokenAddress, undefined));
  }
  for (const { notes, tokenAddress } of transfersByKey.values()) {
    entries.push(transferReceivedEntry(notes, tokenHashKey(notes[0]!.tokenHash), tokenAddress));
  }
  return entries.sort(sortEntries);
}

export interface ReconstructHistoryInput {
  readonly ownedTxos: readonly TXO[];
  readonly spentNullifiers: readonly SpentNullifier[];
  readonly unshields: readonly DecodedUnshield[];
  /** Notes the wallet authored (recovered sender-side) — recipient/fee detail of its own sends. */
  readonly sentOutputs: readonly SentOutput[];
  /** Per-txid relayer fee paid in a gasless shield we co-authored (issue #88 lever 2) — recovered from
   *  the Shield event's plaintext commitment values. Attached to the matching shield entry. */
  readonly shieldRelayerFees?: ReadonlyMap<string, bigint>;
  readonly nullifyingKey: bigint;
  /** The wallet's own 0zk address — used to recognize sends addressed to self (a self-transfer, not an
   *  outgoing payment) so they aren't misreported as money leaving the wallet. */
  readonly shieldedAddress: string;
  /** Resolve a token hash → ERC20 address for each entry (issue #90). Notes in an unresolvable token
   *  (non-ERC20 / NFT — out of scope) are skipped. Token-agnostic: every held ERC20 gets history. */
  readonly resolveToken: TokenAddressResolver;
  /** Canonical 32-byte hash (no 0x) of USDC — the yield vault's asset; distinguishes a yield deposit
   *  (asset in / shares out) from a withdrawal (shares in / asset out). Not a scoping filter. */
  readonly usdcHash: string;
  /** Yield adapter address (lowercased-compared); an unshield to it marks a yield op. */
  readonly yieldAdapterAddress?: string;
}

/**
 * Full history reconstruction (H1 receives + H2 sends/unshields/yield). Each transaction the wallet
 * participated in is classified once, per token, from owned notes + spent nullifiers + Unshield events:
 *
 *  - receive tx (no own spend): ONE `shield` and ONE `transfer-received` per `(txid, token)` however
 *    many notes paid us (a split send pays one per proof; anyone can batch shields) — unless the tx also
 *    carries an Unshield to the yield adapter, i.e. the USDC leg of a yield withdrawal → `yield-withdraw`.
 *  - spend tx (own inputs nullified): net delta = change − inputs (negative). Category by Unshield:
 *    to the adapter → `yield-deposit`; to any other address → `unshield` (+ recipient + protocol fee);
 *    none → `transfer-sent`.
 *
 * The broadcaster (relayer) fee inside a send is a non-owned output not recoverable here — H3 adds it
 * via sender-side decryption. `value` is the signed wallet delta for the token. Token-agnostic (issue
 * #90): every held ERC20 gets history, classified per `(txid, token)`; a yield op emits one entry per
 * leg (asset + vault share), distinguished by `usdcHash` (the vault asset) and value sign.
 */
export function reconstructHistory(input: ReconstructHistoryInput): HistoryEntry[] {
  const { ownedTxos, spentNullifiers, unshields, sentOutputs, nullifyingKey, shieldedAddress, resolveToken, usdcHash } = input;
  const yieldAdapter = input.yieldAdapterAddress?.toLowerCase();

  const spendByKey = new Map(spentNullifiers.map((s) => [nullifierKey(s.tree, s.nullifier), s]));
  const unshieldsByTxid = new Map<string, DecodedUnshield[]>();
  for (const u of unshields) {
    const list = unshieldsByTxid.get(u.txid);
    if (list === undefined) unshieldsByTxid.set(u.txid, [u]);
    else list.push(u);
  }
  // Our authored outputs per txid — recipient transfers + broadcaster fee, across ALL tokens.
  const sentByTxid = new Map<string, SentOutput[]>();
  for (const s of sentOutputs) {
    const list = sentByTxid.get(s.txid);
    if (list === undefined) sentByTxid.set(s.txid, [s]);
    else list.push(s);
  }

  // Which owned notes we spent, and in which spend. The whole Nullify marker is kept (not just its
  // txid) because the spend's own block — not the input note's origin block — dates the send entry.
  const spendOf = new Map<TXO, SpentNullifier>();
  // (txid, tokenHash) pairs where we spent an input of that token — token-scoped so a note received in a
  // tx where we only spent a DIFFERENT token (e.g. the USDC returned by a yield withdrawal that spent
  // shares) is correctly a receive, not our change.
  const spentTokenInTxid = new Set<string>();
  for (const txo of ownedTxos) {
    const spend = spendByKey.get(nullifierKey(txo.tree, TransactNote.getNullifier(nullifyingKey, txo.position)));
    if (spend !== undefined) {
      spendOf.set(txo, spend);
      spentTokenInTxid.add(`${spend.txid}::${txo.tokenHash}`);
    }
  }

  // Per-(txid, token) aggregation — a single tx can move multiple tokens (a yield op moves the asset AND
  // the vault share), so each token is classified independently.
  interface Agg {
    txid: string;
    tokenHash: string;
    blockNumber: number;
    inputs: bigint;
    change: bigint;
    receives: TXO[];
    selfMetadata?: string;
  }
  const byKey = new Map<string, Agg>();
  const keyOf = (txid: string, tokenHash: string): string => `${txid}::${tokenHash}`;
  const agg = (txid: string, tokenHash: string, blockNumber: number): Agg => {
    const key = keyOf(txid, tokenHash);
    let a = byKey.get(key);
    if (a === undefined) {
      a = { txid, tokenHash, blockNumber, inputs: 0n, change: 0n, receives: [] };
      byKey.set(key, a);
    } else {
      a.blockNumber = Math.min(a.blockNumber, blockNumber);
    }
    return a;
  };
  for (const txo of ownedTxos) {
    const token = txo.tokenHash;
    const spentIn = spendOf.get(txo);
    if (spentIn !== undefined) agg(spentIn.txid, token, spentIn.blockNumber).inputs += txo.value;
    // A transact note is our change only if we spent the SAME token in that tx; otherwise it's a receive.
    if (spentTokenInTxid.has(keyOf(txo.txid, token)) && txo.origin === 'transact') {
      const a = agg(txo.txid, token, txo.blockNumber);
      a.change += txo.value;
      // Recover caller metadata stashed in the change note's memo (issue #88 lever 3). Only the change
      // note carries the tagged blob; a user's self-transfer memo won't match the marker.
      const meta = decodeSelfMetadata(txo.memo);
      if (meta !== undefined) a.selfMetadata = meta;
    } else {
      agg(txo.txid, token, txo.blockNumber).receives.push(txo);
    }
  }

  const entries: HistoryEntry[] = [];
  for (const a of byKey.values()) {
    const { txid, tokenHash } = a;
    const tokenAddress = resolveToken(tokenHash);
    if (tokenAddress === undefined) continue; // unresolvable (non-ERC20 / NFT — out of scope): can't represent
    const isUsdc = tokenHash === usdcHash;
    const txUnshields = unshieldsByTxid.get(txid) ?? [];
    const toAdapter = yieldAdapter !== undefined && txUnshields.some((u) => u.to.toLowerCase() === yieldAdapter);
    const external = txUnshields.filter((u) => yieldAdapter === undefined || u.to.toLowerCase() !== yieldAdapter);
    const weSpentThisToken = spentTokenInTxid.has(keyOf(txid, tokenHash));

    if (weSpentThisToken) {
      const net = a.change - a.inputs; // negative: this token's shielded balance decreased
      // Sender-side detail for THIS token: split authored outputs into recipient transfers vs broadcaster fee.
      const outs = (sentByTxid.get(txid) ?? []).filter((o) => o.tokenHash === tokenHash);
      const transfers = outs.filter((o) => (o.outputType ?? OutputType.Transfer) === OutputType.Transfer);
      const feeOutputs = outs.filter((o) => o.outputType === OutputType.BroadcasterFee);
      const broadcasterFee = feeOutputs.reduce((acc, o) => acc + o.value, 0n);
      // A Transfer output addressed to OUR OWN 0zk is a self-transfer leg — the value comes straight back
      // (already netted into `change`), so it is NOT an outgoing payment and is kept out of `sentOutputs`.
      const externalTransfers = transfers.filter((o) => o.recipientShieldedAddress !== shieldedAddress);
      const selfTransfers = transfers.filter((o) => o.recipientShieldedAddress === shieldedAddress);
      const feeField = {
        ...(broadcasterFee > 0n ? { broadcasterFee } : {}),
        ...(feeOutputs[0] !== undefined ? { broadcasterShieldedAddress: feeOutputs[0].recipientShieldedAddress } : {}),
        ...(a.selfMetadata !== undefined ? { selfMetadata: a.selfMetadata } : {}),
      };
      const recipients: SentRecipient[] = externalTransfers.map((o) => ({
        recipientShieldedAddress: o.recipientShieldedAddress,
        value: o.value,
        ...(o.memo !== undefined ? { memo: o.memo } : {}),
      }));
      const sentField = recipients.length > 0 ? { sentOutputs: recipients } : {};

      if (toAdapter) {
        // We spent this token into the yield adapter: the asset (USDC) → deposit, the vault share → withdraw.
        entries.push({ txid, blockNumber: a.blockNumber, category: isUsdc ? 'yield-deposit' : 'yield-withdraw', tokenHash, tokenAddress, value: net, ...feeField });
      } else if (external.length > 0) {
        const u = external[0]!;
        entries.push({ txid, blockNumber: a.blockNumber, category: 'unshield', tokenHash, tokenAddress, value: net, unshieldFee: u.fee, recipient: u.to, ...feeField });
      } else if (externalTransfers.length === 0 && selfTransfers.length > 0) {
        // Positively recovered outputs, all addressed to ourselves: a self-transfer (consolidation).
        // `value` is just the fee. (When NO recipients were recovered we can't tell self from external,
        // so that falls through to `transfer-sent`.)
        entries.push({ txid, blockNumber: a.blockNumber, category: 'self-transfer', tokenHash, tokenAddress, value: net, ...feeField });
      } else {
        entries.push({ txid, blockNumber: a.blockNumber, category: 'transfer-sent', tokenHash, tokenAddress, value: net, ...feeField, ...sentField });
      }
      continue;
    }

    // Receive side for this token. In a yield op the returned/minted token comes back here: the asset
    // (USDC) returned → withdraw, the vault share minted → deposit.
    if (toAdapter && a.receives.length > 0) {
      const sum = a.receives.reduce((acc, r) => acc + r.value, 0n);
      if (isUsdc) {
        // yield-withdraw USDC leg. Attach BOTH pieces the counterpart share leg / re-shield fee would
        // otherwise strand, so a consumer that keeps only this USDC leg is whole:
        //  - `shares`: the vault shares redeemed = the vault-token unshield to the adapter (this txid's
        //    only adapter-unshield on a withdraw).
        //  - `broadcasterFee`: the relayer's re-shield fee note (GROSS), captured by `shieldRelayerFees`
        //    (issue #92) — the redeem re-shields USDC to the user AND a fee note to the relayer.
        const shares = txUnshields.find((u) => u.to.toLowerCase() === yieldAdapter)?.amount;
        const relayerFee = input.shieldRelayerFees?.get(txid);
        entries.push({
          txid, blockNumber: a.blockNumber, category: 'yield-withdraw', tokenHash, tokenAddress, value: sum,
          ...(shares !== undefined ? { shares } : {}),
          ...(relayerFee !== undefined && relayerFee > 0n ? { broadcasterFee: relayerFee } : {}),
        });
      } else {
        entries.push({ txid, blockNumber: a.blockNumber, category: 'yield-deposit', tokenHash, tokenAddress, value: sum });
      }
      continue;
    }
    // Shields in this tx + token: one entry however many notes (#102). Gasless shields carry a relayer
    // fee note in the same txid (issue #88); its GROSS (note + its own shield fee) is the entry's
    // broadcaster fee, so the recovered shield matches the local record's total — user notes + user
    // shield fees + relayer gross reconstructs the full deposit. It's per tx, so it's attached once.
    const shieldsIn = a.receives.filter((r) => r.origin === 'shield');
    if (shieldsIn.length > 0) {
      entries.push(shieldEntry(shieldsIn, tokenHash, tokenAddress, input.shieldRelayerFees?.get(txid)));
    }
    // Incoming transfers in this tx + token: one entry however many notes paid us (a split send, #100).
    const transfersIn = a.receives.filter((r) => r.origin !== 'shield');
    if (transfersIn.length > 0) entries.push(transferReceivedEntry(transfersIn, tokenHash, tokenAddress));
  }
  return entries.sort(sortEntries);
}

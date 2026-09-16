// ABOUTME: Native receive-history reconstruction (H1) — shields + incoming transfers, with the
// ABOUTME: wallet's own change correctly excluded via nullifier matching.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, TransactNote } from '../core/index';
import type { TXO, SpentNullifier } from './balances';
import { reconstructReceiveHistory, reconstructHistory, newReceivedNotes } from './history';
import { encodeSelfMetadata } from './self-metadata';
import type { DecodedUnshield } from './event-decoder';
import type { SentOutput } from './scan-engine';

const USDC_HASH = 'aa'.repeat(32);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const NK = 987654321n;
const tx = (n: string): string => `0x${n.repeat(32)}`;

// Only USDC resolves — a note in any other token is skipped.
const resolveToken = (hash: string): `0x${string}` | undefined => (hash === USDC_HASH ? USDC : undefined);

function txo(over: Partial<TXO> & Pick<TXO, 'tree' | 'position' | 'value' | 'txid' | 'origin'>): TXO {
  return { tokenHash: USDC_HASH, blockNumber: 10, random: '00'.repeat(16), notePublicKey: 0n, ...over };
}

describe('reconstructReceiveHistory (H1)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('emits shield + incoming-transfer entries and excludes the wallet\'s own change', () => {
    // WHY: a transact-origin note created in a tx where WE spent an input is change, not an incoming
    // transfer — misclassifying it would double-count the sender's outflow as a receive.
    const shieldNote = txo({ tree: 0, position: 0, value: 1_000_000n, txid: tx('11'), origin: 'shield', shieldFee: 5_000n });
    const received = txo({ tree: 0, position: 1, value: 250_000n, txid: tx('22'), origin: 'transact', blockNumber: 20, memo: 'gm', senderShieldedAddress: '0zk_alice' });
    // A spend we authored at position 1... use a distinct input note we own that got nullified.
    const spentInput = txo({ tree: 0, position: 5, value: 900_000n, txid: tx('11'), origin: 'transact', blockNumber: 5 });
    const changeNote = txo({ tree: 0, position: 6, value: 400_000n, txid: tx('33'), origin: 'transact', blockNumber: 30 });

    // The spend tx (0x33) nullified our input note (position 5); change (position 6) landed in 0x33.
    const spent: SpentNullifier[] = [
      { tree: 0, nullifier: TransactNote.getNullifier(NK, 5), txid: tx('33'), blockNumber: 30 },
    ];

    const entries = reconstructReceiveHistory([shieldNote, received, spentInput, changeNote], spent, NK, resolveToken);

    // shield (0x11), incoming transfer (0x22), and the spentInput itself (a transact note NOT created
    // in a tx where we spent → it's an earlier receive). The change note (0x33) is excluded.
    const byTxid = new Map(entries.map((e) => [e.txid, e]));
    expect(byTxid.get(tx('33'))).toBeUndefined(); // change excluded
    expect(byTxid.get(tx('11'))).toMatchObject({ category: 'shield', value: 1_000_000n, shieldFee: 5_000n, tokenHash: USDC_HASH, tokenAddress: USDC });
    expect(byTxid.get(tx('22'))).toMatchObject({ category: 'transfer-received', value: 250_000n, tokenHash: USDC_HASH, tokenAddress: USDC, memo: 'gm', senderShieldedAddress: '0zk_alice' });
    expect(entries).toHaveLength(3); // shield + received + the pre-spend input receive
    // Every entry carries BOTH identifiers — the hash joins `balances()`/events, the address is the ERC-20.
    for (const e of entries) expect(e).toMatchObject({ tokenHash: USDC_HASH, tokenAddress: USDC });
  });

  it('skips notes in non-USDC tokens', () => {
    const other = txo({ tree: 0, position: 0, value: 1n, txid: tx('44'), origin: 'shield', tokenHash: 'bb'.repeat(32) });
    expect(reconstructReceiveHistory([other], [], NK, resolveToken)).toHaveLength(0);
  });

  it('sorts by block then txid', () => {
    const a = txo({ tree: 0, position: 0, value: 1n, txid: tx('bb'), origin: 'shield', blockNumber: 50 });
    const b = txo({ tree: 0, position: 1, value: 1n, txid: tx('aa'), origin: 'shield', blockNumber: 10 });
    const entries = reconstructReceiveHistory([a, b], [], NK, resolveToken);
    expect(entries.map((e) => e.blockNumber)).toEqual([10, 50]);
  });
});

describe('newReceivedNotes (incremental note:received detection)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  const shieldNote = txo({ tree: 0, position: 0, value: 1_000_000n, txid: tx('11'), origin: 'shield' });
  const received1 = txo({ tree: 0, position: 1, value: 250_000n, txid: tx('22'), origin: 'transact' });
  const spentInput = txo({ tree: 0, position: 5, value: 900_000n, txid: tx('aa'), origin: 'transact' });
  const changeNote = txo({ tree: 0, position: 6, value: 400_000n, txid: tx('33'), origin: 'transact' });
  // We spent our input (position 5) in tx 0x33 → 0x33 is an own-spend tx, so its change note is excluded.
  const spent: SpentNullifier[] = [{ tree: 0, nullifier: TransactNote.getNullifier(NK, 5), txid: tx('33'), blockNumber: 30 }];

  it('returns received transfers (excludes shields + own change) and seeds `seen`', () => {
    const seen = new Set<string>();
    const fresh = newReceivedNotes([shieldNote, received1, spentInput, changeNote], spent, NK, seen);
    // received1 + the earlier-received-then-spent input; NOT the shield, NOT the 0x33 change.
    expect(fresh.map((t) => t.position).sort((a, b) => a - b)).toEqual([1, 5]);
    expect(seen.has('0:1')).toBe(true);
    expect(seen.has('0:5')).toBe(true);
    expect(seen.has('0:0')).toBe(false); // shield not tracked
    expect(seen.has('0:6')).toBe(false); // change not tracked
  });

  it('returns only the delta on subsequent calls (seeded notes never re-appear)', () => {
    const seen = new Set<string>();
    newReceivedNotes([shieldNote, received1], spent, NK, seen); // baseline seed
    expect(newReceivedNotes([shieldNote, received1], spent, NK, seen)).toEqual([]); // nothing new
    // A brand-new incoming transfer surfaces exactly once.
    const received2 = txo({ tree: 0, position: 9, value: 42n, txid: tx('99'), origin: 'transact', memo: 'hi' });
    const fresh = newReceivedNotes([shieldNote, received1, received2], spent, NK, seen);
    expect(fresh.map((t) => t.position)).toEqual([9]);
    expect(fresh[0]!.memo).toBe('hi');
    expect(newReceivedNotes([shieldNote, received1, received2], spent, NK, seen)).toEqual([]); // now seen
  });
});

describe('reconstructHistory (H2 — sends / unshields / yield)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  const ADAPTER = '0xada9700000000000000000000000000000000000';
  const RECIPIENT = '0xbeef000000000000000000000000000000000000';
  const SELF_0ZK = '0zk_self_wallet';
  const SPEND = tx('55');

  // An input note we own (received earlier at 0xaa) and later spend in SPEND.
  const inputNote = txo({ tree: 0, position: 5, value: 900_000n, txid: tx('aa'), origin: 'transact', blockNumber: 5 });
  const changeNote = txo({ tree: 0, position: 6, value: 400_000n, txid: SPEND, origin: 'transact', blockNumber: 30 });
  const spent: SpentNullifier[] = [{ tree: 0, nullifier: TransactNote.getNullifier(NK, 5), txid: SPEND, blockNumber: 30 }];

  // Token resolver for the test's synthetic hashes: USDC + a yield-vault SHARE token.
  const SHARE_HASH = 'cc'.repeat(32);
  const SHARE = '0x5ba1e12693dc8f9c48aad8770482f4739beed696' as const;
  const resolveToken = (h: string): `0x${string}` | undefined =>
    h === USDC_HASH ? USDC : h === SHARE_HASH ? SHARE : undefined;
  const base = { spentNullifiers: spent, sentOutputs: [], nullifyingKey: NK, shieldedAddress: SELF_0ZK, resolveToken, usdcHash: USDC_HASH };
  const unshield = (over: Partial<DecodedUnshield>): DecodedUnshield => ({
    to: RECIPIENT,
    tokenData: { tokenType: 0, tokenAddress: USDC, tokenSubID: '0' },
    amount: 500_000n,
    fee: 2_500n,
    blockNumber: 30,
    txid: SPEND,
    ...over,
  });

  it('transfer-sent: net outflow (inputs − change), no unshield event', () => {
    const entries = reconstructHistory({ ...base, ownedTxos: [inputNote, changeNote], unshields: [] });
    const sent = entries.find((e) => e.txid === SPEND);
    expect(sent).toMatchObject({ category: 'transfer-sent', value: -500_000n, tokenHash: USDC_HASH, tokenAddress: USDC });
    // The earlier receipt of the input note still surfaces.
    expect(entries.find((e) => e.txid === tx('aa'))).toMatchObject({ category: 'transfer-received', value: 900_000n });
    // The USDC-scoped reconstruction stamps every entry with the canonical hash + address pair.
    for (const e of entries) expect(e).toMatchObject({ tokenHash: USDC_HASH, tokenAddress: USDC });
  });

  it('unshield: spend + Unshield to an external recipient → recipient + protocol fee', () => {
    const entries = reconstructHistory({ ...base, ownedTxos: [inputNote, changeNote], unshields: [unshield({})] });
    expect(entries.find((e) => e.txid === SPEND)).toMatchObject({
      category: 'unshield',
      value: -500_000n,
      recipient: RECIPIENT,
      unshieldFee: 2_500n,
    });
  });

  it('yield-deposit: spend + Unshield to the configured adapter', () => {
    const entries = reconstructHistory({
      ...base,
      ownedTxos: [inputNote, changeNote],
      unshields: [unshield({ to: ADAPTER })],
      yieldAdapterAddress: ADAPTER,
    });
    expect(entries.find((e) => e.txid === SPEND)).toMatchObject({ category: 'yield-deposit', value: -500_000n });
  });

  it('transfer-sent splits recipient outputs from the broadcaster fee (H3)', () => {
    // WHY: parity — a send should show WHO got WHAT (recipient + amount + memo) and the relayer fee
    // separately, recovered sender-side and classified by OutputType (Transfer vs BroadcasterFee).
    const sentOutputs: SentOutput[] = [
      { txid: SPEND, blockNumber: 30, tokenHash: USDC_HASH, value: 480_000n, recipientShieldedAddress: '0zk_bob', outputType: 0, memo: 'hi' },
      { txid: SPEND, blockNumber: 30, tokenHash: USDC_HASH, value: 20_000n, recipientShieldedAddress: '0zk_relayer', outputType: 1 },
    ];
    const entries = reconstructHistory({ ...base, ownedTxos: [inputNote, changeNote], unshields: [], sentOutputs });
    const sent = entries.find((e) => e.txid === SPEND)!;
    expect(sent.category).toBe('transfer-sent');
    expect(sent.value).toBe(-500_000n);
    expect(sent.broadcasterFee).toBe(20_000n);
    expect(sent.sentOutputs).toEqual([{ recipientShieldedAddress: '0zk_bob', value: 480_000n, memo: 'hi' }]);
  });

  it('transfer-sent excludes the change-to-self and the fee from sentOutputs', () => {
    // WHY: a send's authored outputs are fee + recipients + change-to-self. Only the recipients are
    // "who we paid" — the fee belongs in `broadcasterFee` and the change is our own money coming back.
    // The scan filter already drops Change sender-side, but the classification must hold here too, so
    // an untagged-output regression upstream cannot leak the fee/change into the recipient list.
    const sentOutputs: SentOutput[] = [
      { txid: SPEND, blockNumber: 30, tokenHash: USDC_HASH, value: 20_000n, recipientShieldedAddress: '0zk_relayer', outputType: 1 },
      { txid: SPEND, blockNumber: 30, tokenHash: USDC_HASH, value: 480_000n, recipientShieldedAddress: '0zk_bob', outputType: 0 },
      { txid: SPEND, blockNumber: 30, tokenHash: USDC_HASH, value: 400_000n, recipientShieldedAddress: '0zk_self', outputType: 2 },
    ];
    const entries = reconstructHistory({ ...base, ownedTxos: [inputNote, changeNote], unshields: [], sentOutputs });
    const sent = entries.find((e) => e.txid === SPEND)!;
    expect(sent.sentOutputs).toEqual([{ recipientShieldedAddress: '0zk_bob', value: 480_000n }]);
    expect(sent.broadcasterFee).toBe(20_000n);
  });

  it('recovers the broadcaster shielded address from the fee output', () => {
    const sentOutputs: SentOutput[] = [
      { txid: SPEND, blockNumber: 30, tokenHash: USDC_HASH, value: 20_000n, recipientShieldedAddress: '0zk_relayer', outputType: 1 },
      { txid: SPEND, blockNumber: 30, tokenHash: USDC_HASH, value: 480_000n, recipientShieldedAddress: '0zk_bob', outputType: 0 },
    ];
    const entries = reconstructHistory({ ...base, ownedTxos: [inputNote, changeNote], unshields: [], sentOutputs });
    const sent = entries.find((e) => e.txid === SPEND)!;
    expect(sent.broadcasterShieldedAddress).toBe('0zk_relayer');
  });

  it('classifies a send to our OWN address as self-transfer with value = −fee (issue #88, the "−194" bug)', () => {
    // WHY: a transfer to our own 0zk comes straight back (netted into change), so the wallet only loses
    // the fee. The self-recipient must NOT appear in sentOutputs (it's not an outgoing payment) and the
    // entry must be a distinct `self-transfer`, so a UI never renders it as money leaving the wallet.
    const sentOutputs: SentOutput[] = [
      { txid: SPEND, blockNumber: 30, tokenHash: USDC_HASH, value: 20_000n, recipientShieldedAddress: '0zk_relayer', outputType: 1 },
      { txid: SPEND, blockNumber: 30, tokenHash: USDC_HASH, value: 480_000n, recipientShieldedAddress: SELF_0ZK, outputType: 0 },
    ];
    // inputNote 900k spent; change note here must reflect the self-recipient coming back so net = −fee.
    // Model both returned notes as owned change in SPEND: the 480k self-note + a 400k change note = 880k,
    // inputs 900k → net = −20k (the fee).
    const selfNote = txo({ tree: 0, position: 7, value: 480_000n, txid: SPEND, origin: 'transact', blockNumber: 30 });
    const entries = reconstructHistory({ ...base, ownedTxos: [inputNote, changeNote, selfNote], unshields: [], sentOutputs });
    const self = entries.find((e) => e.txid === SPEND)!;
    expect(self.category).toBe('self-transfer');
    expect(self.value).toBe(-20_000n); // only the fee left the wallet
    expect(self.sentOutputs).toBeUndefined(); // no phantom outgoing amount
    expect(self.broadcasterFee).toBe(20_000n);
  });

  it('attaches the gasless relayer fee to a shield entry (lever 2)', () => {
    const shieldTxid = tx('77');
    const shieldNote = txo({ tree: 0, position: 8, value: 990_000n, txid: shieldTxid, origin: 'shield', shieldFee: 1_000n, blockNumber: 12 });
    const entries = reconstructHistory({
      ...base,
      spentNullifiers: [],
      ownedTxos: [shieldNote],
      unshields: [],
      shieldRelayerFees: new Map([[shieldTxid, 10_000n]]),
    });
    const shield = entries.find((e) => e.txid === shieldTxid)!;
    expect(shield.category).toBe('shield');
    expect(shield.value).toBe(990_000n);
    expect(shield.shieldFee).toBe(1_000n); // protocol fee, distinct from the relayer fee
    expect(shield.broadcasterFee).toBe(10_000n); // gasless relayer fee note
  });

  it('recovers self-metadata stashed in the change-note memo (lever 3)', () => {
    // The change note (owned, in the spend txid) carries a tagged metadata blob written at prove time.
    // A fresh scan recovers it onto the spend entry even though local storage is gone.
    const blob = 'fee=20000;mode=gasless';
    const changeWithMeta = txo({ tree: 0, position: 6, value: 400_000n, txid: SPEND, origin: 'transact', blockNumber: 30, memo: encodeSelfMetadata(blob) });
    const entries = reconstructHistory({ ...base, ownedTxos: [inputNote, changeWithMeta], unshields: [] });
    const sent = entries.find((e) => e.txid === SPEND)!;
    expect(sent.category).toBe('transfer-sent');
    expect(sent.selfMetadata).toBe(blob);
  });

  it('does not mistake a user memo on a received note for self-metadata (lever 3)', () => {
    // A plain incoming transfer with a user memo must not surface selfMetadata.
    const received = txo({ tree: 0, position: 9, value: 100_000n, txid: tx('99'), origin: 'transact', blockNumber: 40, memo: 'thanks' });
    const entries = reconstructHistory({ ...base, spentNullifiers: [], ownedTxos: [received], unshields: [] });
    const entry = entries.find((e) => e.txid === tx('99'))!;
    expect(entry.category).toBe('transfer-received');
    expect(entry.selfMetadata).toBeUndefined();
  });

  it('a mixed send (self + external recipient) stays transfer-sent, self leg excluded from sentOutputs', () => {
    const sentOutputs: SentOutput[] = [
      { txid: SPEND, blockNumber: 30, tokenHash: USDC_HASH, value: 480_000n, recipientShieldedAddress: '0zk_bob', outputType: 0 },
      { txid: SPEND, blockNumber: 30, tokenHash: USDC_HASH, value: 100_000n, recipientShieldedAddress: SELF_0ZK, outputType: 0 },
    ];
    const selfNote = txo({ tree: 0, position: 7, value: 100_000n, txid: SPEND, origin: 'transact', blockNumber: 30 });
    const entries = reconstructHistory({ ...base, ownedTxos: [inputNote, changeNote, selfNote], unshields: [], sentOutputs });
    const sent = entries.find((e) => e.txid === SPEND)!;
    expect(sent.category).toBe('transfer-sent');
    expect(sent.sentOutputs).toEqual([{ recipientShieldedAddress: '0zk_bob', value: 480_000n }]);
  });

  it('reconstructs history for a non-USDC ERC20 receive (token-agnostic, #90)', () => {
    const shareReceive = txo({ tree: 0, position: 20, value: 5_000n, txid: tx('a1'), origin: 'transact', tokenHash: SHARE_HASH, blockNumber: 50 });
    const entries = reconstructHistory({ ...base, spentNullifiers: [], ownedTxos: [shareReceive], unshields: [] });
    const e = entries.find((x) => x.txid === tx('a1'))!;
    expect(e).toMatchObject({ category: 'transfer-received', tokenHash: SHARE_HASH, tokenAddress: SHARE, value: 5_000n });
  });

  it('yield deposit: USDC spent + shares minted → a yield-deposit leg per token (#90)', () => {
    const DEP = tx('d1');
    const usdcIn = txo({ tree: 0, position: 5, value: 900_000n, txid: tx('aa'), origin: 'transact', blockNumber: 5 }); // spent in DEP
    const usdcChange = txo({ tree: 0, position: 6, value: 400_000n, txid: DEP, origin: 'transact', blockNumber: 30 });
    const shares = txo({ tree: 0, position: 7, value: 12_000n, txid: DEP, origin: 'transact', tokenHash: SHARE_HASH, blockNumber: 30 });
    const spentDep: SpentNullifier[] = [{ tree: 0, nullifier: TransactNote.getNullifier(NK, 5), txid: DEP, blockNumber: 30 }];
    const entries = reconstructHistory({ ...base, spentNullifiers: spentDep, ownedTxos: [usdcIn, usdcChange, shares], unshields: [unshield({ to: ADAPTER, txid: DEP })], yieldAdapterAddress: ADAPTER });
    expect(entries.find((e) => e.txid === DEP && e.tokenHash === USDC_HASH)).toMatchObject({ category: 'yield-deposit', value: -500_000n });
    expect(entries.find((e) => e.txid === DEP && e.tokenHash === SHARE_HASH)).toMatchObject({ category: 'yield-deposit', value: 12_000n, tokenAddress: SHARE });
  });

  it('yield withdraw: shares spent + USDC returned → the USDC return is not misclassified (#90 regression)', () => {
    // Regression guard: once shares are scanned (issue #90 commit 1), the withdraw txid becomes an
    // own-spend txid. With token-blind change detection the USDC return would be counted as change and
    // flipped to a positive yield-DEPOSIT. Per-token classification keeps it a yield-withdraw return.
    const WD = tx('e1');
    const sharesIn = txo({ tree: 0, position: 8, value: 12_000n, txid: tx('bb'), origin: 'transact', tokenHash: SHARE_HASH, blockNumber: 6 }); // spent in WD
    const usdcOut = txo({ tree: 0, position: 9, value: 950_000n, txid: WD, origin: 'transact', blockNumber: 40 }); // USDC returned to us
    const spentWd: SpentNullifier[] = [{ tree: 0, nullifier: TransactNote.getNullifier(NK, 8), txid: WD, blockNumber: 40 }];
    const shareUnshield = unshield({ to: ADAPTER, txid: WD, amount: 12_000n, tokenData: { tokenType: 0, tokenAddress: SHARE, tokenSubID: '0' } });
    const entries = reconstructHistory({ ...base, spentNullifiers: spentWd, ownedTxos: [sharesIn, usdcOut], unshields: [shareUnshield], yieldAdapterAddress: ADAPTER, shieldRelayerFees: new Map([[WD, 3_000n]]) });
    // The USDC leg carries the shares redeemed (the adapter Unshield amount) + the relayer's re-shield
    // fee (shieldRelayerFees), so a consumer that keeps only the USDC leg is whole.
    expect(entries.find((e) => e.txid === WD && e.tokenHash === USDC_HASH)).toMatchObject({ category: 'yield-withdraw', value: 950_000n, shares: 12_000n, broadcasterFee: 3_000n });
    expect(entries.find((e) => e.txid === WD && e.tokenHash === SHARE_HASH)).toMatchObject({ category: 'yield-withdraw', value: -12_000n });
  });

  it('yield-withdraw with no relayer fee: shares surfaced, no broadcasterFee', () => {
    const WD = tx('e2');
    const sharesIn = txo({ tree: 0, position: 8, value: 7_000n, txid: tx('cc'), origin: 'transact', tokenHash: SHARE_HASH, blockNumber: 6 });
    const usdcOut = txo({ tree: 0, position: 9, value: 500_000n, txid: WD, origin: 'transact', blockNumber: 40 });
    const spentWd: SpentNullifier[] = [{ tree: 0, nullifier: TransactNote.getNullifier(NK, 8), txid: WD, blockNumber: 40 }];
    const shareUnshield = unshield({ to: ADAPTER, txid: WD, amount: 7_000n, tokenData: { tokenType: 0, tokenAddress: SHARE, tokenSubID: '0' } });
    const entries = reconstructHistory({ ...base, spentNullifiers: spentWd, ownedTxos: [sharesIn, usdcOut], unshields: [shareUnshield], yieldAdapterAddress: ADAPTER });
    const usdcLeg = entries.find((e) => e.txid === WD && e.tokenHash === USDC_HASH)!;
    expect(usdcLeg).toMatchObject({ category: 'yield-withdraw', value: 500_000n, shares: 7_000n });
    expect(usdcLeg.broadcasterFee).toBeUndefined();
  });

  it('transfer-sent is dated by the spend block, not the spent input\'s origin block', () => {
    // WHY: the input note was created by an EARLIER transaction (block 5); the send happened at block
    // 30. Dating the send by its input's origin block backdates it — the entry would sort next to, and
    // display the timestamp of, the deposit that funded it.
    const entries = reconstructHistory({ ...base, ownedTxos: [inputNote, changeNote], unshields: [] });
    expect(inputNote.blockNumber).toBe(5); // the input's origin block, distinct from the spend's
    expect(entries.find((e) => e.txid === SPEND)).toMatchObject({ category: 'transfer-sent', blockNumber: 30 });
  });

  it('yield-withdraw: USDC receive in a tx that also carries the adapter Unshield leg', () => {
    const WITHDRAW = tx('66');
    const returned = txo({ tree: 0, position: 9, value: 950_000n, txid: WITHDRAW, origin: 'transact', blockNumber: 40 });
    const entries = reconstructHistory({
      ...base,
      spentNullifiers: [],
      ownedTxos: [returned],
      unshields: [unshield({ to: ADAPTER, txid: WITHDRAW, amount: 0n })],
      yieldAdapterAddress: ADAPTER,
    });
    expect(entries.find((e) => e.txid === WITHDRAW)).toMatchObject({ category: 'yield-withdraw', value: 950_000n });
  });
});

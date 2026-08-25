// ABOUTME: Native receive-history reconstruction (H1) — shields + incoming transfers, with the
// ABOUTME: wallet's own change correctly excluded via nullifier matching.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, TransactNote } from '../core/index';
import type { TXO, SpentNullifier } from './balances';
import { reconstructReceiveHistory, reconstructHistory, newReceivedNotes } from './history';
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
  const SPEND = tx('55');

  // An input note we own (received earlier at 0xaa) and later spend in SPEND.
  const inputNote = txo({ tree: 0, position: 5, value: 900_000n, txid: tx('aa'), origin: 'transact', blockNumber: 5 });
  const changeNote = txo({ tree: 0, position: 6, value: 400_000n, txid: SPEND, origin: 'transact', blockNumber: 30 });
  const spent: SpentNullifier[] = [{ tree: 0, nullifier: TransactNote.getNullifier(NK, 5), txid: SPEND, blockNumber: 30 }];

  const base = { spentNullifiers: spent, sentOutputs: [], nullifyingKey: NK, usdcHash: USDC_HASH, usdcAddress: USDC };
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

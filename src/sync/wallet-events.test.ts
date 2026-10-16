// ABOUTME: Tests for WalletEvents (F1, #143) — balance:updated only for tokens whose balance changed (a zero when one
// ABOUTME: drops out), and note:received only for new incoming notes after a baseline that never replays history.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise } from '../core/index';
import { WalletEvents } from './wallet-events';
import type { TokenBalance, TXO } from './balances';
import type { SyncEventMap } from './index';

const USDC = 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const tokenHash = (address: string): string => address.padStart(64, '0'); // an ERC-20 hash is the padded address
const NK = 987654321098765n;

const balance = (address: string, spendable: bigint, pending = 0n): TokenBalance =>
  ({ tokenHash: tokenHash(address), spendable, pending, spendableNotes: 1 }) as unknown as TokenBalance;
const received = (position: number, value: bigint, memo?: string): TXO => ({
  tree: 0,
  position,
  tokenHash: tokenHash(USDC),
  value,
  blockNumber: 100 + position,
  txid: `0x${String(position).padStart(64, '0')}`,
  origin: 'transact',
  ...(memo !== undefined ? { memo } : {}),
  random: '00'.repeat(16),
  notePublicKey: 0n,
});

function recorder(events: WalletEvents): { balances: SyncEventMap['balance:updated'][]; notes: SyncEventMap['note:received'][] } {
  const log = { balances: [] as SyncEventMap['balance:updated'][], notes: [] as SyncEventMap['note:received'][] };
  events.on('balance:updated', (p) => log.balances.push(p));
  events.on('note:received', (p) => log.notes.push(p));
  return log;
}

beforeAll(async () => {
  await initPoseidonPromise;
});

describe('WalletEvents (F1, #143)', () => {
  it('emits balance:updated only for a token whose balance changed, and a zero when a token drops out', () => {
    const events = new WalletEvents();
    const log = recorder(events);
    const OTHER = 'b'.repeat(40);
    events.balancesChanged([balance(USDC, 10n), balance(OTHER, 5n)]);
    expect(log.balances.map((b) => [b.tokenAddress, b.spendable])).toEqual([[`0x${USDC}`, 10n], [`0x${OTHER}`, 5n]]);

    log.balances.length = 0;
    events.balancesChanged([balance(USDC, 10n), balance(OTHER, 5n)]); // nothing changed
    expect(log.balances).toEqual([]);

    events.balancesChanged([balance(USDC, 12n)]); // USDC changed; OTHER fully spent
    expect(log.balances.map((b) => [b.tokenAddress, b.spendable, b.pending])).toEqual([
      [`0x${USDC}`, 12n, 0n],
      [`0x${OTHER}`, 0n, 0n],
    ]);
  });

  it('baselines note:received on the first call, then reports only new incoming notes; reset re-baselines', () => {
    const events = new WalletEvents();
    const log = recorder(events);
    events.notesReceived([received(0, 1n)], [], NK); // first sync: history is not "received"
    expect(log.notes).toEqual([]);
    events.notesReceived([received(0, 1n), received(1, 2n, 'hi')], [], NK);
    expect(log.notes).toEqual([{ tokenHash: tokenHash(USDC), tokenAddress: `0x${USDC}`, value: 2n, memo: 'hi' }]);

    events.reset();
    log.notes.length = 0;
    events.notesReceived([received(0, 1n), received(1, 2n)], [], NK);
    expect(log.notes).toEqual([]);
  });

  it('a wallet loaded with saved notes reports what arrived since, on its first sync', () => {
    const events = new WalletEvents();
    const log = recorder(events);
    events.baselineReceives([received(0, 1n)], [], NK);
    events.notesReceived([received(0, 1n), received(1, 2n)], [], NK);
    expect(log.notes.map((n) => n.value)).toEqual([2n]);
  });
});

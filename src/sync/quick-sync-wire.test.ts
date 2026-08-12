// ABOUTME: Round-trip + validation tests for the native quick-sync wire contract — the schema the
// ABOUTME: watcher (Phase 2) must conform to and IndexerEventSource consumes.

import { describe, it, expect } from 'vitest';
import type { DecodedPoolEvents } from './event-decoder';
import {
  QUICK_SYNC_SCHEMA_VERSION,
  serializeQuickSync,
  parseQuickSync,
} from './quick-sync-wire';
import { QuickSyncSchemaError } from '../errors';

const h = (b: string): string => b.repeat(32); // 32-byte no-0x hex fixture

// A representative event set: a shield WITH a fee, a shield WITHOUT one (exactOptional path), a
// transact with real Uint8Array blinded keys, and a large nullifier (bigint > 2^53).
const EVENTS: DecodedPoolEvents = {
  shields: [
    {
      tree: 0,
      position: 5,
      blockNumber: 100,
      txid: `0x${h('ab')}`,
      hash: h('aa'),
      npk: h('bb'),
      tokenData: { tokenType: 0, tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', tokenSubID: '0' },
      value: 1_000_000n,
      encryptedBundle: [h('c1'), h('c2'), h('c3')],
      shieldKey: h('dd'),
      fee: 5_000n,
    },
    {
      tree: 0,
      position: 6,
      blockNumber: 100,
      txid: `0x${h('ac')}`,
      hash: h('a1'),
      npk: h('b1'),
      tokenData: { tokenType: 0, tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', tokenSubID: '0' },
      value: 250_000n,
      encryptedBundle: [h('d1'), h('d2'), h('d3')],
      shieldKey: h('de'),
      // no fee → must round-trip as an absent key, not `fee: undefined`
    },
  ],
  transacts: [
    {
      tree: 0,
      position: 7,
      blockNumber: 101,
      txid: `0x${h('cd')}`,
      hash: h('ee'),
      ciphertext: {
        ciphertext: [h('f0'), h('f1'), h('f2'), h('f3')],
        blindedSenderViewingKey: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        blindedReceiverViewingKey: new Uint8Array([255, 254, 0, 128, 16]),
        memo: '',
        annotationData: h('99'),
      },
    },
  ],
  nullifiers: [
    { tree: 0, nullifier: 123_456_789_012_345_678_901n, blockNumber: 102, txid: `0x${h('ef')}` },
  ],
  unshields: [
    {
      to: '0x1111111111111111111111111111111111111111',
      tokenData: { tokenType: 0, tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', tokenSubID: '0' },
      amount: 750_000n,
      fee: 3_750n,
      blockNumber: 103,
      txid: `0x${h('ef')}`,
    },
  ],
};

describe('quick-sync wire contract', () => {
  it('round-trips DecodedPoolEvents through JSON with full fidelity', () => {
    // WHY: the wire form must be genuinely JSON-serializable (no bigint/Uint8Array escapes) AND
    // decode back to a byte-identical DecodedPoolEvents — otherwise an indexer-fed scan would build
    // a different tree than a getLogs scan. The JSON.parse(JSON.stringify(...)) hop proves both.
    const wire = serializeQuickSync(EVENTS, 5_000);
    const overWire = JSON.parse(JSON.stringify(wire)); // throws if any bigint leaked
    const { events, syncedThroughBlock } = parseQuickSync(overWire);
    expect(events).toEqual(EVENTS);
    expect(syncedThroughBlock).toBe(5_000);
  });

  it('stamps + requires the schema version', () => {
    const wire = serializeQuickSync(EVENTS, 1);
    expect(wire.schemaVersion).toBe(QUICK_SYNC_SCHEMA_VERSION);
    expect(() => parseQuickSync({ ...wire, schemaVersion: 999 })).toThrow(QuickSyncSchemaError);
  });

  it('preserves the absent-fee shield as an absent key (not undefined)', () => {
    const wire = serializeQuickSync(EVENTS, 1);
    expect('fee' in wire.shields[1]!).toBe(false);
    const { events } = parseQuickSync(JSON.parse(JSON.stringify(wire)));
    expect('fee' in events.shields[1]!).toBe(false);
  });

  it('rejects malformed responses with QuickSyncSchemaError', () => {
    // WHY: the watcher is an external trust boundary — a mistyped or truncated response must fail
    // loudly (→ SDK RPC fallback), never silently scan partial/garbage state.
    expect(() => parseQuickSync(null)).toThrow(QuickSyncSchemaError);
    expect(() => parseQuickSync({ schemaVersion: 1, syncedThroughBlock: 1 })).toThrow(QuickSyncSchemaError); // missing arrays
    const good = serializeQuickSync(EVENTS, 1);
    expect(() => parseQuickSync({ ...good, shields: [{ ...good.shields[0], value: 'not-a-number' }] })).toThrow(
      QuickSyncSchemaError,
    );
    expect(() =>
      parseQuickSync({
        ...good,
        transacts: [
          { ...good.transacts[0], ciphertext: { ...good.transacts[0]!.ciphertext, blindedSenderViewingKey: 'zz' } },
        ],
      }),
    ).toThrow(QuickSyncSchemaError);
  });

  it('rejects out-of-range / non-integer numbers and malformed ciphertext arity (M1 hardening)', () => {
    // WHY: an untrusted indexer could send a negative block, a fractional/oversized position, a negative
    // value, or a wrong-arity ciphertext — each must be a typed schema rejection (→ RPC fallback), not a
    // silently-poisoned scan or a generic crash deep in unpackCiphertext.
    const good = serializeQuickSync(EVENTS, 1);
    expect(() => parseQuickSync({ ...good, shields: [{ ...good.shields[0], blockNumber: -1 }] })).toThrow(QuickSyncSchemaError);
    expect(() => parseQuickSync({ ...good, shields: [{ ...good.shields[0], position: 1.5 }] })).toThrow(QuickSyncSchemaError);
    expect(() => parseQuickSync({ ...good, shields: [{ ...good.shields[0], position: 65536 }] })).toThrow(QuickSyncSchemaError);
    expect(() => parseQuickSync({ ...good, shields: [{ ...good.shields[0], value: '-1' }] })).toThrow(QuickSyncSchemaError);
    expect(() =>
      parseQuickSync({
        ...good,
        transacts: [{ ...good.transacts[0], ciphertext: { ...good.transacts[0]!.ciphertext, ciphertext: ['a', 'b', 'c'] } }],
      }),
    ).toThrow(QuickSyncSchemaError);
  });
});

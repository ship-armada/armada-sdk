// ABOUTME: Tests for the pool event decoder (§4.4) — ethers ABI validation, a real shield-leaf-hash
// ABOUTME: cross-check vs commitment-vectors.json, and the offline decode→decrypt→balance pipeline.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Interface } from 'ethers';
import { initPoseidonPromise, getTokenDataERC20, type TokenData } from '../core/index';
import { deriveKeyset, type Keyset } from '../wallet/derive';
import {
  POOL_V2_EVENT_ABI,
  formatShieldEvent,
  formatTransactEvent,
  formatNullifiedEvent,
  decodePoolEvents,
  type RawShieldArgs,
  type RawTransactArgs,
  type RawNullifiedArgs,
  type ParsedPoolLog,
} from './event-decoder';
import { createTransferNote, encryptNoteToReceiver } from './note-crypto';
import { computeBalances, txoFromNote } from './balances';

const TOKEN_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const META = { blockNumber: 640, txid: '0x' + 'ab'.repeat(32) };
const b32 = (fill: string): string => '0x' + fill.repeat(32);

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

describe('pool event decoder (§4.4)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('decodes real ethers-encoded logs via POOL_V2_EVENT_ABI', () => {
    const iface = new Interface(POOL_V2_EVENT_ABI);

    // Nullified — the simplest: tree + two nullifiers.
    const nulLog = iface.encodeEventLog('Nullified', [7, [b32('11'), b32('22')]]);
    const nulParsed = iface.parseLog(nulLog)!;
    const nullifiers = formatNullifiedEvent(nulParsed.args as unknown as RawNullifiedArgs, META);
    expect(nullifiers).toEqual([
      { tree: 7, nullifier: BigInt(b32('11')), blockNumber: 640, txid: META.txid },
      { tree: 7, nullifier: BigInt(b32('22')), blockNumber: 640, txid: META.txid },
    ]);

    // Transact — one commitment with a full ciphertext struct; positions offset from startPosition.
    const ct = {
      ciphertext: [b32('a1'), b32('a2'), b32('a3'), b32('a4')],
      blindedSenderViewingKey: b32('b1'),
      blindedReceiverViewingKey: b32('b2'),
      annotationData: '0xdead',
      memo: '0xbeef',
    };
    const txLog = iface.encodeEventLog('Transact', [3, 100, [b32('cc')], [ct]]);
    const txParsed = iface.parseLog(txLog)!;
    const transacts = formatTransactEvent(txParsed.args as unknown as RawTransactArgs, META);
    expect(transacts).toHaveLength(1);
    expect(transacts[0]!.tree).toBe(3);
    expect(transacts[0]!.position).toBe(100);
    expect(transacts[0]!.hash).toBe('cc'.repeat(32));
    expect(transacts[0]!.ciphertext.ciphertext).toEqual(['a1'.repeat(32), 'a2'.repeat(32), 'a3'.repeat(32), 'a4'.repeat(32)]);
    expect(transacts[0]!.ciphertext.blindedSenderViewingKey).toHaveLength(32);
    expect(transacts[0]!.ciphertext.memo).toBe('0xbeef');
  });

  it('computes shield leaf hashes matching commitment-vectors.json (differential)', () => {
    const fixturePath = fileURLToPath(new URL('../../test/vectors/commitment-vectors.json', import.meta.url));
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      tokenAddress: string;
      vectors: Array<{ npk: string; tokenHash: string; value: string; commitment: string }>;
    };
    expect(fixture.vectors.length).toBeGreaterThan(0);

    for (const v of fixture.vectors) {
      const args: RawShieldArgs = {
        treeNumber: 0,
        startPosition: 0,
        commitments: [{ npk: v.npk, token: { tokenType: 0, tokenAddress: fixture.tokenAddress, tokenSubID: 0 }, value: BigInt(v.value) }],
        shieldCiphertext: [{ encryptedBundle: [b32('00'), b32('00'), b32('00')], shieldKey: b32('00') }],
        fees: [0],
      };
      const [decoded] = formatShieldEvent(args, META);
      expect(decoded!.hash).toBe(v.commitment.slice(2)); // leaf hash = Poseidon(npk, tokenHash, value)
    }
  });

  it('decode → decrypt → balance pipeline (fully offline)', async () => {
    const sender: Keyset = await deriveKeyset(new Uint8Array(32).fill(0x11));
    const receiver: Keyset = await deriveKeyset(new Uint8Array(32).fill(0x22));
    const tokenData: TokenData = getTokenDataERC20(TOKEN_ADDRESS);
    const value = 750000n;

    const note = createTransferNote({
      receiverAddressData: { masterPublicKey: receiver.masterPublicKey, viewingPublicKey: receiver.viewingPublicKey },
      senderAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      value,
      tokenData,
    });
    const commitment = await encryptNoteToReceiver(
      note,
      { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey, viewingPrivateKey: sender.viewingPrivateKey },
      receiver.viewingPublicKey,
    );

    // Build the on-chain Transact args carrying this note (0x-prefixed, as a real event would decode).
    const args: RawTransactArgs = {
      treeNumber: 0,
      startPosition: 5,
      hash: [`0x${note.hash.toString(16).padStart(64, '0')}`],
      ciphertext: [
        {
          ciphertext: commitment.ciphertext.map((c) => `0x${c}`),
          blindedSenderViewingKey: `0x${bytesToHex(commitment.blindedSenderViewingKey)}`,
          blindedReceiverViewingKey: `0x${bytesToHex(commitment.blindedReceiverViewingKey)}`,
          annotationData: `0x${commitment.annotationData}`,
          memo: `0x${commitment.memo}`,
        },
      ],
    };

    const [decoded] = formatTransactEvent(args, { blockNumber: 100, txid: META.txid });
    expect(decoded!.position).toBe(5);

    const tokenDataGetter = { getTokenDataFromHash: async () => tokenData };
    const { tryDecryptCommitment } = await import('./note-crypto');
    const recovered = await tryDecryptCommitment(
      decoded!.ciphertext,
      { addressData: { masterPublicKey: receiver.masterPublicKey, viewingPublicKey: receiver.viewingPublicKey }, viewingPrivateKey: receiver.viewingPrivateKey },
      tokenDataGetter,
    );
    expect(recovered).toBeDefined();
    expect(recovered!.value).toBe(value);

    const txo = txoFromNote(recovered!, decoded!.tree, decoded!.position, decoded!.blockNumber);
    const balances = computeBalances([txo], [], receiver.nullifyingKey, { currentBlock: 200, finalityThreshold: 10 });
    expect(balances).toEqual([{ tokenHash: recovered!.tokenHash, spendable: value, pending: 0n }]);
  });

  it('decodePoolEvents dispatches by name and ignores unknown events', () => {
    const logs: ParsedPoolLog[] = [
      { name: 'Nullified', args: { treeNumber: 1, nullifier: [b32('01')] } as RawNullifiedArgs, blockNumber: 10, txid: META.txid },
      { name: 'SomethingElse', args: {} as RawNullifiedArgs, blockNumber: 11, txid: META.txid },
    ];
    const out = decodePoolEvents(logs);
    expect(out.nullifiers).toHaveLength(1);
    expect(out.nullifiers[0]!.tree).toBe(1);
    expect(out.shields).toHaveLength(0);
    expect(out.transacts).toHaveLength(0);
  });
});

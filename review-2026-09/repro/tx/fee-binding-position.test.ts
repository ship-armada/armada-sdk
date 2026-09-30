// ABOUTME: Repro — extractFeeOutput binds a decrypted fee note to ANY commitment in the tx (set membership),
// ABOUTME: while the broadcaster's own scanner pairs ciphertext[i] with commitments[i]; a swapped layout passes the verifier but is never discovered.
import { describe, it, expect, beforeAll } from 'vitest';
import { Interface, ZeroAddress } from 'ethers';
import { initPoseidonPromise, getTokenDataERC20, type TokenData } from '../../../src/core/index';
import { deriveKeyset, type Keyset } from '../../../src/wallet/derive';
import { createTransferNote, encryptNoteToReceiver, tryDecryptCommitment, decryptedCommitmentMatches, type CommitmentCiphertextV2 } from '../../../src/sync/index';
import { decodeTransact, extractFeeOutput, TRANSACT_ABI } from '../../../src/tx/decode';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const b32 = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');
const bytesToHex = (b: Uint8Array): string => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hx = (s: string) => (s.startsWith('0x') ? s : `0x${s}`);
const ctTuple = (c: CommitmentCiphertextV2) => [c.ciphertext.map(hx), bytesToHex(c.blindedSenderViewingKey), bytesToHex(c.blindedReceiverViewingKey), hx(c.annotationData), hx(c.memo)];

describe('extractFeeOutput binding is positional-agnostic', () => {
  let sender: Keyset, receiver: Keyset, broadcaster: Keyset, tokenData: TokenData;
  beforeAll(async () => {
    await initPoseidonPromise;
    sender = await deriveKeyset(new Uint8Array(32).fill(0x11));
    receiver = await deriveKeyset(new Uint8Array(32).fill(0x22));
    broadcaster = await deriveKeyset(new Uint8Array(32).fill(0x33));
    tokenData = getTokenDataERC20(USDC);
  });
  const make = async (value: bigint, rcv: Keyset) => {
    const note = createTransferNote({
      receiverAddressData: { masterPublicKey: rcv.masterPublicKey, viewingPublicKey: rcv.viewingPublicKey },
      senderAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      value, tokenData,
    });
    const ct = await encryptNoteToReceiver(note, { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey, viewingPrivateKey: sender.viewingPrivateKey }, rcv.viewingPublicKey);
    return { note, ct };
  };

  it('accepts a fee whose ciphertext sits at a different index than its commitment', async () => {
    const fee = await make(1_000_000n, broadcaster);
    const pay = await make(5_000_000n, receiver);
    const iface = new Interface(TRANSACT_ABI as unknown as string[]);
    // commitments: [fee, pay]; ciphertexts: [pay, fee] — swapped.
    const tx = [[[0n, 0n], [[0n, 0n], [0n, 0n]], [0n, 0n]], b32(1n), [b32(9n)], [b32(fee.note.hash), b32(pay.note.hash)],
      [0, 0n, 0, 31337, ZeroAddress, b32(0n), [ctTuple(pay.ct), ctTuple(fee.ct)]], [b32(0n), [0, ZeroAddress, 0n], 0n]];
    const [decoded] = decodeTransact(iface.encodeFunctionData('transact', [[tx]]));
    const bk = { addressData: { masterPublicKey: broadcaster.masterPublicKey, viewingPublicKey: broadcaster.viewingPublicKey }, viewingPrivateKey: broadcaster.viewingPrivateKey };
    const getter = { getTokenDataFromHash: async () => tokenData };
    // Verifier accepts the fee…
    expect(await extractFeeOutput(decoded!, bk, getter, undefined, { tokenAddress: USDC, minValue: 1_000_000n })).toEqual({ tokenAddress: USDC, value: 1_000_000n });
    // …but the broadcaster's scanner pairs ciphertext[1] with commitments[1] and drops it (engine 9.6.0 check).
    const scanned = await tryDecryptCommitment(decoded!.commitmentCiphertexts[1]!, bk, getter);
    expect(scanned).toBeDefined();
    expect(decryptedCommitmentMatches(scanned!, b32(decoded!.commitments[1]!))).toBe(false);
  });
});
